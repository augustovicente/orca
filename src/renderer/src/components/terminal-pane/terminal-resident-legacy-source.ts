import { TerminalSnapshotObserver } from '../../../../shared/terminal-snapshot-observer'
import { TerminalSnapshotConsumption } from '../../../../shared/terminal-snapshot-consumption'
import type { TerminalSideEffectBatch } from '../../../../shared/terminal-side-effect-facts'
import type { TerminalResidentPolicy } from './terminal-resident-registry'
import type { PtyDataMeta } from './pty-dispatcher'
import type { TerminalResidentBinding } from './terminal-resident-policy'
import { readInFlightCommandCodeTurn } from './terminal-command-code-status-policy'

/** One parser and counter lifetime accepts whichever legacy delivery owns genuine output. */
export class TerminalResidentLegacySource {
  private readonly bytes: TerminalSnapshotObserver
  private readonly consumption = new TerminalSnapshotConsumption()
  private rawEndSeq = 0
  private lastLiveTitleSeq: number | null = null
  byteSource = false

  constructor(binding: TerminalResidentBinding, policy: TerminalResidentPolicy) {
    this.byteSource = binding.runtimeEnvironmentId != null
    this.bytes = new TerminalSnapshotObserver(
      (snapshot, delivery = 'bytes') => {
        const consumed = this.consumption.consume(snapshot)
        if (!consumed) {
          return
        }
        const ownsEffects = this.byteSource === (delivery === 'bytes')
        for (const effect of consumed.effects) {
          if (ownsEffects || (delivery === 'bytes' && effect.fact.kind === 'command-started')) {
            policy.applyEffect(effect, snapshot.current)
          }
        }
        if (!ownsEffects) {
          return
        }
        for (const link of consumed.links) {
          policy.observePrLink(link.url)
        }
        policy.restoreCurrent(snapshot.current, consumed.first, false)
      },
      {
        adopted: true,
        startupCommand: binding.startup?.command,
        initialTitle: binding.initialTitle,
        inFlightTurn: readInFlightCommandCodeTurn(binding.paneKey),
        publishEachFact: true
      }
    )
    const snapshot = this.bytes.snapshot()
    this.consumption.consume(snapshot)
  }

  observeData(data: string, meta?: PtyDataMeta): void {
    if (meta?.droppedOutput) {
      return
    }
    const end = meta?.seq ?? this.rawEndSeq + (meta?.rawLength ?? data.length)
    if (meta?.seq !== undefined && end <= this.rawEndSeq) {
      return
    }
    const rawLength = meta?.rawLength ?? data.length
    const overlap = this.rawEndSeq - (end - rawLength)
    if (overlap > 0 && !meta?.transformed && rawLength === data.length) {
      data = data.slice(overlap)
    }
    this.rawEndSeq = end
    this.bytes.observe(data, end)
  }

  observeFacts(batch: TerminalSideEffectBatch): void {
    if (
      this.byteSource ||
      (batch.replay && this.lastLiveTitleSeq !== null && batch.seq <= this.lastLiveTitleSeq)
    ) {
      return
    }
    for (const fact of batch.facts) {
      if (batch.replay && fact.kind !== 'title') {
        continue
      }
      if (!batch.replay && fact.kind === 'title') {
        this.lastLiveTitleSeq = batch.seq
      }
      this.bytes.observeFact(
        fact.kind === 'pr-link' ? { kind: 'pr-link', url: fact.link.url } : fact,
        batch.seq
      )
    }
  }

  dispose(): void {
    this.bytes.dispose()
  }
}
