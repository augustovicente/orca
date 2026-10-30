// @vitest-environment happy-dom
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTabsSliceMockApi } from '../store/slices/tabs-slice-test-harness'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type * as SessionOwner from '@/runtime/structured-agent-session-owner'
import { useAppStore } from '@/store'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../shared/structured-agent-session-reducer'
import { runConversationSwitch, runNativeChatCliSwitch } from './conversation-surface-switch'
import { pendingNativeChatCliSwitches } from './pending-conversation-surface-switches'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { createWebSessionTabsSnapshotPatch } from '@/runtime/web-session-tabs-sync/snapshot-api'
import { applyWebSessionTabsStorePatch } from '@/runtime/web-session-tabs-sync/store-patch'
import { activateTabNumberShortcut } from './tab-number-shortcuts'
import {
  beginViewerSelectionRequest,
  disposeViewerSelection,
  viewerSelectionOutcome
} from './viewer-selection-request'
import { presentConversationSwitchResult } from './conversation-switch-result-selection'
import { agentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'
import type { Tab } from '../../../shared/tab-types'
const mocks = vi.hoisted(() => {
  function makeTarget(): { current: RuntimeClientTarget } {
    return { current: { kind: 'local' } }
  }
  return {
    target: makeTarget(),
    support: vi.fn(),
    rpc: vi.fn(),
    capture: vi.fn(),
    prepare: vi.fn(),
    pairedRefresh: vi.fn(),
    call: vi.fn(),
    legacy: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    error: vi.fn(),
    info: vi.fn(),
    reader: vi.fn(),
    listeners: new Set<() => void>(),
    subscribe: (listener: () => void) => {
      mocks.listeners.add(listener)
      return () => mocks.listeners.delete(listener)
    }
  }
})
vi.mock('sonner', () => ({ toast: { error: mocks.error, info: mocks.info } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  supportsInPlaceSwitch: mocks.support,
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/structured-agent-session-owner', async (original) => ({
  ...(await original<typeof SessionOwner>()),
  structuredAgentSessionTargetForHost: () => mocks.target.current
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<object>()),
  callRuntimeRpc: mocks.rpc
}))
vi.mock('@/components/tab-bar/cli-chat-resume-terminal-capture', () => ({
  captureSourceTerminal: mocks.capture
}))
vi.mock('./ai-vault-session-resume-preparation', () => ({
  prepareAiVaultSessionForResume: mocks.prepare
}))
vi.mock('@/runtime/web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: mocks.pairedRefresh
}))
vi.mock('./in-place-switch-support', () => ({
  useInPlaceSwitchCapability: () => true
}))
vi.mock('@/runtime/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: () => ({
    subscribe: mocks.subscribe,
    getSnapshot: () => new Map()
  })
}))
vi.mock('@/components/native-chat/structured-agent-session-read-owner-registry', () => ({
  findStructuredAgentSessionReadOwner: mocks.reader
}))
vi.mock('@/components/tab-bar/cli-chat-resume-run', () => ({
  runLegacyCliChatResume: mocks.legacy
}))
vi.mock('@/components/tab-bar/native-chat-cli-switch-run', () => ({
  runLegacyNativeChatCliSwitch: mocks.legacy
}))
vi.mock('@/components/tab-bar/cli-chat-resume-feedback', () => ({
  switchIntoOwnerLegacy: mocks.legacy
}))
vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionWorktreeTabs: mocks.refresh
}))
vi.mock('@/components/right-sidebar/ai-vault-session-resume-in-chat-launch', () => ({
  resumeAiVaultSessionInNewChat: mocks.legacy,
  adoptingAgentOnHost: async (agent: string) => agent
}))

