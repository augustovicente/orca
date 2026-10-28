import type { TerminalSemanticResident } from './terminal-semantic-residents'
import type {
  TerminalSideEffectBatch,
  TerminalSideEffectFact
} from '../../../../shared/terminal-side-effect-facts'
import type { AgentIdleEdgeMeta } from '../../../../shared/terminal-output-side-effects'
import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
import type { TerminalGitHubPRLink } from '../../../../shared/terminal-github-pr-link-detector'

import type { createTerminalResidentPolicy } from './terminal-resident-policy'

import type { TerminalResidentBinding, TerminalResidentServices } from './terminal-resident-policy'

export type TerminalSideEffectFactConsumerCallbacks = {
  onAgentStatus?: (payload: ParsedAgentStatusPayload) => void
  /** `meta.staleWorkingTitleClear` marks facts derived from main's 3s
   *  stale-title timer — policy must clear title/cache state without
   *  scheduling task-complete notifications or unread attention. */
  onTitleChange?: (
    normalizedTitle: string,
    rawTitle: string,
    meta?: { staleWorkingTitleClear?: boolean }
  ) => void
  onBell?: () => void
  onAgentBecameIdle?: (title: string, meta?: AgentIdleEdgeMeta) => void
  onAgentBecameWorking?: () => void
  onAgentExited?: () => void
  /** OSC 133;D — same policy hook the byte-mode commandLifecycle drove
   *  (stale agent-status row drop + interrupt-inference coordination). */
  onCommandFinished?: (bestEffortExitCode: number | null) => void
  onCommandStarted?: () => void
  onPrLink?: (link: TerminalGitHubPRLink) => void
  /** Command Code output scrape (no hooks): working seeds the status row;
   *  done is settle-checked by the pane policy before completing the turn. */
  onCommandCodeWorking?: (prompt: string) => void
  onCommandCodeDone?: (prompt: string) => void
  /** DECSET 2031 subscribe observed by main's tracker. Registered only by
   *  hidden-delivery-gated consumers (their bytes never arrive); it records the
   *  subscription for later theme-flip pushes, it does not answer. */
  onMode2031Subscribe?: () => void
  /** DECSET 2031 withdrawal observed by main's tracker. Clears the pane's
   *  subscription registry so later theme flips stop pushing CSI 997. */
  onMode2031Unsubscribe?: () => void
}

export type ConsumerEntry = {
  binding?: TerminalResidentBinding
  services?: TerminalResidentServices
  policy?: ReturnType<typeof createTerminalResidentPolicy>
  callbacks: TerminalSideEffectFactConsumerCallbacks
  onResident?: (resident: TerminalSemanticResident) => () => void
  detachPresentation?: () => void
  resident?: TerminalSemanticResident
  /** Output sequence of the last live title fact applied. Replay snapshots at
   *  or before this point are stale and must not regress the title state. */
  lastLiveTitleSeq: number | null
}

function applyLiveFact(entry: ConsumerEntry, fact: TerminalSideEffectFact, seq: number): void {
  switch (fact.kind) {
    case 'agent-status':
      entry.callbacks.onAgentStatus?.(fact.payload)
      return
    case 'title':
      entry.lastLiveTitleSeq = seq
      entry.callbacks.onTitleChange?.(
        fact.normalizedTitle,
        fact.rawTitle,
        fact.staleWorkingTitleClear ? { staleWorkingTitleClear: true } : undefined
      )
      return
    case 'bell':
      entry.callbacks.onBell?.()
      return
    case 'agent-working':
      entry.callbacks.onAgentBecameWorking?.()
      return
    case 'agent-idle':
      entry.callbacks.onAgentBecameIdle?.(fact.title, {
        ...(fact.status ? { status: fact.status } : {}),
        ...(fact.staleWorkingTitleClear ? { staleWorkingTitleClear: true } : {})
      })
      return
    case 'agent-exited':
      entry.callbacks.onAgentExited?.()
      return
    case 'command-started':
      entry.callbacks.onCommandStarted?.()
      return
    case 'command-finished':
      entry.callbacks.onCommandFinished?.(fact.exitCode)
      return
    case 'pr-link':
      entry.callbacks.onPrLink?.(fact.link)
      return
    case 'command-code-working':
      entry.callbacks.onCommandCodeWorking?.(fact.prompt)
      return
    case 'command-code-done':
      entry.callbacks.onCommandCodeDone?.(fact.prompt)
      return
    case '2031-subscribe':
      entry.callbacks.onMode2031Subscribe?.()
      return
    case '2031-unsubscribe':
      entry.callbacks.onMode2031Unsubscribe?.()
  }
}

export function applyBatchToConsumer(entry: ConsumerEntry, batch: TerminalSideEffectBatch): void {
  if (batch.replay) {
    // Why: the no-attention-replay rule — (re)attach snapshots restore title
    // state only; historical bells/completions must never fire again. A replay
    // older (by output sequence) than the last live title fact is stale.
    if (entry.lastLiveTitleSeq !== null && batch.seq <= entry.lastLiveTitleSeq) {
      return
    }
    for (const fact of batch.facts) {
      if (fact.kind === 'title') {
        entry.callbacks.onTitleChange?.(fact.normalizedTitle, fact.rawTitle)
      }
    }
    return
  }
  for (const fact of batch.facts) {
    applyLiveFact(entry, fact, batch.seq)
  }
}

export type TerminalSideEffectFactConsumerOptions = {
  ptyId: string
  binding?: TerminalResidentBinding
  services?: TerminalResidentServices
  policy?: ReturnType<typeof createTerminalResidentPolicy>
  callbacks: TerminalSideEffectFactConsumerCallbacks
  /** Pull main's title-only replay snapshot on registration. Pane transports
   *  use this in place of deriving titles from eager-buffer byte replay.
   *  Ordinary parked watchers already have a current pane title; cold-started
   *  watchers request it because no pane populated their slot. */
  restoreTitleOnRegister?: boolean
  onResident?: (resident: TerminalSemanticResident) => () => void
}

export function attachResidentConsumer(
  entry: ConsumerEntry,
  resident: TerminalSemanticResident
): void {
  if (!entry.onResident || entry.resident === resident) {
    return
  }
  entry.detachPresentation?.()
  entry.resident = resident
  entry.detachPresentation = entry.onResident(resident)
  entry.callbacks = {
    ...resident.policy.callbacks,
    onPrLink: (link) => resident.policy.observePrLink(link.url)
  }
}
