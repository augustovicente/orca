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
  unrefJournalProjectionTimer,
  writeJournalProjectionSavepoint
} from './journal-saved-state'

// Each failed publication or savepoint quadruples the wait, so a full disk never rewrites a whole
// chat on a short fixed timer; a healthy incremental write or a reopen resets it.
const REPAIR_DELAY_MS = 1_000
const MAX_REPAIR_DELAY_MS = 60 * 60_000
// A full restore per check: development samples each chat so long streams stay responsive.
const DEVELOPMENT_VERIFY_INTERVAL_MS = 60_000

export class JournalWriteProjection {
  /** Projection tests check the equality invariant after every commit and throw on divergence. */
  static verifyEachCommit = false

  private through = 0
  private failures = 0
  private verifiedAt = Number.NEGATIVE_INFINITY
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
    this.failures = 0
    this.clearTimer()
    this.schedule()
  }

  /** The callback is invoked only after the outer transaction has committed. */
  prepare(db: Database.Database, rows: readonly JournalRow[], savedAt: number): () => void {
    const live = this.deps.state()
    const transition = isolateJournalTransition(live, rows, savedAt)
    const attempted = this.through === live.lastSequence && this.through > 0
    const projected = attempted && this.write(db, transition)
    return () => {
      this.deps.adopt(transition.adopt())
      if (projected) {
        this.through = this.deps.state().lastSequence
        this.failures = 0
      } else if (attempted) {
        this.failures += 1
      }
      this.schedule()
    }
  }

  repair = (): Promise<void> => {
    // A closing chat's next open repairs it.
    if (this.closed) {
      return Promise.resolve()
    }
    return this.deps.queue
      .serialize(() => {
        const state = this.deps.state()
        if (this.through === state.lastSequence) {
          return
        }
        // Capture on this lane, after admitted recovery writes; publication rechecks the epoch.
        if (saveJournalState(this.deps.database, state, true)) {
          this.through = state.lastSequence
        } else {
          this.failures += 1
        }
        this.schedule()
      })
      .catch((error) => {
        this.failures += 1
        logJournalProjectionFailure(this.deps.state().sessionId, error)
        this.schedule()
      })
  }

  /** Runs after commit notification, never in the adopt path. */
  verify(): void {
    if (JournalWriteProjection.verifyEachCommit) {
      this.checkEquivalent()
      return
    }
    const now = performance.now()
    if (
      process.env.NODE_ENV !== 'development' ||
      now - this.verifiedAt < DEVELOPMENT_VERIFY_INTERVAL_MS
    ) {
      return
    }
    this.verifiedAt = now
    try {
      this.checkEquivalent()
    } catch (error) {
      logJournalProjectionFailure(this.deps.state().sessionId, error)
    }
  }

  close(): void {
    this.closed = true
    this.clearTimer()
  }

  private checkEquivalent(): void {
    const live = this.deps.state()
    const loaded = restoreJournal(this.deps.database.db, live.sessionId)
    if (
      !loaded ||
      loaded.projectionThrough !== this.through ||
      loaded.damage ||
      loaded.newer ||
      !isDeepStrictEqual(encodeJournalState(loaded.state), encodeJournalState(live))
    ) {
      throw new Error('journal projection and contiguous tail differ from live state')
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = null
  }

  private schedule(): void {
    if (this.closed || this.timer || this.through === this.deps.state().lastSequence) {
      return
    }
    const delay = Math.min(REPAIR_DELAY_MS * 4 ** this.failures, MAX_REPAIR_DELAY_MS)
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
    return writeJournalProjectionSavepoint(db, transition.state.sessionId, () =>
      writeJournalProjection(db, transition.state, transition.changes())
    )
  }
}
