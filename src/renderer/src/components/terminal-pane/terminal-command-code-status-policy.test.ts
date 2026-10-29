import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'

const PTY_ID_LOCAL = 'pty-1'
const TAB_ID = 'tab-1'
const WORKTREE_ID = 'repo-1::/tmp/wt-1'
const PANE_KEY = `${TAB_ID}:11111111-1111-4111-8111-111111111111`
const PANE_ID = 1
// Mirrors COMMAND_CODE_OUTPUT_DONE_SETTLE_MS.
const DONE_SETTLE_MS = 1500

const ROUTING = { connectionId: null }

type MockStoreState = {
  tabsByWorktree: Record<string, { id: string; launchAgent?: AgentType }[]>
  agentStatusByPaneKey: Record<string, AgentStatusEntry | undefined>
  retainedAgentsByPaneKey: Record<string, { agentType: AgentType } | undefined>
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry>
  agentLaunchConfigByPaneKey: Record<string, { identity: { agentType?: AgentType } } | undefined>
  runtimePaneTitlesByTabId: Record<string, Record<number, string | undefined>>
  setCacheTimerStartedAt: ReturnType<typeof vi.fn>
  setAgentStatus: ReturnType<typeof vi.fn>
  dropAgentStatus: ReturnType<typeof vi.fn>
  clearAgentLaunchConfig: ReturnType<typeof vi.fn>
  setPaneForegroundAgent: ReturnType<typeof vi.fn>
}

let mockStoreState: MockStoreState
const dispatchTerminalCommandFinishedEvent = vi.fn()
const resolveLiveAgentStatusConnectionRouting = vi.fn()
const getConnectionIdFromState = vi.fn()

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mockStoreState, subscribe: vi.fn(() => () => {}) }
}))
vi.mock('@/hooks/terminal-command-finished-event', () => ({
  dispatchTerminalCommandFinishedEvent
}))
vi.mock('@/lib/agent-status-connection-ownership', () => ({
  resolveLiveAgentStatusConnectionRouting
}))
vi.mock('@/lib/connection-owner-resolution', () => ({
  getConnectionIdFromState
}))

function makeMockStoreState(): MockStoreState {
  const initialStore: ReturnType<typeof createInitialStoreState> = createInitialStoreState(
    () => initialStore
  )
  return {
    ...initialStore,
    settings: { promptCacheTimerEnabled: true },
    tabsByWorktree: { [WORKTREE_ID]: [{ id: TAB_ID }] },
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    paneForegroundAgentByPaneKey: {},
    agentLaunchConfigByPaneKey: {},
    runtimePaneTitlesByTabId: { [TAB_ID]: { [PANE_ID]: '✳ Build feature' } },
    setAgentStatus: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
    dropAgentStatus: vi.fn(),
    clearAgentLaunchConfig: vi.fn(),
    setPaneForegroundAgent: vi.fn()
  }
}

function makeStatusEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'build the feature',
    agentType: 'claude',
    updatedAt: 1000,
    stateStartedAt: 1000,
    ...overrides
  } as AgentStatusEntry
}

async function createPolicy(ptyId: string) {
  const { createTerminalResidentPolicy } = await import('./terminal-resident-policy')
  const policy = createTerminalResidentPolicy(
    {
      worktreeId: WORKTREE_ID,
      tabId: TAB_ID,
      paneKey: PANE_KEY,
      cwd: '',
      initialTitle: mockStoreState.runtimePaneTitlesByTabId[TAB_ID]?.[PANE_ID]
    },
    { endpoint: 'local', executionHost: 'local', ptyId, runtimeId: null, incarnationId: null },
    () => true
  )
  return { ...policy.commandCode, dispose: () => policy.dispose() }
}

