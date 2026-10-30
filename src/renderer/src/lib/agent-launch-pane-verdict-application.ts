import { endViewerSelectionForDestination } from './viewer-selection-request'
import { applyOrdinaryAgentLaunchPaneVerdict } from './agent-launch-pane-ordinary-verdict'
import { launchTabWithdrawalIdentity } from '../../../shared/agent-launch-tab-publication'
import type { AgentLaunchPaneVerdictEvent } from '../../../shared/agent-launch-pane-verdict'
import { createKeptWorktreeSurfacePruners } from '@/store/slices/tabs/kept-worktree-surface-pruning'
import { useAppStore } from '@/store'
import { forgetAgentLaunchPanePrompt } from './agent-launch-pane-prompt'
import {
  agentLaunchPaneAttemptCurrent,
  confirmAgentLaunchPaneAttempt,
  settleAgentLaunchPaneStart
} from './agent-launch-pane-start'
import {
  applyVerdictToUndrawnLaunchTab,
  releaseMainWrittenLaunchTab
} from './agent-launch-tab-main-written'

/** Apply main’s typed spawn/takeback verdicts, retaining final pane outcomes until session cleanup. */

export function applyAgentLaunchPaneVerdict(event: AgentLaunchPaneVerdictEvent): boolean {
  if (event.accepted) {
    confirmAgentLaunchPaneAttempt(event.tabId, event.leafId, event.operationId)
    return true
  }
  if (event.withdrawalRoot === undefined) {
    const applied = applyOrdinaryAgentLaunchPaneVerdict(event)
    if (applied && (event.verdict.kind === 'withdrawn' || event.verdict.kind === 'not-started')) {
      endViewerSelectionForDestination(event.worktreeId, event.tabId)
    }
    return applied
  }
  const { worktreeId, tabId, leafId, verdict } = event
  // Commit the state verdict first; never call ordinary Close on a launch's provisional pane.
  let accepted = false
  let withdrawn = false
  useAppStore.setState((state) => {
    if (!agentLaunchPaneAttemptCurrent(tabId, leafId, event.operationId)) {
      return state
    }
    const tab = state.tabsByWorktree[worktreeId]?.find((candidate) => candidate.id === tabId)
    if (!tab) {
      accepted = applyVerdictToUndrawnLaunchTab(event)
      return state
    }
    if (
      tab.agentLaunchPane?.leafId !== leafId ||
      tab.agentLaunchPane.operationId !== event.operationId
    ) {
      return state
    }
    if (verdict.kind === 'withdrawn') {
      const root = state.terminalLayoutsByTabId[tabId]?.root
      if (
        (event.withdrawalRoot !== undefined &&
          event.withdrawalRoot !==
            launchTabWithdrawalIdentity(
              root,
              state.unifiedTabsByWorktree[worktreeId] ?? [],
              state.groupsByWorktree[worktreeId] ?? [],
              tabId
            )) ||
        root?.type !== 'leaf' ||
        root.leafId !== leafId ||
        state.ptyIdsByTabId[tabId]?.length ||
        state.lastTerminalInputAtByPaneKey[`${tabId}:${leafId}`]
      ) {
        return state
      }
      const prune = createKeptWorktreeSurfacePruners(state, {
        worktreeIds: new Set([worktreeId]),
        terminalTabIds: new Set([tabId]),
        unifiedTabIds: new Set(),
        fileIds: new Set(),
        browserTabIds: new Set()
      })
      accepted = withdrawn = true
      endViewerSelectionForDestination(worktreeId, tabId)
      const layouts = { ...state.terminalLayoutsByTabId }
      delete layouts[tabId]
      return {
        tabsByWorktree: prune.tabs(state.tabsByWorktree),
        unifiedTabsByWorktree: prune.unifiedTabs(state.unifiedTabsByWorktree),
        groupsByWorktree: prune.groups(state.groupsByWorktree),
        tabBarOrderByWorktree: prune.tabBarOrder(state.tabBarOrderByWorktree),
        activeTabIdByWorktree: prune.activeTabIds(state.activeTabIdByWorktree),
        terminalLayoutsByTabId: layouts
      }
    }
    accepted = true
    return {
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [worktreeId]: state.tabsByWorktree[worktreeId].map((row) =>
          row !== tab
            ? row
            : {
                ...row,
                agentLaunchPane:
                  verdict.kind === 'proceed'
                    ? undefined
                    : { ...tab.agentLaunchPane!, outcome: verdict }
              }
        )
      }
    }
  })
  if (!accepted) {
    return false
  }
  if (verdict.kind !== 'proceed') {
    settleAgentLaunchPaneStart(tabId, leafId, null)
  }
  if (withdrawn || verdict.kind === 'proceed') {
    releaseMainWrittenLaunchTab(tabId)
    forgetAgentLaunchPanePrompt(tabId)
  }
  return true
}
