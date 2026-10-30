import Database from '../../sqlite/sync-database'
import * as rowTable from './journal-row-table'
import * as rowSchema from './journal-row-schema'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { JournalHostDatabase } from './journal-host-database'
import {
  closeTestJournalHostDatabases,
  insertTestJournalRow,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  publishTestJournalEpoch
} from './journal-host-database-test-support'
import { restoreJournal } from './journal-open'
import {
  applyJournalRow,
  createJournalReducerState,
  type JournalReducerState
} from './journal-reducer'
import type { JournalItemRow, JournalRow } from './journal-row-schema'
import { readJournalSavedState, saveJournalState } from './journal-saved-state'
import { backfillJournalState } from './journal-state-backfill'

const sessionId = 'session'
const epoch = 'epoch'
const providerHandle = { kind: 'codex', threadId: 'thread' } as const
const base = (seq: number) => ({ v: 4, epoch, seq, fence: 1, ts: 1_000 + seq })
const text = (value: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text: value }]
})
const item = (seq: number, revision: number, itemId = 'reply'): JournalItemRow => ({
  ...base(seq),
  kind: 'item',
  itemId,
  revision,
  body: text(`revision ${revision}`)
})
let root: string
let database: JournalHostDatabase
let state: JournalReducerState
const stored = () => liveTestJournalRows(database.db, sessionId)
const run = () => ({
  database: () => database,
  checkpointOpen: async () => false,
  stopped: () => false,
  rest: async () => {}
})

function append(rows: readonly JournalRow[]): void {
  database.transaction((db) => {
    for (const row of rows) {
      insertTestJournalRow(db, sessionId, row)
    }
  })
  for (const row of rows) {
    applyJournalRow(state, row)
  }
}

