import { TerminalSnapshotConsumption } from '../../../../shared/terminal-snapshot-consumption'
import type { TerminalSideEffectBatch } from '../../../../shared/terminal-side-effect-facts'
import type {
  TerminalSnapshotEffect,
  TerminalTransientCurrent,
  TerminalTransientObservation
} from '../../../../shared/terminal-transient-observation'

export type TerminalResidentIdentity = {
  endpoint: string
  executionHost: string
  runtimeId: string | null
  ptyId: string
  incarnationId: string | null
}

export type TerminalResidentPolicy = {
  restoreCurrent: (current: TerminalTransientCurrent, first: boolean, complete?: boolean) => void
  applyEffect: (effect: TerminalSnapshotEffect, current: TerminalTransientCurrent) => void
  observePrLink: (url: string) => void
  dispose: () => void
}

/** An execution owns policy; a mounted terminal is only a replaceable presentation port. */
export class TerminalResident<Policy extends TerminalResidentPolicy> {
  private consumption = new TerminalSnapshotConsumption()
  readonly policy: Policy
  private ended = false

  constructor(
    private physicalIdentity: Readonly<TerminalResidentIdentity>,
    createPolicy: (resident: TerminalResident<Policy>) => Policy
  ) {
    this.policy = createPolicy(this)
  }

  get isLive(): boolean {
    return !this.ended
  }

  get identity(): Readonly<TerminalResidentIdentity> {
    return this.physicalIdentity
  }

  admitIdentity(identity: TerminalResidentIdentity): boolean {
    if (
      this.ended ||
      (this.identity.runtimeId !== null && this.identity.runtimeId !== identity.runtimeId) ||
      (this.identity.incarnationId !== null &&
        this.identity.incarnationId !== identity.incarnationId)
    ) {
      return false
    }
    if (
      this.identity.runtimeId !== identity.runtimeId ||
      this.identity.incarnationId !== identity.incarnationId
    ) {
      this.physicalIdentity = Object.freeze({ ...identity })
      this.consumption = new TerminalSnapshotConsumption()
    }
    return true
  }

  consume(batch: TerminalSideEffectBatch): void {
    if (this.ended || !batch.terminalState) {
      return
    }
    this.consumeSnapshot(batch.terminalState.snapshot)
  }

  consumeSnapshot(
    snapshot: TerminalTransientObservation,
    applyEffect = this.policy.applyEffect,
    complete = true
  ): void {
    if (this.ended) {
      return
    }
    const consumed = this.consumption.consume(snapshot)
    if (!consumed) {
      return
    }
    const current = snapshot.current
    for (const effect of consumed.effects) {
      applyEffect(effect, current)
    }
    for (const link of consumed.links) {
      this.policy.observePrLink(link.url)
    }
    this.policy.restoreCurrent(current, consumed.first, complete)
  }

  dispose(): void {
    if (this.ended) {
      return
    }
    this.ended = true
    this.policy.dispose()
  }
}

export class TerminalResidentRegistry<Policy extends TerminalResidentPolicy> {
  private readonly residents = new Map<string, TerminalResident<Policy>>()

  private key(
    identity: Pick<TerminalResidentIdentity, 'endpoint' | 'executionHost' | 'ptyId'>
  ): string {
    return JSON.stringify([identity.endpoint, identity.executionHost, identity.ptyId])
  }

  admit(
    identity: TerminalResidentIdentity,
    createPolicy: (resident: TerminalResident<Policy>) => Policy
  ): TerminalResident<Policy> {
    const key = this.key(identity)
    const existing = this.residents.get(key)
    if (existing?.admitIdentity(identity)) {
      return existing
    }
    existing?.dispose()
    const resident = new TerminalResident(Object.freeze({ ...identity }), createPolicy)
    this.residents.set(key, resident)
    return resident
  }

  retire(resident: TerminalResident<Policy>): void {
    if (this.residents.get(this.key(resident.identity)) !== resident) {
      return
    }
    this.residents.delete(this.key(resident.identity))
    resident.dispose()
  }

  dispose(): void {
    for (const resident of this.residents.values()) {
      resident.dispose()
    }
    this.residents.clear()
  }
}
