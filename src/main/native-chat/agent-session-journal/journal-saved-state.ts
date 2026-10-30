import type Database from '../../sqlite/sync-database'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalReducerState } from './journal-reducer'
import { startJournalStateDecode } from './journal-state-codec'
import { clearJournalSavedState, publishJournalProjection } from './journal-projection-table'

export { ensureJournalSavedStateTables, clearJournalSavedState } from './journal-projection-table'

/** The saved row a projection delta is computed from; null when the chat has none. */
export type JournalSavedStamp = { epoch: string; through: number; version: number } | null

export function readJournalSavedStamp(db: Database.Database, sessionId: string): JournalSavedStamp {
  const row = db
    .prepare('SELECT epoch, through_seq, version FROM journal_state WHERE session_id = ?')
    .get(sessionId)
  return row &&
    typeof row.epoch === 'string' &&
    typeof row.through_seq === 'number' &&
    typeof row.version === 'number'
    ? { epoch: row.epoch, through: row.through_seq, version: row.version }
    : null
}

export function readJournalSavedState(
  db: Database.Database,
  sessionId: string,
  epoch: string
): JournalReducerState | null {
  const pages = readJournalSavedStatePages(() => db, sessionId, epoch)
  let step = pages.next()
  while (!step.done) {
    step = pages.next()
  }
  return step.value
}

/** Decodes `limit` stored rows per page in storage order, yielding between pages; a negative limit
 * reads each table at once. Null when the view is absent, from another codec, or invalid. */
export function* readJournalSavedStatePages(
  database: () => Database.Database,
  sessionId: string,
  epoch: string,
  limit = -1
): Generator<void, JournalReducerState | null> {
  try {
    const row = database()
      .prepare(`SELECT through_seq, version, state_json FROM journal_state
      WHERE session_id = ? AND epoch = ?`)
      .get(sessionId, epoch)
    if (!row) {
      return null
    }
    if (typeof row.version !== 'number' || typeof row.state_json !== 'string') {
      throw new Error('invalid saved journal state')
    }
    const decode = startJournalStateDecode(row.version, row.state_json)
    if (!decode) {
      return null
    }
    let ordinal = -1
    for (;;) {
      const items = database()
        .prepare(`SELECT ordinal, item_json FROM journal_items
        WHERE session_id = ? AND epoch = ? AND ordinal > ? ORDER BY ordinal LIMIT ?`)
        .all(sessionId, epoch, ordinal, limit)
      for (const item of items) {
        if (typeof item.ordinal !== 'number' || typeof item.item_json !== 'string') {
          throw new Error('invalid saved journal item')
        }
        decode.item(item.item_json)
        ordinal = item.ordinal
      }
      if (limit < 0 || items.length < limit) {
        break
      }
      yield
    }
    let field = ''
    ordinal = -1
    for (;;) {
      const entries = database()
        .prepare(`SELECT field, ordinal, entry_json FROM journal_entries
        WHERE session_id = ? AND epoch = ? AND (field, ordinal) > (?, ?)
        ORDER BY field, ordinal LIMIT ?`)
        .all(sessionId, epoch, field, ordinal, limit)
      for (const entry of entries) {
        if (
          typeof entry.field !== 'string' ||
          typeof entry.ordinal !== 'number' ||
          typeof entry.entry_json !== 'string'
        ) {
          throw new Error('invalid saved journal entry')
        }
        decode.entry(entry.field, entry.entry_json)
        field = entry.field
        ordinal = entry.ordinal
      }
      if (limit < 0 || entries.length < limit) {
        break
      }
      yield
    }
    const state = decode.finish()
    if (
      state.sessionId !== sessionId ||
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

/** Only statement-local failures can keep the outer write; an aborted transaction still throws. */
export function writeJournalProjectionSavepoint(
  db: Database.Database,
  sessionId: string,
  write: () => void
): boolean {
  db.exec('SAVEPOINT journal_projection')
  try {
    write()
  } catch (error) {
    if (!db.isTransaction) {
      throw error
    }
    db.exec('ROLLBACK TO journal_projection')
    db.exec('RELEASE journal_projection')
    if (!db.isTransaction) {
      throw error
    }
    logJournalProjectionFailure(sessionId, error)
    return false
  }
  db.exec('RELEASE journal_projection')
  return true
}

/** Epoch publishers write the new epoch's saved state with its rows; returns the coverage. */
export function publishJournalEpochState(
  db: Database.Database,
  state: JournalReducerState
): number {
  return writeJournalProjectionSavepoint(db, state.sessionId, () =>
    publishJournalProjection(db, state)
  )
    ? state.lastSequence
    : 0
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
