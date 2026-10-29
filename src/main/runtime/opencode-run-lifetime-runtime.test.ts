import { TerminalSnapshotState } from '../../shared/terminal-snapshot-state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeTerminalAgentStatusEvent } from './runtime-terminal-contracts'

const WORKTREE_ID = 'repo::/worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`

function createRuntime(): {
  runtime: OrcaRuntimeService
  statuses: RuntimeTerminalAgentStatusEvent[]
  channelOrder: string[]
} {
  const statuses: RuntimeTerminalAgentStatusEvent[] = []
  const channelOrder: string[] = []
  const runtime = new OrcaRuntimeService(undefined, undefined, {
    onTerminalAgentStatus: (event) => {
      statuses.push(event)
      channelOrder.push(`status:${event.payload.state}`)
    },
    onTerminalSideEffects: (batch) =>
      channelOrder.push(...batch.facts.map((fact) => `fact:${fact.kind}`))
  })
  runtime.setPtyController({
    spawn: vi.fn(),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'opencode'
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      { tabId: 'tab-1', worktreeId: WORKTREE_ID, leafId: LEAF_ID, paneRuntimeId: 1, ptyId: 'pty-1' }
    ]
  })
  return { runtime, statuses, channelOrder }
}

const summary = (statuses: RuntimeTerminalAgentStatusEvent[]): string[] =>
  statuses.map(
    (event) =>
      `${event.paneKey}:${event.payload.state}${event.payload.interrupted ? ':interrupted' : ''}:${event.origin}`
  )

describe('generic terminal observation authority', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it('keeps installed observations authoritative across a display gap and later visibility marker', async () => {
    const { runtime, statuses, channelOrder } = createRuntime()
    const source = new TerminalSnapshotState()
    runtime.applyTerminalTransientObservation('pty-1', 'incarnation', source.snapshot())
    expect(statuses).toEqual([])
    expect(channelOrder).toEqual([])
    runtime.onPtyData('pty-1', '\x1b]133;C\x07', 100)
    source.record({ kind: 'command-started' }, 100)
    source.record(
      {
        kind: 'agent-status',
        payload: { state: 'working', prompt: '', agentType: 'opencode' }
      },
      101
    )
    runtime.applyTerminalTransientObservation('pty-1', 'incarnation', source.snapshot())
    runtime.notePtyDataGap('pty-1', 1000)
    runtime.setPtyTransientFactDelegation('pty-1', false)
    runtime.onPtyData('pty-1', '\x1b]133;D;0\x07\x1b]133;A\x07', 101)
    expect(summary(statuses)).toEqual([`${PANE_KEY}:working:undefined`])
    source.record({ kind: 'command-finished', exitCode: 0 }, 102)
    source.record(
      {
        kind: 'agent-status',
        payload: { state: 'done', prompt: '', agentType: 'opencode' }
      },
      103
    )
    runtime.applyTerminalTransientObservation('pty-1', 'incarnation', source.snapshot())
    expect(summary(statuses)).toEqual([
      `${PANE_KEY}:working:undefined`,
      `${PANE_KEY}:done:undefined`
    ])
    expect(channelOrder).toEqual([
      'fact:command-started',
      'status:working',
      'fact:agent-status',
      'fact:command-finished',
      'status:done',
      'fact:agent-status'
    ])
  })

  it('keeps projection counters continuous through an actual provider source replacement and rollback', () => {
    const { runtime, channelOrder } = createRuntime()
    const first = new TerminalSnapshotState()
    const capable = { provider: {}, stream: {}, terminalState: true }
    runtime.applyTerminalTransientObservation('pty-1', 'physical', first.snapshot(), capable)
    first.record({ kind: 'bell' }, 10)
    runtime.applyTerminalTransientObservation('pty-1', 'physical', first.snapshot(), capable)
    const before = runtime.getTerminalSideEffectSnapshot('pty-1')?.terminalState?.snapshot
    expect(before?.effects.bell?.count).toBe(1)
    const legacy = { provider: {}, stream: {}, terminalState: false }
    runtime.selectPtyLegacySemanticSource('pty-1', legacy)
    runtime.onPtyData('pty-1', '\x07', 20)
    expect(channelOrder.filter((kind) => kind === 'fact:bell')).toHaveLength(2)
    const replacement = new TerminalSnapshotState()
    replacement.record({ kind: 'bell' }, 30)
    const newSource = { provider: legacy.provider, stream: {}, terminalState: true }
    runtime.applyTerminalTransientObservation(
      'pty-1',
      'physical',
      replacement.snapshot(),
      newSource
    )
    expect(channelOrder.filter((kind) => kind === 'fact:bell')).toHaveLength(2)
    replacement.record({ kind: 'bell' }, 40)
    runtime.applyTerminalTransientObservation(
      'pty-1',
      'physical',
      replacement.snapshot(),
      newSource
    )
    const after = runtime.getTerminalSideEffectSnapshot('pty-1')?.terminalState?.snapshot
    expect(after?.effects.bell?.count).toBe(3)
    expect(channelOrder.filter((kind) => kind === 'fact:bell')).toHaveLength(3)
    runtime.onPtyExit('pty-1', 0)
  })

  it('does not synthesize a status for an exited one-shot command', async () => {
    const { runtime, statuses, channelOrder } = createRuntime()
    runtime.onPtyData('pty-1', '\x1b]133;C\x07', 100)
    await vi.advanceTimersByTimeAsync(5000)
    runtime.onPtyData('pty-1', 'done\x1b]133;D;0\x07', 101)
    await vi.advanceTimersByTimeAsync(5000)
    expect(statuses).toEqual([])
    expect(channelOrder).toEqual(['fact:command-started', 'fact:command-finished'])
  })
})
