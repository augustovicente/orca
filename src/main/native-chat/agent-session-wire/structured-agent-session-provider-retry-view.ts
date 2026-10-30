import type { View, ProducerTransition } from './structured-agent-session-provider-retry-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionCurrentWorkJournal } from './structured-agent-session-current-work'

export const owners = new WeakMap<object, View>()
export const structuredAgentSessionProviderRetryPending = (
  journal: StructuredAgentSessionCurrentWorkJournal
): boolean => owners.get(journal)?.pending() ?? false
export const structuredAgentSessionProviderRetryStop = (journal: AgentSessionJournal) =>
  owners.get(journal)?.stop() ?? null
export const structuredAgentSessionProviderRetryCompletion = (journal: AgentSessionJournal) =>
  owners.get(journal)?.completion() ?? null
export const finishAbortedStructuredAgentSessionProviderRetry = (journal: AgentSessionJournal) =>
  owners.get(journal)?.finishAborted() ?? false
export const retireStructuredAgentSessionProviderRetry = (journal: AgentSessionJournal): boolean =>
  owners.get(journal)?.retire() ?? false
export function stageStructuredAgentSessionProviderTransition(
  journal: AgentSessionJournal,
  transition: ProducerTransition
): (() => void) | undefined {
  return owners.get(journal)?.stage(transition)
}
