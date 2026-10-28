import { detectAgentStatusFromTitle } from '@/lib/agent-status'
import { useAppStore } from '@/store'
import type { AgentType } from '../../../../../shared/agent-status-types'
import { AGENT_INTERRUPT_SETTLE_MS } from '../../../../../shared/agent-interrupt-intent'
import { resolvePaneAgentOwner } from '../../../../../shared/pane-agent-owner'
import { titleAfterInferredInterrupt } from '../../../../../shared/terminal-pane-title-reset'
import { MANUAL_AGENT_COMMAND_MAX_CHARS } from './pty-connect-limits'
import type { createTerminalOwnerPolicy } from './terminal-owner-policy'
import type { PtyPaneStartup } from '../pty-connection-types'

export function createTerminalShellInputPolicy(services: {
  paneKey: string
  tabId: string
  worktreeId: string
  startup: PtyPaneStartup
  owner: ReturnType<typeof createTerminalOwnerPolicy>
  readTitle: () => string | null
  showTitle: (title: string) => void
  neutralTerminalTitle: () => string
  requestKnownWindowsShiftEnterReconfirmation: () => void
}) {
  const observeAcceptedShellCommandInput = (data: string): void => {
    if (
      data.includes('\r') ||
      data.includes('\n') ||
      data.includes('\x03') ||
      data.includes('\x04')
    ) {
      // Why: shells without OSC 133 give no command/exit boundary. An accepted
      // submit or interrupt revokes stale trusted Shift+Enter routing and confirms once.
      services.requestKnownWindowsShiftEnterReconfirmation()
    }
    if (services.owner.commandInferredPaneAgent) {
      return
    }
    // Why: bytes typed inside a live agent TUI are prompt text, not shell
    // commands, even if they spell another agent binary name.
    if (services.owner.hasFreshPaneAgentSurface()) {
      services.owner.resetPendingShellCommandLine()
      return
    }
    if (services.owner.shellCommandInferenceSuspendedUntilCommandEnd) {
      if (data.includes('\x03') || data.includes('\x15')) {
        services.owner.shellCommandInferenceSuspendedUntilCommandEnd = false
        services.owner.resetPendingShellCommandLine()
      }
      if (data.includes('\r') || data.includes('\n')) {
        services.owner.shellCommandInferenceSuspendedUntilCommandEnd = false
      }
      return
    }
    if (data.length > MANUAL_AGENT_COMMAND_MAX_CHARS) {
      services.owner.resetPendingShellCommandLine()
      services.owner.shellCommandInferenceSuspendedUntilCommandEnd =
        !data.includes('\r') && !data.includes('\n')
      return
    }
    for (let index = 0; index < data.length; index += 1) {
      const char = data[index]!
      if (char === '\r' || char === '\n') {
        services.owner.shellCommandInferenceSuspendedUntilCommandEnd = false
        services.owner.rememberCommandInferredPaneAgent()
        if (services.owner.commandInferredPaneAgent) {
          return
        }
        continue
      }
      if (char === '\x7f' || char === '\b') {
        services.owner.deletePendingShellCommandCharacter()
        continue
      }
      if (char === '\x17') {
        services.owner.deletePendingShellCommandWord()
        continue
      }
      if (char === '\x03' || char === '\x15') {
        services.owner.resetPendingShellCommandLine()
        continue
      }
      if (char === '\x1b') {
        const nextIndex = services.owner.consumeShellCommandCsiSequence(data, index)
        if (nextIndex !== null) {
          index = nextIndex - 1
          continue
        }
        services.owner.resetPendingShellCommandLine()
        continue
      }
      if (char < ' ') {
        services.owner.resetPendingShellCommandLine()
        continue
      }
      if (char >= ' ') {
        services.owner.appendPendingShellCommandInput(char)
        if (services.owner.shellCommandInferenceSuspendedUntilCommandEnd) {
          return
        }
      }
    }
  }
  /**
   * Resolves the authoritative owner agent type for this pane, checking tab launch,
   * pane startup, typed command ownership, and store state configuration.
   *
   * Why: launch ownership wins so Pi-compatible live titles/hooks can't repaint an
   * OMP-owned pane back to Pi; command ownership covers manually typed `omp`
   * in generic terminals where launch metadata does not exist.
   */
  const getAuthoritativePaneAgent = (): AgentType | undefined => {
    const state = useAppStore.getState()
    const tab = (state.tabsByWorktree[services.worktreeId] ?? []).find(
      (entry) => entry.id === services.tabId
    )
    return (
      resolvePaneAgentOwner({
        launchAgent: tab?.launchAgent,
        startupLaunchAgent: services.startup?.launchAgent,
        initialStatusAgent: services.startup?.initialAgentStatus?.agent,
        commandInferredAgent: services.owner.commandInferredPaneAgent,
        hookAgent: state.agentStatusByPaneKey[services.paneKey]?.agentType
      }) ?? undefined
    )
  }
  // Why: the renderer veto (owner evidence beating a Gemini-looking title) must
  // use only pane-scoped, CURRENT ownership. getAuthoritativePaneAgent leads
  // with the tab-shared `tab.launchAgent` and a never-cleared
  // `paneStartup.launchAgent`, which would let a sibling split pane or a reused
  // pane keep WebGL for a genuine Gemini terminal (#7428 regression class).
  // Launch identity is excluded, and the never-clearing startup seed
  // (`paneStartup.initialAgentStatus`) too; a stale or `done` explicit row is
  // ignored via the freshness predicate so a reused pane cannot inherit a prior
  // agent's veto. Only live foreground command inference and a fresh, active
  // hook row count. A genuine OMP/Pi pane stays protected owner-independently by
  // the isPiAgentTitle guard inside isGeminiTerminalTitle.
  const getPaneScopedRendererOwner = (): AgentType | undefined => {
    const entry = useAppStore.getState().agentStatusByPaneKey[services.paneKey]
    return (
      services.owner.commandInferredPaneAgent ??
      (services.owner.isFreshActivePaneAgentEntry(entry) ? entry.agentType : undefined)
    )
  }
  const clearInferredInterruptWorkingTitle = (): void => {
    const state = useAppStore.getState()
    const currentTitle = services.readTitle()
    const statusTitle = state.agentStatusByPaneKey[services.paneKey]?.terminalTitle
    const neutralTitle = titleAfterInferredInterrupt(
      currentTitle ?? statusTitle,
      services.neutralTerminalTitle()
    )
    if (neutralTitle === null) {
      return
    }
    // Why: inferred interrupts update the explicit hook row, but many CLIs leave
    // their OSC title stuck on a working spinner. Replace only this fallback
    // title signal with a neutral terminal label so the existing process tracker
    // can still decide whether an agent TUI is truly alive.
    services.showTitle(neutralTitle)
  }
  let titleOnlyInterruptTimer: ReturnType<typeof setTimeout> | null = null
  const clearTitleOnlyInterruptTimer = (): void => {
    if (titleOnlyInterruptTimer !== null) {
      clearTimeout(titleOnlyInterruptTimer)
      titleOnlyInterruptTimer = null
    }
  }
  const observeTitleOnlyInterrupt = (): void => {
    const state = useAppStore.getState()
    if (state.agentStatusByPaneKey[services.paneKey]) {
      return
    }
    const runtimeTitle = services.readTitle()
    const tabTitle = (state.tabsByWorktree[services.worktreeId] ?? []).find(
      (entry) => entry.id === services.tabId
    )?.title
    const baselineTitle = runtimeTitle ?? tabTitle
    if (detectAgentStatusFromTitle(baselineTitle ?? '') !== 'working') {
      return
    }
    clearTitleOnlyInterruptTimer()
    titleOnlyInterruptTimer = setTimeout(() => {
      titleOnlyInterruptTimer = null
      if (useAppStore.getState().agentStatusByPaneKey[services.paneKey]) {
        return
      }
      const currentState = useAppStore.getState()
      const currentRuntimeTitle = services.readTitle()
      const currentTabTitle = (currentState.tabsByWorktree[services.worktreeId] ?? []).find(
        (entry) => entry.id === services.tabId
      )?.title
      const currentTitle = currentRuntimeTitle ?? currentTabTitle
      if (
        currentTitle === baselineTitle &&
        detectAgentStatusFromTitle(currentTitle ?? '') === 'working'
      ) {
        // Why: title-only agents such as Pi can miss their own idle title after
        // Ctrl+C. Clear only an unchanged, acknowledged working title.
        clearInferredInterruptWorkingTitle()
      }
    }, AGENT_INTERRUPT_SETTLE_MS)
  }
  return {
    observeAcceptedShellCommandInput,
    getAuthoritativePaneAgent,
    getPaneScopedRendererOwner,
    clearInferredInterruptWorkingTitle,
    clearTitleOnlyInterruptTimer,
    observeTitleOnlyInterrupt
  }
}
