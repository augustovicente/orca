import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import {
  closeTestJournalHostDatabases,
  insertTestJournalRow,
  openTestJournalHostDatabase,
  publishTestJournalEpoch,
  saveTestJournalState
} from './journal-host-database-test-support'
import { restoreJournal } from './journal-open'
import { readJournalSavedState, sweepJournalSavedState } from './journal-saved-state'
import { backfillJournalState } from './journal-state-backfill'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalRow } from './journal-row-schema'
import {
  projectionBase as base,
  projectionEpoch as epoch,
  projectionEpochRow,
  projectionSessionId as sessionId,
  projectionWriter,
  seedProjectionRows,
  watchJournalStatements
} from './journal-projection-test-support'

const N = 40
const providerHandle = { kind: 'codex', threadId: 'thread-1' } as const
const providerItemId = agentJournalItemKey({
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal: 1
})
const WRITTEN_JSON = {
  journal_rows: 'row_json',
  journal_items: 'item_json',
  journal_entries: 'entry_json',
  journal_state: 'state_json'
} as const
let root: string
const rigs: ReturnType<typeof projectionWriter>[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-projection-scaling-'))
})
afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    rig.projection.close()
    rig.queue.markClosed()
    await rig.queue.drain()
  }
  vi.restoreAllMocks()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

const message = (text: string, role: 'user' | 'assistant' = 'user'): AgentJournalMessageItem => ({
  kind: 'message',
  role,
  blocks: [{ type: 'text', text }]
})
const send = (
  seq: number,
  clientMessageId: string,
  body: AgentJournalMessageItem,
  handoverRecorded?: true
): JournalRow => ({
  ...base(seq),
  kind: 'submission',
  clientMessageId,
  body,
  providerHandle,
  ...(handoverRecorded ? { handoverRecorded } : {}),
  payloadFingerprint: agentSessionSendBodyFingerprint(sessionId, body)
})
const answer =
  (text: string, revision: number) =>
  (seq: number, ts: number): JournalRow => ({
    ...base(seq),
    ts,
    kind: 'item',
    itemId: 'answer',
    revision,
    body: message(text, 'assistant')
  })

/** A published chat with `size` sends, statuses and their keyed entries, plus one handed-over send. */
function chatOf(size: number, label: string) {
  const database = openTestJournalHostDatabase(join(root, label))
  const rows: JournalRow[] = [projectionEpochRow]
  for (let index = 0; index < size; index++) {
    rows.push(send(rows.length + 1, `earlier-${index}`, message(`Earlier ${index}`)))
    rows.push({
      ...base(rows.length + 1),
      kind: 'item',
      itemId: `status-${index}`,
      revision: 1,
      body: { kind: 'status', text: `Status ${index}` }
    })
  }
  rows.push(send(rows.length + 1, 'send', message('Continue'), true))
  const state = seedProjectionRows(database, rows)
  saveTestJournalState(database, state)
  const rig = projectionWriter(database, state)
  rigs.push(rig)
  return { database, rig }
}

/** Count every row write and its JSON bytes on the log and the three projection tables. */
function countWrites(
  database: JournalHostDatabase
): () => { write: string; n: number; bytes: number }[] {
  const triggers = Object.entries(WRITTEN_JSON).flatMap(([table, column]) =>
    ['INSERT', 'UPDATE', 'DELETE'].map((op) => {
      const bytes = op === 'DELETE' ? '0' : `length(CAST(NEW.${column} AS BLOB))`
      return `CREATE TEMP TRIGGER count_${table}_${op} AFTER ${op} ON ${table}
        BEGIN INSERT INTO projection_writes VALUES ('${table} ${op}', ${bytes}); END;`
    })
  )
  database.db.exec(
    `CREATE TEMP TABLE projection_writes (target TEXT, bytes INTEGER); ${triggers.join('\n')}`
  )
  return () => {
    const writes = database.db
      .prepare(
        'SELECT target, COUNT(*) AS n, SUM(bytes) AS bytes FROM projection_writes GROUP BY target ORDER BY target'
      )
      .all()
      .map((row) => ({ write: String(row.target), n: Number(row.n), bytes: Number(row.bytes) }))
    database.db.exec('DELETE FROM projection_writes')
    return writes
  }
}

const shape = (writes: readonly { write: string; n: number }[]) =>
  writes.map(({ write, n }) => [write, n])
const bytes = (writes: readonly { bytes: number }[]) =>
  writes.reduce((sum, write) => sum + write.bytes, 0)

