import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, expect, it, vi } from 'vitest'
import type { createTestStore as createStoreFixture } from '@/store/slices/store-test-helpers'
import { clientOnlyUnverifiableInspection } from '../../../../shared/terminal-process-inspection'
import { resolveWindowsShiftEnterEncodingForPane } from './terminal-windows-shift-enter'
import { buildRuntimeMobileAgentStatusProjection } from '@/runtime/sync-runtime-graph/agent-status-projection'
import { resolveRowAgentType } from '../sidebar/worktree-agent-row-type'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { PtyTransport } from './pty-transport-types'
import type { ColdRestoreAgentResumeStartup } from './pty-connection/fresh-spawn-types'
import { flushAsyncTicks } from './pty-connection-test-async'
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'
import { sendTerminalInputThroughPane } from './pty-connection-test-dom'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

afterEach(async () => {
  await restoreTerminalTestGlobals()
  vi.restoreAllMocks()
})

async function connectObservedPane(
  options: { ptyId?: string; appliedLaunch?: boolean; hookFirst?: boolean } = {}
) {
  vi.resetModules()
  vi.clearAllMocks()
  const transportFactoryQueue: MockTransport[] = []
  const createdTransportOptions: Record<string, unknown>[] = []
  let productionStore: ReturnType<typeof createStoreFixture> | undefined
  const mockStoreState: StoreState = createInitialStoreState(() => mockStoreState)
  bindPtyConnectionTestMocks({
    getState: () => mockStoreState,
    getProductionStore: () => productionStore,
    getTransportQueue: () => transportFactoryQueue,
    getTransportOptions: () => createdTransportOptions,
    getStoreSubscribers: () => [],
    setStoreSubscribers: () => {}
  })
  await installTerminalTestGlobals()
  const titleStatus = await import('@/lib/agent-status')
  const actualTitleStatus = await vi.importActual<typeof titleStatus>('@/lib/agent-status')
  vi.mocked(titleStatus.detectAgentStatusFromTitle).mockImplementation(
    actualTitleStatus.detectAgentStatusFromTitle
  )
  const createDeps = (overrides: Record<string, unknown>) =>
    buildPaneConnectionDeps(() => mockStoreState, overrides)
  vi.useFakeTimers()
  const { createTestStore, makeTab, makeWorktree, TEST_REPO } =
    await import('@/store/slices/store-test-helpers')
  Object.assign(window.api, {
    settings: { getSync: () => ({ terminalMainSideEffectAuthority: false }) }
  })
  const ptyId = options.ptyId ?? 'pty-late-interrupt'
  productionStore = createTestStore()
  const store = productionStore
  const { createGlobalSettingsFixture } =
    await import('../../../../shared/global-settings-test-fixture')
  store.setState({
    refreshGitHubForWorktreeIfStale: vi.fn(),
    settings: createGlobalSettingsFixture({ terminalMainSideEffectAuthority: false }),
    repos: [{ ...TEST_REPO, connectionId: null, executionHostId: 'local' }],
    worktreesByRepo: {
      [TEST_REPO.id]: [makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id, hostId: 'local' })]
    },
    tabsByWorktree: {
      'wt-1': [
        makeTab({
          id: 'tab-1',
          worktreeId: 'wt-1',
          ptyId,
          launchAgent: options.appliedLaunch || options.hookFirst ? 'omp' : undefined
        })
      ]
    }
  })
  const paneKey = makePaneKey('tab-1', LEAF_1)
  if (options.hookFirst) {
    store
      .getState()
      .setAgentStatus(paneKey, { state: 'working', agentType: 'pi', prompt: 'task' }, '⠋ Pi')
  }
  const statusWrites = vi.spyOn(store.getState(), 'setAgentStatus')
  const foregroundModule = await import('./pane-foreground-agent-tracker')
  const foregroundFactory = vi.spyOn(foregroundModule, 'createPaneForegroundAgentTracker')
  const completionModule = await import('./agent-completion-coordinator')
  const completionFactory = vi.spyOn(completionModule, 'createAgentCompletionCoordinator')
  const deferredModule = await import('./pty-connection/deferred-cold-restore-and-snapshot')
  const deferredSetup = vi.spyOn(deferredModule, 'bindDeferredColdRestoreAndSnapshot')
  const { connectPanePty } = await import('./pty-connection')
  const pane = createPane(1)
  const transport = createMockTransport(ptyId)
  let callbacks: ConnectCallbacks | undefined
  transport.attach.mockImplementation((args: Parameters<PtyTransport['attach']>[0]) => {
    callbacks = args.callbacks
  })
  transport.connect.mockImplementation(async (args) => {
    callbacks = args.callbacks
    return {
      id: ptyId,
      isReattach: true,
      incarnationId: 'same-incarnation',
      ...(options.appliedLaunch ? { launchAgent: 'omp' } : {})
    }
  })
  transportFactoryQueue.push(transport)
  const deps = createDeps({
    isVisibleRef: { current: false },
    restoredLeafId: LEAF_1,
    restoredPtyIdByLeafId: { [LEAF_1]: ptyId },
    setRuntimePaneTitle: vi.fn((tab: string, paneId: number, title: string) =>
      store.getState().setRuntimePaneTitle(tab, paneId, title)
    ),
    clearRuntimePaneTitle: vi.fn((tab: string, paneId: number) =>
      store.getState().clearRuntimePaneTitle(tab, paneId)
    )
  })
  const manager = createManager(1, 1)
  const binding = connectPanePty(...mockPanePtyArgs(pane, manager, deps))
  await vi.advanceTimersByTimeAsync(20)
  await flushAsyncTicks(20)
  const coordinator = completionFactory.mock.results.find((result) => result.type === 'return')
  if (!coordinator || coordinator.type !== 'return') {
    throw new Error('missing live completion coordinator')
  }
  const titleObservations = vi.spyOn(coordinator.value, 'observeTitle')
  const trackerResult = foregroundFactory.mock.results.find((result) => result.type === 'return')
  if (!trackerResult || trackerResult.type !== 'return') {
    throw new Error('missing actual tracker')
  }
  const tracker = trackerResult.value
  const session = deferredSetup.mock.calls[0]?.[0]
  if (!session) {
    throw new Error('missing live deferred connection session')
  }
  const onTitleChange = (title: string) => {
    const handler = createdTransportOptions[0].onTitleChange
    if (typeof handler !== 'function') {
      throw new Error('missing live title consumer')
    }
    handler(title, title)
  }
  const output = (data: string) => {
    if (!callbacks?.onData) {
      throw new Error('missing live data consumer')
    }
    callbacks.onData(data)
  }
  const appliedLaunch = (includeAgent = true) => {
    if (!callbacks?.onLaunchResult) {
      throw new Error('missing admitted launch consumer')
    }
    callbacks.onLaunchResult({
      ptyId,
      incarnationId: 'same-incarnation',
      ...(includeAgent ? { launchAgent: 'omp' as const } : {})
    })
  }
  const rebind = (nextPtyId: string, previousPtyId: string, incarnationId: string) => {
    const handler = createdTransportOptions[0].onPtyRebind
    if (typeof handler !== 'function') {
      throw new Error('missing real rebind consumer')
    }
    transport.getPtyId.mockReturnValue(nextPtyId)
    handler(nextPtyId, previousPtyId, incarnationId)
  }
  const exit = () => {
    const handler = createdTransportOptions[0].onPtyExit
    if (typeof handler !== 'function') {
      throw new Error('missing real exit consumer')
    }
    handler(ptyId, 0)
  }
  return {
    session,
    store,
    pane,
    transport,
    deps,
    manager,
    binding,
    tracker,
    rebind,
    paneKey,
    titleObservations,
    statusWrites,
    onTitleChange,
    output,
    appliedLaunch,
    exit
  }
}

