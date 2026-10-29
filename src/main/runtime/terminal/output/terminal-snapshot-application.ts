import { TerminalSnapshotConsumption } from '../../../../shared/terminal-snapshot-consumption'
import { TerminalSnapshotState } from '../../../../shared/terminal-snapshot-state'
import { isAgentStatusHooksEnabledForAgent } from '../../../../shared/agent-status-hooks-setting'
import type { ProcessedAgentStatusChunk } from '../../../../shared/agent-status-osc'
import type { AgentStatus } from '../../../../shared/agent-detection'
import type { TerminalTransientFact } from '../../../../shared/terminal-transient-observation'
import { OrcaRuntimeWithScheduleWaitBlockedCheck } from '../wait/terminal-wait-blocked-checks'

import type { TerminalSideEffectFact } from '../../../../shared/terminal-side-effect-facts'

import type { TerminalTitleFactMeta } from '../../../../shared/terminal-output-side-effects'
import type { TerminalTransientObservation } from '../../../../shared/terminal-transient-observation'
import { parseTerminalGitHubPRUrl } from '../../../../shared/terminal-github-pr-link-detector'

export abstract class OrcaRuntimeWithTerminalSnapshotApplication extends OrcaRuntimeWithScheduleWaitBlockedCheck {
  protected abstract retirePtyAgentLaunchAuthorityOnConfirmedExit(ptyId: string): void
  protected abstract recheckHookAgentPresenceForPty(
    ptyId: string,
    exitedSince?: number
  ): Promise<'live' | 'unverifiable' | 'exited' | null>

  protected abstract applyTrackedPtyTitle(
    ptyId: string,
    raw: string,
    normalized: string,
    meta?: TerminalTitleFactMeta
  ): boolean
  protected abstract applyPtyProgramActivity(
    ptyId: string,
    activity: AgentStatus | null,
    observedAt?: number
  ): void
  protected abstract confirmPtyAgentExit(ptyId: string, recoverCompletedHook?: boolean): void
  protected abstract emitTerminalAgentStatusEvents(
    ptyId: string,
    chunk: Pick<ProcessedAgentStatusChunk, 'payloads'> & Partial<ProcessedAgentStatusChunk>,
    provenance?:
      | { origin: 'process'; yieldsToHookSince: number }
      | { renewsProgramStatusLease: true },
    recordsPromptLifecycle?: boolean,
    observedAt?: number
  ): void

  applyTerminalTransientObservation(
    ptyId: string,
    incarnationId: string,
    observation: TerminalTransientObservation
  ): void {
    const entry = this.getOrCreatePtyTitleTrackerEntry(ptyId)
    if (entry.transientIncarnationId !== incarnationId) {
      entry.transientIncarnationId = incarnationId
      entry.transientConsumption = new TerminalSnapshotConsumption()
      entry.sideEffectState = new TerminalSnapshotState()
      entry.sourceSnapshot = undefined
      this.openCodeRunLifetime.forgetPty(ptyId)
    }
    const consumed = entry.transientConsumption?.consume(observation)
    if (!consumed) {
      return
    }
    const previous = entry.sourceSnapshot
    entry.sourceSnapshot = observation
    entry.tracker.setTransientFactScanningSuppressed(true)
    entry.sideEffectState ??= new TerminalSnapshotState()
    const current = observation.current
    const policyTitle = entry.sideEffectState.state.current.title
    const policyActivity = entry.sideEffectState.state.current.activity
    const titleChanged =
      !previous || previous.current.title?.observedAt !== current.title?.observedAt
    const programActivity = current.program?.activity ?? null
    entry.applyingChunk = true
    try {
      for (const effect of consumed.effects) {
        this.applySnapshotFact(ptyId, effect.fact, effect)
      }
      for (const link of consumed.links) {
        this.applySnapshotFact(
          ptyId,
          { kind: 'pr-link', url: link.url },
          { observedAt: link.observedAt, commandOrdinal: current.commandOrdinal }
        )
      }
      // Historical effects must not leave the projection behind the source's current command.
      entry.sideEffectState.state.current = structuredClone(current)
      if (!previous || previous.revision !== observation.revision) {
        entry.sideEffectState.state.revision++
      }
      entry.sideEffectState.state.rawEndSeq = observation.rawEndSeq
      if (titleChanged || previous?.current.program?.activity !== programActivity) {
        entry.tracker.restoreCurrent(current.title?.rawTitle ?? null, programActivity)
      }
      if (current.title && titleChanged) {
        this.applyTrackedPtyTitle(
          ptyId,
          current.title.rawTitle,
          current.title.normalizedTitle,
          current.title
        )
        entry.lastTitle = { raw: current.title.rawTitle, normalized: current.title.normalizedTitle }
        if (!previous || previous.current.title?.observedAt !== current.title.observedAt) {
          entry.pendingFacts.push({ kind: 'title', ...current.title })
        }
      }
      if (!previous || previous.current.program?.activity !== programActivity) {
        this.applyPtyProgramActivity(ptyId, programActivity, current.program?.observedAt)
      }
      if (
        current.program &&
        (!previous || previous.current.program?.observedAt !== current.program.observedAt)
      ) {
        const program = current.program
        this.emitTerminalAgentStatusEvents(ptyId, {
          payloads: [],
          programStatusFacet: program.facet
        })
        if (consumed.first && program.payload) {
          this.applySnapshotFact(
            ptyId,
            {
              kind: 'agent-status',
              payload: program.payload,
              fromProgramStatus: true,
              removesProgramStatusRow: program.removesRow
            },
            { observedAt: program.observedAt, commandOrdinal: current.commandOrdinal }
          )
        }
      }
      if (consumed.first && current.inBandStatus) {
        this.applySnapshotFact(
          ptyId,
          { kind: 'agent-status', payload: current.inBandStatus.payload },
          { observedAt: current.inBandStatus.observedAt, commandOrdinal: current.commandOrdinal }
        )
      }
      if (current.mode2031 !== 'unknown' && previous?.current.mode2031 !== current.mode2031) {
        entry.pendingFacts.push({
          kind: current.mode2031 === 'subscribed' ? '2031-subscribe' : '2031-unsubscribe'
        })
      }
      entry.sideEffectState.state.current = structuredClone(current)
      if (!titleChanged) {
        entry.sideEffectState.state.current.title = policyTitle
        if (previous?.current.activity === current.activity) {
          entry.sideEffectState.state.current.activity = policyActivity
        }
      }
      if (consumed.first) {
        void this.recheckHookAgentPresenceForPty(ptyId)
      }
    } finally {
      entry.applyingChunk = false
      const facts = entry.pendingFacts.splice(0)
      this.emitTerminalSideEffectBatch(ptyId, facts)
    }
  }

