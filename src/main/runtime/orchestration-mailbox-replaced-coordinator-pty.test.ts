import './rpc/unused-default-rpc-methods.test-fixture'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './orchestration/db'
import { createRootDispatch } from './orchestration/db/root-dispatch-test-fixture'
import {
  createRuntime,
  driveToLiveIdle,
  LEAF_ID,
  PANE_KEY,
  pointerCount,
  PTY_ID,
  SECOND_PANE_KEY,
  TAB_ID,
  TERMINAL_HANDLE,
  WORKTREE_ID
} from './orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

async function deliverWhileIdle(
  harness: ReturnType<typeof createRuntime>,
  db: OrchestrationDb,
  mailbox: string,
  runId: string
): Promise<void> {
  db.insertMessage({ from: 'term_sender', to: mailbox, subject: 'Mail', type: 'status', runId })
  harness.runtime.notifyMessageArrived(mailbox, 'status')
  await vi.advanceTimersByTimeAsync(600)
}

/** A replacement PTY registered before any handle is issued for it, then observed idle. */
async function replacePtyWithoutHandle(harness: ReturnType<typeof createRuntime>): Promise<void> {
  harness.runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    incarnationId: 'replacement'
  })
  harness.runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 1)
  await harness.runtime.serializeMainTerminalBuffer(PTY_ID)
}

describe('Run and Dispatch mail for a pane whose PTY was replaced', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('wakes the pane coordinator of a Run created under the PTY a restart replaced', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    const harness = createRuntime(db)
    const run = db.createRun({
      objective: 'Run from the previous PTY',
      coordinatorHandle: 'term_previous_pty_in_pane',
      coordinatorPaneKey: PANE_KEY
    })
    await driveToLiveIdle(harness.runtime)

    await deliverWhileIdle(harness, db, `run:${run.id}`, run.id)

    expect(pointerCount(harness.write)).toBe(1)
    db.close()
  })

  it('wakes a Run coordinator whose replacement PTY has no handle issued yet', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    const harness = createRuntime(db)
    const run = db.createRun({
      objective: 'Replacement before handle inventory',
      coordinatorHandle: TERMINAL_HANDLE,
      coordinatorPaneKey: PANE_KEY
    })
    await replacePtyWithoutHandle(harness)

    await deliverWhileIdle(harness, db, `run:${run.id}`, run.id)

    expect(pointerCount(harness.write)).toBe(1)
    db.close()
  })

  it('wakes a headless Dispatch worker whose replacement PTY has no handle issued yet', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    const harness = createRuntime(db, { headless: true })
    const run = db.createRun({
      objective: 'Headless worker',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: SECOND_PANE_KEY
    })
    const task = db.createTask({ spec: 'worker', runId: run.id })
    const dispatch = createRootDispatch(db, task.id, TERMINAL_HANDLE, PANE_KEY)
    await replacePtyWithoutHandle(harness)

    await deliverWhileIdle(harness, db, `dispatch:${dispatch.id}`, run.id)

    expect(pointerCount(harness.write)).toBe(1)
    db.close()
  })

  it('resolves Run mail mid-reload without re-issuing the PTY handle', async () => {
    const db = new OrchestrationDb(':memory:')
    const harness = createRuntime(db)
    const run = db.createRun({
      objective: 'Reloading coordinator',
      coordinatorHandle: TERMINAL_HANDLE,
      coordinatorPaneKey: PANE_KEY
    })
    await harness.runtime.listTerminals()
    harness.runtime.markRendererReloading(1)
    const issue = vi.spyOn(harness.runtime, 'issuePtyHandle')

    const target = harness.runtime['orchestrationMailboxDeliveryTarget'].resolveTerminal(
      `run:${run.id}`
    )

    expect(target?.handle).toBe(TERMINAL_HANDLE)
    expect(issue).not.toHaveBeenCalled()
    db.close()
  })
})