function expectSameState(actual: JournalReducerState | null | undefined): void {
  if (!actual) {
    throw new Error('missing restored state')
  }
  expect(Object.keys(actual)).toEqual(Object.keys(state))
  const fields: Record<string, unknown> = { ...actual }
  for (const [key, expected] of Object.entries(state)) {
    const value = fields[key]
    if (
      (value instanceof Map && expected instanceof Map) ||
      (value instanceof Set && expected instanceof Set)
    ) {
      expect([...value]).toStrictEqual([...expected])
    } else if (key === 'queue') {
      expect([...actual.queue.cards]).toStrictEqual([...state.queue.cards])
      expect(actual.queue.revision).toBe(state.queue.revision)
    } else if (key === 'derivedTurnScope') {
      expect(actual.derivedTurnScope.snapshot()).toBe(state.derivedTurnScope.snapshot())
    } else {
      expect(value).toStrictEqual(expected)
    }
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-compaction-'))
  database = openTestJournalHostDatabase(root)
  state = createJournalReducerState(sessionId, epoch)
  publishTestJournalEpoch(database.db, sessionId, epoch)
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

it.each([10, 100])(
  'bounds real maintenance and anchors for %i duplicate/imported batches',
  async (count) => {
    database.db.pragma('auto_vacuum = 0')
    database.db.exec('VACUUM')
    append([
      { ...base(1), kind: 'epoch', reason: 'legacy_import', providerHandle },
      item(2, 1),
      item(3, 1, 'removed')
    ])
    const rows: JournalRow[] = []
    const batch = (
      settlementId: string,
      mutations: Extract<JournalRow, { kind: 'lifecycle-batch' }>['mutations']
    ) => {
      rows.push({ ...base(4 + rows.length), kind: 'lifecycle-batch', settlementId, mutations })
    }
    const current = { kind: 'item', itemId: 'reply', revision: 2, body: text('P') } as const
    for (let index = 0; index < count; index++) {
      batch('repeated', [current])
      batch(`paired-${index}`, [current])
      batch(`paired-${index}`, [
        { ...current, revision: 99, body: { ...text('ignored'), role: 'user' } }
      ])
      rows.push({ ...item(4 + rows.length, 2), body: text('P') })
      batch(`remove-${index}`, [{ kind: 'tombstone', itemId: 'removed', revision: 2 }])
    }
    const shared = 4 + rows.length
    batch('sibling', [current, { ...current, itemId: 'sibling', revision: 1 }])
    rows.push(item(4 + rows.length, 1), item(5 + rows.length, 1, 'removed'))
    const stop = 4 + rows.length
    rows.push({
      ...base(stop),
      kind: 'tombstone',
      itemId: 'stop',
      revision: 1,
      stopEvent: { reason: 'user-stop', at: 1000 + stop }
    })
    append(rows)
    saveJournalState(database, state)
    const beforeBytes = stored().reduce((sum, row) => sum + Buffer.byteLength(row.rowJson), 0)
    const read = vi.spyOn(rowTable, 'readJournalRowsAfter')
    const parse = vi.spyOn(rowSchema, 'parseJournalRow')
    const transaction = vi.spyOn(database, 'transaction')
    const physicalReads: number[] = []
    let deleteCalls = 0
    const prepare = Database.prototype.prepare
    const observed = new WeakSet<object>()
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database, sql) {
      const statement = prepare.call(this, sql)
      if (!observed.has(statement)) {
        observed.add(statement)
        if (sql.startsWith('SELECT seq, ts, row_json FROM journal_rows')) {
          const all = statement.all.bind(statement)
          vi.spyOn(statement, 'all').mockImplementation((...args) => {
            const rows = all(...args)
            physicalReads.push(rows.length)
            return rows
          })
        } else if (sql.startsWith('DELETE FROM journal_rows')) {
          const remove = statement.run.bind(statement)
          vi.spyOn(statement, 'run').mockImplementation((...args) => {
            deleteCalls++
            return remove(...args)
          })
        }
      }
      return statement
    })
    const set = Map.prototype.set
    let summaries = 0
    const summaryKeys = new Set<string>()
    const summary = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
      this: Map<unknown, unknown>,
      key,
      value
    ) {
      if (
        typeof key === 'string' &&
        value &&
        typeof value === 'object' &&
        'first' in value &&
        'last' in value
      ) {
        summaries++
        summaryKeys.add(key)
      }
      return set.call(this, key, value)
    })
    expect(await backfillJournalState(run())).toEqual({ deleted: 5 * count })
    summary.mockRestore()
    const parsed = parse.mock.results.flatMap((result) =>
      result.type === 'return' && result.value.ok ? [result.value.row] : []
    )
    const contributions = parsed.reduce(
      (sum, row) =>
        sum + (row.kind === 'lifecycle-batch' ? row.mutations.length : row.kind === 'item' ? 1 : 0),
      0
    )
    const retained = [1, 2, 3, shared, shared + 1, shared + 2, stop]
    expect(summaries).toBe(5 * count + 6)
    expect(summaryKeys.size).toBe(3)
    expect(deleteCalls).toBe(5 * count)
    expect(physicalReads.reduce((sum, size) => sum + size, 0)).toBe(3 * (5 * count + 7))
    expect(physicalReads.every((size) => size <= 32)).toBe(true)
    expect(parse).toHaveBeenCalledTimes(3 * (5 * count + 7))
    expect(contributions).toBe(3 * (5 * count + 6))
    expect(
      read.mock.results.every((result) => result.type === 'return' && result.value.length <= 32)
    ).toBe(true)
    expect(read.mock.calls.length).toBeLessThanOrEqual(2 * Math.ceil((5 * count + 7) / 32))
    const chunks = transaction.mock.calls.filter((call) => call[1] === true).length
    expect(chunks).toBeGreaterThanOrEqual(Math.ceil((5 * count) / 8))
    expect(chunks).toBeLessThanOrEqual(Math.ceil((5 * count) / 8) + Math.ceil((5 * count + 7) / 32))
    const residual = stored()
    expect(residual.map((row) => row.seq)).toEqual(retained)
    const bytes = residual.reduce((sum, row) => sum + Buffer.byteLength(row.rowJson), 0)
    expect(bytes).toBeLessThan(beforeBytes)
    expect(
      residual
        .filter((row) => JSON.parse(row.rowJson).kind === 'lifecycle-batch')
        .map((row) => row.seq)
    ).toEqual([shared])
    expect(residual.filter((row) => row.rowJson.includes('ignored'))).toEqual([])
    expect(
      residual.filter((row) => ['item', 'lifecycle-batch'].includes(JSON.parse(row.rowJson).kind))
    ).toHaveLength(5)
    expect(5).toBeLessThanOrEqual(2 * summaryKeys.size)
    expect(
      residual.reduce((copies, row) => {
        const parsed = rowSchema.parseJournalRow(row.rowJson)
        if (!parsed.ok) {
          throw new Error('unreadable residual')
        }
        const mutations =
          parsed.row.kind === 'lifecycle-batch'
            ? parsed.row.mutations
            : parsed.row.kind === 'item'
              ? [parsed.row]
              : []
        return copies + mutations.filter((mutation) => mutation.itemId === 'reply').length
      }, 0)
    ).toBe(3)
    expectSameState(restoreJournal(database.db, sessionId)?.state)
    closeTestJournalHostDatabases()
    database = openTestJournalHostDatabase(root)
    read.mockClear()
    parse.mockClear()
    physicalReads.length = 0
    const deletesBefore = deleteCalls
    expect(await backfillJournalState(run())).toEqual({ deleted: 0 })
    expect(parse).toHaveBeenCalledTimes(2 * retained.length)
    expect(read).toHaveBeenCalledTimes(1)
    expect(physicalReads).toEqual([retained.length, retained.length])
    expect(deleteCalls).toBe(deletesBefore)
    expect(stored()).toEqual(residual)
    expect(stored().reduce((sum, row) => sum + Buffer.byteLength(row.rowJson), 0)).toBe(bytes)
  }
)

