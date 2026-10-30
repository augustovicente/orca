/** Kept open, or temporary with the host's deadline (null while it runs or works again); the host
 *  answers null when nothing closes it. Hosts without orchestration.worker-keep-open.v1 lack the method. */
export type WorkerAutoCloseState = { kept: true } | { kept: false; closesAt: string | null }

export function readWorkerAutoCloseReply(result: unknown): WorkerAutoCloseState | null {
  if (typeof result !== 'object' || result === null || !('autoClose' in result)) {
    return null
  }
  const state = result.autoClose
  if (typeof state !== 'object' || state === null || !('kept' in state)) {
    return null
  }
  if (state.kept === true) {
    return { kept: true }
  }
  const closesAt = 'closesAt' in state ? state.closesAt : null
  return { kept: false, closesAt: typeof closesAt === 'string' ? closesAt : null }
}

/** m:ss until the host's deadline, never below 0:00. */
export function formatWorkerAutoCloseCountdown(closesAt: string, nowMs: number): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(closesAt) - nowMs) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

// A worker is re-read often so the strip follows its finish, follow-ups and Allow Auto-Close; anything else rarely.
const POLL_MS = 3_000
const IDLE_POLL_MS = 15_000

/** Reads now and again until the returned stop is called. */
export function pollWorkerAutoClose(
  read: () => Promise<WorkerAutoCloseState | null>,
  onState: (state: WorkerAutoCloseState | null) => void
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const poll = (): void => {
    void read().then((state) => {
      if (!stopped) {
        onState(state)
        timer = setTimeout(poll, state !== null ? POLL_MS : IDLE_POLL_MS)
      }
    })
  }
  poll()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
