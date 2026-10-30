// @vitest-environment happy-dom
import { agentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'
import {
  beginViewerSelectionRequest,
  disposeViewerSelection,
  viewerSelectionOutcome
} from '@/lib/viewer-selection-request'
import { activateTabNumberShortcut } from '@/lib/tab-number-shortcuts'
import { registerTerminalUiRoutingIpcBridge } from '@/hooks/ipc-events/terminal-ui-routing-ipc-bridge'
import { applyWebSessionTabsStorePatch } from './web-session-tabs-sync/store-patch'
import {
  createWebSessionTabsSnapshotPatch,
  applyWebSessionTabsSnapshot
} from './web-session-tabs-sync/snapshot-api'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeOpenFile } from '@/store/slices/store-session-test-harness'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import { createWebRuntimeSessionTerminalResult } from './web-runtime-terminal-create-operation'
import { refreshWebRuntimeSessionTabsSnapshot } from './web-runtime-session-snapshot'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'

const ENV = 'paired-placement',
  WT = 'repo::/repo'
const chat = (id: string) => ({
  type: 'agent-session' as const,
  id: `agent-session:${id}`,
  sessionId: id,
  agent: 'codex' as const,
  title: id,
  isActive: false
})
type TerminalFocusCallback = Parameters<typeof window.api.ui.onFocusTerminal>[0]
function routeTerminalFocus(data: Parameters<TerminalFocusCallback>[0]): void {
  let focusTerminal: TerminalFocusCallback = () => {
    throw new Error('Terminal focus listener was not registered')
  }
  const originalApi = window.api
  Object.assign(window, {
    api: {
      ...originalApi,
      ui: {
        ...originalApi?.ui,
        onSplitTerminal: () => () => {},
        onRenameTerminal: () => () => {},
        onSetPaneTitle: () => () => {},
        onFocusEditorTab: () => () => {},
        onFocusTerminal: (callback: TerminalFocusCallback) => {
          focusTerminal = callback
          return () => {}
        }
      }
    }
  })
  const unsubs: (() => void)[] = []
  try {
    registerTerminalUiRoutingIpcBridge(unsubs)
    focusTerminal(data)
  } finally {
    unsubs.forEach((unsubscribe) => unsubscribe())
    Object.assign(window, { api: originalApi })
  }
}

let frame: RuntimeMobileSessionTabsResult
function resetFrame() {
  resetWebSessionTabsSnapshotFreshnessForTests()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    activeWorktreeId: WT,
    activeWorkspaceExecutionHostId: `runtime:${ENV}`,
    settings: createGlobalSettingsFixture({
      ...useAppStore.getState().settings,
      activeRuntimeEnvironmentId: ENV
    })
  })
  const source = ['A', 'C', 'B']
  frame = {
    worktree: WT,
    publicationEpoch: 'host-placement',
    snapshotVersion: 1,
    activeGroupId: 'R',
    activeTabId: 'agent-session:D',
    activeTabType: 'agent-session',
    tabs: [...source, 'D'].map(chat),
    tabGroups: [
      {
        id: 'L',
        activeTabId: 'agent-session:C',
        tabOrder: source.map((id) => `agent-session:${id}`)
      },
      { id: 'R', activeTabId: 'agent-session:D', tabOrder: ['agent-session:D'] }
    ]
  }
  useAppStore.setState((state) => applyWebSessionTabsSnapshot(state, frame, ENV))
}
beforeEach(() => resetFrame())
afterEach(() => vi.restoreAllMocks())
it.each([{ pinned: false }, { pinned: true }])(
  'keeps client neighbors and pin partitions through early retirement and refresh (pinned: $pinned)',
  async ({ pinned }) => {
    if (pinned) {
      frame = {
        ...frame,
        snapshotVersion: frame.snapshotVersion + 1,
        tabs: [
          ...frame.tabs.map((tab) => ({
            ...tab,
            isPinned: ['agent-session:A', 'agent-session:C', 'agent-session:B'].includes(tab.id)
          })),
          chat('U')
        ],
        tabGroups: frame.tabGroups?.map((group) =>
          group.id === 'L' ? { ...group, tabOrder: [...group.tabOrder, 'agent-session:U'] } : group
        )
      }
      useAppStore.setState((state) => applyWebSessionTabsSnapshot(state, frame, ENV))
    }
    const before = useAppStore.getState()
    const source = before.unifiedTabsByWorktree[WT].find((tab) => tab.entityId === 'C')!
    const sourceGroup = source.groupId
    const runtimeCall = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'session.tabs.createTerminal') {
        frame = {
          ...frame,
          snapshotVersion: frame.snapshotVersion + 1,
          tabs: [
            ...frame.tabs.filter((tab) => tab.id !== 'agent-session:C'),
            {
              type: 'terminal',
              id: 'T::leaf',
              parentTabId: 'T',
              leafId: 'leaf',
              title: 'Terminal',
              terminal: 'term_T',
              isActive: false,
              status: 'ready'
            }
          ],
          tabGroups: [
            {
              id: 'L',
              activeTabId: 'T',
              tabOrder: [
                'agent-session:A',
                'agent-session:B',
                'T',
                ...(pinned ? ['agent-session:U'] : [])
              ]
            },
            frame.tabGroups![1]
          ]
        }
        // Publication beats the create response, with C already gone and T at the host's old fallback.
        useAppStore.setState((state) => applyWebSessionTabsSnapshot(state, frame, ENV))
        expect(
          useAppStore.getState().unifiedTabsByWorktree[WT].some((tab) => tab.entityId === 'C')
        ).toBe(false)
        useAppStore.getState().createUnifiedTab(WT, 'editor', {
          id: 'concurrent',
          entityId: '/repo/concurrent',
          targetGroupId: sourceGroup
        })
        return { id: 'create', ok: true as const, result: { tab: frame.tabs.at(-1) } }
      }
      if (method === 'session.tabs.list') {
        return { id: 'list', ok: true as const, result: frame }
      }
      throw new Error(`Unexpected ${method}`)
    })
    Object.assign(window, {
      api: {
        ...window.api,
        runtimeEnvironments: { ...window.api?.runtimeEnvironments, call: runtimeCall }
      }
    })
    const result = await createWebRuntimeSessionTerminalResult({
      environmentId: ENV,
      worktreeId: WT,
      afterTabId: source.id,
      targetGroupId: sourceGroup,
      launchAgent: 'codex',
      command: 'codex resume conversation',
      resumeOrigin: 'switch',
      providerSession: { key: 'session_id', id: 'conversation' },
      selectWorktree: false,
      activate: true
    })
    expect(result.outcome.status).toBe('created')
    const order = () =>
      useAppStore.getState().groupsByWorktree[WT].find((group) => group.id === sourceGroup)!
        .tabOrder
    const expected = [
      'structured-agent-session-A',
      ...(pinned ? ['structured-agent-session-B'] : []),
      toWebTerminalSurfaceTabId('T'),
      ...(pinned ? ['structured-agent-session-U'] : ['structured-agent-session-B']),
      'concurrent'
    ]
    expect(order()).toEqual(expected)
    expect(useAppStore.getState().activeGroupIdByWorktree[WT]).toBe(sourceGroup)
    await refreshWebRuntimeSessionTabsSnapshot(ENV, WT, { acceptCurrentSnapshot: true })
    expect(order()).toEqual(expected)
  }
)

