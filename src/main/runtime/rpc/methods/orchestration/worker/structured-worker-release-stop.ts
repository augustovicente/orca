import type { WorkerTerminalReleaseRuntime } from '../../../../orchestration/worker-terminal-release-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { WorkerTerminalResourceRow } from '../../../../orchestration/worker-terminal-ownership'
import { stopStructuredWorker } from '../../orchestration-structured-worker-lifecycle'
import type { StructuredWorkerIdentity } from '../../../../structured-worker-identity'
import { archiveSummary } from './worker-terminal-resource-presentation'
import { releaseUnknownRecovery, type WorkerReleaseReceipt } from './worker-release-completion'

/** Use host settlement to prove structured close; unproven closes remain release_unknown. Retry with a fresh request id because replay returns the old receipt. */
export async function stopStructuredWorkerForRelease(args: {
  structured: StructuredWorkerIdentity
  dispatchId: string
  resource: WorkerTerminalResourceRow
  runtime: WorkerTerminalReleaseRuntime
  db: OrchestrationDb
  archiveSource: string | null
  archiveStatus: string | null
}): Promise<WorkerReleaseReceipt> {
  const { structured, dispatchId, resource, runtime, db } = args
  // Only an automatic release can be refused; an explicit one keeps cutting through a hung start.
  const stop = await stopStructuredWorker(
    structured,
    dispatchId,
    runtime,
    resource.auto_release_at ? () => admitAutomaticClose(runtime, db, resource) : undefined
  )
  if (!stop.stopped) {
    const current = db.getWorkerTerminalResource(resource.id)
    if (current && current.release_state !== 'releasing') {
      // Refused in the session lane: Keep open, a new turn, or a fall back to manual release.
      return {
        dispatchId,
        state: 'retained',
        processAction: 'none',
        archive: archiveSummary(current)
      }
    }
    const unknown = db.markWorkerTerminalReleaseUnknown(
      resource.id,
      stop.reason ?? 'The structured session close was not proven.'
    )
    return {
      dispatchId,
      state: 'release_unknown',
      processAction: stop.closeAttempted ? 'closed_agent_terminal' : 'none',
      archive: { source: args.archiveSource, status: args.archiveStatus },
      lastError: unknown.release_error ?? stop.reason,
      recovery: releaseUnknownRecovery(dispatchId)
    }
  }
  const settled = db.settleWorkerTerminalRelease(resource.id)
  runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
  return {
    dispatchId,
    state: 'released',
    processAction: 'closed_agent_terminal',
    archive: archiveSummary(settled)
  }
}

// In the session lane, so a turn that began while the archive was taken is seen before Stop.
function admitAutomaticClose(
  runtime: WorkerTerminalReleaseRuntime,
  db: OrchestrationDb,
  resource: WorkerTerminalResourceRow
): boolean {
  if (runtime.isWorkerAgentInTurn(resource)) {
    db.deferWorkerTerminalAutoRelease(resource.id)
    return false
  }
  return db.admitWorkerChatReleaseClose(resource.id)
}
