/** Apply main’s typed spawn/takeback verdicts, retaining final pane outcomes until session cleanup. */

import type { AgentLaunchPaneVerdictEvent } from '../../../shared/agent-launch-pane-verdict'
import { applyClosedTerminalLeafNotice } from '@/components/terminal-pane/closed-terminal-leaf-notice'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import { useAppStore } from '@/store'
import { forgetAgentLaunchPanePrompt } from './agent-launch-pane-prompt'
import {
  agentLaunchPaneAttemptCurrent,
  settleAgentLaunchPaneStart
} from './agent-launch-pane-start'
import {
  applyVerdictToUndrawnLaunchTab,
  releaseMainWrittenLaunchTab
} from './agent-launch-tab-main-written'

export function applyOrdinaryAgentLaunchPaneVerdict(event: AgentLaunchPaneVerdictEvent): boolean {
  if (!agentLaunchPaneAttemptCurrent(event.tabId, event.leafId, event.operationId)) {
    return false
  }
  const { worktreeId, tabId, leafId, verdict } = event
  const state = useAppStore.getState()
  const tab = state.tabsByWorktree[worktreeId]?.find((candidate) => candidate.id === tabId)
  // A main-written tab this window does not draw yet keeps the verdict until it draws.
  if (!tab && applyVerdictToUndrawnLaunchTab(event)) {
    return true
  }
  // Only a pane its tab says a launch laid out: a verdict never touches anything else.
  if (
    tab?.agentLaunchPane?.leafId !== leafId ||
    tab.agentLaunchPane.operationId !== event.operationId
  ) {
    return false
  }
  if (verdict.kind !== 'proceed') {
    settleAgentLaunchPaneStart(tabId, leafId, null)
  }
  switch (verdict.kind) {
    case 'proceed':
      releaseMainWrittenLaunchTab(tabId)
      forgetAgentLaunchPanePrompt(tabId)
      state.setTabAgentLaunchPane(tabId, undefined)
      return true
    case 'not-started':
    case 'unconfirmed': {
      const root = state.terminalLayoutsByTabId[tabId]?.root
      if (root && !collectLeafIdsInOrder(root).includes(leafId)) {
        forgetAgentLaunchPanePrompt(tabId)
        state.setTabAgentLaunchPane(tabId, undefined)
        return true
      }
      state.setTabAgentLaunchPane(tabId, { ...tab.agentLaunchPane, outcome: verdict })
      return true
    }
    case 'withdrawn': {
      forgetAgentLaunchPanePrompt(tabId)
      if (releaseMainWrittenLaunchTab(tabId)) {
        state.setTabAgentLaunchPane(tabId, undefined)
        return true
      }
      // The pane alone when the user split the tab while it waited; their split stays.
      if (state.terminalLayoutsByTabId[tabId]?.root?.type === 'leaf') {
        state.closeTab(tabId, {
          reason: 'cleanup',
          recordInteraction: false,
          captureRecentlyClosed: false
        })
      } else {
        state.setTabAgentLaunchPane(tabId, undefined)
        applyClosedTerminalLeafNotice(tabId, leafId)
      }
    }
  }
  return true
}
