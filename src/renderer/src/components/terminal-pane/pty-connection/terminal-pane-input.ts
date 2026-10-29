import { useAppStore } from '@/store'
import { createAgentQuestionAnsweredInference } from '../agent-question-answered-inference'
import { isPassiveTerminalInputReport } from '../terminal-passive-input-report'
import { markTerminalBracketedPasteInterrupted } from '../terminal-bracketed-paste'
import { dismissRetainedProgramResult } from '@/lib/program-status/result-retention'
import type { AgentInterruptInputIntent } from '../../../../../shared/agent-interrupt-intent'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'

/** Key intent and immediate pane effects exist before any execution is known. */
export function installTerminalPaneInput(session: ConnectPanePtySession): void {
  let intent: AgentInterruptInputIntent | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  session.clearPendingTerminalInputIntent = () => {
    intent = null
    clearTimeout(timer)
    timer = undefined
  }
  session.setPendingTerminalInputIntent = (value: AgentInterruptInputIntent) => {
    session.clearPendingTerminalInputIntent()
    intent = value
    timer = setTimeout(session.clearPendingTerminalInputIntent, 0)
  }
  session.pendingTerminalInputIntentFor = (data: string) =>
    isPassiveTerminalInputReport(data) ? null : intent
  session.inferIntentFromExactTerminalInput = (data: string) =>
    data === '\x03' ? 'ctrl-c' : data === '\x1b' ? 'plain-escape' : null
  const paneKey = session.cacheKey
  const terminal = session.pane.terminal
  session.observePaneInputEffects = (data: string, baseline: AgentStatusEntry | null) => {
    if (data === '\x03') {
      markTerminalBracketedPasteInterrupted(terminal)
    }
    if ((useAppStore.getState().agentStatusByPaneKey[paneKey] ?? null) !== baseline) {
      return
    }
    const question = createAgentQuestionAnsweredInference({
      paneKey,
      getStatusEntry: () => baseline ?? undefined,
      inferQuestionAnswered: (request) =>
        window.api.agentStatus.inferQuestionAnswered(request).catch((error) => {
          console.warn('[agent-question] inferQuestionAnswered failed:', error)
          return false
        })
    })
    question.observeSentTerminalInput(data)
    if (!isPassiveTerminalInputReport(data)) {
      dismissRetainedProgramResult(paneKey, useAppStore.getState())
    }
  }
}
