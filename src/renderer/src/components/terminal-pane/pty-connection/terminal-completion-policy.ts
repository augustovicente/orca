import { useAppStore } from '@/store'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import { isFreshNonDoneAgentStatus } from '../../../../../shared/agent-status-types'
import { createAgentCompletionCoordinator } from '../agent-completion-coordinator'
import type { AgentCompletionCoordinatorOptions } from '../agent-completion-coordinator-types'
import type { createTerminalNotificationPolicy } from './terminal-notification-policy'
import type { AgentType } from '../../../../../shared/agent-status-types'
import { dispatchAgentHookTerminalLifecycle } from '../agent-hook-terminal-lifecycle'
import { resolveCompatibleAgentTypeForOwner } from '../../../../../shared/agent-title-owner'
import { isAgentTaskCompleteTrackingEnabled } from './agent-task-complete-settings'
import { isAgentProcessInspectionCostly } from '../agent-process-inspection-cost'
import { isRemoteExecutionHostPtyId } from '../../../../../shared/remote-execution-host-pty-id'

export function createTerminalCompletionPolicy(
  services: Pick<
    AgentCompletionCoordinatorOptions,
    'paneKey' | 'getPtyId' | 'getExpectedIncarnationId' | 'isLive' | 'onForegroundAgentExited'
  > & {
    isVisible: () => boolean
    clearSuppressedTitleSideEffects: () => void
    setFocusReportSuppressionForAgentCompletion: (
      title: string | undefined,
      agentType: AgentType | undefined
    ) => void
    queueAgentIdleTerminalModeReset: () => void
    scheduleAgentTaskCompleteNotification: ReturnType<
      typeof createTerminalNotificationPolicy
    >['scheduleAgentTaskCompleteNotification']
  }
) {
  return createAgentCompletionCoordinator({
    paneKey: services.paneKey,
    statusLane: 'pty',
    getPtyId: services.getPtyId,
    isRemotePtyId: isRemoteExecutionHostPtyId,
    getExpectedIncarnationId: services.getExpectedIncarnationId,
    inspectProcess: inspectRuntimeTerminalProcess,
    dispatchHookLifecycle: (payload) =>
      dispatchAgentHookTerminalLifecycle(services.paneKey, payload),
    shouldSuppressProcessReplacementCompletion: (_exited, replacement) => {
      const currentStatus = useAppStore.getState().agentStatusByPaneKey[services.paneKey]
      const currentAgentForReplacement = resolveCompatibleAgentTypeForOwner(
        currentStatus?.agentType,
        replacement.agent
      )
      return (
        isFreshNonDoneAgentStatus(currentStatus) && currentAgentForReplacement === replacement.agent
      )
    },
    shouldSuppressConfirmedProcessExitCompletion: (exited) => {
      const currentStatus = useAppStore.getState().agentStatusByPaneKey[services.paneKey]
      const currentAgentForExited = resolveCompatibleAgentTypeForOwner(
        currentStatus?.agentType,
        exited.agent
      )
      // Why: a replacement hook can lead process visibility by one cadence;
      // only a different known active owner can veto confirmed old-process exit.
      return Boolean(
        isFreshNonDoneAgentStatus(currentStatus) &&
        currentStatus.agentType &&
        currentStatus.agentType !== 'unknown' &&
        currentAgentForExited !== exited.agent
      )
    },
    onForegroundAgentExited: services.onForegroundAgentExited,
    dispatchCompletion: (title, meta) => {
      if (meta?.source === 'process-exit') {
        services.clearSuppressedTitleSideEffects()
      }
      if (meta?.terminalIdleConfirmed === true) {
        // Why: an agent can crash before its done hook; confirmed process death
        // must still restore cursor and native Windows Kitty keyboard modes.
        const currentAgentStatus = useAppStore.getState().agentStatusByPaneKey[services.paneKey]
        if (!isFreshNonDoneAgentStatus(currentAgentStatus)) {
          services.setFocusReportSuppressionForAgentCompletion(title, meta.agentStatus?.agentType)
        }
        services.queueAgentIdleTerminalModeReset()
      }
      services.scheduleAgentTaskCompleteNotification(title, {
        allowDoneDetailAfterGrace: meta?.quietedHookDone,
        ...(meta?.source === 'process-exit' ? { agentCompletionSource: meta.source } : {}),
        ...(meta?.agentStatus ? { agentStatusSnapshot: meta.agentStatus } : {})
      })
    },
    dispatchAttention: (title, meta) =>
      services.scheduleAgentTaskCompleteNotification(title, {
        agentStatusSnapshot: meta.agentStatus
      }),
    shouldPollProcessCadence: () => {
      const ptyId = services.getPtyId()
      if (isRemoteExecutionHostPtyId(ptyId)) {
        return false
      }
      return isAgentTaskCompleteTrackingEnabled() && services.isVisible()
    },
    shouldPollNoEvidenceProcessCadence: () => {
      const ptyId = services.getPtyId()
      return !isRemoteExecutionHostPtyId(ptyId)
    },
    isProcessInspectionCostly: () =>
      isAgentProcessInspectionCostly(navigator.userAgent, services.getPtyId()),
    isLive: services.isLive
  })
}
