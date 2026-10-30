import { afterEach, expect, it, vi } from 'vitest'
import { registerRuntimeEnvironmentSubscriptionHandlers } from '../../src/main/ipc/runtime-environments/runtime-environment-subscription-handlers'
import { subscribeRuntimeEnvironmentFromPreload } from '../../src/preload/runtime-environment-subscriptions'
import { sendSharedControlSubscription } from '../../src/shared/remote-runtime/control/remote-runtime-shared-control-send'
import type { SharedControlLogicalSubscription } from '../../src/shared/remote-runtime/control/remote-runtime-shared-control-types'
import { agentSessionSwitchDeadline } from '../../src/shared/agent-session-switch-execution'
import { callAbortableRuntimeEnvironment } from '../../src/renderer/src/runtime/abortable-runtime-environment-call'
import { stubRuntimeEnvironmentBridge } from '../../src/renderer/src/runtime/runtime-environment-bridge-fixture'

// @vitest-environment happy-dom

type SubscriptionIpc = Parameters<typeof subscribeRuntimeEnvironmentFromPreload>[0]
type SubscriptionEvent = Parameters<Parameters<SubscriptionIpc['on']>[1]>[1]
const mocks = vi.hoisted(() => ({ handle: vi.fn(), subscribe: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle, on: vi.fn() } }))
vi.mock('../../src/shared/runtime-environment-store', () => ({
  resolveEnvironment: () => ({ id: 'paired', createdAt: 1, runtimeId: 'host' })
}))
vi.mock(
  '../../src/main/ipc/runtime-environments/runtime-environment-connectivity-handlers',
  () => ({
    isRuntimeEnvironmentManuallyDisconnected: () => false
  })
)
vi.mock('../../src/main/ipc/runtime-environments/runtime-environment-transport-generation', () => ({
  getRuntimeEnvironmentTransportGeneration: () => 1
}))
vi.mock('../../src/main/ipc/runtime-environments/runtime-environment-transport-routing', () => ({
  subscribeRuntimeEnvironment: mocks.subscribe
}))
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
it.each(['ready after expiry', 'delayed sent receipt'] as const)(
  'uses actual main/shared-control dispatch authority with %s across preload',
  async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const deadline = agentSessionSwitchDeadline(Date.now, 735_000)
    const ready = Promise.withResolvers<void>()
    const queuedEvents: (() => void)[] = []
    let deliver: Parameters<SubscriptionIpc['on']>[1] | undefined
    const wire = vi.fn(() => true)
    const sender = {
      id: 1,
      isDestroyed: () => false,
      on: vi.fn(),
      removeListener: vi.fn(),
      send: (_channel: string, payload: SubscriptionEvent) => {
        queuedEvents.push(() => deliver?.(null, payload))
      }
    }
    registerRuntimeEnvironmentSubscriptionHandlers({
      getUserDataPath: () => '/unused',
      remoteRuntimeSubscriptions: new Map(),
      pendingSubscriptions: new Map(),
      recordLayoutFrame: () => {}
    })
    const handler = (channel: string) =>
      mocks.handle.mock.calls.find(([name]) => name === channel)?.[1]
    const ipc: SubscriptionIpc = {
      invoke: async (channel: string, args: unknown) => {
        // Cancellation delivery is independently stalled; the main deadline must suffice.
        if (channel.endsWith(':unsubscribe')) {
          return new Promise(() => {})
        }
        const call = handler(channel)
        if (!call) {
          throw new Error('missing handler')
        }
        return call({ sender }, args)
      },
      send: vi.fn(),
      on: (_channel: string, listener: typeof deliver) => {
        deliver = listener
      },
      removeListener: vi.fn()
    }
    mocks.subscribe.mockImplementation(async (_root, _id, method, params, _timeout, callbacks) => {
      await ready.promise
      const logical: SharedControlLogicalSubscription = {
        requestId: 'request',
        method,
        params,
        retainedParamsBytes: 0,
        sent: false,
        closed: false,
        closeAfterReady: false,
        remoteSubscriptionId: null,
        callbacks: {
          beforeSend: callbacks.beforeSend,
          onResponse: (response) => callbacks.onEvent({ type: 'response', response }),
          onError: (error) =>
            callbacks.onEvent({ type: 'error', code: error.code, message: error.message }),
          onClose: callbacks.onClose
        }
      }
      sendSharedControlSubscription({
        subscriptions: new Map([['request', logical]]),
        subscription: logical,
        deviceToken: 'fixture-token',
        send: wire
      })
      return { requestId: 'request', close: vi.fn(), sendBinary: () => false }
    })
    stubRuntimeEnvironmentBridge({
      subscribe: (
        args: Parameters<typeof subscribeRuntimeEnvironmentFromPreload>[1],
        callbacks: Parameters<typeof subscribeRuntimeEnvironmentFromPreload>[2]
      ) => subscribeRuntimeEnvironmentFromPreload(ipc, args, callbacks),
      cancelSubscription: () => new Promise(() => {})
    })
    await vi.advanceTimersByTimeAsync(700_000)
    const sent = vi.fn((at?: number) => deadline.beforeSend(at))
    const call = callAbortableRuntimeEnvironment(
      'paired',
      'agentSession.switchToChat',
      {},
      735_000,
      deadline.signal,
      undefined,
      undefined,
      sent,
      deadline.delegateSend()
    )
    void call.catch(() => undefined)
    expect(mocks.subscribe).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(36_000)
    ready.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(wire).not.toHaveBeenCalled()
    for (const send of queuedEvents.splice(0)) {
      send()
    }
    await expect(call).rejects.toThrow()
    deadline.dispose()
  }
)
