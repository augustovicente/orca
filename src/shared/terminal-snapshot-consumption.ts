import {
  terminalEffectKeys,
  type TerminalTransientObservation,
  type TerminalSnapshotEffect
} from './terminal-transient-observation'

export class TerminalSnapshotConsumption {
  private previous: TerminalTransientObservation | null = null
  consume(snapshot: TerminalTransientObservation): {
    effects: TerminalSnapshotEffect[]
    links: TerminalTransientObservation['recentPrLinks']
    first: boolean
  } | null {
    const previous = this.previous
    if (previous && snapshot.revision < previous.revision) {
      return null
    }
    this.previous = snapshot
    const effects: TerminalSnapshotEffect[] = []
    if (previous) {
      for (const key of terminalEffectKeys) {
        const effect = snapshot.effects[key]
        if (effect && effect.count > (previous.effects[key]?.count ?? 0)) {
          effects.push(effect)
        }
      }
    }
    const previousLinkOrder = Math.max(
      0,
      ...(previous?.recentPrLinks.map((link) => link.order) ?? [])
    )
    return {
      effects: effects.sort((a, b) => a.order - b.order),
      links: previous
        ? snapshot.recentPrLinks.filter((link) => link.order > previousLinkOrder)
        : [],
      first: !previous
    }
  }
}
