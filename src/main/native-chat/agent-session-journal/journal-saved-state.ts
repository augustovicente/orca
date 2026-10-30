import type Database from '../../sqlite/sync-database'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalReducerState } from './journal-reducer'
import { readJournalSessionEpoch } from './journal-row-table'
import { decodeJournalState } from './journal-state-codec'
import { clearJournalSavedState, publishJournalProjection } from './journal-projection-table'

export { ensureJournalSavedStateTables, clearJournalSavedState } from './journal-projection-table'

export function readJournalSavedState(
  db: Database.Database,
  sessionId: string,
  epoch: string
): JournalReducerState | null {
  const row = db
    .prepare(`SELECT through_seq, version, state_json FROM journal_state
    WHERE session_id = ? AND epoch = ?`)
    .get(sessionId, epoch)
  if (!row) {
    return null
  }
  try {
    if (typeof row.version !== 'number' || typeof row.state_json !== 'string') {
      throw new Error('invalid saved journal state')
    }
    const items = db
      .prepare(`SELECT item_json FROM journal_items
      WHERE session_id = ? AND epoch = ? ORDER BY ordinal`)
      .all(sessionId, epoch)
    const jsons = items.map((item) => {
      if (typeof item.item_json !== 'string') {
        throw new Error('invalid saved journal item')
      }
      return item.item_json
    })
    const entries = db
      .prepare(`SELECT field, entry_json FROM journal_entries
      WHERE session_id = ? AND epoch = ? ORDER BY field, ordinal`)
      .all(sessionId, epoch)
      .map((entry) => {
        if (typeof entry.field !== 'string' || typeof entry.entry_json !== 'string') {
          throw new Error('invalid saved journal entry')
        }
        return { path: entry.field, entryJson: entry.entry_json }
      })
    const state = decodeJournalState(row.version, row.state_json, jsons, entries)
    if (
      state?.sessionId !== sessionId ||
      state.epoch !== epoch ||
      state.lastSequence !== row.through_seq
    ) {
      throw new Error('invalid saved journal coverage')
    }
    return state
  } catch (error) {
    logJournalProjectionFailure(sessionId, error)
    return null
  }
}

/** Full publication runs only on the owning write lane, for bootstrap or coverage repair. */
export function saveJournalState(
  database: JournalHostDatabase,
  state: JournalReducerState,
  repairEqualPrefix = false
): boolean {
  if (database.readOnly || database.isClosed || state.lastSequence === 0) {
    return false
  }
  try {
    return database.transaction((db) => {
      if (readJournalSessionEpoch(db, state.sessionId) !== state.epoch) {
        return false
      }
      const previous = db
        .prepare('SELECT epoch, through_seq FROM journal_state WHERE session_id = ?')
        .get(state.sessionId)
      if (
        previous?.epoch === state.epoch &&
        (Number(previous.through_seq) > state.lastSequence ||
          (Number(previous.through_seq) === state.lastSequence && !repairEqualPrefix))
      ) {
        return false
      }
      publishJournalProjection(db, state)
      return true
    })
  } catch (error) {
    logJournalProjectionFailure(state.sessionId, error)
    return false
  }
}

/** Items and entries are written only beside their session's state row, so orphans are found from
 * one row per chat; the deletes use each session's key prefix. */
export function sweepJournalSavedState(database: JournalHostDatabase): void {
  database.transaction((db) => {
    const orphans = db
      .prepare(`SELECT c.session_id FROM journal_state c
      LEFT JOIN journal_sessions s ON s.session_id = c.session_id AND s.epoch = c.epoch
      WHERE s.session_id IS NULL`)
      .all()
    for (const { session_id: sessionId } of orphans) {
      if (typeof sessionId === 'string') {
        clearJournalSavedState(db, sessionId)
      }
    }
  })
}

export function logJournalProjectionFailure(sessionId: string, error: unknown): void {
  console.warn('[agent-session-journal] could not save chat state', { sessionId, error })
}

/** Mobile test programs type global timers as numbers; Node timers may release the event loop. */
export function unrefJournalProjectionTimer(timer: unknown): void {
  if (typeof timer === 'object' && timer && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref()
  }
}
