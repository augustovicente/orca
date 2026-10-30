import { expect, vi } from 'vitest'
import type { SqliteStatement } from '../../sqlite/sqlite-statement'
import type { JournalHostDatabase } from './journal-host-database'
import { JournalRowWriter } from './journal-row-writer'
import { JournalWriteQueue } from './journal-write-queue'
import { JournalWriteProjection } from './journal-write-projection'
import {
  applyJournalRow,
  createJournalReducerState,
  type JournalReducerState
} from './journal-reducer'
import { replayJournal, restoreJournal } from './journal-open'
import { encodeJournalState } from './journal-state-codec'
import { readJournalSavedState } from './journal-saved-state'
import { insertTestJournalRow, publishTestJournalEpoch } from './journal-host-database-test-support'
import type { JournalRow } from './journal-row-schema'

// Projection tests check the saved-state invariant after every commit.
JournalWriteProjection.verifyEachCommit = true

export const projectionSessionId = 'session-1'
export const projectionEpoch = 'epoch-1'
export const projectionBase = (seq: number) => ({
  v: 4,
  epoch: projectionEpoch,
  seq,
  ts: 1_000 + seq,
  fence: 1
})
export const projectionEpochRow: JournalRow = {
  ...projectionBase(1),
  kind: 'epoch',
  reason: 'session_created',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

export function seedProjectionRows(
  database: JournalHostDatabase,
  rows: readonly JournalRow[]
): JournalReducerState {
  const state = createJournalReducerState(projectionSessionId, projectionEpoch)
  database.transaction((db) => {
    publishTestJournalEpoch(db, projectionSessionId, projectionEpoch)
    for (const row of rows) {
      insertTestJournalRow(db, projectionSessionId, row)
      applyJournalRow(state, row)
    }
  })
  return state
}

export function projectionWriter(database: JournalHostDatabase, initial: JournalReducerState) {
  let state = initial
  const queue = new JournalWriteQueue(state.sessionId)
  const projection = new JournalWriteProjection({
    database,
    queue,
    state: () => state,
    adopt: (next) => {
      state = next
    }
  })
  projection.opened(
    readJournalSavedState(database.db, state.sessionId, state.epoch)?.lastSequence ?? 0
  )
  const writer = new JournalRowWriter({
    database: () => database,
    sessionId: state.sessionId,
    now: () => 10_000,
    serialize: (run) => queue.serialize(run),
    readOnly: () => false,
    highestFence: () => state.highestFence,
    nextSequence: () => state.lastSequence + 1,
    prepare: (db, rows, savedAt) => projection.prepare(db, rows, savedAt),
    commit: () => projection.verify()
  })
  return { writer, projection, state: () => state, queue }
}

export function expectProjectionMatches(
  database: JournalHostDatabase,
  state: JournalReducerState,
  fresh = true
): void {
  const restored = restoreJournal(database.db, state.sessionId)
  expect(restored?.damage).toBeNull()
  expect(restored?.newer).toBeNull()
  expect(restored && encodeJournalState(restored.state)).toStrictEqual(encodeJournalState(state))
  if (fresh) {
    const replayed = replayJournal(database.db, state.sessionId)
    expect(replayed && encodeJournalState(replayed.state)).toStrictEqual(encodeJournalState(state))
  }
}

/** Every statement prepared, and the rows read back by journal row page queries. */
export function watchJournalStatements(database: JournalHostDatabase): {
  statements: string[]
  rowsRead: () => number
} {
  const prepare = database.db.prepare.bind(database.db)
  const statements: string[] = []
  let rowsRead = 0
  vi.spyOn(database.db, 'prepare').mockImplementation((sql: string) => {
    statements.push(sql)
    const statement = prepare(sql)
    if (!sql.startsWith('SELECT seq, ts, row_json FROM journal_rows')) {
      return statement
    }
    const counted: SqliteStatement = {
      all: (...parameters) => {
        const rows = statement.all(...parameters)
        rowsRead += rows.length
        return rows
      },
      get: (...parameters) => statement.get(...parameters),
      run: (...parameters) => statement.run(...parameters),
      iterate: (...parameters) => statement.iterate(...parameters),
      setReadBigInts: (enabled) => statement.setReadBigInts(enabled)
    }
    return counted
  })
  return { statements, rowsRead: () => rowsRead }
}
