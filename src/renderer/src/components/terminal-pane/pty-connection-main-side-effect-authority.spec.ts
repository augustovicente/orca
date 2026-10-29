import type { createRemoteRuntimePtyTransport } from './remote-runtime-pty-transport'
import { registerPersistedResidentAuthorityTests } from './pty-connection-persisted-resident-authority.spec'
import { TerminalSnapshotState } from '../../../../shared/terminal-snapshot-state'
import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { sendTerminalInputThroughPane } from './pty-connection-test-dom'
import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import { AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS } from './pty-connection-test-constants'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import {
  createInitialStoreState,
  buildActiveRuntimeEnvironmentState
} from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

export function registerPtyConnectionMainSideEffectAuthorityTests(): void {
  let mockStoreState: StoreState
  let realRemoteTransportFactory: typeof createRemoteRuntimePtyTransport | undefined
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  // Why: activeRuntimeEnvironmentId exercises the remote-runtime path where the renderer still owns OSC 9999 status.
  function enableActiveRuntimeEnvironment(environmentId = 'env-1'): void {
    mockStoreState = buildActiveRuntimeEnvironmentState(mockStoreState, environmentId)
  }

  function notifyStoreSubscribers(): void {
    for (const listener of storeSubscribers.slice()) {
      listener(mockStoreState)
    }
  }

  describe('connectPanePty', () => {
    beforeEach(async () => {
      vi.resetModules()
      vi.clearAllMocks()
      transportFactoryQueue = []
      realRemoteTransportFactory = undefined
      createdTransportOptions = []
      storeSubscribers = []
      mockStoreState = createInitialStoreState(() => mockStoreState)
      bindPtyConnectionTestMocks({
        getState: () => mockStoreState,
        getRemoteTransportFactory: () => realRemoteTransportFactory,
        getTransportQueue: () => transportFactoryQueue,
        getTransportOptions: () => createdTransportOptions,
        getStoreSubscribers: () => storeSubscribers,
        setStoreSubscribers: (subscribers) => {
          storeSubscribers = subscribers
        }
      })
      await installTerminalTestGlobals()
    })

    afterEach(async () => {
      await restoreTerminalTestGlobals()
    })

    registerPersistedResidentAuthorityTests({
      getState: () => mockStoreState,
      enableRemote: enableActiveRuntimeEnvironment,
      setTransportFactory: (factory) => {
        realRemoteTransportFactory = factory
      }
    })

    describe('with main side-effect authority on', () => {
      const SIDE_EFFECT_PARSER_CALLBACKS = [
        'onTitleChange',
        'onBell',
        'onAgentBecameIdle',
        'onAgentBecameWorking',
        'onAgentExited'
      ] as const

      function enableMainAuthority(): void {
        mockStoreState.settings = {
          ...mockStoreState.settings,
          terminalMainSideEffectAuthority: true
        }
      }

      it('omits byte-parser callbacks from the local transport options', async () => {
        enableMainAuthority()
        const { connectPanePty } = await import('./pty-connection')
        const transport = createMockTransport()
        transportFactoryQueue.push(transport)

        connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)

        expect(createdTransportOptions[0]).toBeDefined()
        for (const callback of SIDE_EFFECT_PARSER_CALLBACKS) {
          expect(createdTransportOptions[0]?.[callback]).toBeUndefined()
        }
        // Lifecycle callbacks stay on the transport; only side-effect parsing moves to the fact consumer.
        expect(createdTransportOptions[0]?.onPtySpawn).toBeTypeOf('function')
        expect(createdTransportOptions[0]?.onPtyExit).toBeTypeOf('function')
      })

      it('keeps byte-parser callbacks on remote-runtime transports', async () => {
        enableMainAuthority()
        enableActiveRuntimeEnvironment()
        const { connectPanePty } = await import('./pty-connection')
        const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
        const transport = createMockTransport()
        transportFactoryQueue.push(transport)

        connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)

        expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('env-1', expect.any(Object))
        for (const callback of SIDE_EFFECT_PARSER_CALLBACKS) {
          expect(createdTransportOptions[0]?.[callback]).toBeTypeOf('function')
        }
      })

      it('keeps prebinding input acknowledgement and pending completion after detaching', async () => {
        enableMainAuthority()
        vi.useFakeTimers()
        Object.assign(mockStoreState, { isPtyShutdownPending: () => false })
        const { connectPanePty } = await import('./pty-connection')
        const handler = await import('./terminal-side-effect-facts-handler')
        const transport = createMockTransport()
        const accepted = createDeferred<boolean>()
        transport.sendInputAccepted = vi.fn(() => accepted.promise)
        transportFactoryQueue.push(transport)
        const pane = createPane(1)
        const deps = createDeps()
        const connection = connectPanePty(pane as never, createManager(1) as never, deps as never)
        sendTerminalInputThroughPane(pane, '\x03')
        expect(transport.sendInputAccepted).toHaveBeenCalledOnce()
        expect(handler.getTerminalSemanticResident('pty-prebinding')).toBeUndefined()
        const spawn = createdTransportOptions[0]?.onPtySpawn
        if (typeof spawn !== 'function') {
          throw new Error('Expected physical spawn callback')
        }
        spawn('pty-prebinding')
        const source = new TerminalSnapshotState()
        const deliver = () =>
          handler._dispatchTerminalSideEffectBatchForTest({
            ptyId: 'pty-prebinding',
            seq: source.state.revision,
            facts: [],
            paneKey: makePaneKey('tab-1', LEAF_1),
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            terminalState: {
              runtimeId: 'runtime-1',
              incarnationId: 'incarnation-1',
              snapshot: source.snapshot()
            }
          })
        deliver()
        const resident = handler.getTerminalSemanticResident('pty-prebinding')
        source.record({ kind: 'agent-working' })
        deliver()
        source.record({ kind: 'agent-idle', title: 'Codex done', status: 'idle' })
        deliver()
        expect(resident?.policy.notification.hasPendingAgentTaskCompleteNotification()).toBe(true)
        connection.dispose()
        accepted.resolve(true)
        await flushAsyncTicks()
        expect(resident?.isLive).toBe(true)
        expect(resident?.policy.input.pendingTerminalInputWrite).toBeNull()
        expect(resident?.policy.notification.hasPendingAgentTaskCompleteNotification()).toBe(true)
        await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
        expect(deps.dispatchNotification).toHaveBeenCalledOnce()
        expect(deps.dispatchNotification).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'agent-task-complete',
            ptyId: 'pty-prebinding',
            terminalTitle: 'Codex done'
          })
        )
        handler.observeTerminalSemanticResidentExit('pty-prebinding', 0, 'incarnation-1')
      })

      it('keeps one execution across detach and consumes a gap without retiring the next command', async () => {
        enableMainAuthority()
        vi.useFakeTimers()
        const { connectPanePty } = await import('./pty-connection')
        const handler = await import('./terminal-side-effect-facts-handler')
        const transport = createMockTransport()
        transportFactoryQueue.push(transport)
        const deps = createDeps()
        Object.assign(mockStoreState, {
          markTerminalBell: deps.markTerminalBell,
          setCacheTimerStartedAt: deps.setCacheTimerStartedAt,
          setRuntimePaneTitle: deps.setRuntimePaneTitle,
          updateTabTitle: deps.updateTabTitle,
          isPtyShutdownPending: deps.isPtyShutdownPending
        })
        const connection = connectPanePty(
          createPane(1) as never,
          createManager(1) as never,
          deps as never
        )
        const spawned = createdTransportOptions[0]?.onPtySpawn as (id: string) => void
        spawned('pty-resident')
        const source = new TerminalSnapshotState()
        source.record(
          { kind: 'title', rawTitle: 'Codex working', normalizedTitle: 'Codex working' },
          100
        )
        source.record({ kind: 'bell' }, 101)
        const deliver = () =>
          handler._dispatchTerminalSideEffectBatchForTest({
            ptyId: 'pty-resident',
            seq: source.state.revision,
            facts: [],
            paneKey: makePaneKey('tab-1', LEAF_1),
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            terminalState: {
              runtimeId: 'runtime-1',
              incarnationId: 'incarnation-1',
              snapshot: source.snapshot()
            }
          })
        deliver()
        const resident = handler.getTerminalSemanticResident('pty-resident')
        expect(resident).toBeDefined()
        expect(mockStoreState.markTerminalBell).not.toHaveBeenCalled()
        source.record({ kind: 'command-started' }, 102)
        deliver()
        connection.dispose()
        source.record({ kind: 'command-finished', exitCode: 0 }, 103)
        source.record({ kind: 'command-started' }, 104)
        source.record({ kind: 'bell' }, 105)
        mockStoreState.dropAgentStatus.mockClear()
        mockStoreState.clearAgentLaunchConfig.mockClear()
        deliver()
        deliver()
        expect(handler.getTerminalSemanticResident('pty-resident')).toBe(resident)
        expect(resident?.isLive).toBe(true)
        expect(mockStoreState.markTerminalBell).toHaveBeenCalledTimes(1)
        expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
        expect(mockStoreState.clearAgentLaunchConfig).not.toHaveBeenCalled()
        handler.observeTerminalSemanticResidentExit('pty-resident', -1, 'incarnation-1')
        expect(resident?.isLive).toBe(true)
        handler.observeTerminalSemanticResidentExit('pty-resident', 0, 'old-incarnation')
        expect(resident?.isLive).toBe(true)
        handler.observeTerminalSemanticResidentExit('pty-resident', 0, 'incarnation-1')
        expect(resident?.isLive).toBe(false)
        handler._resetTerminalSideEffectFactConsumersForTest()
      })

      it('consumes pty:sideEffect facts with the live-path policy after spawn', async () => {
        enableMainAuthority()
        const { connectPanePty } = await import('./pty-connection')
        const handler = await import('./terminal-side-effect-facts-handler')
        const transport = createMockTransport()
        transportFactoryQueue.push(transport)
        vi.useFakeTimers()

        const pane = createPane(1)
        const manager = createManager(1)
        const deps = createDeps()
        connectPanePty(pane as never, manager as never, deps as never)

        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
        onPtySpawn('pty-fact-1')

        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-fact-1',
          seq: 10,
          facts: [
            { kind: 'title', normalizedTitle: 'Codex working', rawTitle: 'Codex working' },
            { kind: 'bell' }
          ]
        })

        expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'Codex working')
        expect(deps.markTerminalBell).toHaveBeenCalledTimes(1)
        expect(deps.markTerminalBell).toHaveBeenCalledWith({
          worktreeId: 'wt-1',
          tabId: 'tab-1',
          paneKey: makePaneKey('tab-1', LEAF_1)
        })
        expect(deps.dispatchNotification).not.toHaveBeenCalled()
        vi.advanceTimersByTime(250)
        expect(deps.dispatchNotification).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'terminal-bell',
            paneKey: makePaneKey('tab-1', LEAF_1)
          })
        )
      })

      it('stops consuming facts after the pane binding is disposed', async () => {
        enableMainAuthority()
        const { connectPanePty } = await import('./pty-connection')
        const handler = await import('./terminal-side-effect-facts-handler')
        const transport = createMockTransport()
        transportFactoryQueue.push(transport)

        const deps = createDeps()
        const binding = connectPanePty(
          createPane(1) as never,
          createManager(1) as never,
          deps as never
        )
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
        onPtySpawn('pty-fact-2')

        binding.dispose()
        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-fact-2',
          seq: 1,
          facts: [{ kind: 'bell' }]
        })

        expect(deps.markTerminalBell).not.toHaveBeenCalled()
      })

      it('schedules the completion notification for genuine working→idle facts', async () => {
        enableMainAuthority()
        const { connectPanePty } = await import('./pty-connection')
        const handler = await import('./terminal-side-effect-facts-handler')
        const transport = createMockTransport()
        transportFactoryQueue.push(transport)
        vi.useFakeTimers()

        const deps = createDeps()
        connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
        onPtySpawn('pty-fact-genuine')

        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-fact-genuine',
          seq: 1,
          facts: [
            { kind: 'title', normalizedTitle: '⠋ Codex working', rawTitle: '⠋ Codex working' },
            { kind: 'agent-working' }
          ]
        })
        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-fact-genuine',
          seq: 2,
          facts: [
            { kind: 'title', normalizedTitle: '* Codex done', rawTitle: '* Codex done' },
            { kind: 'agent-idle', title: '* Codex done' }
          ]
        })
        vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

        expect(deps.dispatchNotification).toHaveBeenCalledWith(
          expect.objectContaining({ source: 'agent-task-complete' })
        )
      })

      it('clears state without completion attention for stale-derived facts', async () => {
        enableMainAuthority()
        const { connectPanePty } = await import('./pty-connection')
        const handler = await import('./terminal-side-effect-facts-handler')
        const transport = createMockTransport()
        transportFactoryQueue.push(transport)
        vi.useFakeTimers()

        const deps = createDeps()
        connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
        onPtySpawn('pty-fact-stale')

        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-fact-stale',
          seq: 1,
          facts: [
            { kind: 'title', normalizedTitle: '⠋ Codex working', rawTitle: '⠋ Codex working' },
            { kind: 'agent-working' }
          ]
        })
        // Main's unthrottled 3s stale-title rewrite for a merely-paused agent.
        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-fact-stale',
          seq: 2,
          facts: [
            {
              kind: 'title',
              normalizedTitle: 'Codex',
              rawTitle: 'Codex',
              staleWorkingTitleClear: true
            },
            { kind: 'agent-idle', title: 'Codex', staleWorkingTitleClear: true }
          ]
        })

        expect(deps.setRuntimePaneTitle).toHaveBeenLastCalledWith('tab-1', 1, 'Codex')
        expect(deps.setCacheTimerStartedAt).toHaveBeenLastCalledWith(
          makePaneKey('tab-1', LEAF_1),
          null
        )
        vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS * 2)
        expect(deps.dispatchNotification).not.toHaveBeenCalled()
        expect(deps.markTerminalBell).not.toHaveBeenCalled()
      })

      it('drops the agent status from a command-finished fact like the byte path did', async () => {
        enableMainAuthority()
        const { connectPanePty } = await import('./pty-connection')
        const handler = await import('./terminal-side-effect-facts-handler')
        const transport = createMockTransport()
        transportFactoryQueue.push(transport)
        const paneKey = makePaneKey('tab-1', LEAF_1)
        mockStoreState.agentStatusByPaneKey = {
          [paneKey]: {
            paneKey,
            state: 'done',
            prompt: 'hi',
            updatedAt: 1000,
            stateStartedAt: 1000,
            agentType: 'codex',
            stateHistory: []
          }
        }

        connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
        onPtySpawn('pty-fact-133')

        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-fact-133',
          seq: 1,
          facts: [{ kind: 'command-finished', exitCode: 130 }]
        })

        expect(mockStoreState.dropAgentStatus).toHaveBeenCalledWith(paneKey)
        expect(mockStoreState.removeAgentStatus).not.toHaveBeenCalled()
      })

      it('routes pr-link facts to the worktree PR observer', async () => {
        enableMainAuthority()
        const { connectPanePty } = await import('./pty-connection')
        const handler = await import('./terminal-side-effect-facts-handler')
        const transport = createMockTransport()
        transportFactoryQueue.push(transport)

        connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
        onPtySpawn('pty-fact-pr')

        const link = {
          url: 'https://github.com/acme/orca/pull/42',
          slug: { owner: 'acme', repo: 'orca', host: 'github.com' },
          number: 42
        }
        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-fact-pr',
          seq: 1,
          facts: [{ kind: 'pr-link', link }]
        })

        expect(mockStoreState.observeTerminalGitHubPullRequestLink).toHaveBeenCalledWith(
          'wt-1',
          link,
          expect.objectContaining({ tabId: 'tab-1', ptyId: 'pty-fact-pr' })
        )
      })

      it('does not byte-scan PR links or OSC 133 — facts are the only consumer', async () => {
        enableMainAuthority()
        const { connectPanePty } = await import('./pty-connection')
        const transport = createMockTransport()
        const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
        transport.connect.mockImplementation(
          async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
            capturedDataCallback.current = callbacks.onData ?? null
            return 'pty-authority-bytes'
          }
        )
        transportFactoryQueue.push(transport)
        const paneKey = makePaneKey('tab-1', LEAF_1)
        mockStoreState.agentStatusByPaneKey = {
          [paneKey]: {
            paneKey,
            state: 'done',
            prompt: 'hi',
            updatedAt: 1000,
            stateStartedAt: 1000,
            agentType: 'codex',
            stateHistory: []
          }
        }

        connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
        await flushAsyncTicks()
        expect(capturedDataCallback.current).not.toBeNull()

        capturedDataCallback.current?.('Created https://github.com/acme/orca/pull/42\r\n')
        capturedDataCallback.current?.('\x1b]133;D;130\x07prompt $ ')

        expect(mockStoreState.observeTerminalGitHubPullRequestLink).not.toHaveBeenCalled()
        expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
      })

      it('seeds and settles Command Code status from command-code facts', async () => {
        enableMainAuthority()
        const { connectPanePty } = await import('./pty-connection')
        const handler = await import('./terminal-side-effect-facts-handler')
        const transport = createMockTransport()
        transportFactoryQueue.push(transport)
        vi.useFakeTimers()
        const paneKey = makePaneKey('tab-1', LEAF_1)

        connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
        onPtySpawn('pty-fact-cc')

        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-fact-cc',
          seq: 1,
          facts: [{ kind: 'command-code-working', prompt: 'say hi' }]
        })
        expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
          state: 'working',
          prompt: 'say hi',
          agentType: 'command-code'
        })

        // Done facts are hints; pane policy owns settling so it can consult the live row before completion.
        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-fact-cc',
          seq: 2,
          facts: [{ kind: 'command-code-done', prompt: 'say hi' }]
        })
        vi.advanceTimersByTime(1499)
        expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({ state: 'working' })
        vi.advanceTimersByTime(1)
        expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
          state: 'done',
          prompt: 'say hi',
          agentType: 'command-code'
        })
      })

      it('rejects Command Code facts when Claude owns the pane', async () => {
        enableMainAuthority()
        const { connectPanePty } = await import('./pty-connection')
        const handler = await import('./terminal-side-effect-facts-handler')
        const transport = createMockTransport()
        transportFactoryQueue.push(transport)
        vi.useFakeTimers()
        const paneKey = makePaneKey('tab-1', LEAF_1)
        const claudeStatus = {
          paneKey,
          state: 'done' as const,
          prompt: 'Previous Claude turn',
          updatedAt: Date.now(),
          stateStartedAt: Date.now(),
          agentType: 'claude' as const,
          stateHistory: []
        }
        mockStoreState.tabsByWorktree = {
          'wt-1': [{ id: 'tab-1', ptyId: null, launchAgent: 'claude' }]
        }
        mockStoreState.agentStatusByPaneKey[paneKey] = claudeStatus
        mockStoreState.paneForegroundAgentByPaneKey[paneKey] = {
          agent: 'claude',
          shellForeground: false
        }

        connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
        onPtySpawn('pty-fact-false-cc')
        mockStoreState.setAgentStatus.mockClear()

        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-fact-false-cc',
          seq: 1,
          facts: [
            { kind: 'command-code-working', prompt: 'False prompt' },
            { kind: 'command-code-done', prompt: 'False prompt' }
          ]
        })
        vi.advanceTimersByTime(2000)

        expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
        expect(mockStoreState.agentStatusByPaneKey[paneKey]).toBe(claudeStatus)
      })

      it('rejects Command Code facts when retained Claude identity owns the pane', async () => {
        enableMainAuthority()
        const { connectPanePty } = await import('./pty-connection')
        const handler = await import('./terminal-side-effect-facts-handler')
        const transport = createMockTransport()
        transportFactoryQueue.push(transport)
        vi.useFakeTimers()
        const paneKey = makePaneKey('tab-1', LEAF_1)
        const unknownStatus = {
          paneKey,
          state: 'working' as const,
          prompt: '',
          updatedAt: Date.now(),
          stateStartedAt: Date.now(),
          agentType: 'unknown' as const,
          stateHistory: []
        }
        mockStoreState.retainedAgentsByPaneKey[paneKey] = { agentType: 'claude' }
        mockStoreState.agentStatusByPaneKey[paneKey] = unknownStatus

        connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
        onPtySpawn('pty-fact-retained-false-cc')
        mockStoreState.setAgentStatus.mockClear()

        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-fact-retained-false-cc',
          seq: 1,
          facts: [
            { kind: 'command-code-working', prompt: 'False prompt' },
            { kind: 'command-code-done', prompt: 'False prompt' }
          ]
        })
        vi.advanceTimersByTime(2000)

        expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
        expect(mockStoreState.agentStatusByPaneKey[paneKey]).toBe(unknownStatus)
      })

      it('keeps Command Code working when a working fact lands before the done settles', async () => {
        enableMainAuthority()
        const { connectPanePty } = await import('./pty-connection')
        const handler = await import('./terminal-side-effect-facts-handler')
        const transport = createMockTransport()
        transportFactoryQueue.push(transport)
        vi.useFakeTimers()
        const paneKey = makePaneKey('tab-1', LEAF_1)

        connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
        onPtySpawn('pty-fact-cc-repaint')

        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-fact-cc-repaint',
          seq: 1,
          facts: [{ kind: 'command-code-working', prompt: 'Run a slow command' }]
        })
        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-fact-cc-repaint',
          seq: 2,
          facts: [{ kind: 'command-code-done', prompt: 'Run a slow command' }]
        })
        vi.advanceTimersByTime(1000)
        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-fact-cc-repaint',
          seq: 3,
          facts: [{ kind: 'command-code-working', prompt: 'Run a slow command' }]
        })
        vi.advanceTimersByTime(2000)

        expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
          state: 'working',
          prompt: 'Run a slow command',
          agentType: 'command-code'
        })
      })

      it('does not byte-scan Command Code output — facts are the only consumer', async () => {
        enableMainAuthority()
        const { connectPanePty } = await import('./pty-connection')
        const transport = createMockTransport()
        const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
        transport.connect.mockImplementation(
          async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
            capturedDataCallback.current = callbacks.onData ?? null
            return 'pty-authority-cc-bytes'
          }
        )
        transportFactoryQueue.push(transport)

        connectPanePty(
          createPane(1) as never,
          createManager(1) as never,
          createDeps({ startup: { command: 'command-code --trust' } }) as never
        )
        await flushAsyncTicks()
        expect(capturedDataCallback.current).not.toBeNull()

        capturedDataCallback.current?.('# Command Code v0.27.2\r\n')
        capturedDataCallback.current?.('❯ Fix the spinner\r\n\x1b[35m✻ Thinking...\x1b[0m')

        expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
      })

      it('honors the persisted kill switch for panes bound before settings hydrate', async () => {
        // Pre-hydration: settings not loaded but kill switch persisted off — pane registers byte parsers, not a fact consumer.
        mockStoreState.settings = null
        ;(window.api as unknown as Record<string, unknown>).settings = {
          getSync: vi.fn(() => ({ terminalMainSideEffectAuthority: false }))
        }
        const { connectPanePty } = await import('./pty-connection')
        const handler = await import('./terminal-side-effect-facts-handler')
        const transport = createMockTransport()
        transportFactoryQueue.push(transport)

        const deps = createDeps()
        connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)

        for (const callback of SIDE_EFFECT_PARSER_CALLBACKS) {
          expect(createdTransportOptions[0]?.[callback]).toBeTypeOf('function')
        }
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
        onPtySpawn('pty-prehydration')

        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-prehydration',
          seq: 1,
          facts: [{ kind: 'bell' }]
        })
        expect(deps.markTerminalBell).not.toHaveBeenCalled()

        // Hydration with switch still off: byte parsing stays the single consumer — one BEL marks unread once.
        mockStoreState.settings = { terminalMainSideEffectAuthority: false }
        notifyStoreSubscribers()
        const onBell = createdTransportOptions[0]?.onBell as () => void
        onBell()
        expect(deps.markTerminalBell).toHaveBeenCalledTimes(1)
      })
    })
  })
}
