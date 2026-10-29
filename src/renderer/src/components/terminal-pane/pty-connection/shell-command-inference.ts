import { detectAgentStatusFromTitle } from '@/lib/agent-status'
import { useAppStore } from '@/store'

import {
  CURSOR_AGENT_REATTACH_HEADER,
  terminalOwnsDomFocus,
  hasCursorAgentReattachPayloadScreenSignal
} from './cursor-agent-reattach-screen'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installShellCommandInference(session: ConnectPanePtySession): void {
  session.clearReattachIdleAgentCursorResetTimer = (): void => {
    if (session.reattachIdleAgentCursorResetTimer !== null) {
      clearTimeout(session.reattachIdleAgentCursorResetTimer)
      session.reattachIdleAgentCursorResetTimer = null
    }
  }
  session.getCurrentTerminalTitle = (): string | null => {
    const state = useAppStore.getState()
    const runtimeTitle = state.runtimePaneTitlesByTabId?.[session.deps.tabId]?.[session.pane.id]
    const tabTitle = (state.tabsByWorktree[session.deps.worktreeId] ?? []).find(
      (entry) => entry.id === session.deps.tabId
    )?.title
    return runtimeTitle ?? tabTitle ?? null
  }
  session.reattachReplayPayloadHasCursorAgentSignal = false
  // Only the latest replay generation may judge post-parse agent-screen evidence.
  session.reattachReplayPayloadSignalGeneration = 0
  session.rememberReattachPayloadAgentSignal = (
    data: string,
    opts: { fullScreenReplay: boolean }
  ): void => {
    session.reattachReplayPayloadSignalGeneration += 1
    // Agent names in history are not liveness; require restored Cursor screen shape.
    const signal = hasCursorAgentReattachPayloadScreenSignal(data)
    // Incremental frames may add evidence; only authoritative full-screen repaint may clear it.
    session.reattachReplayPayloadHasCursorAgentSignal = opts.fullScreenReplay
      ? signal
      : session.reattachReplayPayloadHasCursorAgentSignal || signal
  }
  session.isCursorAgentNativeTitle = (title: string): boolean => {
    return title.trim().toLowerCase() === CURSOR_AGENT_REATTACH_HEADER.toLowerCase()
  }
  session.hasLiveAgentReattachStatusOrTitleSignal = (): boolean => {
    // Permanent tab launch metadata cannot prove liveness; require current status/title or restored screen shape.
    if (useAppStore.getState().agentStatusByPaneKey[session.cacheKey]) {
      return true
    }
    const title = session.getCurrentTerminalTitle() ?? ''
    // Loose label matching can classify ssh user names; mode preservation and input injection need exact/status titles.
    return detectAgentStatusFromTitle(title) !== null || session.isCursorAgentNativeTitle(title)
  }
  session.hasLiveAgentReattachSignal = (): boolean => {
    return (
      session.hasLiveAgentReattachStatusOrTitleSignal() ||
      session.reattachReplayPayloadHasCursorAgentSignal
    )
  }
  session.shouldPreserveAgentReattachModes = (): boolean => {
    // Why: ordinary shells can inherit stale ?25l/?1004h from replay bytes.
    // Preserve those modes only when reattach still looks agent-owned.
    return session.hasLiveAgentReattachSignal()
  }
  session.shouldSendFocusedAgentReattachFocusIn = (): boolean => {
    return terminalOwnsDomFocus(session.pane.terminal) && session.shouldPreserveAgentReattachModes()
  }
}