it.each([
  {
    owner: 'local-structured-session',
    direction: 'chat',
    inventoryFirst: false,
    navigation: 'notification'
  },
  {
    owner: 'local-structured-session',
    direction: 'terminal',
    inventoryFirst: true,
    navigation: 'shortcut'
  },
  { owner: ENV, direction: 'chat', inventoryFirst: true, navigation: 'shortcut' },
  { owner: ENV, direction: 'terminal', inventoryFirst: false, navigation: 'shortcut' }
] as const)(
  'consumes the original viewer choice once at the real $owner $direction snapshot writer ($navigation)',
  async ({ owner, direction, inventoryFirst, navigation }) => {
    const worktreeId = navigation === 'notification' ? 'folder:folder-1' : WT
    for (const navigate of [false, true]) {
      disposeViewerSelection()
      useAppStore.setState(useAppStore.getInitialState(), true)
      useAppStore.setState({ activeWorktreeId: worktreeId, activeView: 'terminal' })
      const leafId = '10000000-0000-4000-8000-000000000001'
      const terminal = (id: string) => ({
        type: 'terminal' as const,
        id: `${id}::${leafId}`,
        parentTabId: id,
        leafId,
        title: id,
        terminal: `term_${id}`,
        isActive: false,
        status: 'ready' as const
      })
      const source = direction === 'chat' ? terminal('A') : chat('A')
      let snapshot: RuntimeMobileSessionTabsResult = {
        worktree: worktreeId,
        publicationEpoch: 'selection',
        snapshotVersion: 1,
        activeGroupId: 'G',
        activeTabId: source.id,
        tabs: [source, terminal('B'), terminal('C')],
        tabGroups: [
          {
            id: 'G',
            activeTabId: source.id,
            tabOrder: [source.type === 'terminal' ? 'A' : source.id, 'B', 'C']
          }
        ]
      }
      const apply = () =>
        applyWebSessionTabsStorePatch(createWebSessionTabsSnapshotPatch(snapshot, owner), {
          frames: []
        })()
      apply()
      const initial = useAppStore.getState()
      const sourceTab = initial.unifiedTabsByWorktree[worktreeId].find(
        (tab) => tab.entityId === (direction === 'chat' ? toWebTerminalSurfaceTabId('A') : 'A')
      )!
      const siblings = ['B', 'C'].map((id) =>
        initial.unifiedTabsByWorktree[worktreeId].find(
          (tab) => tab.entityId === toWebTerminalSurfaceTabId(id)
        )!
      )
      const groupId = sourceTab.groupId
      useAppStore.setState({
        openFiles: [makeOpenFile({ id: '/repo/client-only', worktreeId })]
      })
      initial.createUnifiedTab(worktreeId, 'editor', {
        id: 'X',
        entityId: '/repo/client-only',
        targetGroupId: groupId,
        afterTabId: sourceTab.id,
        activate: false
      })
      const deadline = agentSessionSwitchDeadline(Date.now)
      try {
        const selection = beginViewerSelectionRequest('snapshot-choice', deadline)
        selection.accept()
        const openPlacement = {
          invocationId: 'snapshot-choice',
          generation: 'snapshot-generation',
          placement: { groupId, afterTabId: sourceTab.id, index: 0 },
          activate: true,
          viewerSelection: selection.token
        }
        // Natural disappearance and ordinary fallback are not navigation.
        snapshot = {
          ...snapshot,
          snapshotVersion: 2,
          tabs: snapshot.tabs.slice(1),
          tabGroups: [{ id: 'G', activeTabId: 'C', tabOrder: ['B', 'C'] }]
        }
        apply()
        if (navigation === 'notification') {
          routeTerminalFocus({
            tabId: toWebTerminalSurfaceTabId('C'),
            worktreeId,
            leafId,
            ...(navigate
              ? {
                  ackPaneKeyOnSuccess: makePaneKey(toWebTerminalSurfaceTabId('C'), leafId),
                  flashFocusedPane: true,
                  scrollToBottomIfOutputSinceLastView: true
                }
              : {})
          })
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
          expect(useAppStore.getState().activeWorktreeId).toBe(worktreeId)
          expect(useAppStore.getState().activeTabIdByWorktree[worktreeId]).toBe(
            toWebTerminalSurfaceTabId('C')
          )
        } else if (navigate) {
          // A real shortcut/re-click, including ABA, must supersede the captured gesture.
          expect(activateTabNumberShortcut(2)).toBe(true)
          expect(activateTabNumberShortcut(1)).toBe(true)
          expect(activateTabNumberShortcut(2)).toBe(true)
        }
        const userChoice = useAppStore.getState().activeTabIdByWorktree[worktreeId]
        const destination = direction === 'chat' ? chat('canonical-D') : terminal('D')
        snapshot = {
          ...snapshot,
          snapshotVersion: 3,
          tabs: [destination, ...snapshot.tabs],
          tabGroups: [
            {
              id: 'G',
              activeTabId: 'C',
              tabOrder: [destination.type === 'terminal' ? 'D' : destination.id, 'B', 'C']
            }
          ]
        }
        if (inventoryFirst) {
          snapshot = {
            ...snapshot,
            tabs: snapshot.tabs.map((row) =>
              row.id === destination.id
                ? { ...row, openPlacement: { ...openPlacement, activate: false } }
                : row
            )
          }
          apply()
        }
        if (navigation !== 'notification' || !navigate) {
          expect(viewerSelectionOutcome(selection.token)).toBe(navigate ? 'superseded' : 'pending')
        }
        snapshot = {
          ...snapshot,
          snapshotVersion: 4,
          tabs: snapshot.tabs.map((row) =>
            row.id === destination.id ? { ...row, openPlacement } : row
          )
        }
        apply()
        const after = useAppStore.getState()
        const landed = after.unifiedTabsByWorktree[worktreeId].find(
          (row) =>
            row.entityId === (direction === 'chat' ? 'canonical-D' : toWebTerminalSurfaceTabId('D'))
        )!
        expect(landed).toBeDefined()
        const group = after.groupsByWorktree[worktreeId].find((row) => row.id === groupId)!
        expect(group.tabOrder).toEqual([landed.id, 'X', ...siblings.map((row) => row.id)])
        expect(group.activeTabId).toBe(navigate ? userChoice : landed.id)
        expect(viewerSelectionOutcome(selection.token)).toBe(navigate ? 'superseded' : 'fulfilled')
        expect(
          after.unifiedTabsByWorktree[worktreeId].filter((row) => row.id === landed.id)
        ).toHaveLength(1)
        apply()
        expect(
          useAppStore.getState().groupsByWorktree[worktreeId].find((row) => row.id === groupId)!
            .activeTabId
        ).toBe(group.activeTabId)
        // The same retained metadata is inventory after fulfilment, even after an ordinary repair.
        expect(activateTabNumberShortcut(3)).toBe(true)
        const later = useAppStore.getState().activeTabIdByWorktree[worktreeId]
        apply()
        expect(useAppStore.getState().activeTabIdByWorktree[worktreeId]).toBe(later)
        expect(
          useAppStore.getState().groupsByWorktree[worktreeId].find((row) => row.id === groupId)!
            .tabOrder
        ).toEqual(group.tabOrder)
      } finally {
        deadline.dispose()
      }
    }
  }
)