  private applySnapshotFact(
    ptyId: string,
    fact: TerminalTransientFact,
    qualification?: { observedAt: number; commandOrdinal: number }
  ): void {
    switch (fact.kind) {
      case 'agent-status': {
        this.flushSnapshotFactsBeforeStatus(ptyId)
        const payload = fact.payload
        this.emitTerminalAgentStatusEvents(
          ptyId,
          {
            payloads: [payload],
            ...(fact.fromProgramStatus ? { programStatusPayloads: new Set([payload]) } : {}),
            ...(fact.removesProgramStatusRow
              ? { programStatusRowRemovals: new Set([payload]) }
              : {})
          },
          undefined,
          true,
          qualification?.observedAt
        )
        this.recordTerminalSideEffectFact(ptyId, { kind: 'agent-status', payload }, qualification)
        return
      }
      case 'opencode-status': {
        const entry = this.ptyTitleTrackersByPtyId.get(ptyId)
        if (entry?.sideEffectState) {
          entry.sideEffectState.record(
            fact,
            qualification?.observedAt,
            qualification?.commandOrdinal
          )
        }
        this.flushSnapshotFactsBeforeStatus(ptyId)
        if (
          isAgentStatusHooksEnabledForAgent(
            this.store?.getSettings?.(),
            fact.payload.agentType === 'opencode2' ? 'opencode2' : 'opencode'
          )
        ) {
          this.emitTerminalAgentStatusEvents(
            ptyId,
            { payloads: [fact.payload] },
            { origin: 'process', yieldsToHookSince: fact.startedAt },
            true,
            qualification?.observedAt
          )
        }
        return
      }
      case 'program-facet':
        this.emitTerminalAgentStatusEvents(ptyId, { payloads: [], programStatusFacet: fact.facet })
        return
      case 'title':
        this.applyTrackedPtyTitle(ptyId, fact.rawTitle, fact.normalizedTitle, fact)
        this.recordTerminalSideEffectFact(ptyId, fact, qualification)
        return
      case 'agent-exited':
        this.confirmPtyAgentExit(ptyId)
        return
      case 'pr-link': {
        const link = parseTerminalGitHubPRUrl(fact.url)
        if (link) {
          this.recordTerminalSideEffectFact(ptyId, { kind: 'pr-link', link }, qualification)
        }
        return
      }
      case 'command-started':
        this.recordTerminalSideEffectFact(ptyId, fact, qualification)
        return
      case 'command-finished':
        if (
          !qualification ||
          qualification.commandOrdinal ===
            this.ptyTitleTrackersByPtyId.get(ptyId)?.sourceSnapshot?.current.commandOrdinal
        ) {
          this.retirePtyAgentLaunchAuthorityOnConfirmedExit(ptyId)
        }
        this.recordTerminalSideEffectFact(ptyId, fact, qualification)
        return
      default:
        this.recordTerminalSideEffectFact(ptyId, fact, qualification)
    }
  }

  private flushSnapshotFactsBeforeStatus(ptyId: string): void {
    const entry = this.ptyTitleTrackersByPtyId.get(ptyId)
    if (!entry?.sideEffectState || entry.pendingFacts.length === 0) {
      return
    }
    // Preserve command/status delivery order while the snapshot always names the final source command.
    if (entry.sourceSnapshot) {
      entry.sideEffectState.state.current = structuredClone(entry.sourceSnapshot.current)
    }
    this.emitTerminalSideEffectBatch(ptyId, entry.pendingFacts.splice(0))
  }

  protected abstract recordTerminalSideEffectFact(
    ptyId: string,
    fact: TerminalSideEffectFact,
    qualification?: { observedAt: number; commandOrdinal: number }
  ): void
  protected abstract emitTerminalSideEffectBatch(
    ptyId: string,
    facts: TerminalSideEffectFact[]
  ): void
}
