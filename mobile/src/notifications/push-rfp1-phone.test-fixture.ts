import { pushOwnerNativePorts } from './push-owner-native-ports.test-fixture'
import { expect, vi } from 'vitest'
import WebSocket from 'ws'
import { AppState } from 'react-native'
import {
  companion,
  httpResult,
  integer,
  ownerCleanup,
  post,
  record,
  text
} from '../../../cloud/apps/push/src/push-owner-integration.test-fixture'
import { releaseModuleExport } from '../../../tests/e2e/cross-version-wire/release-module-export'
import type { scopeRpcClientToExecutionHost } from '../transport/execution-host-scoped-rpc-client'
import type { readProbedHostStatus } from '../transport/host-status-probe-operations'
import { readProbedHostStatus as readDirectStatus } from '../transport/host-status-probe-operations'
import { recordHostDescriptorFromStatus } from '../transport/host-descriptor-recorder'
import { parsePairingCode } from '../transport/pairing'
import { RpcClientRequestTracker } from '../transport/rpc-client-request-tracker'
import { connect, type RpcClient } from '../transport/rpc-client'
import { savePairedHost, removeHost, loadHostCatalog } from '../transport/host-store'
import {
  attachPushRegistration,
  resetPushRegistrationForTests,
  setRemotePushEnabled,
  startPushTokenSync
} from './push-registration'
import { foregroundNotificationBehavior, resetForegroundPushClaimsForTests } from './push-receive'
import { setNotificationViewingWorkspace } from './notification-viewing-policy'