it('keeps an acknowledged interrupt clear and refreshes GPU when the delayed tracker reports an owner', async () => {
  const {
    store,
    pane,
    deps,
    manager,
    binding,
    paneKey,
    titleObservations,
    statusWrites,
    onTitleChange,
    exit
  } = await connectObservedPane()
  let finishRead: ((value: string) => void) | undefined
  vi.mocked(window.api.pty.confirmForegroundProcess).mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        finishRead = resolve
      })
  )
  onTitleChange('✦ Gemini')
  expect(manager.setPaneGpuRendering).toHaveBeenLastCalledWith(1, false)
  expect(titleObservations).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(350)
  sendTerminalInputThroughPane(pane, '\x03')
  await flushAsyncTicks()
  await vi.advanceTimersByTimeAsync(500)
  expect(store.getState().runtimePaneTitlesByTabId['tab-1'][1]).toBe('Terminal')
  const effects = {
    title: titleObservations.mock.calls.length,
    cache: deps.setCacheTimerStartedAt.mock.calls.length,
    status: statusWrites.mock.calls.length,
    mode: pane.terminal.write.mock.calls.length
  }
  if (!finishRead) {
    throw new Error('missing production tracker read')
  }
  finishRead('omp')
  await flushAsyncTicks()
  expect(store.getState().paneForegroundAgentByPaneKey[paneKey]?.agent).toBe('omp')
  expect(manager.setPaneGpuRendering).toHaveBeenLastCalledWith(1, true)
  expect(store.getState().runtimePaneTitlesByTabId['tab-1'][1]).toBe('Terminal')
  expect(deps.updateTabTitle).toHaveBeenLastCalledWith('tab-1', 'Terminal')
  expect(titleObservations).toHaveBeenCalledTimes(effects.title)
  expect(deps.setCacheTimerStartedAt).toHaveBeenCalledTimes(effects.cache)
  expect(statusWrites).toHaveBeenCalledTimes(effects.status)
  expect(pane.terminal.write).toHaveBeenCalledTimes(effects.mode)
  onTitleChange('Pi ready')
  expect(store.getState().runtimePaneTitlesByTabId['tab-1'][1]).toBe('OMP ready')
  store.getState().setPaneForegroundAgent(paneKey, {
    agent: 'droid',
    agentEvidence: 'process-read',
    routingTrusted: true,
    shellForeground: false
  })
  vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('cmd.exe')
  binding.requestWindowsShiftEnterReconfirmation()
  await vi.advanceTimersByTimeAsync(350 + 350 + 1200 + 6000)
  expect(store.getState().paneForegroundAgentByPaneKey[paneKey]?.shellForeground).toBe(true)
  expect(store.getState().runtimePaneTitlesByTabId['tab-1'][1]).toBe('Terminal')
  store.getState().setPaneForegroundAgent(paneKey, {
    agent: 'omp',
    agentEvidence: 'process-read',
    shellForeground: false
  })
  expect(store.getState().runtimePaneTitlesByTabId['tab-1'][1]).toBe('Terminal')
  onTitleChange('Pi ready')
  expect(store.getState().runtimePaneTitlesByTabId['tab-1'][1]).toBe('OMP ready')
  exit()
  store.getState().setPaneForegroundAgent(paneKey, {
    agent: 'pi',
    agentEvidence: 'process-read',
    shellForeground: false
  })
  expect(store.getState().runtimePaneTitlesByTabId['tab-1']?.[1]).toBeUndefined()
  binding.dispose()
})

