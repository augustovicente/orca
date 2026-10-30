import { vi } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFakeAppEnvironment } from '../../../../../config/scripts/vitest-host-ports-setup'
import {
  RuntimeAccountController,
  type RuntimeAccountServices
} from '../../../../main/runtime/runtime-account-controller'
import { RuntimeSubscriptionRegistry } from '../../../../main/runtime/runtime-subscription-registry'
import { RateLimitService } from '../../../../main/rate-limits/service'
import { getManagedDataAccountService } from '../../../../main/managed-data-accounts/service'
import { ACCOUNT_METHODS } from '../../../../main/runtime/rpc/methods/accounts'
import {
  eraseRpcMethods,
  isStreamingMethod,
  type RpcContext
} from '../../../../main/runtime/rpc/core'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type {
  ManagedDataAccountProvider,
  ManagedDataAccountsState
} from '../../../../shared/managed-account-types'
import {
  emptyClaudeAccountsState,
  emptyCodexAccountsState
} from '@/runtime/runtime-provider-accounts-client'

type StreamServicePorts = {
  claudeAccounts: Pick<RuntimeAccountServices['claudeAccounts'], 'listAccounts'>
  codexAccounts: Pick<RuntimeAccountServices['codexAccounts'], 'listAccounts'>
  rateLimits: RateLimitService
}
type StreamRuntime = Pick<
  RpcContext['runtime'],
  | 'getAccountsSnapshot'
  | 'getAccountsStreamSnapshot'
  | 'getDataAccountsSnapshot'
  | 'onAccountsChanged'
  | 'registerSubscriptionCleanup'
  | 'refreshAccountsForMobileSubscriber'
>

type StreamContext = { runtime: StreamRuntime; connectionId?: string }
type StreamControllerPort = { setServices(services: StreamServicePorts): void }
type StreamHandlerPort = {
  handler(params: unknown, context: StreamContext, emit: (frame: unknown) => void): Promise<void>
}
type RequestHandlerPort = { handler(params: unknown, context: StreamContext): unknown }

export const P = '11111111-1111-4111-8111-111111111111'
export const Q = '22222222-2222-4222-8222-222222222222'
export const D = '33333333-3333-4333-8333-333333333333'
export const profile = (id: string, label: string) => ({
  id,
  label,
  integrations: [],
  createdAt: 1
})
class PublishedRateLimits extends RateLimitService {
  publish(): void {
    this.updateState({
      ...this.state,
      codex: {
        provider: 'codex',
        session: null,
        weekly: null,
        updatedAt: (this.state.codex?.updatedAt ?? 0) + 1,
        status: 'ok',
        error: null
      }
    })
  }
}

