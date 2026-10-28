import { shouldSuppressTitleCompletionForFreshHook } from './terminal-title-completion-policy'
import { createShellCommandCsiCursor } from './shell-command-csi-cursor'
import { detectAgentStatusFromTitle, isClaudeAgent } from '@/lib/agent-status'
import { useAppStore } from '@/store'
import {
  isFreshNonDoneAgentStatus,
  type AgentStatusEntry,
  type AgentType
} from '../../../../../shared/agent-status-types'
import { registerAgentHookTerminalLifecycleHandler } from '../agent-hook-terminal-lifecycle'
import type { AgentCompletionStatusSnapshot } from '../agent-completion-coordinator-types'
import { resolveCompatibleAgentTypeForOwner } from '../../../../../shared/agent-title-owner'

import { recognizeAgentLaunchCommand } from '../../../../../shared/agent-command-line-intent'
import type { TerminalAgent } from '../../../../../shared/terminal-agent'
import { isTuiAgent } from '../../../../../shared/tui-agent-config'

import { MANUAL_AGENT_COMMAND_MAX_CHARS } from './pty-connect-limits'

export function createTerminalOwnerPolicy(services: {
  paneKey: string
  tabId: string
  worktreeId: string
  setCacheTimerStartedAt: (paneKey: string, startedAt: number | null) => void
  readTitle: () => string | null
  startAcceptedInferredCommand: (agent: TerminalAgent) => void
  setFocusReportSuppressionForAgentCompletion: (
    title: string | undefined,
    agent: AgentType | undefined
  ) => void
  queueAgentIdleTerminalModeReset: () => void
  clearFocusReportSuppression: () => void
}) {
  // Why: infer pane ownership from a manually typed agent command (e.g. `omp`) by
  // shadowing the shell's current command line, for generic terminals where no
  // launch metadata exists. Consumed by getAuthoritativePaneAgent below.
  let commandInferredPaneAgent: TerminalAgent | null = null
  let pendingShellCommandLine: string = ''
  let pendingShellCommandCursor: number = 0
  let commandInferredPaneAgentGeneration: number = 0
  let shellCommandInferenceSuspendedUntilCommandEnd: boolean = false
  const resetPendingShellCommandLine = (): void => {
    pendingShellCommandLine = ''
    pendingShellCommandCursor = 0
  }
  const rememberCommandInferredPaneAgent = (): void => {
    const commandLine = pendingShellCommandLine.trim()
    resetPendingShellCommandLine()
    const candidateAgent = commandLine
      ? (recognizeAgentLaunchCommand(commandLine)?.agent ?? null)
      : null
    const state = useAppStore.getState()
    const registeredLaunchAgent =
      state.agentLaunchConfigByPaneKey[services.paneKey]?.identity.agentType
    // Why: input inside a live TUI can spell another agent command; process or
    // pane-scoped launch ownership is stronger than typed shell inference.
    const hasStrongerAgentOwnership =
      Boolean(state.paneForegroundAgentByPaneKey[services.paneKey]?.agent) ||
      isTuiAgent(registeredLaunchAgent)
    const nextAgent = hasStrongerAgentOwnership ? null : candidateAgent
    commandInferredPaneAgent = nextAgent
    commandInferredPaneAgentGeneration += 1
    if (nextAgent) {
      services.startAcceptedInferredCommand(nextAgent)
    }
  }
  const clearCommandInferredPaneAgent = (): void => {
    commandInferredPaneAgent = null
    resetPendingShellCommandLine()
    commandInferredPaneAgentGeneration += 1
  }
  const clearCommandInferredPaneAgentAfterPtySideEffects = (): void => {
    const generation = commandInferredPaneAgentGeneration
    resetPendingShellCommandLine()
    queueMicrotask(() => {
      setTimeout(() => {
        if (commandInferredPaneAgentGeneration === generation) {
          clearCommandInferredPaneAgent()
        }
      }, 0)
    })
  }
  const appendPendingShellCommandInput = (text: string): void => {
    const available = MANUAL_AGENT_COMMAND_MAX_CHARS - pendingShellCommandLine.length
    if (available <= 0) {
      shellCommandInferenceSuspendedUntilCommandEnd = true
      return
    }
    const inserted = text.slice(0, available)
    pendingShellCommandLine =
      pendingShellCommandLine.slice(0, pendingShellCommandCursor) +
      inserted +
      pendingShellCommandLine.slice(pendingShellCommandCursor)
    pendingShellCommandCursor += inserted.length
    if (inserted.length < text.length) {
      shellCommandInferenceSuspendedUntilCommandEnd = true
    }
  }
  const deletePendingShellCommandWord = (): void => {
    const beforeCursor = pendingShellCommandLine.slice(0, pendingShellCommandCursor)
    const afterCursor = pendingShellCommandLine.slice(pendingShellCommandCursor)
    const nextBeforeCursor = beforeCursor.replace(/[^\S\r\n]*\S+[^\S\r\n]*$/, '')
    pendingShellCommandLine = nextBeforeCursor + afterCursor
    pendingShellCommandCursor = nextBeforeCursor.length
  }
  const cancelSuspendedShellCommandInference = (): void => {
    if (!shellCommandInferenceSuspendedUntilCommandEnd) {
      return
    }
    shellCommandInferenceSuspendedUntilCommandEnd = false
    resetPendingShellCommandLine()
  }
  const deletePendingShellCommandCharacter = (): void => {
    if (pendingShellCommandCursor === 0) {
      return
    }
    pendingShellCommandLine =
      pendingShellCommandLine.slice(0, pendingShellCommandCursor - 1) +
      pendingShellCommandLine.slice(pendingShellCommandCursor)
    pendingShellCommandCursor -= 1
  }
  const deletePendingShellCommandCharacterAtCursor = (): void => {
    if (pendingShellCommandCursor >= pendingShellCommandLine.length) {
      return
    }
    pendingShellCommandLine =
      pendingShellCommandLine.slice(0, pendingShellCommandCursor) +
      pendingShellCommandLine.slice(pendingShellCommandCursor + 1)
  }
  const movePendingShellCommandCursor = (delta: number): void => {
    pendingShellCommandCursor = Math.min(
      pendingShellCommandLine.length,
      Math.max(0, pendingShellCommandCursor + delta)
    )
  }
  const consumeShellCommandCsiSequence = createShellCommandCsiCursor({
    move: movePendingShellCommandCursor,
    set: (position) => {
      pendingShellCommandCursor = position
    },
    length: () => pendingShellCommandLine.length,
    deleteCharacter: deletePendingShellCommandCharacterAtCursor,
    reset: resetPendingShellCommandLine
  })
  const getLivePaneAgentTitle = (): string | null => {
    const state = useAppStore.getState()
    const runtimeTitle = services.readTitle()
    const tabTitle = (state.tabsByWorktree[services.worktreeId] ?? []).find(
      (entry) => entry.id === services.tabId
    )?.title
    return runtimeTitle ?? tabTitle ?? null
  }
  // Why: a pane-scoped explicit row only counts as current ownership evidence
  // when it is fresh and not already `done` — a stale or completed row is a
  // leftover from a prior agent that may no longer own the shell.
  const isFreshActivePaneAgentEntry = (
    entry: AgentStatusEntry | undefined
  ): entry is AgentStatusEntry => {
    return isFreshNonDoneAgentStatus(entry)
  }
  let pendingSuppressedTitleSideEffects: { title: string; agentType?: AgentType } | null = null
  const clearSuppressedTitleSideEffects = (): void => {
    pendingSuppressedTitleSideEffects = null
  }
  const applyAgentCompletionSideEffects = (
    title: string,
    agentType: AgentType | undefined
  ): void => {
    const settings = useAppStore.getState().settings
    if (
      (agentType === 'claude' || isClaudeAgent(title)) &&
      (settings === null || settings.promptCacheTimerEnabled)
    ) {
      services.setCacheTimerStartedAt(services.paneKey, Date.now())
    }
    services.setFocusReportSuppressionForAgentCompletion(title, agentType)
    services.queueAgentIdleTerminalModeReset()
  }
  const preserveSuppressedTitleSideEffects = (
    title: string,
    activeHookStatus: AgentStatusEntry
  ): void => {
    pendingSuppressedTitleSideEffects = {
      title,
      agentType: activeHookStatus.agentType
    }
    if (activeHookStatus.state === 'waiting' || activeHookStatus.state === 'blocked') {
      services.clearFocusReportSuppression()
      services.queueAgentIdleTerminalModeReset()
    }
  }
  const handleAgentHookTerminalLifecycle = (payload: AgentCompletionStatusSnapshot): void => {
    const pending = pendingSuppressedTitleSideEffects
    if (!pending) {
      return
    }
    const payloadAgentForPending = resolveCompatibleAgentTypeForOwner(
      payload.agentType,
      pending.agentType
    )
    const belongsToPendingAgent =
      !pending.agentType ||
      pending.agentType === 'unknown' ||
      !payload.agentType ||
      payload.agentType === 'unknown' ||
      payloadAgentForPending === pending.agentType
    if (!belongsToPendingAgent || payload.state === 'working') {
      clearSuppressedTitleSideEffects()
      return
    }
    if (payload.state === 'done') {
      applyAgentCompletionSideEffects(pending.title, payload.agentType ?? pending.agentType)
      clearSuppressedTitleSideEffects()
      return
    }
    if (payload.state === 'waiting' || payload.state === 'blocked') {
      services.clearFocusReportSuppression()
      services.queueAgentIdleTerminalModeReset()
    }
  }
  const unregisterAgentHookTerminalLifecycle = registerAgentHookTerminalLifecycleHandler(
    services.paneKey,
    handleAgentHookTerminalLifecycle
  )
  const hasFreshPaneAgentSurface = (): boolean => {
    const entry = useAppStore.getState().agentStatusByPaneKey[services.paneKey]
    if (isFreshActivePaneAgentEntry(entry)) {
      return true
    }
    const liveTitle = getLivePaneAgentTitle()
    return detectAgentStatusFromTitle(liveTitle ?? '') !== null
  }
  return {
    get commandInferredPaneAgent() {
      return commandInferredPaneAgent
    },
    set commandInferredPaneAgent(value: TerminalAgent | null) {
      commandInferredPaneAgent = value
    },
    get pendingShellCommandLine() {
      return pendingShellCommandLine
    },
    set pendingShellCommandLine(value: string) {
      pendingShellCommandLine = value
    },
    get pendingShellCommandCursor() {
      return pendingShellCommandCursor
    },
    set pendingShellCommandCursor(value: number) {
      pendingShellCommandCursor = value
    },
    get commandInferredPaneAgentGeneration() {
      return commandInferredPaneAgentGeneration
    },
    set commandInferredPaneAgentGeneration(value: number) {
      commandInferredPaneAgentGeneration = value
    },
    get shellCommandInferenceSuspendedUntilCommandEnd() {
      return shellCommandInferenceSuspendedUntilCommandEnd
    },
    set shellCommandInferenceSuspendedUntilCommandEnd(value: boolean) {
      shellCommandInferenceSuspendedUntilCommandEnd = value
    },
    resetPendingShellCommandLine,
    rememberCommandInferredPaneAgent,
    clearCommandInferredPaneAgent,
    clearCommandInferredPaneAgentAfterPtySideEffects,
    appendPendingShellCommandInput,
    deletePendingShellCommandWord,
    cancelSuspendedShellCommandInference,
    deletePendingShellCommandCharacter,
    deletePendingShellCommandCharacterAtCursor,
    movePendingShellCommandCursor,
    consumeShellCommandCsiSequence,
    getLivePaneAgentTitle,
    isFreshActivePaneAgentEntry,
    shouldSuppressTitleCompletionForFreshHook,
    get pendingSuppressedTitleSideEffects() {
      return pendingSuppressedTitleSideEffects
    },
    set pendingSuppressedTitleSideEffects(value: { title: string; agentType?: AgentType } | null) {
      pendingSuppressedTitleSideEffects = value
    },
    clearSuppressedTitleSideEffects,
    applyAgentCompletionSideEffects,
    preserveSuppressedTitleSideEffects,
    handleAgentHookTerminalLifecycle,
    unregisterAgentHookTerminalLifecycle,
    hasFreshPaneAgentSurface
  }
}