it.each([false, true])(
  'keeps exact applied launch binding across restore, late hook and inconclusive OSC (hookFirst=%s)',
  async (hookFirst) => {
    const c = await connectObservedPane({ appliedLaunch: !hookFirst, hookFirst })
    const { store, paneKey, binding, manager, onTitleChange, output, appliedLaunch, exit } = c
    if (hookFirst) {
      const before = store.getState().agentStatusByPaneKey[paneKey]
      expect(before.agentType).toBe('pi')
      const writes = c.statusWrites.mock.calls.length
      appliedLaunch()
      expect(store.getState().agentStatusByPaneKey[paneKey]).toEqual({
        ...before,
        agentType: 'omp',
        terminalTitle: '⠋ OMP'
      })
      expect(c.statusWrites).toHaveBeenCalledTimes(writes)
    }
    expect(store.getState().agentLaunchConfigByPaneKey[paneKey]).toBeUndefined()
    expect(store.getState().paneForegroundAgentByPaneKey[paneKey]?.agentEvidence).toBe(
      'launch-record'
    )
    onTitleChange('⠋ Pi')
    expect(store.getState().runtimePaneTitlesByTabId['tab-1'][1]).toBe('⠋ OMP')
    const accept = (state: 'working' | 'waiting' | 'done') =>
      store
        .getState()
        .setAgentStatus(
          paneKey,
          { state, agentType: 'pi', prompt: 'task' },
          state === 'working' ? '⠋ Pi' : 'Pi ready'
        )
    accept('working')
    expect(store.getState().agentStatusByPaneKey[paneKey].agentType).toBe('omp')
    const { resolveAgentStatusPaneOwner } = await import('../../../../shared/agent-status-identity')
    const assertCanonical = () => {
      const state = store.getState()
      expect(resolveAgentStatusPaneOwner(state, paneKey)).toBe('omp')
      expect(
        resolveRowAgentType(state.agentStatusByPaneKey[paneKey], state.tabsByWorktree['wt-1'][0])
      ).toBe('omp')
      expect(buildRuntimeMobileAgentStatusProjection(state.agentStatusByPaneKey)).toContain(
        '"agentType":"omp"'
      )
      expect(state.agentStatusByPaneKey[paneKey].terminalTitle).toBe('⠋ OMP')
    }
    assertCanonical()
    // Remove the hook: a title-only managed binding must also survive the actual OSC/read gap.
    store.setState({ agentStatusByPaneKey: {} })
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue(null)
    output('\x1b]133;C\x07')
    expect(store.getState().paneForegroundAgentByPaneKey[paneKey]?.agentEvidence).toBe(
      'launch-record'
    )
    await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
    expect(store.getState().paneForegroundAgentByPaneKey[paneKey]).toEqual(
      expect.objectContaining({
        agent: 'omp',
        agentEvidence: 'launch-record',
        shellForeground: false
      })
    )
    output('\x1b]133;D;0\x07')
    await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
    expect(store.getState().paneForegroundAgentByPaneKey[paneKey]).toEqual(
      expect.objectContaining({
        agent: 'omp',
        agentEvidence: 'launch-record',
        shellForeground: false
      })
    )
    onTitleChange('⠋ Pi')
    expect(store.getState().runtimePaneTitlesByTabId['tab-1'][1]).toBe('⠋ OMP')
    accept('working')
    assertCanonical()
    accept('waiting')
    accept('done')
    accept('working')
    expect(store.getState().agentStatusByPaneKey[paneKey].agentType).toBe('omp')
    // A different actual process supersedes the applied launch; launch replays cannot demote it.
    store.getState().setPaneForegroundAgent(paneKey, {
      agent: 'gemini',
      agentEvidence: 'process-read',
      shellForeground: false
    })
    appliedLaunch()
    onTitleChange('Pi ready')
    expect(store.getState().runtimePaneTitlesByTabId['tab-1'][1]).toBe('Pi ready')
    store.getState().setPaneForegroundAgent(paneKey, { agent: null, shellForeground: true })
    appliedLaunch()
    expect(resolveAgentStatusPaneOwner(store.getState(), paneKey)).toBeUndefined()
    store.getState().retireAgentPaneAuthority(paneKey)
    appliedLaunch()
    expect(resolveAgentStatusPaneOwner(store.getState(), paneKey)).toBeUndefined()
    exit()
    binding.dispose()
    manager.setPaneGpuRendering.mockClear()
    appliedLaunch()
    expect(manager.setPaneGpuRendering).not.toHaveBeenCalled()
  }
)