const subject = {
  direction: 'terminal' as const,
  executionHostId: 'local',
  workspaceId: 'workspace',
  sessionId: 'codex_chat',
  agent: 'codex' as const,
  chatTabId: 'source'
}
beforeEach(() => {
  vi.clearAllMocks()
  createTabsSliceMockApi()
  mocks.target.current = { kind: 'local' }
  mocks.rpc.mockResolvedValue({})
  mocks.pairedRefresh.mockResolvedValue(undefined)
  mocks.capture.mockResolvedValue({
    handle: 'terminal-source',
    incarnationId: 'incarnation',
    presentation: {}
  })
  mocks.reader.mockReturnValue(undefined)
  mocks.support.mockResolvedValue(true)
  mocks.call.mockResolvedValue({ status: 'completed', sessionId: subject.sessionId })
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings!, experimentalNativeChat: true }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  pendingNativeChatCliSwitches.clear()
})
it('reserves pending before negotiation, sends one execution request and leaves all launching to the host', async () => {
  const negotiation = Promise.withResolvers<boolean>()
  mocks.support.mockReturnValue(negotiation.promise)
  const first = runConversationSwitch(subject)
  expect(await runConversationSwitch(subject)).toBe(false)
  negotiation.resolve(true)
  expect(await first).toBe(true)
  expect(mocks.support).toHaveBeenCalledOnce()
  expect(mocks.call).toHaveBeenCalledWith(
    { kind: 'local' },
    'agentSession.switchToTerminal',
    expect.objectContaining({
      sessionId: subject.sessionId,
      execution: expect.objectContaining({ sourceTabId: 'source' })
    }),
    expect.objectContaining({ signal: expect.any(AbortSignal), beforeSend: expect.any(Function) })
  )
  expect(mocks.legacy).not.toHaveBeenCalled()
  expect(pendingNativeChatCliSwitches.size).toBe(0)
})
it('formats real refusal categories once, with agent and next step, never raw errors or platform-wrong job control', async () => {
  mocks.call.mockRejectedValue(new Error('secret raw transport/provider failure'))
  await runConversationSwitch({ ...subject, direction: 'chat' })
  expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
    'Codex could not start in chat. Check its setup and try again.'
  )
})

it.each([false, true])(
  'asks once for a live reply; consent=%s has only the authorized effects',
  async (yes) => {
    mocks.reader.mockReturnValue({
      getSnapshot: () => ({
        current: true,
        state: {
          ...EMPTY_STRUCTURED_AGENT_SESSION,
          working: true,
          latestTurn: { itemId: 'turn', observedAt: 1, turn: { turnId: 'turn', state: 'running' } }
        }
      })
    })
    const answer = Promise.withResolvers<boolean>()
    const confirm = vi.fn(() => answer.promise)
    const first = runConversationSwitch({ ...subject, confirm })
    expect(await runConversationSwitch({ ...subject, confirm })).toBe(false)
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    expect(confirm).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: 'Codex is replying. Stop it and switch?',
        compact: true
      })
    )
    expect(mocks.support).toHaveBeenCalledOnce()
    expect(mocks.call).not.toHaveBeenCalled()
    answer.resolve(yes)
    expect(await first).toBe(yes)
    expect(mocks.call).toHaveBeenCalledTimes(yes ? 1 : 0)
    expect(mocks.refresh).toHaveBeenCalledTimes(yes ? 1 : 0)
  }
)