it('writes the same rows and bytes per streamed revision and per acceptance at N and 10N', async () => {
  const measure = async (size: number) => {
    const { database, rig } = chatOf(size, `chat-${size}`)
    const writes = countWrites(database)
    await rig.writer.enqueue(answer('x'.repeat(4_096), 1))
    writes()
    await rig.writer.enqueue(answer('y'.repeat(4_096), 2))
    const streamed = writes()
    // Acceptance still scans every submission for its echo; that O(n) loop predates the projection.
    await rig.writer.enqueue((seq, ts) => ({
      ...base(seq),
      ts,
      kind: 'item',
      itemId: providerItemId,
      revision: 1,
      body: message('Continue')
    }))
    const accepted = writes()
    expect(rig.state().submissions.get('send')?.dispatchState).toBe('accepted')
    return { streamed, accepted }
  }
  const small = await measure(N)
  const large = await measure(10 * N)
  expect(shape(small.streamed)).toContainEqual(['journal_items UPDATE', 1])
  for (const key of ['streamed', 'accepted'] as const) {
    expect(shape(large[key])).toStrictEqual(shape(small[key]))
    // Only the digits of the larger chat's sequence numbers differ.
    expect(Math.abs(bytes(large[key]) - bytes(small[key]))).toBeLessThanOrEqual(32)
  }
})

it('reopens a chat with current coverage without reading its rows at N and 10N revisions', async () => {
  for (const revisions of [N, 10 * N]) {
    const { database, rig } = chatOf(1, `revisions-${revisions}`)
    for (let revision = 1; revision <= revisions; revision++) {
      await rig.writer.enqueue(answer(`Revision ${revision}`, revision))
    }
    const watched = watchJournalStatements(database)
    expect(restoreJournal(database.db, sessionId)?.projectionThrough).toBe(rig.state().lastSequence)
    expect(watched.rowsRead()).toBe(0)
  }
})

it('sweeps an orphaned projection with the same indexed statements at N and 10N rows', () => {
  const sweep = (size: number) => {
    const { database } = chatOf(size, `orphan-${size}`)
    database.transaction((db) => publishTestJournalEpoch(db, sessionId, 'older-writer'))
    const watched = watchJournalStatements(database)
    const exec = vi.spyOn(database.db, 'exec')
    sweepJournalSavedState(database)
    const statements = [
      ...watched.statements,
      ...exec.mock.calls
        .map(([sql]) => sql)
        .filter((sql) => !/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/.test(sql))
    ]
    // One read of the per-chat state rows, then keyed deletes from the three projection tables.
    expect(statements.map((sql) => sql.trim().split(/\s+/).slice(0, 3).join(' '))).toEqual([
      'SELECT c.session_id FROM',
      'DELETE FROM journal_items',
      'DELETE FROM journal_entries',
      'DELETE FROM journal_state'
    ])
    for (const table of ['journal_state', 'journal_items', 'journal_entries']) {
      expect(database.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0)
    }
    const plans = statements.flatMap((sql) =>
      database.db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all()
        .map((row) => String(row.detail))
    )
    expect(plans.filter((detail) => /SCAN journal_(items|entries)/.test(detail))).toEqual([])
    return statements
  }
  expect(sweep(10 * N)).toStrictEqual(sweep(N))
})

it('catches up a lagging closed chat in pages whose writes do not grow with its live state at N and 10N', async () => {
  const catchUp = async (size: number) => {
    const { database, rig } = chatOf(size, `lagging-${size}`)
    const through = rig.state().lastSequence
    database.transaction((db) => {
      for (let revision = 1; revision <= 3 * 32; revision++) {
        insertTestJournalRow(
          db,
          sessionId,
          answer(`Revision ${revision}`, revision)(through + revision, 2_000)
        )
      }
    })
    const writes = countWrites(database)
    const stretches: ReturnType<typeof writes>[] = []
    let tick = 0
    await backfillJournalState({
      database: () => database,
      repairOpen: async () => false,
      stopped: () => false,
      // Every slice overruns, so the pass rests after each page of the saved view and of the tail.
      now: () => (tick += 30),
      rest: async () => {
        stretches.push(writes())
      }
    })
    stretches.push(writes())
    expect(readJournalSavedState(database.db, sessionId, epoch)?.lastSequence).toBe(through + 96)
    return {
      loadRests: stretches.length,
      written: stretches
        .map((stretch) => shape(stretch.filter(({ write }) => !write.startsWith('journal_rows'))))
        .filter((stretch) => stretch.length > 0)
    }
  }
  const small = await catchUp(N)
  const large = await catchUp(10 * N)
  // One transaction per page of the tail, each the same at N and 10N: no whole-view rewrite.
  expect(small.written).toHaveLength(3)
  expect(large.written).toStrictEqual(small.written)
  expect(small.written.flat().filter(([write]) => String(write).endsWith('DELETE'))).toEqual([])
  // Decoding the larger saved view takes more paced pages, not a longer stretch.
  expect(large.loadRests).toBeGreaterThan(small.loadRests)
})
