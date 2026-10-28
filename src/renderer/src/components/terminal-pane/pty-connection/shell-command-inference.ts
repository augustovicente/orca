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
  // Why: post-parse veto callbacks must only judge the latest replay frame; a
  // newer frame bumps the generation so a stale callback stands down.
  session.reattachReplayPayloadSignalGeneration = 0
  session.rememberReattachPayloadAgentSignal = (
    data: string,
    opts: { fullScreenReplay: boolean }
  ): void => {
    session.reattachReplayPayloadSignalGeneration += 1
    // Why: ordinary scrollback can mention agent names. Treat replay bytes as
    // a live Cursor Agent signal only when they look like its restored screen.
    const signal = hasCursorAgentReattachPayloadScreenSignal(data)
    // Why: incremental (non-clearing) replay frames repaint only part of the
    // screen, so their bytes can only add evidence — a full-screen replay is
    // the authoritative repaint that may clear the flag.
    session.reattachReplayPayloadHasCursorAgentSignal = opts.fullScreenReplay
      ? signal
      : session.reattachReplayPayloadHasCursorAgentSignal || signal
  }
  session.isCursorAgentNativeTitle = (title: string): boolean => {
    return title.trim().toLowerCase() === CURSOR_AGENT_REATTACH_HEADER.toLowerCase()
  }
  session.hasLiveAgentReattachStatusOrTitleSignal = (): boolean => {
    // Why: launch ownership (tab.launchAgent) never decays after the agent
    // exits, so it must not count as liveness here — only live status, live
    // titles, and the replayed screen shape do.
    if (useAppStore.getState().agentStatusByPaneKey[session.cacheKey]) {
      return true
    }
    const title = session.getCurrentTerminalTitle() ?? ''
    // Why: broad token matching (getAgentLabel) fires on titles like
    // "ssh devin@host"; that surface is too loose to gate mode preservation
    // and PTY byte injection, so only exact/status titles count here.
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
