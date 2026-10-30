import { beforeEach, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'

const mocks = vi.hoisted(() => {
  const tabs: Record<string, Tab[]> = {}
  return {
    call: vi.fn(),
    supports: vi.fn(),
    apply: vi.fn(),
    activateTab: vi.fn(),
    focusGroup: vi.fn(),
    setActiveTabType: vi.fn(),
    state: {
      activeWorktreeId: 'workspace',
      activeWorkspaceExecutionHostId: 'local' as const,
      unifiedTabsByWorktree: tabs
    }
  }
})
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionWorktreeTabs: async () => undefined
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      ...mocks.state,
      activateTab: mocks.activateTab,
      focusGroup: mocks.focusGroup,
      setActiveTabType: mocks.setActiveTabType
    })
  }
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  callRuntimeRpc: mocks.call,
  runtimeEnvironmentSupportsCapability: mocks.supports
}))
vi.mock('@/runtime/local-structured-session-tabs-sync/snapshot-apply', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  applyStructuredSessionTabSnapshots: mocks.apply
}))

import { activateAiVaultStructuredSession } from './activate-ai-vault-structured-session'
import { STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'

const TARGET = { kind: 'environment', environmentId: 'remote-2' } as const
function tab(id: string, host: 'local' | 'runtime:remote-2'): Tab {
  return {
    id,
    worktreeId: 'workspace',
    entityId: 'sender',
    executionHostId: host,
    groupId: 'group',
    contentType: 'agent-session',
    label: 'Claude Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.unifiedTabsByWorktree = { workspace: [tab('wrong-local', 'local')] }
  mocks.supports.mockResolvedValue(true)
  mocks.call.mockImplementation(async (_host, method: string) => {
    if (method === 'orchestration.partyLocation') {
      return { location: { kind: 'chat', sessionId: 'sender', worktreeId: 'workspace' } }
    }
    if (method === 'agentSession.reveal') {
      // The paired mirror, rather than the local snapshot apply, publishes the revealed tab.
      mocks.state.unifiedTabsByWorktree.workspace.push(tab('right-remote', 'runtime:remote-2'))
    }
    return { ok: true, sessionId: 'sender', workspaceId: 'workspace', agent: 'claude' }
  })
})

it.each([false, true])(
  'keeps the known host through lineage/refresh/reveal/activation without applying its snapshot as local; older lookup=%s',
  async (olderLookup) => {
    if (olderLookup) {
      const call = mocks.call.getMockImplementation()!
      mocks.call.mockImplementation(async (...args) => {
        if (args[1] === 'orchestration.partyLocation') {
          throw Object.assign(new Error('old host'), { code: 'method_not_found' })
        }
        return call(...args)
      })
    }
    await expect(
      activateAiVaultStructuredSession(
        {
          structuredSession: { workspaceId: 'workspace', sessionId: 'sender' }
        },
        undefined,
        TARGET
      )
    ).resolves.toBe(true)
    expect(mocks.supports).toHaveBeenCalledWith(
      'remote-2',
      STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY,
      expect.any(Number)
    )
    expect(mocks.call.mock.calls.map(([host, method]) => [host, method])).toEqual([
      [TARGET, 'session.tabs.list'],
      [TARGET, 'orchestration.partyLocation'],
      [TARGET, 'agentSession.reveal'],
      [TARGET, 'session.tabs.list'],
      [TARGET, 'session.tabs.activate']
    ])
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(mocks.activateTab).toHaveBeenCalledOnce()
    expect(mocks.activateTab).toHaveBeenCalledWith('right-remote', { worktreeId: 'workspace' })
  }
)

it('a listed exact History view selects while lookup is unavailable and never starts it', async () => {
  mocks.state.unifiedTabsByWorktree.workspace.push(tab('right-remote', 'runtime:remote-2'))
  mocks.call.mockImplementation(async (_host, method) => {
    if (method === 'orchestration.partyLocation') {
      return new Promise(() => {})
    }
    return { ok: true }
  })
  await activateAiVaultStructuredSession(
    { structuredSession: { sessionId: 'sender', workspaceId: 'workspace' } },
    undefined,
    TARGET
  )
  expect(mocks.activateTab).toHaveBeenCalledWith('right-remote', { worktreeId: 'workspace' })
  expect(mocks.call.mock.calls.map((call) => call[1])).toEqual(['session.tabs.activate'])
})

it('bounds a missing local History lookup and releases coalescing for a legitimate retry', async () => {
  vi.useFakeTimers()
  try {
    mocks.state.unifiedTabsByWorktree = {}
    mocks.call.mockImplementation(async (_host, method) =>
      method === 'orchestration.partyLocation' ? new Promise(() => {}) : { ok: true }
    )
    const session = { structuredSession: { sessionId: 'missing', workspaceId: 'workspace' } }
    const first = activateAiVaultStructuredSession(session, undefined, { kind: 'local' })
    const second = activateAiVaultStructuredSession(session, undefined, { kind: 'local' })
    await vi.advanceTimersByTimeAsync(5001)
    await Promise.all([first, second])
    expect(
      mocks.call.mock.calls.filter((call) => call[1] === 'orchestration.partyLocation')
    ).toHaveLength(1)
    const retry = activateAiVaultStructuredSession(session, undefined, { kind: 'local' })
    await vi.advanceTimersByTimeAsync(5001)
    await retry
    expect(
      mocks.call.mock.calls.filter((call) => call[1] === 'orchestration.partyLocation')
    ).toHaveLength(2)
  } finally {
    vi.useRealTimers()
  }
})
