// @vitest-environment happy-dom
import { agentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'
import {
  beginViewerSelectionRequest,
  disposeViewerSelection,
  viewerSelectionOutcome
} from './viewer-selection-request'
import { activateTabNumberShortcut } from './tab-number-shortcuts'
import { expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { createTabsSliceMockApi } from '@/store/slices/tabs-slice-test-harness'
import { launchAiVaultSessionInNewTab } from './launch-ai-vault-session'

const mocks = vi.hoisted(() => {
  const held: { store: unknown } = { store: null }
  return held
})
vi.mock('@/store', () => ({
  get useAppStore() {
    return mocks.store
  }
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: () => null
}))
vi.mock('@/runtime/structured-agent-session-tab-retirement', () => ({
  beginStructuredAgentSessionTabClose: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

createTabsSliceMockApi()

it('keeps the pinned partition and neighbor order after a local switch retires its source', () => {
  const worktreeId = 'repo1::/work/app'
  const groupId = 'group-1'
  const tab = (id: string, extra: Partial<Tab> = {}): Tab => ({
    id,
    entityId: id,
    groupId,
    worktreeId,
    contentType: 'browser',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...extra
  })
  const source = tab('agent-session:chat', {
    entityId: 'chat',
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    executionHostId: 'local',
    isPinned: true
  })
  const store = createTestStore()
  mocks.store = store
  store.setState({
    unifiedTabsByWorktree: {
      [worktreeId]: [source, tab('pinned', { isPinned: true }), tab('unpinned')]
    },
    groupsByWorktree: {
      [worktreeId]: [
        {
          id: groupId,
          worktreeId,
          activeTabId: source.id,
          tabOrder: [source.id, 'pinned', 'unpinned']
        }
      ]
    },
    activeGroupIdByWorktree: { [worktreeId]: groupId },
    layoutByWorktree: { [worktreeId]: { type: 'leaf', groupId } }
  })

  const result = launchAiVaultSessionInNewTab({
    agent: 'codex',
    worktreeId,
    command: 'codex resume provider-1',
    afterTabId: source.id,
    resumeOrigin: 'switch'
  })
  expect(result.tabId).toEqual(expect.any(String))
  store.getState().closeUnifiedTab(source.id)

  expect(store.getState().groupsByWorktree[worktreeId]?.[0]?.tabOrder).toEqual([
    'pinned',
    result.tabId,
    'unpinned'
  ])
  expect(store.getState().unifiedTabsByWorktree[worktreeId]?.some((t) => t.id === source.id)).toBe(
    false
  )
})

it.each([false, true])(
  'old Continue ordinary create consumes the original selection, newer reclick=%s',
  (navigate) => {
    const store = createTestStore()
    mocks.store = store
    const worktreeId = 'repo1::/work/app'
    store.setState({ activeWorktreeId: worktreeId, activeView: 'terminal' })
    const source = store.getState().createTab(worktreeId)
    const deadline = agentSessionSwitchDeadline(Date.now)
    try {
      const selection = beginViewerSelectionRequest('old-continue', deadline)
      selection.accept()
      if (navigate) {
        expect(activateTabNumberShortcut(0)).toBe(true)
      }
      const result = launchAiVaultSessionInNewTab({
        agent: 'codex',
        worktreeId,
        command: 'codex resume copied-conversation',
        viewerSelection: selection.token
      })
      expect(result.tabId).not.toBeNull()
      expect(store.getState().tabsByWorktree[worktreeId]).toHaveLength(2)
      expect(store.getState().getActiveTab(worktreeId)?.entityId).toBe(
        navigate ? source.id : result.tabId
      )
      expect(viewerSelectionOutcome(selection.token)).toBe(navigate ? 'superseded' : 'fulfilled')
      expect(store.getState().pendingStartupByTabId[result.tabId ?? '']?.command).toBe(
        'codex resume copied-conversation'
      )
    } finally {
      deadline.dispose()
      disposeViewerSelection()
    }
  }
)
