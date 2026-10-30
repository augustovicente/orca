import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess
} from '../../../../shared/agent-process-recognition'
import { resolveCompatibleAgentTypeForOwner } from '../../../../shared/agent-title-owner'
import { isShellProcess } from '../../../../shared/shell-process-detection'
import { PaneForegroundReadScheduler } from './pane-foreground-read-scheduler'
import { createPaneForegroundProcessReader } from './pane-foreground-process-reader'
import { FOREGROUND_COMMAND_READS } from '../../../../shared/foreground-command-settle'
import type {
  ForegroundReadReason,
  PaneForegroundAgentTracker,
  PaneForegroundAgentTrackerDeps
} from './pane-foreground-agent-tracker-contract'

const VISIBLE_PTY_SETTLE_MS = 350

/** Read foreground identity at command boundaries; confirm 133;D before clearing known agents because nested shells can leak that marker. */
export function createPaneForegroundAgentTracker(
  deps: PaneForegroundAgentTrackerDeps
): PaneForegroundAgentTracker {
  let disposed = false
  const reads = new PaneForegroundReadScheduler(readForeground)
  // Nested agent shells leak 133;D onto the main PTY; confirm foreground before treating it as prompt return.
  let hasForegroundAgentEvidence = false
  // Latch launch/hook evidence through confirmation so cleanup cannot disarm the bounded retry ladder.
  let hasKnownAgentEvidence = false
  let hasAgentExpectation = false
  let startupSampled = false
  const readProcess = createPaneForegroundProcessReader(deps)
  const clearAgentEvidence = (): void => {
    hasForegroundAgentEvidence = false
    hasKnownAgentEvidence = false
    hasAgentExpectation = false
  }

  const publishInconclusiveForeground = (): void => {
    const current = deps.getPublishedEntry?.()
    deps.publish(
      current?.agentEvidence === 'launch-record' && !current.shellForeground
        ? {
            agent: current.agent,
            agentEvidence: 'launch-record',
            shellForeground: false,
            routingRevoked: true
          }
        : { agent: null, shellForeground: false }
    )
  }

  const trackablePtyId = (): string | null => {
    const ptyId = deps.getPtyId()
    return ptyId && deps.isTrackablePtyId(ptyId) ? ptyId : null
  }

  const cancelPendingRead = (): void => reads.cancel()
  const scheduleRead = (delay: number, retryIndex: number, reason: ForegroundReadReason): void =>
    reads.schedule(delay, retryIndex, reason)

  // Release retained capabilities when a read ends; superseded reads delegate settlement to their successor.
  const releaseRetainedCapability = (hadReadInFlight: boolean): void => {
    if (hadReadInFlight) {
      deps.onVisibleForegroundSettled?.('inconclusive')
    }
  }

  const settleAbortedRead = (generation: number): void => {
    if (!disposed && generation === reads.generation) {
      deps.onVisibleForegroundSettled?.('inconclusive')
    }
  }

  async function readForeground(
    generation: number,
    retryIndex: number,
    reason: ForegroundReadReason
  ): Promise<void> {
    const ptyId = trackablePtyId()
    if (disposed || generation !== reads.generation || !ptyId) {
      settleAbortedRead(generation)
      return
    }
    const requiresRoutingConfirmation =
      reason === 'command-finished' ||
      reason === 'accepted-input' ||
      hasForegroundAgentEvidence ||
      hasKnownAgentEvidence ||
      hasAgentExpectation
    const { processName, remoteEvidenceVerdict, expectedIncarnationId, remote } = await readProcess(
      ptyId,
      requiresRoutingConfirmation
    )
    // Fence pending inspection so an old PTY cannot publish identity into its replacement.
    if (
      disposed ||
      generation !== reads.generation ||
      trackablePtyId() !== ptyId ||
      (remote && deps.getExpectedIncarnationId?.() !== expectedIncarnationId)
    ) {
      settleAbortedRead(generation)
      return
    }
    const settledReason = reads.activeReason ?? reason
    const recognized =
      remoteEvidenceVerdict === 'live'
        ? recognizeAgentProcess(processName)
        : remoteEvidenceVerdict !== null
          ? null
          : recognizeAgentProcess(processName)
    if (recognized) {
      hasForegroundAgentEvidence = true
      hasAgentExpectation = false
      deps.publish({
        agent: recognized.agent,
        agentEvidence: 'process-read',
        shellForeground: false,
        ...(requiresRoutingConfirmation ? { routingTrusted: true } : {})
      })
      // Why: nothing else re-derives this read in a pane without command marks.
      if (!remote) {
        deps.onAgentProcessRead?.(recognized)
      }
      if (settledReason === 'visible-pty' || settledReason === 'accepted-input') {
        deps.onVisibleForegroundSettled?.('agent')
      }
      return
    }
    // 133;D cancels pending reads, so a surviving command read’s shell is nested and cannot prove prompt return.
    const retryDelay = FOREGROUND_COMMAND_READS.retryDelaysMs[retryIndex]
    const hasConfirmationExpectation =
      hasForegroundAgentEvidence || hasKnownAgentEvidence || hasAgentExpectation
    const shouldRetryExpectedIdentity =
      hasConfirmationExpectation && (settledReason !== 'command-finished' || processName === null)
    const shouldRetry =
      retryDelay !== undefined &&
      (shouldRetryExpectedIdentity ||
        (processName !== null &&
          (settledReason === 'command' || isAgentForegroundWrapperProcess(processName))))
    if (shouldRetry) {
      // Bound retries across PowerShell-to-WMIC enrichment, which may initially hide a live agent.
      scheduleRead(retryDelay, retryIndex + 1, settledReason)
      return
    }
    if (settledReason === 'accepted-input') {
      hasAgentExpectation = false
      deps.onVisibleForegroundSettled?.('inconclusive')
      return
    }
    if (settledReason === 'command') {
      if (remoteEvidenceVerdict !== null && remoteEvidenceVerdict !== 'live') {
        hasAgentExpectation = false
        deps.onVisibleForegroundSettled?.('inconclusive')
        return
      }
      hasAgentExpectation = false
      publishInconclusiveForeground()
      deps.onVisibleForegroundSettled?.('inconclusive')
      return
    }
    if (settledReason === 'visible-pty') {
      if (
        (hasForegroundAgentEvidence || hasKnownAgentEvidence) &&
        processName !== null &&
        isShellProcess(processName)
      ) {
        clearAgentEvidence()
        deps.publish({ agent: null, shellForeground: true })
        deps.onConfirmedShellForeground?.(settledReason)
        deps.onVisibleForegroundSettled?.('shell')
      } else {
        deps.onVisibleForegroundSettled?.('inconclusive')
      }
      return
    }
    if (settledReason === 'command-finished') {
      if (processName === null) {
        if (remoteEvidenceVerdict !== null && remoteEvidenceVerdict !== 'live') {
          deps.onCommandFinishedUnavailable?.()
          deps.onVisibleForegroundSettled?.('inconclusive')
          return
        }
        // Unverifiable inspection is not shell proof; retire stale routing after the bounded D ladder without asserting shell truth.
        clearAgentEvidence()
        publishInconclusiveForeground()
        deps.onCommandFinishedUnavailable?.()
        deps.onVisibleForegroundSettled?.('inconclusive')
        return
      }
      if ((hasForegroundAgentEvidence || hasKnownAgentEvidence) && !isShellProcess(processName)) {
        // Settle any visible confirmation this read replaced, or its retained capability has no remaining owner to release it.
        deps.onVisibleForegroundSettled?.('inconclusive')
        return
      }
      // 133;D plus no foreground agent proves exit; reset evidence to restore ordinary commands’ no-RPC finish path.
      clearAgentEvidence()
      deps.publish({ agent: null, shellForeground: true })
      // Clear stale agent titles that the shell does not repaint.
      deps.onConfirmedShellForeground?.(settledReason)
    }
  }

  return {
    // A higher-authority command read still promises confirmation when visibility schedules nothing.
    hasReadInFlight: () => reads.hasReadInFlight(),
    onVisiblePtyBound(expectsAgent = false) {
      // Lower-authority visibility recovery must not cancel command-boundary reads that own the exit decision.
      if (reads.hasBoundaryReadInFlight()) {
        return false
      }
      const hadReadBeforeVisibleBind = reads.hasReadInFlight()
      cancelPendingRead()
      if (!trackablePtyId()) {
        releaseRetainedCapability(hadReadBeforeVisibleBind)
        return false
      }
      if (expectsAgent || deps.hasKnownAgentIdentity?.() === true) {
        hasKnownAgentEvidence = true
      }
      // Restore/manual panes may already run an agent without a command-start event to seed identity.
      scheduleRead(VISIBLE_PTY_SETTLE_MS, 0, 'visible-pty')
      return true
    },
    onAcceptedCommandBoundary() {
      if (disposed || reads.hasBoundaryReadInFlight()) {
        return
      }
      cancelPendingRead()
      if (!trackablePtyId()) {
        return
      }
      hasAgentExpectation = true
      scheduleRead(FOREGROUND_COMMAND_READS.settleMs, 0, 'accepted-input')
    },
    onCommandStarted(requireConfirmation = false) {
      startupSampled = false
      // Keep an accepted submit's read while applying the actual OSC lifecycle boundary.
      const acceptedReadPending = reads.hasAcceptedInputRead()
      const hadReadBeforeCommandStart = reads.hasReadInFlight()
      if (!acceptedReadPending) {
        cancelPendingRead()
      }
      const ptyId = trackablePtyId()
      if (!ptyId) {
        cancelPendingRead()
        releaseRetainedCapability(hadReadBeforeCommandStart)
        return
      }
      const alreadyHasKnownIdentity = deps.hasKnownAgentIdentity?.() === true
      hasAgentExpectation = requireConfirmation || acceptedReadPending
      reads.promoteAcceptedInputToCommand()
      if (alreadyHasKnownIdentity) {
        hasKnownAgentEvidence = true
      }
      // New commands invalidate routing authority; launch/hook expectations and remote markers supply no identity before fresh host evidence.
      if (deps.isRemotePtyId?.(ptyId) !== true) {
        publishInconclusiveForeground()
      }
      if (!acceptedReadPending) {
        scheduleRead(FOREGROUND_COMMAND_READS.settleMs, 0, 'command')
      }
    },
    onAgentStartupObserved() {
      if (
        disposed ||
        startupSampled ||
        hasForegroundAgentEvidence ||
        reads.hasReadInFlight() ||
        !trackablePtyId()
      ) {
        return
      }
      // A late startup title requests one bounded confirmation; it never supplies identity.
      startupSampled = true
      cancelPendingRead()
      hasAgentExpectation = true
      scheduleRead(FOREGROUND_COMMAND_READS.settleMs, 0, 'command')
    },
    onCommandFinished() {
      startupSampled = false
      if (deps.hasKnownAgentIdentity?.() === true) {
        hasKnownAgentEvidence = true
      }
      // Any identity read cancelled by rapid 133;C→D needs reconfirmation; trusting D could latch shell state and permanently hide a reattached agent.
      const hadReadBeforeCommandFinish = reads.hasReadInFlight()
      cancelPendingRead()
      if (!trackablePtyId()) {
        releaseRetainedCapability(hadReadBeforeCommandFinish)
        return false
      }
      const ptyId = trackablePtyId()!
      // Trust D without an RPC only with no prior agent evidence, launch/hook identity or racing identity read.
      if (!hasForegroundAgentEvidence && !hasKnownAgentEvidence && !hasAgentExpectation) {
        if (deps.isRemotePtyId?.(ptyId) !== true) {
          deps.publish({ agent: null, shellForeground: true })
        }
        return false
      }
      // Confirm before clearing: a live agent republishes identity; a genuine shell result clears it.
      scheduleRead(FOREGROUND_COMMAND_READS.settleMs, 0, 'command-finished')
      return true
    },
    onProcessExitConfirmed(process) {
      // Why: an in-flight command read owns the pane's next identity, and only a live read is ours.
      const published = deps.getPublishedEntry?.()
      if (
        disposed ||
        reads.hasCommandReadInFlight() ||
        published?.agentEvidence !== 'process-read' ||
        resolveCompatibleAgentTypeForOwner(process.agent, published.agent) !== published.agent
      ) {
        return
      }
      const hadVisibleRead = reads.hasReadInFlight()
      cancelPendingRead()
      clearAgentEvidence()
      startupSampled = false
      // Accepted submits can discover the next agent without retaining the exited interface's authority.
      deps.publish({ agent: null, shellForeground: true })
      if (hadVisibleRead) {
        deps.onVisibleForegroundSettled?.('shell')
      }
      deps.onConfirmedShellForeground?.('process-exit')
    },
    dispose() {
      const hadReadAtDispose = reads.hasReadInFlight()
      disposed = true
      cancelPendingRead()
      releaseRetainedCapability(hadReadAtDispose)
    }
  }
}
