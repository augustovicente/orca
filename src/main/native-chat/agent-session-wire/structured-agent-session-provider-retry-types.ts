import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import type { AgentSessionTransientFailure } from '../../../shared/agent-session-provider-retry-policy'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionTransition } from './structured-agent-session-transition'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

export type CurrentResult = {
  itemId: string
  turnId: string
  sequence: number
  role: 'predecessor' | 'execution'
  state: 'running' | 'ended'
  category?: AgentSessionTransientFailure
}
export type ProducerTransition = Pick<
  StructuredAgentSessionTransition,
  'turnLifecycle' | 'transientTerminal'
>
export type ProviderRetryCompletion = { owner: object; itemId: string }
export type ProviderRetryDisposition = 'consume' | 'release' | 'abandon'
export type View = {
  completion: () => ProviderRetryCompletion | null
  finishAborted: () => boolean
  pending: () => boolean
  stop: () => { turnId: string; written: boolean } | null
  retire: () => boolean
  stage: (transition: ProducerTransition) => () => void
}
export type Retry = {
  journal: AgentSessionJournal
  epoch: string
  fence: number
  child: NonNullable<StructuredAgentSessionHostSession['child']>
  currentResult?: CurrentResult
  offered?: { itemId: string; category?: AgentSessionTransientFailure; state?: 'start' | 'end' }
  options?: AgentSessionExecutionOptions
  attempt: number
  phase: 'candidate' | 'waiting' | 'starting' | 'running' | 'settled'
  startedTurnRef?: string
  written: boolean
  timer?: ReturnType<typeof setTimeout>
  abort: AbortController
}
export type ContinueInput = Parameters<
  NonNullable<StructuredAgentSessionAdapter['continueAfterTransientFailure']>
>[0]
