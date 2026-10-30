import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import {
  createTrackedJournalOpener,
  insertTestJournalRow,
  openTestJournalHostDatabase,
  publishTestJournalEpoch,
  liveTestJournalRows,
  updateTestJournalRowJson
} from './journal-host-database-test-support'
import { AgentSessionJournal } from './journal-store'
import {
  clearJournalSavedState,
  readJournalSavedState,
  saveJournalState,
  sweepJournalSavedState
} from './journal-saved-state'
import { restoreJournal } from './journal-open'
import { startJournalStateBackfill } from './journal-state-backfill'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalRow } from './journal-row-schema'
import {
  expectProjectionMatches,
  projectionBase as base,
  projectionEpoch as epoch,
  projectionEpochRow,
  projectionSessionId as sessionId,
  seedProjectionRows,
  watchJournalStatements
} from './journal-projection-test-support'

const identity: AgentSessionJournalIdentity = {
  sessionId,
  workspaceId: 'workspace',
  hostId: 'host',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}
let root: string
let database: JournalHostDatabase
const journals = createTrackedJournalOpener()
let backfill: { stop: () => void } | undefined
const childItemId = agentJournalItemKey({
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal: 1
})
// A crashed host left this child working, so opening it appends an unverifiable revision.
const workingChild: JournalRow = {
  ...base(2),
  kind: 'item',
  itemId: childItemId,
  revision: 1,
  body: {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'subagent', id: 'child', label: 'Audit', state: 'working', groupId: 'turn-1' }]
  }
}
const legacyItem = (seq: number): JournalRow => ({
  ...base(seq),
  kind: 'item',
  itemId: `legacy-${seq}`,
  revision: 1,
  body: { kind: 'status', text: 'Saved before projections existed' }
})
const publications = (statements: readonly string[]) =>
  statements.filter((sql) => /^\s*(INSERT|DELETE)[\s\S]*journal_(items|entries|state)/.test(sql))