it.each([10, 100])('bounds real result discovery and selection at %i workspaces', async (count) => {
  const environmentId = 'scale-owner'
  const target = { kind: 'environment', environmentId } as const
  const sourceWorkspace = 'folder:scale-0'
  const destinationWorkspace = `folder:scale-${count - 1}`
  const sessionId = 'scale-native-A'
  disposeViewerSelection()
  useAppStore.setState({ activeWorktreeId: sourceWorkspace, activeView: 'terminal' })
  for (let index = 0; index < count; index++) {
    const sibling = terminal(index === 0 ? 'B' : `sibling-${index}`)
    const id = index === 1 || index === count - 1 ? sessionId : `unrelated-${index}`
    const second =
      index === 0
        ? terminal('C')
        : {
            type: 'agent-session' as const,
            id: `agent-session:${id}`,
            sessionId: id,
            agent: 'codex' as const,
            title: id,
            isActive: false
          }
    applySwitchSnapshot(
      {
        worktree: `folder:scale-${index}`,
        publicationEpoch: 'result-scale',
        snapshotVersion: 1,
        activeGroupId: 'G',
        activeTabId: sibling.id,
        activeTabType: 'terminal',
        tabs: [sibling, second],
        tabGroups: [
          {
            id: 'G',
            activeTabId: sibling.parentTabId,
            tabOrder: [
              sibling.parentTabId,
              second.type === 'terminal' ? second.parentTabId : second.id
            ]
          }
        ]
      },
      index === 1 ? 'other-owner' : environmentId
    )
  }
  const before = useAppStore.getState()
  const destinationRows = before.unifiedTabsByWorktree[destinationWorkspace]
  const destination = destinationRows.find((tab) => tab.entityId === sessionId)!
  const originalOrder = before.groupsByWorktree[destinationWorkspace][0].tabOrder
  const sourceRows = before.unifiedTabsByWorktree[sourceWorkspace]
  const sourceTerminals = before.tabsByWorktree[sourceWorkspace]
  const sourceLayouts = sourceRows.map((tab) => before.terminalLayoutsByTabId[tab.entityId])
  expect(destinationRows).toHaveLength(2)
  expect(
    Object.values(before.unifiedTabsByWorktree).reduce((sum, rows) => sum + rows.length, 0)
  ).toBe(2 * count)
  expect(destination.executionHostId).toBe('runtime:scale-owner')
  expect(
    before.unifiedTabsByWorktree['folder:scale-1'].find((tab) => tab.entityId === sessionId)
      ?.executionHostId
  ).toBe('runtime:other-owner')

  const [activation, owners, storePatch, viewer] = await Promise.all([
    import('./agent-session/structured-agent-session-tab-activation'),
    import('@/runtime/structured-agent-session-owner'),
    import('@/runtime/web-session-tabs-sync/store-patch'),
    import('./viewer-selection-request')
  ])
  const discovery = { calls: 0, keyPasses: 0, keys: 0, workspaces: 0, tabs: 0 }
  const candidateVisits = new Map<string, number>()
  const realFind = activation.findStructuredAgentSessionTab
  const lookup = vi
    .spyOn(activation, 'findStructuredAgentSessionTab')
    .mockImplementation((tabs, args) => {
      if (args.workspaceId !== undefined) {
        return realFind(tabs, args)
      }
      discovery.calls++
      return realFind(
        new Proxy(tabs, {
          ownKeys(actual) {
            const keys = Reflect.ownKeys(actual)
            discovery.keyPasses++
            discovery.keys += keys.length
            return keys
          },
          get(actual, property, receiver) {
            // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: only Reflect.get forwards a raw string|symbol key with the proxy receiver.
            const rows: readonly Tab[] | undefined = Reflect.get(actual, property, receiver)
            if (typeof property !== 'string' || !Object.hasOwn(actual, property) || !rows) {
              return rows
            }
            discovery.workspaces++
            return new Proxy(rows, {
              get(actualRows, key, arrayReceiver) {
                if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) {
                  discovery.tabs++
                  const row = `${property}:${key}`
                  candidateVisits.set(row, (candidateVisits.get(row) ?? 0) + 1)
                }
                // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: only Reflect.get forwards a raw string|symbol key with the proxy receiver.
                return Reflect.get(actualRows, key, arrayReceiver)
              }
            })
          }
        }),
        args
      )
    })
  const qualification = vi.spyOn(owners, 'structuredAgentSessionOwnerForTab')
  const selection = vi.spyOn(storePatch, 'selectSessionTabForViewer')
  const commit = vi.spyOn(viewer, 'commitViewerSelection')
  const deadline = agentSessionSwitchDeadline(Date.now)
  const request = beginViewerSelectionRequest(`result-scale-${count}`, deadline)
  request.accept()
  mocks.pairedRefresh.mockClear()
  mocks.rpc.mockClear()
  try {
    await presentConversationSwitchResult(
      {
        ...subject,
        direction: 'chat',
        workspaceId: sourceWorkspace,
        executionHostId: 'runtime:scale-owner'
      },
      target,
      { status: 'completed', sessionId },
      request.token
    )
    expect(discovery).toEqual({
      calls: 1,
      keyPasses: 1,
      keys: count,
      workspaces: count,
      tabs: 2 * count
    })
    expect(qualification).toHaveBeenCalledTimes(4)
    expect(candidateVisits.size).toBe(2 * count)
    expect(new Set(candidateVisits.values())).toEqual(new Set([1]))
    expect(qualification.mock.calls.map(([, tab]) => tab.executionHostId)).toEqual([
      'runtime:other-owner',
      'runtime:scale-owner',
      'runtime:scale-owner',
      'runtime:scale-owner'
    ])
    console.info(
      `[result-selection-work] W=${count} T=${2 * count} discoveryKeys=${discovery.keys} workspaceVisits=${discovery.workspaces} tabVisits=${discovery.tabs} ownerChecks=${qualification.mock.calls.length}`
    )
    expect(selection).toHaveBeenCalledExactlyOnceWith(
      destinationWorkspace,
      destination.id,
      request.token,
      environmentId
    )
    expect(commit).toHaveBeenCalledOnce()
    expect(viewerSelectionOutcome(request.token)).toBe('fulfilled')
    expect(mocks.pairedRefresh).toHaveBeenCalledExactlyOnceWith(
      environmentId,
      destinationWorkspace,
      {
        acceptCurrentSnapshot: true,
        afterCurrentInFlight: true
      }
    )
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(target, 'session.tabs.activate', {
      worktree: `id:${destinationWorkspace}`,
      tabId: `agent-session:${sessionId}`,
      notifyClients: false,
      navigation: 'caller'
    })
    const after = useAppStore.getState()
    expect(after.activeWorktreeId).toBe(destinationWorkspace)
    expect(
      after.groupsByWorktree[destinationWorkspace].find(
        (group) => group.id === after.activeGroupIdByWorktree[destinationWorkspace]
      )?.activeTabId
    ).toBe(destination.id)
    expect(after.activeTabType).toBe('agent-session')
    expect(after.unifiedTabsByWorktree[destinationWorkspace]).toHaveLength(2)
    expect(after.groupsByWorktree[destinationWorkspace][0].tabOrder).toEqual(originalOrder)
    expect(after.unifiedTabsByWorktree[sourceWorkspace]).toBe(sourceRows)
    expect(after.tabsByWorktree[sourceWorkspace]).toBe(sourceTerminals)
    expect(sourceRows.map((tab) => after.terminalLayoutsByTabId[tab.entityId])).toEqual(
      sourceLayouts
    )
  } finally {
    lookup.mockRestore()
    qualification.mockRestore()
    selection.mockRestore()
    commit.mockRestore()
    deadline.dispose()
    disposeViewerSelection()
    useAppStore.setState(useAppStore.getInitialState(), true)
  }
})

