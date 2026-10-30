import { afterEach, describe, expect, it, vi } from 'vitest'
import { pollWorkerAutoClose, type WorkerAutoCloseState } from './worker-auto-close'

describe('pollWorkerAutoClose', () => {
  afterEach(() => vi.useRealTimers())

  it('re-reads only while the worker is temporary, every 15 seconds', async () => {
    vi.useFakeTimers()
    const states: (WorkerAutoCloseState | null)[] = [
      { kept: false, closesAt: null },
      { kept: false, closesAt: '2026-10-27T12:02:00Z' },
      { kept: true }
    ]
    const read = vi.fn(async () => states.shift() ?? null)
    const stop = pollWorkerAutoClose(read, () => {})

    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(read).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(read).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(read).toHaveBeenCalledTimes(3)
    stop()
  })

  it('reads a non-worker once', async () => {
    vi.useFakeTimers()
    const read = vi.fn(async () => null)
    const stop = pollWorkerAutoClose(read, () => {})

    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(read).toHaveBeenCalledTimes(1)
    stop()
  })
})