beforeEach(async () => {
  vi.useFakeTimers()
  root = await mkdtemp(join(tmpdir(), 'orca-journal-projection-bootstrap-'))
  database = openTestJournalHostDatabase(root)
})
afterEach(async () => {
  backfill?.stop()
  await journals.closeAll()
  vi.restoreAllMocks()
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

it('keeps recovery writes behind coverage zero, repairs the current epoch after rollover, and paces closed-chat bootstrap', async () => {
  const legacy = seedProjectionRows(database, [projectionEpochRow, workingChild])
  database.db.exec(`CREATE TRIGGER fail_bootstrap BEFORE INSERT ON journal_state
    BEGIN SELECT RAISE(ABORT, 'bootstrap failed'); END`)
  const exec = vi.spyOn(database.db, 'exec')
  const journal = journals.track(
    new AgentSessionJournal({ identity, database, mintEpoch: () => 'rolled' })
  )
  await journal.open()
  expect(journal.cursor()).toEqual({ epoch, sequence: 3 })
  expect(journal.itemBody(childItemId)).toMatchObject({ blocks: [{ state: 'unverifiable' }] })
  expect(readJournalSavedState(database.db, sessionId, epoch)).toBeNull()
  expect(exec.mock.calls.filter(([sql]) => sql.startsWith('SAVEPOINT'))).toEqual([])
  expect(restoreJournal(database.db, sessionId)?.projectionThrough).toBe(0)
  const recovered = restoreJournal(database.db, sessionId)
  if (!recovered) {
    throw new Error('missing recovered journal')
  }
  expectProjectionMatches(database, recovered.state)

  // A scheduled retry must capture the new epoch rather than the state from failed bootstrap.
  database.db.exec('DROP TRIGGER fail_bootstrap')
  await journal.rollEpoch('session_created', 1)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(readJournalSavedState(database.db, sessionId, 'rolled')?.lastSequence).toBe(
    journal.cursor().sequence
  )
  expect(readJournalSavedState(database.db, sessionId, epoch)).toBeNull()
  expect(saveJournalState(database, legacy)).toBe(false)
  await journal.close()

  database.transaction((db) => {
    clearJournalSavedState(db, sessionId)
    for (let index = 0; index < 300; index++) {
      insertTestJournalRow(db, sessionId, {
        ...base(index + 2),
        epoch: 'rolled',
        kind: 'item',
        itemId: `closed-${index}`,
        revision: 1,
        body: { kind: 'status', text: 'Saved before projections existed' }
      })
    }
  })
  const before = liveTestJournalRows(database.db, sessionId)
  const rests: number[] = []
  let tick = 0
  vi.spyOn(performance, 'now').mockImplementation(() => {
    tick += 10
    return tick
  })
  vi.spyOn(Date, 'now').mockImplementation(() => 10_000 - tick)
  const repairOpen = vi.fn(async () => false)
  backfill = startJournalStateBackfill(
    {
      database: () => database,
      repairOpen,
      rest: async (ms) => {
        rests.push(ms)
      }
    },
    (error) => {
      throw error
    }
  )
  await vi.advanceTimersByTimeAsync(59_999)
  expect(readJournalSavedState(database.db, sessionId, 'rolled')).toBeNull()
  await vi.advanceTimersByTimeAsync(1)
  const saved = readJournalSavedState(database.db, sessionId, 'rolled')
  expect(saved?.lastSequence).toBe(301)
  expect(repairOpen).toHaveBeenCalledTimes(2)
  expect(rests.length).toBeGreaterThan(1)
  expect(rests.every((ms) => ms >= 25 * 9)).toBe(true)
  expect(liveTestJournalRows(database.db, sessionId)).toStrictEqual(before)
  if (!saved) {
    throw new Error('missing background projection')
  }
  expectProjectionMatches(database, saved)
  database.transaction((db) => publishTestJournalEpoch(db, sessionId, 'older-writer'))
  sweepJournalSavedState(database)
  for (const table of ['journal_state', 'journal_items', 'journal_entries']) {
    expect(
      database.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(sessionId)
        ?.n
    ).toBe(0)
  }
  backfill.stop()
})

it('opens a legacy chat before publishing it, then publishes on the write lane', async () => {
  seedProjectionRows(database, [
    projectionEpochRow,
    ...Array.from({ length: 40 }, (_, index) => legacyItem(index + 2))
  ])
  const watched = watchJournalStatements(database)
  const journal = journals.track(new AgentSessionJournal({ identity, database }))
  await journal.open()
  expect(journal.cursor()).toEqual({ epoch, sequence: 41 })
  expect(publications(watched.statements)).toEqual([])
  await vi.advanceTimersByTimeAsync(1_000)
  expect(publications(watched.statements).length).toBeGreaterThan(0)
  expect(readJournalSavedState(database.db, sessionId, epoch)?.lastSequence).toBe(41)
})

it('stops the repair timer of a chat whose open fails after adopting its history', async () => {
  seedProjectionRows(database, [projectionEpochRow, workingChild])
  database.db.exec(`CREATE TRIGGER fail_rows BEFORE INSERT ON journal_rows
    BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`)
  const watched = watchJournalStatements(database)
  await expect(journals.open({ identity, stateDirectory: root })).rejects.toThrow()
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(publications(watched.statements)).toEqual([])
})

it('skips a closed chat that cannot publish until a new row arrives', async () => {
  seedProjectionRows(database, [
    projectionEpochRow,
    ...Array.from({ length: 99 }, (_, index) => legacyItem(index + 2))
  ])
  database.transaction((db) => updateTestJournalRowJson(db, sessionId, 5, '{"unreadable":'))
  const watched = watchJournalStatements(database)
  backfill = startJournalStateBackfill(
    { database: () => database, repairOpen: async () => false, rest: async () => undefined },
    (error) => {
      throw error
    }
  )
  await vi.advanceTimersByTimeAsync(60_000)
  // One page: the fold stops at the damaged row instead of reading the whole chat.
  expect(watched.rowsRead()).toBe(32)
  expect(readJournalSavedState(database.db, sessionId, epoch)).toBeNull()
  await vi.advanceTimersByTimeAsync(6 * 60 * 60_000)
  expect(watched.rowsRead()).toBe(32)
  database.transaction((db) => insertTestJournalRow(db, sessionId, legacyItem(101)))
  await vi.advanceTimersByTimeAsync(6 * 60 * 60_000)
  expect(watched.rowsRead()).toBe(64)
})
