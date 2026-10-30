import { AsyncLocalStorage } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { vi } from 'vitest'
import { getAppEnvironment, setAppEnvironment } from '../../../shared/app-environment'
import { fakeAppEnvironment } from '../../../../config/scripts/vitest-host-ports-setup'
import { createElectronModuleMock, handleMock } from '../../ipc/notifications-test-harness'
import type { Tab } from '../../../shared/tab-types'
import type { AgentSessionAttentionEdge } from '../../../shared/agent-session-attention'
import type { AgentSessionTurnCompletion } from '../../../shared/agent-session-wire'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { RuntimeSubscriptionContext } from '../../../shared/runtime-rpc-envelope'
import type { getDefaultPersistedState } from '../../../shared/constants'
import type { listEnvironments } from '../../../shared/runtime-environment-store'
import type { StructuredTab } from '../../../renderer/src/components/native-chat/structured-agent-session-tabs'
import type { registerNotificationHandlers } from '../../ipc/notifications'
import type { registerRuntimeEnvironmentSubscriptionHandlers } from '../../ipc/runtime-environments/runtime-environment-subscription-handlers'
import type { subscribeRuntimeEnvironmentFromPreload } from '../../../preload/runtime-environment-subscriptions'
import type { callRuntimeEnvironment } from '../../ipc/runtime-environments/runtime-environment-transport-routing'
import type {
  findForwardedPushSource,
  PendingRuntimeSubscription,
  RetainedRemoteRuntimeSubscription
} from '../../ipc/runtime-environments/runtime-environment-subscription-source'
type PreloadIpc = Parameters<typeof subscribeRuntimeEnvironmentFromPreload>[0]
type SubscriptionListener = Parameters<PreloadIpc['on']>[1]
type SubscriptionPayload = Parameters<SubscriptionListener>[1]
import {
  RFP1_ALERT_SESSION,
  RFP1_WORKSPACE,
  type observationRuntime
} from './push-rfp1-source-runtime.test-fixture'
import {
  ownerCleanup,
  record
} from '../../../../cloud/apps/push/src/push-owner-integration.test-fixture'

export function observationNativePorts(scratch: string) {
  const previousEnvironment = getAppEnvironment()
  const scope = new AsyncLocalStorage<string>()
  const path = () => scope.getStore() ?? join(scratch, 'native')
  const windows = new Map<string, Window>()
  const windowForProfile = () => {
    let window = windows.get(path())
    if (!window) {
      window = new Window({ url: 'http://localhost' })
      windows.set(path(), window)
    }
    return window
  }
  for (const property of ['window', 'document', 'localStorage', 'navigator']) {
    vi.stubGlobal(
      property,
      new Proxy(
        {},
        {
          get: (_, key) => {
            const window = windowForProfile()
            const target = property === 'window' ? window : Reflect.get(window, property)
            const value = Reflect.get(target, key)
            return typeof value === 'function' ? value.bind(target) : value
          }
        }
      )
    )
  }
  setAppEnvironment(fakeAppEnvironment({ getPath: () => path() }))
  const electron = createElectronModuleMock()
  vi.doMock('electron', () => ({
    ...electron,
    ipcMain: { ...record(electron.ipcMain), on: vi.fn() },
    powerMonitor: { on: vi.fn(), getSystemIdleTime: () => 3600 },
    app: { getPath: path, getVersion: () => '0.0.0-test', isPackaged: false }
  }))
  return {
    run: <T>(profile: string, action: () => T): T => scope.run(profile, action),
    setApi: (api: unknown) => {
      Reflect.set(windowForProfile(), 'api', api)
    },
    close: async () => {
      const cleanup = ownerCleanup()
      for (const window of windows.values()) {
        await cleanup.run(() => window.happyDOM.close())
      }
      windows.clear()
      await cleanup.run(() => setAppEnvironment(previousEnvironment))
      cleanup.finish()
    }
  }
}

type ObservationStore = {
  setState: (update: {
    unifiedTabsByWorktree?: Record<string, Tab[]>
    settings?: ReturnType<typeof getDefaultPersistedState>['settings']
    activeWorktreeId?: string | null
    runtimeEnvironments?: ReturnType<typeof listEnvironments>
  }) => void
}
type DispatchCompletion = (
  tab: StructuredTab,
  completion: AgentSessionTurnCompletion,
  target: RuntimeClientTarget,
  context?: RuntimeSubscriptionContext
) => void
type CompletionFeed = (target: RuntimeClientTarget) => {
  activate: () => () => void
  subscribe: (
    listener: (edge: AgentSessionAttentionEdge, context?: RuntimeSubscriptionContext) => void
  ) => () => void
}

