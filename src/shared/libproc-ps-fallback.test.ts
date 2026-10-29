import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcess } = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess }))

import { setLibprocAddonForTests, type LibprocAddon } from './libproc-addon'
import { resetNativeReadsForTests } from './libproc-native-reads'
import { runPsInProcess } from './libproc-process-table'
import { resetPsFallbackForTests } from './libproc-ps-fallback'

const POLL_MS = 750
const STREAMS = 13
const ENV = { LC_ALL: 'C', LANG: 'C' }

function installAddon(readProcessTable: LibprocAddon['readProcessTable']): void {
  setLibprocAddonForTests({
    readProcessTable,
    readProcessCwd: async () => null,
    readProcessPath: async () => null
  })
}

/** The call-site shape every poller uses: the in-process reader, else its own ps. */
async function poll(pid: number): Promise<void> {
  const args = ['-o', 'pid=,ppid=,pgid=,lstart=', '-p', String(pid)]
  const options = { env: ENV, timeoutMs: 2000, maxOutputBytes: 4096 }
  if (!(await runPsInProcess(args, options))) {
    await runProcess({ program: 'ps', args, ...options })
  }
}

async function forksOverOneMinute(): Promise<number> {
  const timers = Array.from({ length: STREAMS }, (_, stream) =>
    setInterval(() => void poll(7000 + stream), POLL_MS)
  )
  await vi.advanceTimersByTimeAsync(60_000)
  timers.forEach(clearInterval)
  return runProcess.mock.calls.length
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance']
  })
  runProcess.mockImplementation(async ({ args }: { args: string[] }) => ({
    code: 0,
    signal: null,
    stdout: ` ${args.at(-1)} 1 1 Thu Sep  3 16:02:01 2026\n`,
    stderr: '',
    timedOut: false,
    outputTruncated: false
  }))
})

afterEach(() => {
  vi.useRealTimers()
  runProcess.mockReset()
  setLibprocAddonForTests(undefined)
  resetNativeReadsForTests()
  resetPsFallbackForTests()
})

describe('ps fallback budget', () => {
  it('bounds ps forks across pollers while native reads keep rejecting', async () => {
    const readProcessTable = vi.fn(async () => {
      throw new Error('sysctl failed')
    })
    installAddon(readProcessTable)

    const forks = await forksOverOneMinute()
    console.info(
      `[fork-budget] native rejection: ${forks} ps/min, ${readProcessTable.mock.calls.length} native reads`
    )
    expect(forks).toBeLessThanOrEqual(70)
    // Backoff: rejection stops being retried on every poll.
    expect(readProcessTable.mock.calls.length).toBeLessThan(15)
  })

  it('bounds ps forks across pollers while the stalled-pool breaker is open', async () => {
    installAddon(vi.fn(() => new Promise<never>(() => {})))
    // Fill the cap with stalled reads and trip the breaker.
    for (let index = 0; index < 9; index += 1) {
      void runPsInProcess(['-p', String(5000 + index), '-o', 'pid='], { timeoutMs: 50 })
    }
    await vi.advanceTimersByTimeAsync(50)
    runProcess.mockClear()

    const forks = await forksOverOneMinute()
    console.info(`[fork-budget] breaker open: ${forks} ps/min`)
    expect(forks).toBeLessThanOrEqual(70)
  })

  it('never answers a request with a fallback ps spawned before it, but shares one spawned after', async () => {
    installAddon(async () => {
      throw new Error('sysctl failed')
    })
    const finish: ((stdout: string) => void)[] = []
    runProcess.mockImplementation(
      () =>
        new Promise((resolve) =>
          finish.push((stdout) =>
            resolve({ code: 0, signal: null, stdout, stderr: '', timedOut: false })
          )
        )
    )
    // pid= only: a descendant read that would signal whatever pids it returns.
    const read = () => runPsInProcess(['-axo', 'pid='], { timeoutMs: 2000 })

    const early = read()
    await vi.advanceTimersByTimeAsync(0)
    expect(runProcess).toHaveBeenCalledTimes(1)
    const late = [read(), read()]
    await vi.advanceTimersByTimeAsync(0)
    expect(runProcess).toHaveBeenCalledTimes(2)
    finish[0]?.(' 9999\n')
    finish[1]?.(' 4242\n')
    expect((await early)?.stdout).toBe(' 9999\n')
    expect((await Promise.all(late)).map((result) => result?.stdout)).toEqual([
      ' 4242\n',
      ' 4242\n'
    ])
  })
})
