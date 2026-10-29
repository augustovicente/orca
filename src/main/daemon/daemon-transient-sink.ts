import type { Socket } from 'node:net'
import type { TerminalTransientSink } from '../../shared/terminal-transient-observation'
import type { StreamQueueEntry, PendingStreamDataBatch } from './daemon-stream-keep-tail-drop'
import {
  accountDaemonStreamEntry,
  releaseDaemonStreamEntry
} from './daemon-stream-entry-accounting'

export function createDaemonTransientSink(
  context: {
    socket: Socket
    isCurrent: () => boolean
    getBatch: () => PendingStreamDataBatch
    getPendingBatch: () => PendingStreamDataBatch | undefined
    removeSnapshot: (batch: PendingStreamDataBatch) => void
    updateBackpressure: (batch: PendingStreamDataBatch) => void
    scheduleFlush: (batch: PendingStreamDataBatch) => void
  },
  sessionId: string
): TerminalTransientSink {
  const { socket } = context
  let disposed = false
  let incarnationId = ''
  let pending: Parameters<TerminalTransientSink['stage']>[0] | null = null
  let readCurrent: (() => Parameters<TerminalTransientSink['stage']>[0]) | undefined
  let queuedEntry: StreamQueueEntry | undefined
  let installation: StreamQueueEntry | undefined
  const commit = (): void => {
    if (disposed || !context.isCurrent() || socket.destroyed) {
      return
    }
    pending ??= readCurrent?.() ?? null
    if (!pending) {
      return
    }
    const batch = context.getBatch()
    context.removeSnapshot(batch)
    queuedEntry = {
      sessionId,
      data: '',
      observation: {
        type: 'event',
        event: 'terminalObservation',
        sessionId,
        incarnationId,
        payload: pending
      }
    }
    batch.queue.push(queuedEntry)
    pending = null
    context.scheduleFlush(batch)
  }
  return {
    install: (state, incarnation, read) => {
      incarnationId = incarnation
      readCurrent = read
      const batch = context.getBatch()
      context.removeSnapshot(batch)
      installation = accountDaemonStreamEntry(batch, {
        sessionId,
        data: '',
        control: {
          type: 'event',
          event: 'terminalObservation',
          sessionId,
          incarnationId,
          payload: state
        }
      })
      batch.queue.push(installation)
      context.updateBackpressure(batch)
      context.scheduleFlush(batch)
    },
    stage: (state) => {
      pending = state
    },
    commit,
    dispose: () => {
      disposed = true
      pending = null
      readCurrent = undefined
      const batch = context.getPendingBatch()
      if (batch) {
        batch.queue = batch.queue.filter((entry) => {
          if (entry !== queuedEntry && entry !== installation) {
            return true
          }
          releaseDaemonStreamEntry(batch, entry)
          return false
        })
        context.updateBackpressure(batch)
      }
      queuedEntry = undefined
    }
  }
}