it('keeps a handle rotation but retires hook, registry and launch evidence on actual incarnation replacement', async () => {
  const c = await connectObservedPane({ appliedLaunch: true })
  const { resolveAgentStatusPaneOwner } = await import('../../../../shared/agent-status-identity')
  const { retainedAgentEntryFromLive } =
    await import('@/store/slices/agent-status/agent-status-pane-key-tab-binding')
  const owner = () => resolveAgentStatusPaneOwner(c.store.getState(), c.paneKey)
  c.store
    .getState()
    .setAgentStatus(c.paneKey, { agentType: 'pi', state: 'working', prompt: 'task' })
  c.store
    .getState()
    .registerAgentLaunchConfig(
      c.paneKey,
      { agentCommand: 'omp', agentArgs: '', agentEnv: {} },
      { agentType: 'omp', launchToken: 'old-launch' }
    )
  const before = c.store.getState()
  const retained = retainedAgentEntryFromLive(
    before,
    'wt-1',
    before.agentStatusByPaneKey[c.paneKey],
    'omp'
  )
  c.store.setState({ retainedAgentsByPaneKey: { [c.paneKey]: retained } })
  expect(owner()).toBe('omp')
  c.rebind('pty-rotated', 'pty-late-interrupt', 'same-incarnation')
  expect(c.store.getState().agentStatusByPaneKey[c.paneKey]).toBe(
    before.agentStatusByPaneKey[c.paneKey]
  )
  expect(c.store.getState().agentLaunchConfigByPaneKey[c.paneKey]).toBe(
    before.agentLaunchConfigByPaneKey[c.paneKey]
  )
  expect(owner()).toBe('omp')
  let settle: ((value: string) => void) | undefined
  vi.mocked(window.api.pty.confirmForegroundProcess).mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        settle = resolve
      })
  )
  c.output('\x1b]133;C\x07')
  await vi.advanceTimersByTimeAsync(350)
  expect(c.tracker.hasReadInFlight()).toBe(true)
  c.rebind('pty-replaced', 'pty-rotated', 'new-incarnation')
  expect(owner()).toBeUndefined()
  expect(c.store.getState().agentStatusByPaneKey[c.paneKey]).toBeUndefined()
  expect(c.store.getState().agentLaunchConfigByPaneKey[c.paneKey]).toBeUndefined()
  expect(c.store.getState().retainedAgentsByPaneKey[c.paneKey]).toBe(retained)
  if (!settle) {
    throw new Error('missing old incarnation read')
  }
  settle('omp')
  await flushAsyncTicks()
  expect(owner()).toBeUndefined()
  c.onTitleChange('Pi ready')
  expect(c.store.getState().runtimePaneTitlesByTabId['tab-1'][1]).toBe('Pi ready')
  c.store.getState().setPaneForegroundAgent(c.paneKey, {
    agent: 'codex',
    agentEvidence: 'process-read',
    shellForeground: false
  })
  c.rebind('pty-replaced', 'pty-replaced', 'same-handle-new-incarnation')
  expect(owner()).toBeUndefined()
  c.binding.dispose()
  const disposed = c.store.getState()
  c.rebind('pty-disposed', 'pty-replaced', 'disposed-incarnation')
  expect(c.store.getState()).toBe(disposed)
  expect(c.tracker.hasReadInFlight()).toBe(false)
})