type Runtime = Awaited<ReturnType<typeof observationRuntime>>

export async function observationRenderer(
  actor: Runtime,
  environmentId: string,
  native: ReturnType<typeof observationNativePorts>,
  capture: (value: Record<string, unknown>) => void
) {
  return native.run(actor.profile, async () => {
    const load = actor.load
    // Native UI ports; notification eligibility/delivery/source authority remain real.
    vi.doMock(join(actor.checkout.root, 'src/main/ipc/ui.ts'), () => ({
      getTrustedUIRendererWindow: () => null
    }))
    vi.doMock(join(actor.checkout.root, 'src/main/tray/system-tray.ts'), () => ({
      setTrayAttention: () => {}
    }))
    vi.doMock(
      join(actor.checkout.root, 'src/main/ipc/notification-authorization-status.ts'),
      () => ({ readNotificationAuthorizationStatus: async () => null })
    )
    const pending = new Map<string, PendingRuntimeSubscription>()
    const retained = new Map<string, RetainedRemoteRuntimeSubscription>()
    const subscriptions = await load<typeof registerRuntimeEnvironmentSubscriptionHandlers>(
      'src/main/ipc/runtime-environments/runtime-environment-subscription-handlers.ts',
      'registerRuntimeEnvironmentSubscriptionHandlers'
    )
    const preload = await load<typeof subscribeRuntimeEnvironmentFromPreload>(
      'src/preload/runtime-environment-subscriptions.ts',
      'subscribeRuntimeEnvironmentFromPreload'
    )
    const register = await load<typeof registerNotificationHandlers>(
      'src/main/ipc/notifications.ts',
      'registerNotificationHandlers'
    )
    const findSource =
      actor.checkout.commit === '7f4c8f606435d4ca90964e176e860626ffba918a'
        ? undefined
        : await load<typeof findForwardedPushSource>(
            'src/main/ipc/runtime-environments/runtime-environment-subscription-source.ts',
            'findForwardedPushSource'
          )
    const first = handleMock.mock.calls.length
    subscriptions({
      getUserDataPath: () => actor.profile,
      pendingSubscriptions: pending,
      remoteRuntimeSubscriptions: retained,
      recordLayoutFrame: () => {}
    })
    register(actor.store, actor.runtime, (id, environment, context) =>
      findSource?.(pending, retained, id, environment, context)
    )
    const handler = (channel: string) => {
      const calls: readonly (readonly unknown[])[] = handleMock.mock.calls.slice(first)
      const fn = calls.find(([name]) => name === channel)?.[1]
      if (typeof fn !== 'function') {
        throw new Error(`Observation IPC missing ${channel}`)
      }
      return fn
    }
    let listener: SubscriptionListener | undefined
    let destroyed = false
    const sender = Object.assign(new EventEmitter(), {
      id: actor.runtime.getRuntimeId().charCodeAt(0) + first,
      isDestroyed: () => destroyed,
      send: (_channel: string, payload: SubscriptionPayload) =>
        native.run(actor.profile, () => listener?.({}, payload))
    })
    const ipc: PreloadIpc = {
      invoke: async (channel: string, args: unknown) =>
        native.run(actor.profile, () => handler(channel)({ sender }, args)),
      send: (channel: string, args: unknown) =>
        native.run(actor.profile, () => handler(channel)({ sender }, args)),
      on: (_channel: string, fn: NonNullable<typeof listener>) => {
        listener = fn
      },
      removeListener: () => {
        listener = undefined
      }
    }
    const call = await load<typeof callRuntimeEnvironment>(
      'src/main/ipc/runtime-environments/runtime-environment-transport-routing.ts',
      'callRuntimeEnvironment'
    )
    const api = {
      runtimeEnvironments: {
        subscribe: (
          args: Parameters<typeof preload>[1],
          callbacks: Parameters<typeof preload>[2]
        ) => preload(ipc, args, callbacks),
        call: (args: {
          selector: string
          method: string
          params?: unknown
          timeoutMs?: number
          expectedEnvironmentPairingRevision?: number
          expectedEnvironmentRuntimeId?: string
        }) =>
          native.run(actor.profile, () =>
            call(
              actor.profile,
              args.selector,
              args.method,
              args.params,
              args.timeoutMs,
              args.expectedEnvironmentPairingRevision,
              undefined,
              { expectedEnvironmentRuntimeId: args.expectedEnvironmentRuntimeId }
            )
          )
      },
      notifications: {
        dispatch: async (request: unknown) => {
          capture({ boundary: 'renderer-dispatch', actor: actor.checkout.commit, request })
          const result = record(
            await native.run(actor.profile, () =>
              handler('notifications:dispatch')({ sender }, request)
            )
          )
          if (typeof result.delivered !== 'boolean') {
            throw new Error('Observation notification IPC returned no delivery result')
          }
          return result
        },
        applyRemoteStructuredRead: async (read: unknown) =>
          handler('notifications:applyRemoteStructuredRead')({ sender }, read)
      }
    }
    native.setApi(api)
    let stopListener = () => {}
    let stopFeed = () => {}
    const close = async () => {
      const cleanup = ownerCleanup()
      await cleanup.run(stopListener)
      await cleanup.run(stopFeed)
      destroyed = true
      await cleanup.run(() => sender.emit('destroyed'))
      for (const owner of pending.values()) {
        await cleanup.run(() => owner.close())
      }
      for (const owner of retained.values()) {
        await cleanup.run(() => owner.close())
      }
      pending.clear()
      retained.clear()
      listener = undefined
      cleanup.finish()
    }
    try {
      const store = await load<ObservationStore>('src/renderer/src/store/index.ts', 'useAppStore')
      const tab: StructuredTab = {
        id: 'observed-tab',
        entityId: RFP1_ALERT_SESSION,
        groupId: 'observed-group',
        worktreeId: RFP1_WORKSPACE,
        contentType: 'agent-session',
        label: 'Alert',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 1,
        agentSessionAgent: 'codex'
      }
      store.setState({
        unifiedTabsByWorktree: { [RFP1_WORKSPACE]: [tab] },
        settings: actor.store.getSettings(),
        activeWorktreeId: null
      })
      const dispatch = await load<DispatchCompletion>(
        'src/renderer/src/components/native-chat/structured-attention-dispatch.ts',
        'dispatchStructuredTurnCompletionAttention'
      )
      const getFeed = await load<CompletionFeed>(
        'src/renderer/src/runtime/structured-agent-session-turn-completion-feed.ts',
        'getStructuredAgentSessionTurnCompletionFeed'
      )
      const environments = await load<
        typeof import('../../../shared/runtime-environment-store').listEnvironments
      >('src/shared/runtime-environment-store.ts', 'listEnvironments')
      store.setState({ runtimeEnvironments: environments(actor.profile) })
      const target = { kind: 'environment', environmentId } as const
      const feed = getFeed(target)
      stopListener = feed.subscribe((edge, context) =>
        native.run(actor.profile, () => {
          native.setApi(api)
          capture({
            boundary: 'renderer-feed',
            pin: actor.checkout.commit,
            edge,
            context,
            sources: [...pending.values(), ...retained.values()].map((owner) => ({
              environmentId: owner.environmentId,
              requestId: owner.source?.requestId
            }))
          })
          if (edge.type === 'completion') {
            dispatch(tab, edge.completion, target, context)
          }
        })
      )
      stopFeed = feed.activate()
      return {
        projection: () =>
          api.runtimeEnvironments.call({
            selector: environmentId,
            method: 'session.tabs.list',
            params: { worktree: `id:${RFP1_WORKSPACE}` }
          }),
        async status() {
          return native.run(actor.profile, async () => {
            const probe = await load<
              typeof import('../../ipc/runtime-environments/runtime-environment-status-probe').getRuntimeEnvironmentStatus
            >(
              'src/main/ipc/runtime-environments/runtime-environment-status-probe.ts',
              'getRuntimeEnvironmentStatus'
            )
            return probe(actor.profile, environmentId, 5000, { reconnect: true })
          })
        },
        close
      }
    } catch (error) {
      const cleanup = ownerCleanup({ failed: true, error })
      await cleanup.run(close)
      cleanup.finish()
      throw error
    }
  })
}
