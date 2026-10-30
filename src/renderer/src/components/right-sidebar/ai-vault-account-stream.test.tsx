// @vitest-environment happy-dom
import { renderToString } from 'react-dom/server'
import { act, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { decodeAccountsSnapshot } from '../../../../../mobile/src/components/accounts-snapshot'
import { createRateLimitsApi } from '@/web/preload-api/web-rate-limits-api'
import { accountStreamFixture, P, Q, D, profile } from './ai-vault-account-stream-test-fixture'
import {
  accountCards,
  accountRenders,
  details,
  recordedSession,
  flushAccountWork,
  installAccountFixture
} from './ai-vault-account-test-fixture'

vi.mock('node:fs', async (original) => ({ ...(await original<typeof fs>()) }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
const bridge = vi.hoisted(() => ({ subscribe: vi.fn() }))
vi.mock('@/web/preload-api/web-runtime-session', () => ({
  requireActiveEnvironmentOrNull: () => ({ id: 'fixture' }),
  getClientForEnvironment: () => ({ subscribe: bridge.subscribe })
}))
vi.mock('@/web/preload-api/web-runtime-calls', () => ({ callRuntimeResult: vi.fn() }))
installAccountFixture()
let fixture: ReturnType<typeof accountStreamFixture> | undefined
let closeWeb: (() => void) | undefined
afterEach(async () => {
  closeWeb?.()
  closeWeb = undefined
  await fixture?.dispose()
  fixture = undefined
})
function dataSession(id = 'p', profileId = P): AiVaultSession {
  return {
    ...recordedSession('claude'),
    id,
    agent: 'opencode',
    accountHome: { kind: 'opencode', locator: { kind: 'managed', managedProfileId: profileId } }
  }
}
const oneProducer = { lists: 2, reads: 2, parses: 2, claude: 1, codex: 1, frames: 1, listData: 0 }

it.each([2, 20])(
  'bounds real stream production independently of %i mounted readers',
  async (count) => {
    const source = (fixture = accountStreamFixture())
    const sessions = Array.from({ length: count }, (_, i) => dataSession(`p-${i}`))
    expect(renderToString(accountCards(sessions))).toContain('Unknown')
    expect(source.subscribe).not.toHaveBeenCalled()
    const panel = render(accountCards(sessions))
    await flushAccountWork()
    expect(source.subscribe).toHaveBeenCalledTimes(1)
    expect(source.listenerCounts()).toEqual([1, 1])
    expect(source.counters()).toEqual(oneProducer)
    expect(source.refresh).toHaveBeenCalledTimes(1)
    expect(panel.getByTestId('p-0').textContent).toContain('Work')
    // Sequential acquires, including another binding, reuse the live source and ready proof.
    const q = dataSession('q', Q)
    panel.rerender(accountCards([...sessions, q]))
    await flushAccountWork()
    expect(source.subscribe).toHaveBeenCalledTimes(1)
    expect(source.counters()).toEqual(oneProducer)
    const events = [
      () => source.usage.publish(),
      () => source.controller.selectData('devin', D),
      () => {
        source.seed('opencode', [profile(P, 'Work'), profile(Q, 'Other changed')])
        return source.controller.selectData('opencode', Q)
      },
      () => source.controller.selectData('opencode', null)
    ]
    for (const event of events) {
      source.observations.length = 0
      accountRenders.clear()
      await act(async () => {
        await event()
      })
      expect(source.observations).toEqual([oneProducer])
      for (const session of sessions) {
        expect(accountRenders.get(session.id) ?? 0).toBe(0)
      }
      expect(panel.getByTestId('p-0').textContent).toContain('Work')
    }
    accountRenders.clear()
    const beforeReplay = source.counters()
    await act(async () => source.slots[0]!.emit(source.frames.at(-1)))
    expect(source.counters()).toEqual({ ...beforeReplay, frames: beforeReplay.frames + 1 })
    expect(accountRenders.size).toBe(0)
    source.seed('opencode', [profile(P, 'Renamed'), profile(Q, 'Other changed')])
    await act(async () => {
      await source.controller.selectData('opencode', Q)
    })
    expect(panel.getByTestId('p-0').textContent).toContain('Renamed')
    expect(accountRenders.get('q') ?? 0).toBe(0)
    for (const session of sessions) {
      expect(accountRenders.get(session.id)).toBeGreaterThan(0)
    }
    // Removing one reader does not close siblings; last reader removes both source listeners.
    panel.rerender(accountCards(sessions.slice(1)))
    await flushAccountWork()
    expect(source.listenerCounts()).toEqual([1, 1])
    panel.unmount()
    await flushAccountWork()
    expect(source.listenerCounts()).toEqual([0, 0])
    expect(source.slots[0]!.unsubscribe).toHaveBeenCalledTimes(1)
  }
)

it('isolates real optional-registry failures in ready/data/usage while keeping strict and mobile/web consumers', async () => {
  const source = (fixture = accountStreamFixture())
  fs.writeFileSync(source.registry('devin'), 'corrupt registry')
  const panel = details([dataSession()])
  await flushAccountWork()
  expect(panel.account('p').getByText('Work')).toBeTruthy()
  bridge.subscribe.mockImplementation(
    (
      method: string,
      params: unknown,
      handlers: { onResponse: (response: RuntimeRpcResponse<unknown>) => void }
    ) => source.subscribe({ method, params }, handlers.onResponse)
  )
  const webUsage = vi.fn()
  closeWeb = createRateLimitsApi().onUpdate(webUsage)
  await flushAccountWork()
  const validFrames = () => {
    for (const frame of source.frames) {
      if (typeof frame === 'object' && frame !== null && 'snapshot' in frame) {
        const snapshot = decodeAccountsSnapshot(frame.snapshot)
        expect(snapshot.claude.accounts.map((account) => account.id)).toEqual(['healthy-claude'])
        expect(snapshot.codex.accounts.map((account) => account.id)).toEqual(['healthy-codex'])
        expect(snapshot.devin).toBeUndefined()
      }
    }
  }
  validFrames()
  expect(webUsage).toHaveBeenCalled()
  const beforeUsage = webUsage.mock.calls.length
  await act(async () => source.usage.publish())
  expect(webUsage.mock.calls.length).toBe(beforeUsage + 1)
  expect(webUsage.mock.calls.at(-1)?.[0]).toMatchObject({ codex: { status: 'ok', updatedAt: 1 } })
  await expect(source.callStrict('accounts.list')).rejects.toThrow()
  await expect(source.callStrict('accounts.listData')).rejects.toThrow()
  expect(() => source.controller.getSnapshot()).toThrow()
  await act(async () => {
    await source.controller.removeData('opencode', P)
  })
  panel.unknown('p')
  validFrames()
  // An unavailable used registry is omitted, clears proof and restores on a legitimate event.
  source.seed('opencode', [profile(P, 'Restored')])
  await act(async () => source.usage.publish())
  expect(panel.account('p').getByText('Restored')).toBeTruthy()
  fs.writeFileSync(source.registry('opencode'), 'corrupt registry')
  await act(async () => source.usage.publish())
  panel.unknown('p')
  const last = source.frames.at(-1)
  if (typeof last !== 'object' || last === null || !('snapshot' in last)) {
    throw new Error('Missing actual frame')
  }
  expect(decodeAccountsSnapshot(last.snapshot).opencode).toBeUndefined()
  source.seed('opencode', [profile(P, 'Restored again')])
  await act(async () => source.usage.publish())
  expect(panel.account('p').getByText('Restored again')).toBeTruthy()
  expect(source.counters().listData).toBe(0)
})

it('fences lost streams and late handles, recovers old readers on new acquire, and retains same-commit leases', async () => {
  const source = (fixture = accountStreamFixture())
  source.holdHandles(true)
  const p = dataSession()
  const panel = render(accountCards([p]))
  await flushAccountWork()
  expect(panel.getByTestId('p').textContent).toContain('Work')
  await act(async () => source.slots[0]!.end())
  expect(panel.getByTestId('p').textContent).toContain('Unknown')
  panel.rerender(accountCards([p, dataSession('new')]))
  await flushAccountWork()
  expect(source.subscribe).toHaveBeenCalledTimes(2)
  expect(source.listenerCounts()).toEqual([1, 1])
  expect(panel.getByTestId('p').textContent).toContain('Work')
  await act(async () => {
    source.slots[0]!.releaseHandle()
    source.slots[0]!.emit({
      type: 'snapshot',
      snapshot: { opencode: { accounts: [profile(P, 'Stale')] } }
    })
    source.slots[0]!.emit({ type: 'end' })
  })
  expect(source.slots[0]!.unsubscribe).toHaveBeenCalledTimes(1)
  expect(panel.getByTestId('p').textContent).toContain('Work')
  for (const snapshot of [{}, { opencode: { accounts: [{ id: P, label: 1 }] } }]) {
    await act(async () => source.slots[1]!.emit({ type: 'snapshot', snapshot }))
    expect(panel.getByTestId('p').textContent).toContain('Unknown')
    await act(async () => source.usage.publish())
    expect(panel.getByTestId('p').textContent).toContain('Work')
  }
  // The same-commit new key has the same binding; the pending handle and producer survive.
  panel.rerender(accountCards([dataSession('replacement')]))
  await flushAccountWork()
  expect(source.subscribe).toHaveBeenCalledTimes(2)
  await act(async () => source.slots[1]!.releaseHandle())
  panel.unmount()
  await flushAccountWork()
  expect(source.listenerCounts()).toEqual([0, 0])
  expect(source.slots[1]!.unsubscribe).toHaveBeenCalledTimes(1)
  const reacquired = render(accountCards([p]))
  await flushAccountWork()
  expect(source.subscribe).toHaveBeenCalledTimes(3)
  expect(reacquired.getByTestId('p').textContent).toContain('Work')
  // A rejected source is lost evidence, with no autonomous retry.
  await act(async () => {
    source.slots[2]!.fail()
    source.slots[2]!.releaseHandle()
  })
  source.subscribe.mockRejectedValueOnce(new Error('transport rejected'))
  reacquired.rerender(accountCards([p, dataSession('retry-failed')]))
  await flushAccountWork()
  expect(reacquired.getByTestId('p').textContent).toContain('Unknown')
  expect(source.subscribe).toHaveBeenCalledTimes(4)
  await flushAccountWork()
  expect(source.subscribe).toHaveBeenCalledTimes(4)
  reacquired.rerender(accountCards([p, dataSession('retry-failed'), dataSession('recovered')]))
  await flushAccountWork()
  expect(source.subscribe).toHaveBeenCalledTimes(5)
  expect(reacquired.getByTestId('p').textContent).toContain('Work')
  await act(async () => source.slots[3]!.releaseHandle())
  window.api.claudeAccounts = {
    ...window.api.claudeAccounts,
    list: vi.fn().mockResolvedValue({ accounts: [], activeAccountId: null })
  }
  window.api.codexAccounts = {
    ...window.api.codexAccounts,
    list: vi.fn().mockResolvedValue({ accounts: [], activeAccountId: null })
  }
  reacquired.rerender(accountCards([recordedSession('claude')]))
  await flushAccountWork()
  expect(source.listenerCounts()).toEqual([0, 0])
  expect(source.slots[3]!.unsubscribe).toHaveBeenCalledTimes(1)
})