it.each(['codex'] as const)(
  'dispatches idle %s once through the common host command, preserving configured commands',
  async (agent) => {
    const confirm = vi.fn()
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        agentCmdOverrides: { [agent]: 'my-alias --option' }
      }
    })
    expect(await runConversationSwitch({ ...subject, agent, confirm })).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith(
      { kind: 'local' },
      'agentSession.switchToTerminal',
      expect.objectContaining({
        sessionId: subject.sessionId,
        execution: expect.objectContaining({ commandOverride: 'my-alias --option' })
      }),
      expect.any(Object)
    )
  }
)

it('does not offer chat switching while Chat UI is off', async () => {
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings!, experimentalNativeChat: false }
  })
  expect(await runConversationSwitch({ ...subject, direction: 'chat' })).toBe(false)
  expect(mocks.support).not.toHaveBeenCalled()
  expect(mocks.call).not.toHaveBeenCalled()
})

it('Continue with Chat UI off uses the same host switch identity, never copied/fork startup', async () => {
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings!, experimentalNativeChat: false }
  })
  const legacyContinue = vi.fn(async () => {})
  await runNativeChatCliSwitch({ ...subject, legacyContinue })
  expect(mocks.call).toHaveBeenCalledExactlyOnceWith(
    { kind: 'local' },
    'agentSession.switchToTerminal',
    expect.objectContaining({
      sessionId: subject.sessionId,
      execution: expect.objectContaining({
        sourceTabId: subject.chatTabId,
        viewerSelection: expect.stringMatching(/^selection-v1:/)
      })
    }),
    expect.any(Object)
  )
  expect(legacyContinue).not.toHaveBeenCalled()
  expect(mocks.legacy).not.toHaveBeenCalled()
})

it('old-host Continue while replying reports its copy outcome without promising Stop', async () => {
  mocks.support.mockResolvedValue(false)
  mocks.reader.mockReturnValue({
    getSnapshot: () => ({
      current: true,
      state: {
        ...EMPTY_STRUCTURED_AGENT_SESSION,
        working: true,
        latestTurn: { itemId: 'turn', observedAt: 1, turn: { turnId: 'turn', state: 'running' } }
      }
    })
  })
  const confirm = vi.fn()
  const legacyContinue = vi.fn(async () => {})
  await runNativeChatCliSwitch({ ...subject, confirm, legacyContinue })
  expect(mocks.support).toHaveBeenCalledOnce()
  expect(confirm).not.toHaveBeenCalled()
  expect(mocks.call).not.toHaveBeenCalled()
  expect(legacyContinue).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^selection-v1:/))
})

