import type { PendingPtyInputWrite, PtyInputWriteQueueDeps } from './pty-input-write-queue-contract'

// Use per-write cancellation; queue-lifetime promise reactions retain every acknowledged write until teardown.
export async function writeAcceptedPtyChunk(
  deps: PtyInputWriteQueueDeps,
  pendingAcceptedCancels: Set<() => void>,
  item: PendingPtyInputWrite,
  data: string
): Promise<boolean> {
  let cancel = (): void => undefined
  const cancelled = new Promise<boolean>((resolve) => {
    cancel = () => resolve(false)
  })
  // Install cancellation before writes because synchronous accepted callbacks may clear the queue reentrantly.
  pendingAcceptedCancels.add(cancel)
  try {
    return await Promise.race([
      cancelled,
      Promise.resolve(deps.writeAccepted?.(item.id, data, item.inputKind) ?? false).catch(
        () => false
      )
    ])
  } finally {
    pendingAcceptedCancels.delete(cancel)
  }
}
