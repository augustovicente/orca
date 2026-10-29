import { runProcess } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'
import {
  DEADLINE_PASSED,
  createSettleNotifier,
  monotonicNow,
  type Settled
} from './deadline-settle-notifier'

/** Every setuid /bin/ps the in-process reader still needs runs through a fork budget: fallbacks while the reader is
 * down (stalled pool, rejecting addon), forced subprocess captures, and argv recovery for other users' processes.
 * Without one, each poller forks its own ps per poll per stream, the rate #31783 removed. */

type Flight = {
  /** Creation order; a flight serves only requests registered at or before it, so its ps started after them. */
  sequence: number
  readonly submitted: boolean
  wait: (deadline: number) => Promise<Settled<ProcessResult> | typeof DEADLINE_PASSED>
}

type Spec = { args: readonly string[]; env: NodeJS.ProcessEnv; maxOutputBytes?: number }

/** Requests for one invocation waiting on a token; served together, in the order their invocation first queued. */
type Queued = { spec: Spec; waiters: Map<() => void, number> }

const TIMED_OUT: ProcessResult = {
  code: null,
  signal: 'SIGTERM',
  stdout: '',
  stderr: '',
  timedOut: true,
  outputTruncated: false
}

const FLIGHT_LIMIT = 64
let nextSequence = 0

/** Register before any in-process attempt: only a ps spawned from now on may answer this request. */
export function registerPsFallbackRequest(): number {
  return nextSequence
}

// ps output follows its locale, zone and (without -ww) width, so only identically shaped invocations share a run.
function flightKey(spec: Spec): string {
  const shape = ['LC_ALL', 'LC_CTYPE', 'LC_TIME', 'LANG', 'TZ', 'COLUMNS'].map(
    (name) => spec.env[name] ?? null
  )
  return JSON.stringify([spec.args, shape, spec.maxOutputBytes ?? null])
}

type PsForkBudget = {
  run: (spec: Spec, registeredSequence: number, deadline: number) => Promise<ProcessResult>
  reset: () => void
}

function createPsForkBudget(burst: number, refillMs: number): PsForkBudget {
  // Keeps each invocation's latest flight, finished or not, for requests that queued meanwhile.
  const flights = new Map<string, Flight>()
  // Insertion order is service order: a busy invocation cannot take every token from the others.
  const queue = new Map<string, Queued>()
  let tokens = burst
  let refilledAtMs = Number.NEGATIVE_INFINITY
  let grantTimer: ReturnType<typeof setTimeout> | undefined

  const refill = (now: number): void => {
    tokens = Math.min(burst, tokens + Math.max(0, now - refilledAtMs) / refillMs)
    refilledAtMs = now
  }

  const submit = (key: string, spec: Spec, timeoutMs: number): void => {
    const submission = { submitted: false }
    const pending = new Promise<ProcessResult>((resolve, reject) => {
      // A microtask later, so requests registered in the same turn share this ps.
      queueMicrotask(() => {
        submission.submitted = true
        runProcess({
          program: '/bin/ps',
          args: [...spec.args],
          env: spec.env,
          timeoutMs,
          ...(spec.maxOutputBytes === undefined ? {} : { maxOutputBytes: spec.maxOutputBytes })
        }).then(resolve, reject)
      })
    })
    flights.delete(key)
    for (const oldest of flights.keys()) {
      if (flights.size < FLIGHT_LIMIT) {
        break
      }
      flights.delete(oldest)
    }
    flights.set(key, {
      sequence: nextSequence++,
      get submitted() {
        return submission.submitted
      },
      wait: createSettleNotifier(pending)
    })
  }

  const grant = (): void => {
    grantTimer = undefined
    const now = monotonicNow()
    refill(now)
    for (const [key, queued] of queue) {
      if (tokens < 1) {
        break
      }
      queue.delete(key)
      const latest = Math.max(...queued.waiters.values())
      if (queued.waiters.size === 0 || latest <= now) {
        continue
      }
      tokens -= 1
      submit(key, queued.spec, Math.floor(latest - now))
      for (const wake of queued.waiters.keys()) {
        wake()
      }
    }
    if (queue.size > 0) {
      grantTimer = setTimeout(grant, Math.ceil((1 - tokens) * refillMs))
    }
  }

  const run = async (
    spec: Spec,
    registeredSequence: number,
    deadline: number
  ): Promise<ProcessResult> => {
    const key = flightKey(spec)
    for (;;) {
      const flight = flights.get(key)
      if (flight && (!flight.submitted || flight.sequence >= registeredSequence)) {
        const settled = await flight.wait(deadline)
        if (settled === DEADLINE_PASSED) {
          return TIMED_OUT
        }
        if (!settled.ok) {
          throw settled.error
        }
        return settled.value
      }
      const now = monotonicNow()
      if (deadline <= now) {
        return TIMED_OUT
      }
      refill(now)
      if (queue.size === 0 && tokens >= 1) {
        tokens -= 1
        submit(key, spec, Math.floor(deadline - now))
        continue
      }
      const served = await new Promise<boolean>((resolve) => {
        const queued = queue.get(key) ?? { spec, waiters: new Map() }
        queue.set(key, queued)
        const timer = setTimeout(
          () => {
            queued.waiters.delete(wake)
            resolve(false)
          },
          Math.max(0, deadline - now)
        )
        const wake = (): void => {
          clearTimeout(timer)
          resolve(true)
        }
        queued.waiters.set(wake, deadline)
        grantTimer ??= setTimeout(grant, Math.ceil((1 - tokens) * refillMs))
      })
      if (!served) {
        return TIMED_OUT
      }
    }
  }

  return {
    run,
    reset: () => {
      clearTimeout(grantTimer)
      grantTimer = undefined
      flights.clear()
      queue.clear()
      tokens = burst
      refilledAtMs = Number.NEGATIVE_INFINITY
    }
  }
}

// While the reader is down: a burst of 4 forks, then one a second, however many streams poll.
const fallbackBudget = createPsForkBudget(4, 1_000)
// argv only setuid ps can read (sudo/su in a pane): a burst of 2, then one every 2s.
const argvRecoveryBudget = createPsForkBudget(2, 2_000)

/** /bin/ps for a request registered at `registeredSequence`, sharing a run begun after it; times out like a killed ps
 * when neither a shared run nor a fork token arrives before `deadline`. */
export function runPsFallback(
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; maxOutputBytes?: number },
  registeredSequence: number,
  deadline: number
): Promise<ProcessResult> {
  return fallbackBudget.run({ args, ...options }, registeredSequence, deadline)
}

/** `ps -o pid=,command= -p …` for argv the in-process reader could not read, under its own smaller budget. */
export function runArgvRecoveryPs(
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; maxOutputBytes?: number },
  deadline: number
): Promise<ProcessResult> {
  return argvRecoveryBudget.run({ args, ...options }, registerPsFallbackRequest(), deadline)
}

export function resetPsFallbackForTests(): void {
  fallbackBudget.reset()
  argvRecoveryBudget.reset()
}
