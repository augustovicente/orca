import type { View, ProducerTransition } from './structured-agent-session-provider-retry-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export const owners = new WeakMap<object, View>()
export const structuredAgentSessionProviderRetryPending = (journal: object): boolean =>
  owners.get(journal)?.pending() ?? false
export const structuredAgentSessionProviderRetryStop = (journal: object) =>
  owners.get(journal)?.stop() ?? null
export const structuredAgentSessionProviderRetryCompletion = (journal: object) =>
  owners.get(journal)?.completion() ?? null
export const finishAbortedStructuredAgentSessionProviderRetry = (journal: object) =>
  owners.get(journal)?.finishAborted() ?? false
export const retireStructuredAgentSessionProviderRetry = (journal: object): boolean =>
  owners.get(journal)?.retire() ?? false
export function stageStructuredAgentSessionProviderTransition(
  journal: AgentSessionJournal,
  transition: ProducerTransition
): (() => void) | undefined {
  return owners.get(journal)?.stage(transition)
}