it('preserves a new launch registered by the real resume flow before its incarnation result', async () => {
  const c = await connectObservedPane({ appliedLaunch: true })
  const startup = {
    command: 'omp --session resumed-session',
    agent: 'omp',
    resumeOrigin: 'saved',
    resumeProviderSession: { key: 'session_id', id: 'resumed-session' },
    launchConfig: { agentCommand: 'omp', agentArgs: '--model resumed', agentEnv: {} },
    launchToken: 'new-launch-token',
    useLiveEntry: false,
    hasSleepingRecord: false,
    sleepingRecordEntry: null
  } satisfies ColdRestoreAgentResumeStartup
  let registered:
    | ReturnType<typeof c.store.getState>['agentLaunchConfigByPaneKey'][string]
    | undefined
  c.transport.connect.mockImplementation(async () => {
    registered = c.store.getState().agentLaunchConfigByPaneKey[c.paneKey]
    expect(registered?.identity.launchToken).toBe(startup.launchToken)
    expect(c.session.inputModeOwnerIncarnationId).toBeNull()
    c.transport.getPtyId.mockReturnValue('pty-resumed')
    return {
      id: 'pty-resumed',
      incarnationId: 'resumed-incarnation',
      launchConfig: startup.launchConfig,
      launchToken: startup.launchToken,
      launchAgent: startup.agent
    }
  })
  const pending = c.session.spawnColdRestoreAgentResume(startup)
  await flushAsyncTicks(20)
  await vi.advanceTimersByTimeAsync(20)
  expect(await pending).toBe('pty-resumed')
  expect(registered).toBeDefined()
  expect(c.store.getState().agentLaunchConfigByPaneKey[c.paneKey]).toBe(registered)
  expect(c.session.inputModeOwnerIncarnationId).toBe('resumed-incarnation')
  c.binding.dispose()
})

