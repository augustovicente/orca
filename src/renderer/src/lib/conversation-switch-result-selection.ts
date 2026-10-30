import type { AgentSessionSwitchResult } from '../../../shared/agent-session-switch-execution'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { refreshWebRuntimeSessionTabsSnapshot } from '@/runtime/web-runtime-session-snapshot'
import {
  activateStructuredAgentSessionById,
  findStructuredAgentSessionTab
} from './agent-session/structured-agent-session-tab-activation'
import { useAppStore } from '@/store'
import { presentAgentLaunchTab } from './agent-launch-tab-presentation'
import { conversationSwitchViewerSelectionCurrent } from './conversation-switch-selection'
import type { ConversationSwitch } from './conversation-switch-state'

/** The owning host published membership; this caller alone may move its viewer. */
export async function presentConversationSwitchResult(
  args: ConversationSwitch,
  target: Extract<RuntimeClientTarget, { kind: 'environment' }>,
  result: Extract<AgentSessionSwitchResult, { status: 'completed' }>,
  viewerSelection: string
): Promise<void> {
  const workspaceId =
    (args.direction === 'chat'
      ? findStructuredAgentSessionTab(useAppStore.getState().unifiedTabsByWorktree, {
          sessionId: result.sessionId,
          target
        })?.worktreeId
      : undefined) ?? args.workspaceId
  await refreshWebRuntimeSessionTabsSnapshot(target.environmentId, workspaceId, {
    acceptCurrentSnapshot: true,
    afterCurrentInFlight: true
  }).catch(() => {})
  if (!conversationSwitchViewerSelectionCurrent(viewerSelection)) {
    return
  }
  if (args.direction === 'chat') {
    activateStructuredAgentSessionById({
      worktreeId: workspaceId,
      sessionId: result.sessionId,
      target,
      callerOnly: true,
      viewerSelection
    })
  } else if (result.terminal) {
    presentAgentLaunchTab(
      'focus-window',
      args.workspaceId,
      toWebTerminalSurfaceTabId(result.terminal),
      undefined,
      viewerSelection
    )
  }
}
