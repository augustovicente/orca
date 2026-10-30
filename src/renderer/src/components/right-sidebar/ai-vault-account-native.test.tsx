// @vitest-environment happy-dom
import { act, render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import * as paths from '../../../../shared/cross-platform-path'
import { useAppStore } from '../../store'
import * as index from './ai-vault-native-account-index'
import {
  accountSettings,
  recordedSession,
  accountCards,
  accountRenders,
  flushAccountWork,
  installAccountFixture
} from './ai-vault-account-test-fixture'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
installAccountFixture()

function nativeClient(settings: ReturnType<typeof accountSettings>) {
  let claude: ClaudeRateLimitAccountsState = {
    accounts: settings.claudeManagedAccounts.map((account) => ({
      ...account,
      home: account.managedAuthPath
    })),
    activeAccountId: null
  }
  let codex: CodexRateLimitAccountsState = {
    accounts: settings.codexManagedAccounts,
    activeAccountId: null
  }
  const claudeList = vi.fn(async () => claude)
  const codexList = vi.fn(async () => codex)
  window.api.claudeAccounts = { ...window.api.claudeAccounts, list: claudeList }
  window.api.codexAccounts = { ...window.api.codexAccounts, list: codexList }
  return {
    claudeList,
    codexList,
    setClaude: (value: ClaudeRateLimitAccountsState) => {
      claude = value
    },
    setCodex: (value: CodexRateLimitAccountsState) => {
      codex = value
    }
  }
}
async function changeSettings(
  update: (settings: ReturnType<typeof accountSettings>) => ReturnType<typeof accountSettings>
) {
  await act(async () => {
    const settings = useAppStore.getState().settings
    if (!settings) {
      throw new Error('Missing fixture settings')
    }
    useAppStore.setState({ settings: update(settings) })
  })
}

it.each([
  { count: 2, size: 100 },
  { count: 20, size: 1000 }
])(
  'selects native evidence before IO at $count readers/$size accounts',
  async ({ count, size }) => {
    const settings = accountSettings(size)
    useAppStore.setState({ settings })
    const client = nativeClient(settings)
    const comparisons = vi.spyOn(paths, 'normalizeRuntimePathForComparison')
    const project = vi.spyOn(index, 'nativeAccountDependency')
    const resolve = vi.spyOn(index, 'nativeAccountLabel')
    let settingsListeners = 0
    const subscribe = useAppStore.subscribe
    vi.spyOn(useAppStore, 'subscribe').mockImplementation((listener) => {
      settingsListeners++
      const close = subscribe(listener)
      return () => {
        settingsListeners--
        close()
      }
    })
    const a = recordedSession('claude')
    const sessions = Array.from({ length: count }, (_, i) => ({ ...a, id: `reader-${i}` }))
    const panel = render(
      accountCards([...sessions, { ...a, id: 'remote', executionHostId: 'runtime:other' }])
    )
    await flushAccountWork()
    expect(client.claudeList).toHaveBeenCalledTimes(1)
    expect(client.codexList).toHaveBeenCalledTimes(1)
    expect(panel.getByTestId('reader-0').textContent).toContain('claude-0@example.com')
    expect(settingsListeners).toBe(1)
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(project.mock.calls.length).toBeLessThanOrEqual(6)
    expect(comparisons.mock.calls.length).toBeLessThanOrEqual(4 * size + 4 * count)
    for (const update of [
      (s: typeof settings) => ({ ...s, terminalFontSize: s.terminalFontSize + 1 }),
      (s: typeof settings) => ({ ...s, activeClaudeManagedAccountId: 'claude-9' }),
      (s: typeof settings) => ({
        ...s,
        codexManagedAccounts: s.codexManagedAccounts.map((a) => ({
          ...a,
          email: 'other-provider@example.com'
        }))
      }),
      (s: typeof settings) => ({
        ...s,
        claudeManagedAccounts: s.claudeManagedAccounts.map((a, i) =>
          i === 1
            ? { ...a, email: 'unused@example.com', updatedAt: 22, organizationName: 'Unused' }
            : a
        )
      }),
      (s: typeof settings) => ({
        ...s,
        claudeManagedAccounts: [
          ...s.claudeManagedAccounts,
          {
            ...s.claudeManagedAccounts[1]!,
            id: 'distro',
            managedAuthRuntime: 'wsl' as const,
            wslDistro: 'Debian'
          }
        ]
      })
    ]) {
      accountRenders.clear()
      comparisons.mockClear()
      project.mockClear()
      resolve.mockClear()
      await changeSettings(update)
      expect(accountRenders.size).toBe(0)
      expect(client.claudeList).toHaveBeenCalledTimes(1)
      expect(client.codexList).toHaveBeenCalledTimes(1)
      expect(project.mock.calls.length).toBeLessThanOrEqual(2)
      expect(resolve).not.toHaveBeenCalled()
      expect(comparisons.mock.calls.length).toBeLessThanOrEqual(2 * (size + 1))
    }
    accountRenders.clear()
    await act(async () =>
      useAppStore.setState((state) => {
        const statuses = new Map(state.runtimeStatusByEnvironmentId)
        statuses.set('runtime:other', { status: null, checkedAt: 2 })
        return { runtimeStatusByEnvironmentId: statuses }
      })
    )
    expect(accountRenders.size).toBe(0)
    expect(client.claudeList).toHaveBeenCalledTimes(1)
    // B changed while unused: its new acquire cannot certify the old native roster.
    client.setClaude({
      accounts: [
        { ...settings.claudeManagedAccounts[0]!, home: '/accounts/claude-0' },
        {
          ...settings.claudeManagedAccounts[1]!,
          home: '/accounts/claude-1',
          email: 'unused@example.com'
        }
      ],
      activeAccountId: 'claude-9'
    })
    const b = { ...recordedSession('claude', 1), id: 'new-b' }
    accountRenders.clear()
    panel.rerender(accountCards([...sessions, b]))
    await flushAccountWork()
    expect(client.claudeList).toHaveBeenCalledTimes(2)
    expect(panel.getByTestId('new-b').textContent).toContain('unused@example.com')
    accountRenders.clear()
    client.setClaude({
      accounts: [
        {
          ...settings.claudeManagedAccounts[0]!,
          home: '/accounts/claude-0',
          email: 'changed@example.com'
        },
        {
          ...settings.claudeManagedAccounts[1]!,
          home: '/accounts/claude-1',
          email: 'unused@example.com'
        }
      ],
      activeAccountId: null
    })
    await changeSettings((s) => ({
      ...s,
      claudeManagedAccounts: s.claudeManagedAccounts.map((a, i) =>
        i === 0 ? { ...a, email: 'changed@example.com', lastAuthenticatedAt: 2 } : a
      )
    }))
    expect(panel.getByTestId('reader-0').textContent).toContain('changed@example.com')
    expect(accountRenders.get('new-b') ?? 0).toBe(0)
    const missing = {
      ...a,
      id: 'discover',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/new/home' }
    }
    panel.rerender(accountCards([...sessions, b, missing]))
    await flushAccountWork()
    expect(panel.getByTestId('discover').textContent).toContain('Unknown')
    client.setClaude({
      accounts: [{ ...settings.claudeManagedAccounts[0]!, home: '/new/home' }],
      activeAccountId: null
    })
    await changeSettings((s) => ({
      ...s,
      claudeManagedAccounts: s.claudeManagedAccounts.map((a, i) =>
        i === 0 ? { ...a, managedAuthPath: '/new/home' } : a
      )
    }))
    expect(panel.getByTestId('discover').textContent).toContain('claude-0@example.com')
    expect(panel.getByTestId('reader-0').textContent).toContain('Unknown')
    client.setClaude({ accounts: [], activeAccountId: null })
    await changeSettings((s) => ({
      ...s,
      claudeManagedAccounts: s.claudeManagedAccounts.filter((a) => a.id !== 'claude-0')
    }))
    expect(panel.getByTestId('discover').textContent).toContain('Unknown')
    panel.unmount()
    await flushAccountWork()
    expect(settingsListeners).toBe(0)
  }
)

it('drains actual deferred list dispatches through R0, R1, R2, failures and legitimate recovery', async () => {
  const settings = accountSettings()
  useAppStore.setState({ settings })
  const reads: {
    claude: ReturnType<typeof Promise.withResolvers<ClaudeRateLimitAccountsState>>
    codex: ReturnType<typeof Promise.withResolvers<CodexRateLimitAccountsState>>
  }[] = []
  const claudeList = vi.fn(() => {
    const read = {
      claude: Promise.withResolvers<ClaudeRateLimitAccountsState>(),
      codex: Promise.withResolvers<CodexRateLimitAccountsState>()
    }
    reads.push(read)
    return read.claude.promise
  })
  const codexList = vi.fn(() => reads.at(-1)!.codex.promise)
  window.api.claudeAccounts = { ...window.api.claudeAccounts, list: claudeList }
  window.api.codexAccounts = { ...window.api.codexAccounts, list: codexList }
  const a = recordedSession('claude')
  const panel = render(accountCards([a, { ...recordedSession('codex'), id: 'codex' }]))
  const mutate = () =>
    changeSettings((s) => ({
      ...s,
      claudeManagedAccounts: s.claudeManagedAccounts.map((a) => ({
        ...a,
        lastAuthenticatedAt: a.lastAuthenticatedAt + 1
      }))
    }))
  const settle = async (n: number, failure: 'none' | 'claude' | 'both' = 'none') =>
    act(async () => {
      const read = reads[n]!
      if (failure === 'none') {
        read.claude.resolve({
          accounts: [
            {
              ...settings.claudeManagedAccounts[0]!,
              home: '/accounts/claude-0',
              email: `R${n}@example.com`
            }
          ],
          activeAccountId: null
        })
      } else {
        read.claude.reject(new Error('Claude unavailable'))
      }
      if (failure === 'both') {
        read.codex.reject(new Error('Codex unavailable'))
      } else {
        read.codex.resolve({
          accounts: [{ ...settings.codexManagedAccounts[0]!, email: `healthy-${n}@example.com` }],
          activeAccountId: null
        })
      }
    })
  expect(reads).toHaveLength(1)
  await mutate()
  expect(reads).toHaveLength(1)
  await settle(0)
  expect(reads).toHaveLength(2)
  expect(panel.getByTestId(a.id).textContent).toContain('Unknown')
  await mutate()
  expect(reads).toHaveLength(2)
  await settle(1, 'both')
  expect(reads).toHaveLength(3)
  await settle(2)
  expect(reads).toHaveLength(3)
  expect(panel.getByTestId(a.id).textContent).toContain('R2@example.com')
  await mutate()
  expect(panel.getByTestId(a.id).textContent).toContain('Unknown')
  await settle(3, 'claude')
  expect(panel.getByTestId('codex').textContent).toContain('healthy-3@example.com')
  expect(reads).toHaveLength(4)
  await mutate()
  await settle(4, 'both')
  await flushAccountWork()
  expect(reads).toHaveLength(5)
  panel.rerender(
    accountCards([a, { ...a, id: 'recover' }, { ...recordedSession('codex'), id: 'codex' }])
  )
  expect(reads).toHaveLength(6)
  await settle(5)
  expect(panel.getByTestId('recover').textContent).toContain('R5@example.com')
  expect(panel.getByTestId(a.id).textContent).toContain('R5@example.com')
  // Last native reader fences already-dispatched IPC; a later owner starts fresh.
  panel.unmount()
  await flushAccountWork()
  const latePanel = render(accountCards([a]))
  expect(reads).toHaveLength(7)
  latePanel.unmount()
  await flushAccountWork()
  const successor = render(accountCards([a]))
  expect(reads).toHaveLength(8)
  await settle(6)
  expect(successor.getByTestId(a.id).textContent).toContain('Unknown')
  await settle(7)
  expect(successor.getByTestId(a.id).textContent).toContain('R7@example.com')
  expect(claudeList).toHaveBeenCalledTimes(8)
  expect(codexList).toHaveBeenCalledTimes(8)
  successor.unmount()
  await flushAccountWork()
  claudeList.mockImplementationOnce(() => {
    throw new Error('Synchronous IPC setup failure')
  })
  const setupFailure = render(accountCards([a]))
  await flushAccountWork()
  expect(setupFailure.getByTestId(a.id).textContent).toContain('Unknown')
  expect(claudeList).toHaveBeenCalledTimes(9)
  setupFailure.rerender(accountCards([a, { ...a, id: 'after-setup-failure' }]))
  expect(claudeList).toHaveBeenCalledTimes(10)
  await settle(8)
  expect(setupFailure.getByTestId(a.id).textContent).toContain('R8@example.com')
})

it('retains Codex saved fallback and refreshes relevant same-email peer groups', async () => {
  const settings = accountSettings(2)
  settings.codexManagedAccounts[1]!.email = settings.codexManagedAccounts[0]!.email
  useAppStore.setState({ settings })
  const client = nativeClient(settings)
  client.codexList.mockRejectedValueOnce(new Error('Codex unavailable'))
  const a = recordedSession('codex')
  const panel = render(accountCards([a]))
  await flushAccountWork()
  expect(panel.getByTestId(a.id).textContent).toContain('codex-0@example.com')
  client.setCodex({ accounts: settings.codexManagedAccounts, activeAccountId: 'codex-1' })
  await changeSettings((s) => ({
    ...s,
    codexManagedAccounts: s.codexManagedAccounts.map((a, i) =>
      i === 1 ? { ...a, workspaceLabel: 'Team' } : a
    )
  }))
  expect(client.codexList).toHaveBeenCalledTimes(2)
  expect(panel.getByTestId(a.id).textContent).toContain('(codex-0)')
  client.setCodex({ accounts: [{ ...settings.codexManagedAccounts[0]! }], activeAccountId: null })
  await changeSettings((s) => ({
    ...s,
    codexManagedAccounts: s.codexManagedAccounts.filter((a) => a.id !== 'codex-1')
  }))
  expect(panel.getByTestId(a.id).textContent).toContain('codex-0@example.com')
  expect(panel.getByTestId(a.id).textContent).not.toContain('(codex-0)')
})