it.each(['command', 'command-finished'] as const)(
  'settles a remote forced read handed to %s, then retries through accepted input',
  async (successor) => {
    const c = await connectObservedPane({ ptyId: 'ssh:conn-1@@term-1' })
    const { store, pane, paneKey, binding, output } = c
    c.appliedLaunch(false)
    const runtimeInspection = await import('@/runtime/runtime-terminal-inspection')
    let epoch = 0
    const live = (processName = 'droid') => ({
      foregroundProcess: processName,
      hasChildProcesses: processName === 'droid',
      foregroundProcessEvidence: {
        verdict: 'live' as const,
        processName,
        authorityGeneration: 'test-authority',
        observationEpoch: ++epoch,
        capturedAgeMs: 0,
        ptyId: 'term-1',
        ptyIncarnationId: 'same-incarnation',
        fence: {
          platform: 'windows' as const,
          rootProcessId: 1,
          rootCreationTime: 'test-start',
          sessionId: 'test-session'
        }
      }
    })
    const inspect = vi
      .spyOn(runtimeInspection, 'inspectRuntimeTerminalProcess')
      .mockImplementation(async () => live())
    const encoding = () => resolveWindowsShiftEnterEncodingForPane(store.getState(), paneKey)
    sendTerminalInputThroughPane(pane, '\r')
    await flushAsyncTicks()
    await vi.advanceTimersByTimeAsync(350)
    expect(inspect).toHaveBeenCalledTimes(1)
    expect(inspect).toHaveBeenCalledWith('ssh:conn-1@@term-1', {
      expectedIncarnationId: 'same-incarnation'
    })
    expect(store.getState().paneForegroundAgentByPaneKey[paneKey]).toEqual(
      expect.objectContaining({ agent: 'droid', routingTrusted: true })
    )
    expect(encoding()).toBe('csi-u')
    inspect.mockResolvedValue(clientOnlyUnverifiableInspection('timeout'))
    sendTerminalInputThroughPane(pane, '\r')
    await flushAsyncTicks()
    expect(store.getState().paneForegroundAgentByPaneKey[paneKey]?.routingConfirmationPending).toBe(
      true
    )
    output('\x1b]133;C\x07')
    if (successor === 'command-finished') {
      output('\x1b]133;D;0\x07')
    }
    for (let i = 0; i < 10; i += 1) {
      sendTerminalInputThroughPane(pane, '\r')
    }
    await flushAsyncTicks()
    await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
    expect(inspect).toHaveBeenCalledTimes(4)
    expect(store.getState().paneForegroundAgentByPaneKey[paneKey]).toEqual({
      agent: 'droid',
      agentEvidence: 'process-read',
      routingRevoked: true,
      shellForeground: false
    })
    expect(encoding()).toBe('alt-enter')
    expect(c.tracker.hasReadInFlight()).toBe(false)
    await vi.advanceTimersByTimeAsync(10000)
    expect(inspect).toHaveBeenCalledTimes(4)
    inspect.mockImplementation(async () => live())
    sendTerminalInputThroughPane(pane, '\r')
    await flushAsyncTicks()
    await vi.advanceTimersByTimeAsync(350)
    expect(inspect).toHaveBeenCalledTimes(5)
    expect(encoding()).toBe('csi-u')
    // An admitted shell result remains genuine shell proof in the forced sampler.
    inspect.mockImplementation(async () => live('cmd.exe'))
    sendTerminalInputThroughPane(pane, '\r')
    await flushAsyncTicks()
    await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
    expect(store.getState().paneForegroundAgentByPaneKey[paneKey]?.shellForeground).toBe(true)
    expect(encoding()).toBe('alt-enter')
    // A reply for an old PTY/incarnation cannot publish into its replacement.
    let settle: ((value: ReturnType<typeof live>) => void) | undefined
    inspect.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve
        })
    )
    sendTerminalInputThroughPane(pane, '\r')
    await flushAsyncTicks()
    await vi.advanceTimersByTimeAsync(350)
    c.rebind('ssh:conn-1@@replacement', 'ssh:conn-1@@term-1', 'replacement-incarnation')
    const replacement = store.getState().paneForegroundAgentByPaneKey[paneKey]
    if (!settle) {
      throw new Error('missing real pending provider')
    }
    settle(live())
    await flushAsyncTicks()
    expect(store.getState().paneForegroundAgentByPaneKey[paneKey]).toBe(replacement)
    sendTerminalInputThroughPane(pane, '\r')
    await flushAsyncTicks()
    await vi.advanceTimersByTimeAsync(350)
    expect(c.tracker.hasReadInFlight()).toBe(true)
    binding.dispose()
    expect(c.tracker.hasReadInFlight()).toBe(false)
    settle(live())
    await flushAsyncTicks()
    expect(store.getState().paneForegroundAgentByPaneKey[paneKey]).toBe(replacement)
    const calls = inspect.mock.calls.length
    output('\x1b]133;C\x07')
    sendTerminalInputThroughPane(pane, '\r')
    await flushAsyncTicks()
    await vi.advanceTimersByTimeAsync(10000)
    expect(inspect).toHaveBeenCalledTimes(calls)
  }
)