export function accountStreamFixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'orca-pr35392-stream-'))
  installFakeAppEnvironment({ getPath: () => root })
  const service = getManagedDataAccountService()
  const directory = join(root, 'managed-data-accounts')
  const registry = (provider: ManagedDataAccountProvider) =>
    join(directory, provider, 'accounts.json')
  const seed = (
    provider: ManagedDataAccountProvider,
    accounts: ManagedDataAccountsState['accounts']
  ) => {
    fs.mkdirSync(join(directory, provider), { recursive: true })
    for (const account of accounts) {
      fs.mkdirSync(join(directory, provider, account.id), { recursive: true })
    }
    fs.writeFileSync(registry(provider), JSON.stringify({ accounts, activeAccountId: null }))
  }
  seed('opencode', [profile(P, 'Work'), profile(Q, 'Other')])
  seed('devin', [profile(D, 'Devin')])
  const usage = new PublishedRateLimits()
  const refresh = vi.spyOn(usage, 'refreshIfStale').mockResolvedValue(usage.getState())
  vi.spyOn(usage, 'fetchInactiveClaudeAccountsOnOpen').mockResolvedValue(undefined)
  vi.spyOn(usage, 'fetchInactiveCodexAccountsOnOpen').mockResolvedValue(undefined)
  const nativeClaude = vi.fn(() => ({
    ...emptyClaudeAccountsState(),
    accounts: [
      {
        id: 'healthy-claude',
        email: 'claude@example.com',
        authMethod: 'unknown' as const,
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1
      }
    ]
  }))
  const nativeCodex = vi.fn(() => ({
    ...emptyCodexAccountsState(),
    accounts: [
      {
        id: 'healthy-codex',
        email: 'codex@example.com',
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1
      }
    ]
  }))
  const controller = new RuntimeAccountController()
  // The stream producer calls only these native list ports; no native disk IO is part of this contract.
  const services: StreamServicePorts = {
    claudeAccounts: { listAccounts: nativeClaude },
    codexAccounts: { listAccounts: nativeCodex },
    rateLimits: usage
  }
  const controllerPort: StreamControllerPort = controller
  controllerPort.setServices(services)
  const subscriptions = new RuntimeSubscriptionRegistry()
  const runtime: StreamRuntime = {
    getAccountsSnapshot: controller.getSnapshot.bind(controller),
    getAccountsStreamSnapshot: controller.getStreamSnapshot.bind(controller),
    getDataAccountsSnapshot: controller.dataAccountsSnapshot.bind(controller),
    onAccountsChanged: controller.onChanged.bind(controller),
    registerSubscriptionCleanup: subscriptions.register.bind(subscriptions),
    refreshAccountsForMobileSubscriber: controller.refreshForMobileSubscriber.bind(controller)
  }
  const methods = eraseRpcMethods(ACCOUNT_METHODS)
  const method = methods.find((candidate) => candidate.name === 'accounts.subscribe')
  if (!method || !isStreamingMethod(method)) {
    throw new Error('Missing account stream')
  }
  const stream: StreamHandlerPort = method
  const frames: unknown[] = []
  const slots: {
    emit: (frame: unknown) => void
    fail: () => void
    end: () => void
    unsubscribe: ReturnType<typeof vi.fn>
    releaseHandle: () => void
  }[] = []
  const running: Promise<unknown>[] = []
  const observations: ReturnType<typeof counters>[] = []
  const observe = (run: () => void) => {
    const before = counters()
    run()
    const after = counters()
    observations.push({
      lists: after.lists - before.lists,
      reads: after.reads - before.reads,
      parses: after.parses - before.parses,
      claude: after.claude - before.claude,
      codex: after.codex - before.codex,
      frames: after.frames - before.frames,
      listData: after.listData - before.listData
    })
  }
  let dataListeners = 0
  let usageListeners = 0
  const originalDataOnChanged = service.onChanged.bind(service)
  vi.spyOn(service, 'onChanged').mockImplementation((listener) => {
    dataListeners++
    const close = originalDataOnChanged(() => observe(listener))
    return () => {
      dataListeners--
      close()
    }
  })
  const originalUsageOnChanged = usage.onStateChange.bind(usage)
  vi.spyOn(usage, 'onStateChange').mockImplementation((listener) => {
    usageListeners++
    const close = originalUsageOnChanged((state) => observe(() => listener(state)))
    return () => {
      usageListeners--
      close()
    }
  })
  let holdHandles = false
  const subscribe = vi.fn(
    async (
      request: { method: string; params?: unknown },
      onResponse: (response: RuntimeRpcResponse<unknown>) => void
    ) => {
      if (request.method !== 'accounts.subscribe') {
        throw new Error('Unexpected stream')
      }
      const connectionId = `fixture-${slots.length}`
      const emit = (frame: unknown) => {
        frames.push(frame)
        onResponse({ id: connectionId, ok: true, result: frame, _meta: { runtimeId: 'fixture' } })
      }
      const end = () => subscriptions.cleanupForConnection(connectionId)
      const unsubscribe = vi.fn(end)
      const handle = Promise.withResolvers<void>()
      const fail = () =>
        onResponse({
          id: connectionId,
          ok: false,
          error: { code: 'fixture_error', message: 'Disconnected' }
        })
      slots.push({ emit, fail, end, unsubscribe, releaseHandle: () => handle.resolve() })
      const work = Promise.resolve(stream.handler(null, { runtime, connectionId }, emit))
      running.push(work)
      if (holdHandles) {
        await handle.promise
      }
      return {
        unsubscribe,
        sendBinary: () => {
          throw new Error('No fixture binary input')
        }
      }
    }
  )
  window.api.runtime = { ...window.api.runtime, subscribe }
  const listData = vi.fn()
  window.api.runtime.call = listData
  const lists = vi.spyOn(service, 'list')
  const reads = vi.spyOn(fs, 'readFileSync')
  const parses = vi.spyOn(JSON, 'parse')
  const counters = () => ({
    lists: lists.mock.calls.length,
    reads: reads.mock.calls.filter(
      ([path]) => String(path) === registry('opencode') || String(path) === registry('devin')
    ).length,
    parses: parses.mock.calls.filter(([text]) => text.includes('"activeAccountId"')).length,
    claude: nativeClaude.mock.calls.length,
    codex: nativeCodex.mock.calls.length,
    frames: frames.length,
    listData: listData.mock.calls.length
  })
  return {
    controller,
    service,
    usage,
    subscribe,
    slots,
    frames,
    refresh,
    registry,
    seed,
    counters,
    observations,
    listenerCounts: () => [dataListeners, usageListeners],
    holdHandles: (hold: boolean) => {
      holdHandles = hold
    },
    callStrict: (name: string) => {
      const strict = methods.find((candidate) => candidate.name === name)
      if (!strict || isStreamingMethod(strict)) {
        throw new Error('Missing one-shot')
      }
      const request: RequestHandlerPort = strict
      return request.handler(name === 'accounts.list' ? { refreshUsage: false } : null, { runtime })
    },
    dispose: async () => {
      for (const slot of slots) {
        slot.releaseHandle()
        slot.end()
      }
      await Promise.all(running)
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}
