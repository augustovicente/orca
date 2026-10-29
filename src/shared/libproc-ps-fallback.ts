import { runProcess } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'
import {
  DEADLINE_PASSED,
  createSettleNotifier,
  monotonicNow,
  type Settled
} from './deadline-settle-notifier'

/** While the in-process reader is down (stalled pool, rejecting addon), every poller would fork its own setuid ps:
 * one per poll per stream, the rate #31783 removed. Fallbacks instead share one ps per invocation and a fork budget. */

type Flight = {
  /** Creation order; a flight serves only requests registered at or before it, so its ps started after them. */
  sequence: number
  readonly submitted: boolean
  wait: (deadline: number) => Promise<Settled<ProcessResult> | typeof DEADLINE_PASSED>
}

// Keeps each invocation's latest flight, finished or not, for requests that queued for the budget meanwhile.
const flights = new Map<string, Flight>()
const FLIGHT_LIMIT = 64
let nextSequence = 0

// A burst of 4 forks, then one a second: a stalled pool costs at most ~64 ps a minute however many streams poll.
const BUDGET_BURST = 4
const BUDGET_REFILL_MS = 1_000
let tokens = BUDGET_BURST
let refilledAtMs = Number.NEGATIVE_INFINITY

const TIMED_OUT: ProcessResult = {
  code: null,
  signal: 'SIGTERM',
  stdout: '',
  stderr: '',
  timedOut: true,
  outputTruncated: false
}

/** Register before any in-process attempt: only a ps spawned from now on may answer this request. */
export function registerPsFallbackRequest(): number {
  return nextSequence
}

/** Take a fork token, or return how long until one is due. */
function takeToken(now: number): number {
  tokens = Math.min(BUDGET_BURST, tokens + Math.max(0, now - refilledAtMs) / BUDGET_REFILL_MS)
  refilledAtMs = now
  if (tokens >= 1) {
    tokens -= 1
    return 0
  }
  return Math.ceil((1 - tokens) * BUDGET_REFILL_MS)
}

// ps output follows its locale, zone and (without -ww) width, so only identically shaped invocations share a run.
function flightKey(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  maxOutputBytes?: number
): string {
  const shape = ['LC_ALL', 'LC_CTYPE', 'LC_TIME', 'LANG', 'TZ', 'COLUMNS'].map(
    (name) => env[name] ?? null
  )
  return JSON.stringify([args, shape, maxOutputBytes ?? null])
}

function submit(
  key: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxOutputBytes?: number
): void {
  const submission = { submitted: false }
  const pending = new Promise<ProcessResult>((resolve, reject) => {
    // A microtask later, so requests registered in the same turn share this ps.
    queueMicrotask(() => {
      submission.submitted = true
      runProcess({
        program: '/bin/ps',
        args: [...args],
        env,
        timeoutMs,
        ...(maxOutputBytes === undefined ? {} : { maxOutputBytes })
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

/** /bin/ps for a request registered at `registeredSequence`, sharing a run begun after it; times out like a killed ps
 * when neither a shared run nor a fork token arrives before `deadline`. */
export async function runPsFallback(
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; maxOutputBytes?: number },
  registeredSequence: number,
  deadline: number
): Promise<ProcessResult> {
  const key = flightKey(args, options.env, options.maxOutputBytes)
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
    const timeoutMs = Math.floor(deadline - now)
    if (timeoutMs <= 0) {
      return TIMED_OUT
    }
    const waitMs = takeToken(now)
    if (waitMs === 0) {
      submit(key, args, options.env, timeoutMs, options.maxOutputBytes)
      continue
    }
    if (now + waitMs > deadline) {
      return TIMED_OUT
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
}

export function resetPsFallbackForTests(): void {
  flights.clear()
  tokens = BUDGET_BURST
  refilledAtMs = Number.NEGATIVE_INFINITY
}