it.each([10, 100])(
  'reads open-chat authority only once for %i saved items, including failed publication',
  async (count) => {
    append([{ ...base(1), kind: 'epoch', reason: 'session_created', providerHandle }])
    for (let index = 0; index < count; index++) {
      const seq = 2 + 3 * index
      append([
        item(seq, 1, `item-${index}`),
        item(seq + 1, 2, `item-${index}`),
        item(seq + 2, 3, `item-${index}`)
      ])
    }
    expect(saveJournalState(database, state)).toBe(true)
    const through = state.lastSequence
    append([
      item(through + 1, 1, 'tail'),
      item(through + 2, 2, 'tail'),
      item(through + 3, 3, 'tail')
    ])
    const tail = stored().filter((row) => row.seq > through)
    const prepare = Database.prototype.prepare
    const observed = new WeakSet<object>()
    let stateReads = 0
    const itemReads: number[] = []
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database, sql) {
      const statement = prepare.call(this, sql)
      if (!observed.has(statement)) {
        observed.add(statement)
        if (sql.startsWith('SELECT through_seq, version, state_json FROM journal_state')) {
          const get = statement.get.bind(statement)
          vi.spyOn(statement, 'get').mockImplementation((...args) => {
            stateReads++
            return get(...args)
          })
        } else if (sql.startsWith('SELECT item_json FROM journal_items')) {
          const all = statement.all.bind(statement)
          vi.spyOn(statement, 'all').mockImplementation((...args) => {
            const rows = all(...args)
            itemReads.push(rows.length)
            return rows
          })
        }
      }
      return statement
    })
    const checkpointOpen = vi.fn(async () => {
      saveJournalState(database, state)
      return true
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    database.db.exec(
      "CREATE TRIGGER fail_checkpoint BEFORE INSERT ON journal_state BEGIN SELECT RAISE(ABORT, 'save failed'); END"
    )
    // A live callback can return true after publication fails: only the older FULL prefix qualifies.
    expect(await backfillJournalState({ ...run(), checkpointOpen })).toBeNull()
    expect(checkpointOpen).toHaveBeenCalledTimes(1)
    expect(stateReads).toBe(1)
    expect(itemReads).toEqual([count])
    expect(stored()).toHaveLength(2 * count + 4)
    expect(stored().filter((row) => row.seq > through)).toEqual(tail)
    expect(readJournalSavedState(database.db, sessionId, epoch)?.lastSequence).toBe(through)
    expectSameState(restoreJournal(database.db, sessionId)?.state)
    database.db.exec('DROP TRIGGER fail_checkpoint')
    stateReads = 0
    itemReads.length = 0
    checkpointOpen.mockClear()
    expect(await backfillJournalState({ ...run(), checkpointOpen })).toEqual({ deleted: 1 })
    expect(checkpointOpen).toHaveBeenCalledTimes(1)
    expect(stateReads).toBe(1)
    expect(itemReads).toEqual([count + 1])
    closeTestJournalHostDatabases()
    database = openTestJournalHostDatabase(root)
    expectSameState(restoreJournal(database.db, sessionId)?.state)
  }
)
