import { agentSessionHostStatusBody } from '../../shared/agent-session-host-status-rows'
import type { AgentJournalPlainStatusItem } from '../../shared/agent-session-journal-types'

export function acpHistoryBoundary(): AgentJournalPlainStatusItem | null {
  // Pending product decision: keep this neutral body or return null for no extra line.
  return agentSessionHostStatusBody('history-loaded')
}