const terminal = (id: string) => ({
  type: 'terminal' as const,
  id: `${id}::11111111-1111-4111-8111-111111111111`,
  parentTabId: id,
  leafId: '11111111-1111-4111-8111-111111111111',
  title: id,
  terminal: `term_${id}`,
  isActive: false,
  status: 'ready' as const
})
const applySwitchSnapshot = (frame: RuntimeMobileSessionTabsResult, owner: string) =>
  applyWebSessionTabsStorePatch(createWebSessionTabsSnapshotPatch(frame, owner), {
    frames: []
  })()

it.each([
  { workspace: 'folder:existing-chat', navigate: false },
  { workspace: 'folder:existing-chat', navigate: true },
  { workspace: 'folder:terminal-source', navigate: false }
])(
  'selects the completed session in its actual $workspace without relocating it (navigation=$navigate)',
  async ({ workspace, navigate }) => {
    const environmentId = 'switch-owner'
    const target = { kind: 'environment', environmentId } as const
    const sourceWorkspace = 'folder:terminal-source'
    const sessionId = 'existing-native-A'
    const sourceFrame: RuntimeMobileSessionTabsResult = {
      worktree: sourceWorkspace,
      publicationEpoch: 'result-selection',
      snapshotVersion: 1,
      activeGroupId: 'source-group',
      activeTabId: terminal('B').id,
      activeTabType: 'terminal',
      tabs: [terminal('B'), terminal('C')],
      tabGroups: [{ id: 'source-group', activeTabId: 'B', tabOrder: ['B', 'C'] }]
    }
    const destinationFrame: RuntimeMobileSessionTabsResult = {
      ...sourceFrame,
      worktree: workspace,
      activeGroupId: workspace === sourceWorkspace ? 'source-group' : 'chat-group',
      activeTabId:
        workspace === sourceWorkspace ? sourceFrame.activeTabId : `agent-session:${sessionId}`,
      activeTabType: workspace === sourceWorkspace ? 'terminal' : 'agent-session',
      tabs: [
        ...(workspace === sourceWorkspace ? sourceFrame.tabs : []),
        {
          type: 'agent-session',
          id: 'agent-session:existing-native-A',
          sessionId,
          agent: 'codex',
          title: 'Existing chat A',
          isActive: false
        }
      ],
      tabGroups: [
        ...(workspace === sourceWorkspace ? (sourceFrame.tabGroups ?? []) : []),
        {
          id: 'chat-group',
          activeTabId: `agent-session:${sessionId}`,
          tabOrder: [`agent-session:${sessionId}`]
        }
      ]
    }
    const apply = (frame: RuntimeMobileSessionTabsResult, owner = environmentId) =>
      applySwitchSnapshot(frame, owner)
    disposeViewerSelection()
    mocks.target.current = target
    useAppStore.setState({ activeWorktreeId: sourceWorkspace, activeView: 'terminal' })
    apply(sourceFrame)
    // The same session string on a different host is not this command's destination.
    apply(
      {
        ...destinationFrame,
        worktree: 'folder:foreign-chat',
        tabs: destinationFrame.tabs.filter((tab) => tab.type === 'agent-session'),
        tabGroups: destinationFrame.tabGroups?.filter((group) => group.id === 'chat-group'),
        activeGroupId: 'chat-group',
        activeTabId: `agent-session:${sessionId}`,
        activeTabType: 'agent-session'
      },
      'other-owner'
    )
    apply(destinationFrame)
    const before = useAppStore.getState()
    expect(before.activeWorktreeId).toBe(sourceWorkspace)
    const sourceTabs = before.tabsByWorktree[sourceWorkspace]
    const sourceRows = before.unifiedTabsByWorktree[sourceWorkspace].filter(
      (tab) => tab.contentType === 'terminal'
    )
    const destination = before.unifiedTabsByWorktree[workspace].find(
      (tab) => tab.entityId === sessionId
    )!
    const chatGroup = before.groupsByWorktree[workspace].find(
      (group) => group.id === destination.groupId
    )!
    const refresh = Promise.withResolvers<void>()
    mocks.pairedRefresh.mockImplementation(() => refresh.promise)
    const result = { status: 'completed', sessionId } as const
    mocks.call.mockResolvedValue(result)
    const args = {
      ...subject,
      direction: 'chat' as const,
      workspaceId: sourceWorkspace,
      executionHostId: 'runtime:switch-owner'
    }
    try {
      const switching = runConversationSwitch(args)
      await vi.waitFor(() => expect(mocks.pairedRefresh).toHaveBeenCalledOnce())
      expect(mocks.pairedRefresh).toHaveBeenCalledWith(environmentId, workspace, {
        acceptCurrentSnapshot: true,
        afterCurrentInFlight: true
      })
      const token = mocks.call.mock.calls[0][2].execution.viewerSelection
      if (navigate) {
        expect(activateTabNumberShortcut(1)).toBe(true)
      }
      const beforeResult = useAppStore.getState()
      const selectedBeforeResult = beforeResult.activeTabIdByWorktree[sourceWorkspace]
      const selectedGroupBeforeResult = beforeResult.groupsByWorktree[sourceWorkspace].find(
        (group) => group.id === beforeResult.activeGroupIdByWorktree[sourceWorkspace]
      )
      refresh.resolve()
      expect(await switching).toBe(true)
      const after = useAppStore.getState()
      const selectedWorkspace = navigate ? sourceWorkspace : workspace
      const activeGroupId = after.activeGroupIdByWorktree[selectedWorkspace]
      const selectedGroup = after.groupsByWorktree[selectedWorkspace].find(
        (group) => group.id === activeGroupId
      )
      expect(after.activeWorktreeId).toBe(selectedWorkspace)
      expect(selectedGroup?.activeTabId).toBe(
        navigate ? selectedGroupBeforeResult?.activeTabId : destination.id
      )
      expect(after.activeTabType).toBe(navigate ? 'terminal' : 'agent-session')
      expect(after.activeTabTypeByWorktree[selectedWorkspace]).toBe(
        navigate ? 'terminal' : 'agent-session'
      )
      expect(after.activeTabIdByWorktree[selectedWorkspace]).toBe(
        navigate ? selectedBeforeResult : (before.activeTabIdByWorktree[workspace] ?? null)
      )
      expect(viewerSelectionOutcome(token)).toBe(navigate ? 'superseded' : 'fulfilled')
      expect(after.tabsByWorktree[sourceWorkspace]).toEqual(sourceTabs)
      expect(
        after.unifiedTabsByWorktree[sourceWorkspace]
          .filter((tab) => tab.contentType === 'terminal')
          .map((tab) => ({ id: tab.id, entityId: tab.entityId, groupId: tab.groupId }))
      ).toEqual(
        sourceRows.map((tab) => ({ id: tab.id, entityId: tab.entityId, groupId: tab.groupId }))
      )
      expect(
        after.groupsByWorktree[workspace].find((group) => group.id === destination.groupId)
          ?.tabOrder
      ).toEqual(chatGroup.tabOrder)
      expect(
        after.unifiedTabsByWorktree[workspace].filter((tab) => tab.entityId === sessionId)
      ).toHaveLength(1)
      const accepted = after.activeTabIdByWorktree
      await presentConversationSwitchResult(args, target, result, token)
      const replayed = useAppStore.getState()
      expect(replayed.activeTabIdByWorktree).toBe(accepted)
      expect(replayed.activeWorktreeId).toBe(after.activeWorktreeId)
      expect(replayed.activeGroupIdByWorktree[selectedWorkspace]).toBe(activeGroupId)
      expect(
        replayed.groupsByWorktree[selectedWorkspace].find((group) => group.id === activeGroupId)
          ?.activeTabId
      ).toBe(selectedGroup?.activeTabId)
      expect(mocks.rpc).toHaveBeenCalledTimes(navigate ? 0 : 1)
      if (!navigate) {
        expect(mocks.rpc).toHaveBeenCalledWith(target, 'session.tabs.activate', {
          worktree: `id:${workspace}`,
          tabId: `agent-session:${sessionId}`,
          notifyClients: false,
          navigation: 'caller'
        })
      }
    } finally {
      disposeViewerSelection()
    }
  }
)
