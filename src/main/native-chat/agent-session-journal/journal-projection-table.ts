// Keyed projection writes preserve insertion order without rewriting unchanged entities.

import type Database from '../../sqlite/sync-database'
import type { JournalReducerState } from './journal-reducer'
import type { JournalEntryChange } from './journal-transition-collections'
import { JOURNAL_STATE_CODEC_VERSION } from './journal-state-codec'
import {
  journalEntryJson,
  journalStateCollections,
  journalStateScalars
} from './journal-state-layout'

export function ensureJournalSavedStateTables(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS journal_state (
    session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, through_seq INTEGER NOT NULL,
    version INTEGER NOT NULL, state_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS journal_items (
    session_id TEXT NOT NULL, epoch TEXT NOT NULL, item_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL, item_json TEXT NOT NULL,
    PRIMARY KEY (session_id, epoch, item_id)
  );
  CREATE TABLE IF NOT EXISTS journal_entries (
    session_id TEXT NOT NULL, epoch TEXT NOT NULL, field TEXT NOT NULL,
    entry_key TEXT NOT NULL, ordinal INTEGER NOT NULL, entry_json TEXT NOT NULL,
    PRIMARY KEY (session_id, epoch, field, entry_key)
  );
  CREATE INDEX IF NOT EXISTS journal_items_order ON journal_items (session_id, epoch, ordinal);
  CREATE INDEX IF NOT EXISTS journal_entries_order ON journal_entries (session_id, epoch, field, ordinal)`)
}

export function writeJournalProjection(
  db: Database.Database,
  state: JournalReducerState,
  changes: readonly JournalEntryChange[]
): void {
  for (const entry of changes) {
    writeEntry(db, state, entry)
  }
  writeScalars(db, state)
}

export function publishJournalProjection(db: Database.Database, state: JournalReducerState): void {
  clearJournalSavedState(db, state.sessionId)
  const insertItem = db.prepare(`INSERT INTO journal_items
    (session_id, epoch, item_id, ordinal, item_json) VALUES (?, ?, ?, ?, ?)`)
  let ordinal = 0
  for (const [key, item] of state.items) {
    insertItem.run(state.sessionId, state.epoch, key, ordinal++, JSON.stringify(item))
  }
  const insertEntry = db.prepare(`INSERT INTO journal_entries
    (session_id, epoch, field, entry_key, ordinal, entry_json) VALUES (?, ?, ?, ?, ?, ?)`)
  for (const { path, entries } of journalStateCollections(state)) {
    if (path === 'items') {
      continue
    }
    ordinal = 0
    for (const [key, value] of entries) {
      insertEntry.run(
        state.sessionId,
        state.epoch,
        path,
        JSON.stringify(key),
        ordinal++,
        journalEntryJson(key, value)
      )
    }
  }
  writeScalars(db, state)
}

function writeScalars(db: Database.Database, state: JournalReducerState): void {
  db.prepare(`INSERT INTO journal_state (session_id, epoch, through_seq, version, state_json)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
    epoch = excluded.epoch, through_seq = excluded.through_seq,
    version = excluded.version, state_json = excluded.state_json`).run(
    state.sessionId,
    state.epoch,
    state.lastSequence,
    JOURNAL_STATE_CODEC_VERSION,
    journalStateScalars(state)
  )
}

function writeEntry(
  db: Database.Database,
  state: JournalReducerState,
  entry: JournalEntryChange
): void {
  const item = entry.path === 'items'
  const table = item ? 'journal_items' : 'journal_entries'
  const keyColumn = item ? 'item_id' : 'entry_key'
  const jsonColumn = item ? 'item_json' : 'entry_json'
  const field = item ? '' : ' AND field = ?'
  const prefix = item ? [state.sessionId, state.epoch] : [state.sessionId, state.epoch, entry.path]
  const key = item ? String(entry.key) : JSON.stringify(entry.key)
  if (entry.deleted || entry.reinsert) {
    db.prepare(
      `DELETE FROM ${table} WHERE session_id = ? AND epoch = ?${field} AND ${keyColumn} = ?`
    ).run(...prefix, key)
  }
  if (entry.deleted) {
    return
  }
  const json = item ? JSON.stringify(entry.value) : journalEntryJson(entry.key, entry.value)
  const columns = item ? '' : ', field'
  const placeholders = item ? '' : ', ?'
  db.prepare(`INSERT INTO ${table} (session_id, epoch${columns}, ${keyColumn}, ordinal, ${jsonColumn})
    VALUES (?, ?${placeholders}, ?,
      (SELECT COALESCE(MAX(ordinal), -1) + 1 FROM ${table} WHERE session_id = ? AND epoch = ?${field}), ?)
    ON CONFLICT(session_id, epoch${columns}, ${keyColumn}) DO UPDATE SET ${jsonColumn} = excluded.${jsonColumn}`).run(
    ...prefix,
    key,
    ...prefix,
    json
  )
}

/** Epoch publishers call this inside their row/epoch transaction. */
export function clearJournalSavedState(db: Database.Database, sessionId: string): void {
  for (const table of ['journal_items', 'journal_entries', 'journal_state']) {
    db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId)
  }
}
