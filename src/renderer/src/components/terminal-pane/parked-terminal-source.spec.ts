import { expect, it, vi } from 'vitest'
import type { MockStoreState, ParkedWatcherTestInstance } from './parked-terminal-byte-watcher.test'
import type { ParkedTerminalByteWatcherOptions } from './parked-terminal-byte-watcher'
import type { RuntimeTerminalDataSubscriptionOptions } from '@/runtime/runtime-terminal-stream'
import type { TerminalSideEffectFact } from '../../../../shared/terminal-side-effect-facts'
import { AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS } from './agent-task-complete-policy'

const PTY_ID = 'pty-parked-1'
const TAB_ID = 'tab-1'
const WORKTREE_ID = 'repo-1::/tmp/wt-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const PANE_ID = 1
const IDLE_TITLE = '✳ Build feature'

export function registerParkedTerminalSourceTests(context: {
  getStore: () => MockStoreState
  startWatcher: (
    options?: Partial<ParkedTerminalByteWatcherOptions>
  ) => Promise<ParkedWatcherTestInstance>
  dispatchTerminalNotification: ReturnType<typeof vi.fn>
  emit: (data: string) => void
  getOnData: () => unknown
  holdRemoteAdmission: () => void
  getRemoteSubscriptions: () => { options?: RuntimeTerminalDataSubscriptionOptions }[]
}): void {
  const { startWatcher, dispatchTerminalNotification, emit } = context
  it.each([
    ['local main-authority', 'pty-parked-1'],
    ['SSH through main', 'ssh:connection-1@@pty-1'],
    ['WSL facts', 'wsl-pty-1'],
    ['parked paired', 'remote:env-1@@terminal-1']
  ])('production Uprime retains the bounded old-host bell: %s', async (_route, ptyId) => {
    context.getStore().settings = {
      ...context.getStore().settings,
      terminalMainSideEffectAuthority: true
    }
    const pty = window.api.pty
    const admission = Promise.withResolvers<boolean>()
    Object.assign(pty, { hasPty: vi.fn(() => admission.promise) })
    context.holdRemoteAdmission()
    const pinned = Boolean(process.env.ORCA_PR31182_PINNED_MAIN_PARITY_ROOT)
    const pinnedRoot = process.env.ORCA_PR31182_PINNED_MAIN_PARITY_ROOT
    const watcher = pinned
      ? await import(/* @vite-ignore */ `${pinnedRoot}/parked-terminal-byte-watcher.ts`)
      : await import('./parked-terminal-byte-watcher')
    const handler = pinned
      ? await import(/* @vite-ignore */ `${pinnedRoot}/terminal-side-effect-facts-handler.ts`)
      : await import('./terminal-side-effect-facts-handler')
    const options = {
      ptyId,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      leafId: LEAF_ID,
      paneId: PANE_ID
    }
    // Reveal removes presentation before the next watcher; the bell has no consumer.
    const first = watcher.startParkedTerminalByteWatcher(options)
    first()
    handler.dispatchTerminalSideEffectBatch({ ptyId, seq: 1, facts: [{ kind: 'bell' }] })
    expect(context.getStore().markTerminalBell).not.toHaveBeenCalled()
    const next = watcher.startParkedTerminalByteWatcher(options)
    admission.resolve(true)
    for (const subscription of context.getRemoteSubscriptions()) {
      subscription.options?.onAdmitted?.()
    }
    await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
    expect.soft(context.getStore().markTerminalBell).toHaveBeenCalledOnce()
    expect
      .soft(dispatchTerminalNotification)
      .toHaveBeenCalledWith(
        WORKTREE_ID,
        expect.objectContaining({ source: 'terminal-bell', ptyId, paneKey: PANE_KEY })
      )
    console.info('production-Uprime', {
      pinned,
      route: _route,
      attention: context.getStore().markTerminalBell.mock.calls.length,
      notifications: dispatchTerminalNotification.mock.calls.length
    })
    next()
    handler._resetTerminalSideEffectFactConsumersForTest()
  })

  it('production Uprime retains the local authority-OFF raw-buffer bell', async () => {
    const admission = Promise.withResolvers<boolean>()
    Object.assign(window.api.pty, { hasPty: vi.fn(() => admission.promise) })
    const { ensurePtyDispatcher } = await import('./pty-dispatcher')
    const { replayPreHandlerPtyData } = await import('./pty-pre-handler-buffer')
    ensurePtyDispatcher()
    const pinned = Boolean(process.env.ORCA_PR31182_PINNED_MAIN_PARITY_ROOT)
    const pinnedRoot = process.env.ORCA_PR31182_PINNED_MAIN_PARITY_ROOT
    const watcher = pinned
      ? await import(/* @vite-ignore */ `${pinnedRoot}/parked-terminal-byte-watcher.ts`)
      : await import('./parked-terminal-byte-watcher')
    const dispose = watcher.startParkedTerminalByteWatcher({
      ptyId: PTY_ID,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      leafId: LEAF_ID,
      paneId: PANE_ID
    })
    expect(context.getOnData()).toBeTypeOf('function')
    emit('\x07')
    const retained = vi.fn()
    replayPreHandlerPtyData(PTY_ID, (data) => retained(data))
    expect(retained).toHaveBeenCalledWith('\x07')
    admission.resolve(true)
    await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
    console.info('production-Uprime-raw-buffer', {
      pinned,
      retainedBytes: retained.mock.calls.map(([data]) => data).join(''),
      attention: context.getStore().markTerminalBell.mock.calls.length,
      notifications: dispatchTerminalNotification.mock.calls.length
    })
    expect.soft(context.getStore().markTerminalBell).toHaveBeenCalledOnce()
    expect
      .soft(dispatchTerminalNotification)
      .toHaveBeenCalledWith(
        WORKTREE_ID,
        expect.objectContaining({ source: 'terminal-bell', ptyId: PTY_ID, paneKey: PANE_KEY })
      )
    dispose()
  })

  it.each(['command-finished', 'agent-idle', 'agent-status', 'command-code-done'] as const)(
    'keeps the original absent subject on retained %s without losing its independent bell',
    async (kind) => {
      context.getStore().settings = {
        ...context.getStore().settings,
        terminalMainSideEffectAuthority: true
      }
      const admission = Promise.withResolvers<boolean>()
      Object.assign(window.api.pty, { hasPty: vi.fn(() => admission.promise) })
      const { startParkedTerminalByteWatcher } = await import('./parked-terminal-byte-watcher')
      const handler = await import('./terminal-side-effect-facts-handler')
      const dispose = startParkedTerminalByteWatcher({
        ptyId: PTY_ID,
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneId: PANE_ID
      })
      const fact: TerminalSideEffectFact =
        kind === 'command-finished'
          ? { kind, exitCode: 0 }
          : kind === 'agent-idle'
            ? { kind, title: IDLE_TITLE }
            : kind === 'agent-status'
              ? { kind, payload: { state: 'done', prompt: 'old', agentType: 'codex' } }
              : { kind, prompt: 'old' }
      dispose()
      handler.dispatchTerminalSideEffectBatch({
        ptyId: PTY_ID,
        seq: 1,
        facts: [fact, { kind: 'bell' }]
      })
      const state = context.getStore()
      const newer = {
        paneKey: PANE_KEY,
        state: 'working' as const,
        prompt: 'new',
        agentType: 'codex' as const,
        updatedAt: Date.now(),
        stateStartedAt: Date.now(),
        stateHistory: []
      }
      state.agentStatusByPaneKey[PANE_KEY] = newer
      const launch = { identity: { agentType: 'codex' }, launchToken: 'new' }
      Object.assign(state.agentLaunchConfigByPaneKey, { [PANE_KEY]: launch })
      admission.resolve(true)
      await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
      expect(state.agentStatusByPaneKey[PANE_KEY]).toBe(newer)
      expect(state.agentLaunchConfigByPaneKey[PANE_KEY]).toBe(launch)
      expect(state.markTerminalBell).toHaveBeenCalledOnce()
      expect(dispatchTerminalNotification).toHaveBeenCalledOnce()
    }
  )

  it('delivers the first capable live bell through daemon installation, runtime projection and the resident store', async () => {
    const { Socket } = await import('node:net')
    const { DaemonStreamDataBatcher } =
      await import('../../../../main/daemon/daemon-stream-data-batcher')
    const { DaemonTransientReader } =
      await import('../../../../main/daemon/daemon-transient-reader')
    const { SessionOutputPlane } = await import('../../../../main/daemon/session-output-plane')
    const { OrcaRuntimeService } = await import('../../../../main/runtime/orca-runtime')
    const handler = await import('./terminal-side-effect-facts-handler')
    context.getStore().settings = {
      ...context.getStore().settings,
      terminalMainSideEffectAuthority: true
    }
    Object.assign(window.api.pty, { hasPty: vi.fn().mockResolvedValue(false) })
    const { dispose } = await startWatcher()
    const runtime = new OrcaRuntimeService(undefined, undefined, {
      onTerminalSideEffects: handler.dispatchTerminalSideEffectBatch
    })
    runtime.setPtyController({
      spawn: vi.fn(),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          leafId: LEAF_ID,
          paneRuntimeId: PANE_ID,
          ptyId: PTY_ID
        }
      ]
    })
    const socket = new Socket()
    let deep = 256 * 1024
    Object.defineProperty(socket, 'writableLength', { get: () => deep })
    const reader = new DaemonTransientReader((event) => {
      if (event.event === 'terminalObservation') {
        runtime.applyTerminalTransientObservation(PTY_ID, event.incarnationId, event.payload)
      }
    })
    vi.spyOn(socket, 'write').mockImplementation((...args: unknown[]) => {
      reader.accept(JSON.parse(String(args[0])))
      return deep === 0
    })
    const batcher = new DaemonStreamDataBatcher(() => ({
      streamSocket: socket,
      streamFraming: 'ndjson'
    }))
    const plane = new SessionOutputPlane({ cols: 80, rows: 24, incarnationId: 'physical' })
    try {
      plane.emit({ data: '\x07', rawStartSeq: 0, rawEndSeq: 1 })
      batcher.enqueue('client', PTY_ID, 'x'.repeat(64 * 1024))
      plane.attachClient({
        transients: batcher.bindTransients('client', PTY_ID),
        onData: (data) => batcher.enqueue('client', PTY_ID, data),
        onExit: () => {}
      })
      plane.emit({ data: '\x07', rawStartSeq: 1, rawEndSeq: 2 })
      batcher.flush('client')
      expect(context.getStore().markTerminalBell).not.toHaveBeenCalled()
      deep = 0
      batcher.flush('client')
      expect(context.getStore().markTerminalBell).toHaveBeenCalledOnce()
      const resident = handler.getTerminalSemanticResident(PTY_ID)
      expect(resident?.identity.incarnationId).toBe('physical')
      dispose()
      await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
      expect(dispatchTerminalNotification).toHaveBeenCalledOnce()
      expect(handler.getTerminalSemanticResident(PTY_ID)).toBe(resident)
    } finally {
      reader.dispose()
      plane.markDisposed()
      plane.disposeEmulator()
      batcher.clear()
      socket.destroy()
      runtime.onPtyExit(PTY_ID, 0)
      dispose()
    }
  })
}