export async function runObservationPhone(base: string) {
  const ports = pushOwnerNativePorts()
  const nativeFetch = globalThis.fetch
  const clients = new Map<string, RpcClient>()
  const detach = new Map<string, () => void>()
  const pending: Promise<unknown>[] = []
  let stop: (() => void) | undefined
  let selected: RpcClient | undefined
  let decode: typeof readProbedHostStatus | undefined
  let executionHost: `runtime:${string}` | undefined
  let firstUse = true
  let clock = 1_700_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  vi.stubGlobal('WebSocket', WebSocket)
  vi.stubGlobal('fetch', ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.startsWith(base)) {
      return nativeFetch(input, init)
    }
    const request = new Request(input, init)
    return request
      .text()
      .then((body) =>
        nativeFetch(`${base}/gateway`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            url,
            method: request.method,
            headers: Object.fromEntries(request.headers),
            body
          })
        })
      )
      .then(async (response) => httpResult(await response.json()))
  }) satisfies typeof fetch)
  const capture = (value: Record<string, unknown>) => post(base, '/observation', value)
  const retain = (work: Promise<unknown>) => {
    pending.push(work)
    void work.catch(() => {})
  }
  const resolve = RpcClientRequestTracker.prototype.resolve
  vi.spyOn(RpcClientRequestTracker.prototype, 'resolve').mockImplementation(function (
    this: RpcClientRequestTracker,
    frame
  ) {
    const accepted = resolve.call(this, frame)
    retain(capture({ boundary: 'actual-phone-tracker-consumption', frame, accepted }))
    return accepted
  })
  const endLeg = async () => {
    const cleanup = ownerCleanup()
    selected = undefined
    decode = undefined
    for (const release of detach.values()) {
      await cleanup.run(release)
    }
    detach.clear()
    await cleanup.run(() => stop?.())
    stop = undefined
    for (const client of clients.values()) {
      await cleanup.run(() => client.close())
    }
    clients.clear()
    // Retain every task until observed, including failed diagnostic writes.
    for (const task of pending.splice(0)) {
      await cleanup.run(() => task)
    }
    await cleanup.run(() => resetPushRegistrationForTests())
    cleanup.finish()
  }
  let primary: { failed: true; error: unknown } | undefined
  try {
    await companion('mobile', async (op, data) => {
      if (op === 'pair') {
        const offers = record(data.offers)
        for (const [id, code] of Object.entries(offers)) {
          const offer = parsePairingCode(text(code))
          if (!offer) {
            throw new Error('Real phone rejected actual pairing offer')
          }
          await savePairedHost({
            id,
            name: id,
            endpoint: offer.endpoint,
            deviceToken: offer.deviceToken,
            publicKeyB64: offer.publicKeyB64,
            lastConnected: 0
          })
          const client = connect(offer.endpoint, offer.deviceToken, offer.publicKeyB64)
          clients.set(id, client)
          const status = await client.sendRequest('status.get', undefined, { timeoutMs: 5000 })
          if (!status.ok) {
            throw new Error(`Actual ${id} status refused pairing probe`)
          }
          const decoded = readDirectStatus(status)?.status
          if (decoded) {
            recordHostDescriptorFromStatus(id, decoded)
          }
          await capture({ boundary: 'phone-direct-authenticated-status', actor: id, frame: status })
        }
        if (firstUse) {
          expect(ports.keys.has('orca.push-route-key')).toBe(false)
          expect(ports.storage.has('orca:push-route-version')).toBe(false)
          firstUse = false
        }
        await setRemotePushEnabled(true)
        stop = startPushTokenSync()
        for (const [id, client] of clients) {
          const send = client.sendRequest.bind(client)
          vi.spyOn(client, 'sendRequest').mockImplementation(async (method, params, options) => {
            const response = await send(method, params, options)
            if (method === 'notifications.registerPush') {
              if (!response.ok || record(response.result).registered !== true) {
                throw new Error(`Actual ${id} registration failed`)
              }
              await post(base, '/event', {
                name: `phone-registered:${text(data.leg)}:${id}`,
                data: response
              })
            }
            return response
          })
          detach.set(id, attachPushRegistration(id, client))
        }
        return {
          hosts: (await loadHostCatalog()).map(({ id, publicKeyB64 }) => ({ id, publicKeyB64 }))
        }
      }
      if (op === 'select') {
        const c = clients.get('C')
        if (!c) {
          throw new Error('Missing actual outer C client')
        }
        executionHost = `runtime:${text(data.environmentId)}`
        const root = text(data.archiveRoot)
        const scope = releaseModuleExport<typeof scopeRpcClientToExecutionHost>(
          await import(
            /* @vite-ignore */ `${root}/mobile/src/transport/execution-host-scoped-rpc-client.ts`
          ),
          'scopeRpcClientToExecutionHost'
        )
        decode = releaseModuleExport<typeof readProbedHostStatus>(
          await import(
            /* @vite-ignore */ `${root}/mobile/src/transport/host-status-probe-operations.ts`
          ),
          'readProbedHostStatus'
        )
        selected = scope(c, executionHost)
        return null
      }
      if (op === 'remove-A') {
        detach.get('A')?.()
        detach.delete('A')
        await removeHost('A')
        clients.get('A')?.close()
        clients.delete('A')
        detach.get('B')?.()
        detach.delete('B')
        clients.get('B')?.close()
        clients.delete('B')
        expect((await loadHostCatalog()).map(({ id }) => id).sort()).toEqual(['B', 'C'])
        return null
      }
      if (op === 'sample' || op === 'held-status') {
        if (!selected || !decode) {
          throw new Error('Actual scoped phone reader not selected')
        }
        const reader = decode
        const request = selected.sendRequest('status.get', undefined, { timeoutMs: 5000 })
        if (op === 'held-status') {
          retain(
            request.then(
              (frame) =>
                capture({ boundary: 'phone-held-status-settled', frame, decoded: reader(frame) }),
              (error: unknown) =>
                capture({ boundary: 'phone-held-status-settled', error: String(error) })
            )
          )
          return null
        }
        const frame = await request
        if (!frame.ok) {
          throw new Error('Actual relayed status refused current view')
        }
        const sessions = await selected.sendRequest('session.tabs.list', {
          worktree: `id:${text(data.workspace)}`
        })
        const worktrees = await selected.sendRequest('worktree.ps', {})
        const c = clients.get('C')
        if (!c) {
          throw new Error('Outer phone C is closed')
        }
        const catalog = await c.sendRequest('mobileRelay.hosts.list')
        if (!sessions.ok || !worktrees.ok || !catalog.ok) {
          throw new Error('Actual view projection refused')
        }
        const tabs = record(sessions.result).tabs
        if (!Array.isArray(tabs)) {
          throw new Error('Actual session projection has no tab rows')
        }
        expect(tabs.map((tab) => record(tab).sessionId)).toEqual(
          expect.arrayContaining(['alert-session', 'view-session'])
        )
        const worktreeRows = record(worktrees.result).worktrees
        if (!Array.isArray(worktreeRows)) {
          throw new Error('Actual worktree projection has no rows')
        }
        expect(worktreeRows.some((row) => record(row).worktreeId === text(data.workspace))).toBe(
          true
        )
        if (data.descriptorUnavailable) {
          expect(record(frame.result).hostDescriptor).toBeUndefined()
        }
        const viewedSession = tabs.find((tab) => record(tab).sessionId === 'view-session')
        if (!viewedSession) {
          throw new Error('Selected distinct viewed session is absent from actual projection')
        }
        const sample = {
          viewedSession,
          boundary: 'phone-current-relayed-view',
          frame,
          decoded: reader(frame),
          sessions,
          worktrees,
          catalog,
          outerState: c.getState(),
          outerGeneration: c.getGeneration?.(),
          executionHost
        }
        await capture(sample)
        return sample
      }
      if (op === 'present') {
        const payload = record(data.payload)
        const view = { hostId: 'C', executionHost, worktreeId: text(data.workspace) }
        setNotificationViewingWorkspace(view)
        AppState.currentState = 'active'
        resetForegroundPushClaimsForTests()
        const behavior = await foregroundNotificationBehavior({
          request: { content: { data: null }, trigger: { type: 'push', payload } }
        })
        const observation = {
          boundary: 'actual-iOS-foreground-result',
          case: data.case,
          view,
          behavior,
          payload,
          required: { V: 'quiet', U: 'alert' }
        }
        await capture(observation)
        return observation
      }
      if (op === 'end-leg') {
        await endLeg()
        return null
      }
      if (op === 'advance') {
        clock += integer(data.delta)
        return null
      }
      throw new Error(`Unexpected observation phone command ${op}`)
    })
  } catch (error) {
    primary = { failed: true, error }
  }
  const cleanup = ownerCleanup(primary)
  await cleanup.run(() => setNotificationViewingWorkspace(null))
  await cleanup.run(endLeg)
  await cleanup.run(() => vi.restoreAllMocks())
  await cleanup.run(() => vi.unstubAllGlobals())
  cleanup.finish()
}
