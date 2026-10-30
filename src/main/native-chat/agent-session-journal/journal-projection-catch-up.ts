// Advance a lagging saved view one atomic page at a time from its durable coverage. Each committed
// page is a valid prefix to restart from, and sends never wait for the whole chat.

import { isDeepStrictEqual } from 'node:util'
import type { JournalHostDatabase } from './journal-host-database'
import { startJournalRowFold } from './journal-open'
import { createJournalReducerState, type JournalReducerState } from './journal-reducer'
import { isolateJournalTransition } from './journal-reducer-transition'
import { readJournalRowsAfter, readJournalSessionEpoch } from './journal-row-table'
import { clearJournalSavedState, writeJournalProjection } from './journal-projection-table'
import { JOURNAL_STATE_CODEC_VERSION } from './journal-state-codec'
import {
  logJournalProjectionFailure,
  readJournalSavedStamp,
  readJournalSavedStatePages,
  unrefJournalProjectionTimer,
  type JournalSavedStamp
} from './journal-saved-state'

const PAGE_ROWS = 32
// A page ends after the row that crosses this much row text; a single row always fits.
const PAGE_BYTES = 1 << 20
const SLICE_MS = 25

export type JournalCatchUpStep =
  /** One page committed; coverage moved forward. */
  | 'advanced'
  /** No rows follow the saved coverage. */
  | 'current'
  /** The next page holds damage or rows from a newer build; nothing was written. */
  | 'parked'
  /** Another writer moved the saved view; the prefix reloads before the next page. */
  | 'stale'
  /** The chat no longer has this epoch. */
  | 'retired'
  /** The page did not commit; coverage is unchanged. */
  | 'failed'

/** A private prefix of one epoch, never the live state; it changes only after its page commits. */
export class JournalProjectionCatchUp {
  private base: { state: JournalReducerState; stamp: JournalSavedStamp; valid: boolean } | null =
    null

  constructor(
    private readonly database: JournalHostDatabase,
    readonly sessionId: string,
    readonly epoch: string,
    /** Tests page single rows to check every prefix. */
    private readonly pageRows = PAGE_ROWS
  ) {}

  /** The private prefix's coverage, which the saved view holds after each committed page. */
  get through(): number {
    return this.base?.state.lastSequence ?? 0
  }

  /** Decodes the accepted prefix once, resting between pages; false when `rest` stops it. */
  async load(rest: () => Promise<boolean>): Promise<boolean> {
    if (this.base) {
      return true
    }
    const { database, sessionId, epoch } = this
    const stamp = readJournalSavedStamp(database.db, sessionId)
    const pages = readJournalSavedStatePages(() => database.db, sessionId, epoch, this.pageRows)
    for (let step = pages.next(); ; step = pages.next()) {
      if (step.done) {
        if (database.isClosed) {
          return false
        }
        // A missing or unreadable view restarts from the epoch's first row; that page clears it.
        const state = step.value ?? createJournalReducerState(sessionId, epoch)
        this.base = { state, stamp, valid: step.value !== null }
        return true
      }
      if (!(await rest())) {
        return false
      }
    }
  }

  /** Runs synchronously on the chat's owning lane: one FULL transaction or nothing. */
  page(): JournalCatchUpStep {
    const { base, database, sessionId, epoch } = this
    if (!base) {
      return 'stale'
    }
    if (database.readOnly || database.isClosed) {
      return 'failed'
    }
    try {
      const outcome = database.transaction(
        (db): JournalCatchUpStep | (() => JournalReducerState) => {
          if (readJournalSessionEpoch(db, sessionId) !== epoch) {
            return 'retired'
          }
          // The exact predecessor: a delta folded from one saved view must never land on another.
          if (!isDeepStrictEqual(readJournalSavedStamp(db, sessionId), base.stamp)) {
            return 'stale'
          }
          const after = base.state.lastSequence
          const rows = readJournalRowsAfter(
            db,
            sessionId,
            epoch,
            after === 0 ? Number.MIN_SAFE_INTEGER : after,
            this.pageRows
          )
          if (rows.length === 0) {
            return 'current'
          }
          const transition = isolateJournalTransition(base.state, (draft) => {
            const fold = startJournalRowFold({ sessionId, epoch, untilDamage: true }, draft)
            let bytes = 0
            for (const row of rows) {
              bytes += row.rowJson.length
              if (!fold.add(row) || bytes >= PAGE_BYTES) {
                break
              }
            }
            return fold.finish()
          })
          // Coverage never crosses damage; earlier pages stay as the valid prefix.
          if (transition.result.damage || transition.result.newer) {
            return 'parked'
          }
          if (!base.valid) {
            clearJournalSavedState(db, sessionId)
          }
          writeJournalProjection(db, transition.state, transition.changes())
          return transition.adopt
        }
      )
      if (typeof outcome === 'string') {
        if (outcome === 'stale') {
          this.base = null
        }
        return outcome
      }
      const state = outcome()
      this.base = {
        state,
        stamp: { epoch, through: state.lastSequence, version: JOURNAL_STATE_CODEC_VERSION },
        valid: true
      }
      return 'advanced'
    } catch (error) {
      logJournalProjectionFailure(sessionId, error)
      return 'failed'
    }
  }
}

/** Each slice of catch-up work up to 25 ms is followed by nine times its length at rest. */
export function journalCatchUpPace(
  now: () => number = () => performance.now(),
  rest: (ms: number) => Promise<void> = (ms) =>
    new Promise<void>((resolve) => unrefJournalProjectionTimer(setTimeout(resolve, ms)))
): () => Promise<void> {
  let sliceAt = now()
  return async () => {
    const elapsed = now() - sliceAt
    if (elapsed >= SLICE_MS) {
      await rest(elapsed * 9)
      sliceAt = now()
    }
  }
}
