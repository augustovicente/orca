import { isDeepStrictEqual } from 'node:util'
import type Database from '../../sqlite/sync-database'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import type { JournalWriteQueue } from './journal-write-queue'
import { isolateJournalTransition } from './journal-reducer-transition'
import { writeJournalProjection } from './journal-projection-table'
import { encodeJournalState } from './journal-state-codec'
import { restoreJournal } from './journal-open'
import {
  logJournalProjectionFailure,
  saveJournalState,
  unrefJournalProjectionTimer
} from './journal-saved-state'

export class JournalWriteProjection {
  private through = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(
    private readonly deps: {
      database: JournalHostDatabase
      state: () => JournalReducerState
      adopt: (state: JournalReducerState) => void
      queue: JournalWriteQueue
    }
  ) {}

  opened(through: number): void {
    this.through = through
    this.schedule()
  }

  /** The callback is invoked only after the outer transaction has committed. */
  prepare(db: Database.Database, rows: readonly JournalRow[], savedAt: number): () => void {
    const live = this.deps.state()
    const transition = isolateJournalTransition(live, rows, savedAt)
    const projected =
      this.through === live.lastSequence && this.through > 0 ? this.write(db, transition) : false
    return () => {
      this.deps.adopt(transition.adopt())
      if (projected) this.through = this.deps.state().lastSequence
      this.schedule()
      if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
        this.assertEquivalent()
      }
    }
  }

  repair = (): Promise<void> =>
    this.deps.queue
      .serialize(() => {
        const state = this.deps.state()
        if (this.through === state.lastSequence) return
        // Capture on this lane, after admitted recovery writes; publication rechecks the epoch.
        if (saveJournalState(this.deps.database, state, true)) this.through = state.lastSequence
        this.schedule(60_000)
      })
      .catch((error) => {
        logJournalProjectionFailure(this.deps.state().sessionId, error)
        this.schedule(60_000)
      })

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(delay = 1_000): void {
    if (this.closed || this.timer || this.through === this.deps.state().lastSequence) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.repair()
    }, delay)
    unrefJournalProjectionTimer(this.timer)
  }

  private write(
    db: Database.Database,
    transition: ReturnType<typeof isolateJournalTransition>
  ): boolean {
    db.exec('SAVEPOINT journal_projection')
    try {
      writeJournalProjection(db, transition.state, transition.changes())
    } catch (error) {
      // Only statement-local failures can preserve the append. An aborted outer transaction cannot.
      if (!db.isTransaction) throw error
      db.exec('ROLLBACK TO journal_projection')
      db.exec('RELEASE journal_projection')
      if (!db.isTransaction) throw error
      logJournalProjectionFailure(transition.state.sessionId, error)
      return false
    }
    db.exec('RELEASE journal_projection')
    return true
  }

  private assertEquivalent(): void {
    const live = this.deps.state()
    const loaded = restoreJournal(this.deps.database.db, live.sessionId)
    if (
      !loaded ||
      loaded.damage ||
      loaded.newer ||
      !isDeepStrictEqual(encodeJournalState(loaded.state), encodeJournalState(live))
    ) {
      throw new Error('journal projection and contiguous tail differ from live state')
    }
  }
}