describe('terminal Command Code status policy', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    dispatchTerminalCommandFinishedEvent.mockClear()
    resolveLiveAgentStatusConnectionRouting.mockReset().mockReturnValue(ROUTING)
    getConnectionIdFromState.mockReset().mockReturnValue(null)
    mockStoreState = makeMockStoreState()
    vi.stubGlobal('window', {
      api: {
        pty: {
          inspectProcess: vi
            .fn()
            .mockResolvedValue({ foregroundProcess: null, hasChildProcesses: false })
        }
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('seeds a Command Code working row with the current pane title', async () => {
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeWorking('Fix the spinner')

    expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
      PANE_KEY,
      {
        state: 'working',
        prompt: 'Fix the spinner',
        agentType: 'command-code',
        // Why: the row is read off the pane's own output, not a provider signal (STA-4293).
        observation: expect.objectContaining({ origin: 'process', kind: 'transition' })
      },
      '✳ Build feature',
      undefined,
      ROUTING
    )
    policy.dispose()
  })

  it('writes nothing when connection routing does not resolve', async () => {
    resolveLiveAgentStatusConnectionRouting.mockReturnValue(undefined)
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeWorking('Fix the spinner')

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    policy.dispose()
  })

  it('rejects scrape status when a Claude hook owns the pane', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({ state: 'done' })
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeWorking('False prompt')
    policy.onCommandCodeDone('False prompt')
    vi.advanceTimersByTime(DONE_SETTLE_MS)

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    policy.dispose()
  })

  it('rejects scrape status when retained Claude identity owns the pane', async () => {
    mockStoreState.retainedAgentsByPaneKey[PANE_KEY] = { agentType: 'claude' }
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({ agentType: 'unknown' })
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeWorking('False prompt')
    policy.onCommandCodeDone('False prompt')
    vi.advanceTimersByTime(DONE_SETTLE_MS)

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    policy.dispose()
  })

  it('rejects scrape status when Claude launch metadata owns the pane', async () => {
    mockStoreState.tabsByWorktree[WORKTREE_ID] = [{ id: TAB_ID, launchAgent: 'claude' }]
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeWorking('False prompt')

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    policy.dispose()
  })

  it('rejects scrape status when Claude is the foreground process', async () => {
    mockStoreState.paneForegroundAgentByPaneKey[PANE_KEY] = {
      agent: 'claude',
      shellForeground: false
    }
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeWorking('False prompt')

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    policy.dispose()
  })

  it('lets a current Command Code process reclaim stale Claude ownership', async () => {
    mockStoreState.tabsByWorktree[WORKTREE_ID] = [{ id: TAB_ID, launchAgent: 'claude' }]
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({ state: 'done' })
    mockStoreState.retainedAgentsByPaneKey[PANE_KEY] = { agentType: 'claude' }
    mockStoreState.paneForegroundAgentByPaneKey[PANE_KEY] = {
      agent: 'command-code',
      shellForeground: false
    }
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeWorking('New Command Code prompt')

    expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
      PANE_KEY,
      {
        state: 'working',
        prompt: 'New Command Code prompt',
        agentType: 'command-code',
        observation: expect.objectContaining({ origin: 'process', kind: 'transition' })
      },
      '✳ Build feature',
      undefined,
      ROUTING
    )
    policy.dispose()
  })

  it('leaves a settled done row alone when working repeats the same prompt', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'done',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeWorking('Fix the spinner')
    policy.onCommandCodeWorking('')

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    policy.dispose()
  })

  it('settles a still-working Command Code row to done after the settle window', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'working',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeDone('Fix the spinner')
    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    vi.advanceTimersByTime(DONE_SETTLE_MS)

    expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
      PANE_KEY,
      {
        state: 'done',
        prompt: 'Fix the spinner',
        agentType: 'command-code',
        observation: expect.objectContaining({ origin: 'process', kind: 'transition' })
      },
      '✳ Build feature',
      undefined,
      ROUTING
    )
    policy.dispose()
  })

  it('abandons the done settle when another agent owns the row by then', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({ agentType: 'claude' })
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeDone('Fix the spinner')
    vi.advanceTimersByTime(DONE_SETTLE_MS)

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    policy.dispose()
  })

  it('cancels a pending done settle when a working repaint arrives', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'working',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeDone('Fix the spinner')
    policy.onCommandCodeWorking('Fix the spinner')
    vi.advanceTimersByTime(DONE_SETTLE_MS * 2)

    const states = mockStoreState.setAgentStatus.mock.calls.map(([, payload]) => payload.state)
    expect(states).toEqual(['working'])
    policy.dispose()
  })

  // Reveal inherits the settle deadline; flushing early would make the same-prompt guard reject a genuine working repaint.
  it('dispose hands the pending settle to the remounted pane instead of completing it early', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'working',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    const policy = await createPolicy(PTY_ID_LOCAL)
    const { setCommandCodeDoneSettleExecutor } = await import('./command-code-done-settle')

    policy.onCommandCodeDone('Fix the spinner')
    vi.advanceTimersByTime(DONE_SETTLE_MS - 1)
    const revealedPaneSettle = vi.fn()
    setCommandCodeDoneSettleExecutor(PANE_KEY, revealedPaneSettle)
    policy.dispose()

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(revealedPaneSettle).toHaveBeenCalledExactlyOnceWith('Fix the spinner')
  })

  // A revealed pane’s working repaint before the inherited deadline must still cancel completion.
  it('lets a working repaint after the handoff cancel the transferred settle', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'working',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    const policy = await createPolicy(PTY_ID_LOCAL)
    const { cancelCommandCodeDoneSettle, setCommandCodeDoneSettleExecutor } =
      await import('./command-code-done-settle')

    policy.onCommandCodeDone('Fix the spinner')
    const revealedPaneSettle = vi.fn()
    setCommandCodeDoneSettleExecutor(PANE_KEY, revealedPaneSettle)
    policy.dispose()
    cancelCommandCodeDoneSettle(PANE_KEY)
    vi.advanceTimersByTime(DONE_SETTLE_MS * 2)

    expect(revealedPaneSettle).not.toHaveBeenCalled()
    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
  })

  it('dispose does not flush a settle a working repaint already cancelled', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'working',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeDone('Fix the spinner')
    policy.onCommandCodeWorking('Fix the spinner')
    policy.dispose()

    const states = mockStoreState.setAgentStatus.mock.calls.map(([, payload]) => payload.state)
    expect(states).toEqual(['working'])
  })

  it('dispose does not flush when another agent owns the row by then', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({ agentType: 'claude' })
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeDone('Fix the spinner')
    policy.dispose()

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
  })

  it('dispose after the settle fired writes done exactly once', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'working',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeDone('Fix the spinner')
    vi.advanceTimersByTime(DONE_SETTLE_MS)
    policy.dispose()

    expect(mockStoreState.setAgentStatus).toHaveBeenCalledTimes(1)
  })
})

describe('readInFlightCommandCodeTurn', () => {
  beforeEach(() => {
    vi.resetModules()
    mockStoreState = makeMockStoreState()
    vi.stubGlobal('window', {
      api: {
        pty: {
          inspectProcess: vi
            .fn()
            .mockResolvedValue({ foregroundProcess: null, hasChildProcesses: false })
        }
      }
    })
  })

  it('returns only a working command-code turn', async () => {
    const { readInFlightCommandCodeTurn } = await import('./terminal-command-code-status-policy')

    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'working',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    expect(readInFlightCommandCodeTurn(PANE_KEY)).toEqual({ prompt: 'Fix the spinner' })

    // Done rows cannot seed a live detector: a replacement process could be scraped as Command Code.
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'done',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    expect(readInFlightCommandCodeTurn(PANE_KEY)).toBeNull()

    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({ agentType: 'claude' })
    expect(readInFlightCommandCodeTurn(PANE_KEY)).toBeNull()

    delete mockStoreState.agentStatusByPaneKey[PANE_KEY]
    expect(readInFlightCommandCodeTurn(PANE_KEY)).toBeNull()
  })
})
