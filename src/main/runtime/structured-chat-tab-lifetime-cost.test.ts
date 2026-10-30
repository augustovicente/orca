import { expect, it, vi } from 'vitest'
import {
  authorityProfile,
  openAuthorityRuntime
} from './structured-agent-session-tab-authority.test-support'
import { chatTabCommandsSettled } from './session-layout-apply.test-fixture'
import { createChatTabLayoutQueue } from './agent-session-tab-layout-queue'
import { applyWindowLayoutCommand } from './runtime-layout-apply'
import { fixture } from '../persistence/loading-store/profile-state-delayed-authority-fixture'
import { loadChatTabLayout, withChatTabChanges } from './agent-session/agent-session-tab-layout'
import { getDefaultWorkspaceSession } from '../../shared/constants'

const layoutOwner = vi.hoisted(() => ({ main: false }))
vi.mock('../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.main
  }
}))

vi.mock('../claude/claude-cli-flag-prewarm', () => ({
  prewarmClaudeCliFlags: async () => undefined
}))

it.each([10, 100])(
  'counts real raw stores, unrelated window publications and captured cleanup at %i chats',
  async (n) => {
    const ids = Array.from({ length: n }, (_, i) => `selected-${i.toString().padStart(5, '0')}`)
    const rig = await openAuthorityRuntime(await authorityProfile(ids, { visible: ids }))
    await rig.runtime.restoreStructuredAgentSessionTabs()
    await chatTabCommandsSettled()
    const original = rig.runtime.mobileSessionTabsByWorktree.get(rig.workspace)!
    const lookup = vi.spyOn(rig.store, 'getSessionTabId')
    const record = vi.spyOn(rig.store, 'getConversation')
    const journal = vi.spyOn(rig.store, 'transitionHandoff')
    let orderVisits = 0
    const countedOrder = original.tabs.map((tab) => tab.id)
    for (const [index, id] of countedOrder.entries()) {
      Object.defineProperty(countedOrder, index, {
        get: () => {
          orderVisits++
          return id
        }
      })
    }
    const raw = {
      ...original,
      tabGroups: [{ id: 'counted', activeTabId: null, tabOrder: countedOrder }]
    }
    rig.runtime.storeMobileSessionSnapshot(rig.workspace, raw)
    expect(lookup).toHaveBeenCalledTimes(n)
    expect(orderVisits).toBe(n)
    expect(record).not.toHaveBeenCalled()
    lookup.mockClear()
    orderVisits = 0
    rig.runtime.attachWindow(1)
    rig.runtime.markGraphReady(1)
    rig.runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [{ ...raw, publicationEpoch: 'cost-window', snapshotVersion: 1 }]
    })
    expect(lookup.mock.calls.length).toBeLessThanOrEqual(3 * n)
    expect(orderVisits).toBeLessThanOrEqual(6 * n)
    lookup.mockClear()
    record.mockClear()
    // An unrelated terminal-only snapshot still traverses the real identity normalization seam.
    rig.runtime.storeMobileSessionSnapshot('unrelated', {
      ...raw,
      worktree: 'unrelated',
      tabs: [
        {
          type: 'terminal',
          id: 'term-row',
          parentTabId: 'term-tab',
          title: 'terminal',
          isActive: false
        }
      ]
    })
    expect(lookup).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
    const saved = rig.profile.getWorkspaceSession().unifiedTabs?.[rig.workspace] ?? []
    let savedVisits = 0
    for (const tab of saved) {
      const entityId = tab.entityId
      Object.defineProperty(tab, 'entityId', {
        get: () => {
          savedVisits++
          return entityId
        },
        configurable: true
      })
    }
    const { closeStructuredAgentSessionChild } =
      await import('./agent-session/structured-agent-session-close')
    await closeStructuredAgentSessionChild(ids[0]!, { runtime: rig.runtime })
    await chatTabCommandsSettled()
    expect(savedVisits).toBeLessThanOrEqual(8 * n)
    expect(journal).not.toHaveBeenCalled()
    expect(rig.acquire).not.toHaveBeenCalled()
  }
)

it.each([10, 100])(
  'bounds actual queued profile replacement to two steps at %i saved rows in both directions',
  async (n) => {
    const { store, authority } = await fixture()
    const workspace = 'replacement-cost'
    const initial = withChatTabChanges(
      'local',
      getDefaultWorkspaceSession(),
      workspace,
      Array.from({ length: n }, (_, index) => ({
        open: { sessionId: `session-${index}`, agent: 'codex', tabId: `legacy-${index}` }
      }))
    )
    if (!initial) {
      throw new Error('fixture must have saved rows')
    }
    store.setWorkspaceSession(initial)
    await store.flushPendingOrThrowAsync()
    let loads = 0,
      applies = 0
    let applied: Promise<unknown> = Promise.resolve()
    const queue = createChatTabLayoutQueue({
      sessionOf: () => {
        loads++
        return store.getWorkspaceSession()
      },
      hostIdOf: () => 'local',
      apply: (command, run) => {
        applies++
        const result = applyWindowLayoutCommand(store, () => ['local'], command, undefined, run)
        applied = result
        return result
      }
    })
    for (const tabId of ['agent-chat-tab-v1-first', 'agent-chat-tab-v1-next', 'legacy-0']) {
      loads = 0
      applies = 0
      authority.captures.length = 0
      queue(() => [
        {
          worktreeId: workspace,
          change: { open: { sessionId: 'session-0', agent: 'codex', tabId } },
          eligible: () => true
        }
      ])
      await vi.waitFor(() =>
        expect(
          store
            .getWorkspaceSession()
            .unifiedTabs?.[workspace]?.find((tab) => tab.entityId === 'session-0')?.id
        ).toBe(tabId)
      )
      await applied
      expect(applies).toBe(2)
      expect(loads).toBe(4)
      expect(authority.captures).toHaveLength(2)
    }
    applies = 0
    loads = 0
    authority.captures.length = 0
    queue(() => [{ worktreeId: workspace, change: { close: 'session-0', tabId: 'legacy-0' } }])
    await vi.waitFor(() =>
      expect(
        store
          .getWorkspaceSession()
          .unifiedTabs?.[workspace]?.some((tab) => tab.entityId === 'session-0')
      ).toBe(false)
    )
    await applied
    expect(applies).toBe(1)
    expect(loads).toBe(2)
    expect(authority.captures).toHaveLength(1)
  }
)

it.each([10, 100])(
  'publishes actual renderer mappings through the window graph in order at %i chats with linear trigger work',
  async (n) => {
    const { buildMobileSessionTabSnapshots } =
      await import('../../renderer/src/runtime/sync-runtime-graph/mobile-session-snapshots')
    const { makeState } = await import('../../renderer/src/runtime/sync-runtime-graph-test-harness')
    const mappings =
      await import('../../renderer/src/runtime/web-session-tabs-sync/tracking-mappings')
    const { hostSessionTabIdByLocalKey } =
      await import('../../renderer/src/runtime/web-session-tabs-sync/state')
    const ids = Array.from({ length: n }, (_, i) => `mapped-${i.toString().padStart(5, '0')}`)
    const rig = await openAuthorityRuntime(await authorityProfile(ids, { visible: ids }))
    await rig.runtime.restoreStructuredAgentSessionTabs()
    await rig.host.setSessionTabVisibility(ids[0]!, false)
    const issued = 'agent-chat-tab-v1-mapped-current'
    await rig.host.setSessionTabVisibility(ids[0]!, true, issued)
    await rig.runtime.publishStructuredAgentSessionTab({
      workspaceId: rig.workspace,
      sessionId: ids[0]!,
      agent: 'codex',
      tabId: issued,
      activate: false
    })
    const tabs = ids.map((id, index) => ({
      id: `renderer-${id}`,
      entityId: id,
      contentType: 'agent-session' as const,
      groupId: 'mapped-group',
      worktreeId: rig.workspace,
      label: id,
      customLabel: null,
      color: null,
      sortOrder: index,
      createdAt: 1
    }))
    let entityVisits = 0,
      orderVisits = 0
    for (const tab of tabs) {
      const id = tab.entityId
      Object.defineProperty(tab, 'entityId', {
        get: () => {
          entityVisits++
          return id
        }
      })
    }
    const order = tabs.map((tab) => tab.id)
    for (const [index, id] of order.entries()) {
      Object.defineProperty(order, index, {
        get: () => {
          orderVisits++
          return id
        }
      })
    }
    const state = makeState({
      folderWorkspaces: rig.profile.getFolderWorkspaces(),
      projectGroups: rig.profile.getProjectGroups(),
      unifiedTabsByWorktree: { [rig.workspace]: tabs },
      groupsByWorktree: {
        [rig.workspace]: [
          {
            id: 'mapped-group',
            worktreeId: rig.workspace,
            activeTabId: tabs[1]!.id,
            tabOrder: order,
            recentTabIds: [tabs[1]!.id]
          }
        ]
      }
    })
    try {
      const legacy = buildMobileSessionTabSnapshots(state, true)[0]!
      entityVisits = 0
      orderVisits = 0
      for (const [index, tab] of tabs.entries()) {
        mappings.setHostSessionTabIdMapping(
          { environmentId: 'local', worktreeId: rig.workspace, tabId: tab.id },
          index === 0 ? issued : `structured-agent-session-${tab.entityId}`
        )
      }
      const mappingReads = vi.spyOn(hostSessionTabIdByLocalKey, 'get')
      const frame = buildMobileSessionTabSnapshots(state, true)[0]!
      expect(frame).not.toBe(legacy)
      expect(frame.tabGroups?.[0]?.tabOrder[0]).toBe(issued)
      expect(mappingReads).toHaveBeenCalledTimes(n)
      expect(entityVisits).toBeGreaterThanOrEqual(n)
      expect(entityVisits).toBeLessThanOrEqual(5 * n)
      expect(orderVisits).toBeLessThanOrEqual(5 * n)
      mappingReads.mockClear()
      entityVisits = 0
      orderVisits = 0
      expect(buildMobileSessionTabSnapshots(state, true)[0]).toBe(frame)
      expect(mappingReads).toHaveBeenCalledTimes(n)
      expect(entityVisits).toBe(0)
      expect(orderVisits).toBe(0)
      rig.runtime.attachWindow(1)
      rig.runtime.markGraphReady(1)
      rig.runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [frame] })
      const current = await rig.runtime.listMobileSessionTabs(rig.workspace)
      expect(current.tabs[0]?.id).toBe(issued)
      const { projectSessionTabs } =
        await import('../../shared/workspace-layout/old-client/old-client-session-tabs-projection')
      const { loaded } = loadChatTabLayout(
        'local',
        rig.profile.getWorkspaceSession(),
        rig.workspace
      )
      const savedWorkspace = loaded.layout.workspaces[rig.workspace]
      if (!savedWorkspace) {
        throw new Error('published chat must have saved layout')
      }
      const projected = projectSessionTabs(
        rig.workspace,
        savedWorkspace,
        { groups: {}, panes: {}, editorDrafts: {} },
        { tabLabels: {}, terminalRows: {}, browserTabs: {} },
        false
      )
      expect(projected.tabs.map((tab) => tab.id)).toContain(issued)
      expect(projected.tabGroups?.flatMap((group) => group.tabOrder)).toContain(issued)
      expect(projected.tabGroups?.flatMap((group) => group.tabOrder)).not.toContain(
        `agent-session:${ids[0]}`
      )
      const passive = {
        ...frame,
        snapshotVersion: frame.snapshotVersion + 1,
        activeTabId: `agent-session:${ids[0]}`,
        tabGroups: [
          {
            id: 'mapped-group',
            activeTabId: `agent-session:${ids[0]}`,
            recentTabIds: [`agent-session:${ids[0]}`, 'agent-chat-tab-v1-retired'],
            tabOrder: [
              `agent-session:${ids[0]}`,
              ...current.tabs.slice(1).map((tab) => tab.id),
              'agent-chat-tab-v1-retired'
            ]
          }
        ]
      }
      rig.runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [passive] })
      const late = await rig.runtime.listMobileSessionTabs(rig.workspace)
      expect(late.tabs[0]?.id).toBe(issued)
      expect(late.tabGroups?.flatMap((group) => group.tabOrder)).not.toContain(
        `agent-session:${ids[0]}`
      )
      expect(late.tabGroups?.flatMap((group) => group.recentTabIds ?? [])).not.toContain(
        'agent-chat-tab-v1-retired'
      )
      expect(rig.acquire).not.toHaveBeenCalled()
    } finally {
      mappings.clearHostSessionTabIdMappings('local', rig.workspace)
    }
  }
)

it('keeps failed advisory legacy insertion and retention while the actual inner profile write waits', async () => {
  layoutOwner.main = true
  const { store: profile, authority } = await fixture()
  const { root, B, holdStartup, rejectVisibility, savedIds } =
    await import('./structured-agent-session-tab-authority.test-support')
  const { installFakeAppEnvironment } =
    await import('../../../config/scripts/vitest-host-ports-setup')
  const { initOrcaProfilePaths } = await import('../orca-profiles/profile-storage-paths')
  installFakeAppEnvironment({ getPath: () => root })
  initOrcaProfilePaths()
  const { seedTestAgentSessionRecordStore } =
    await import('./agent-session-record-store-test-harness')
  const { agentSessionRecordFixture, agentSessionLeaseFixture } =
    await import('../../shared/agent-session-record.test-fixture')
  const { folderWorkspaceKey } = await import('../../shared/workspace-scope')
  const { structuredAgentSessionTabId } =
    await import('../../shared/structured-agent-session-projection')
  const group = profile.createProjectGroup({
    name: 'Held profile',
    parentPath: root,
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'manual'
  })
  const folder = profile.createFolderWorkspace({
    projectGroupId: group.id,
    folderPath: root,
    name: 'Legacy history'
  })
  const workspace = folderWorkspaceKey(folder.id)
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      sessionId: B,
      ownerProcess: null,
      reservedSpawnToken: null,
      claimStatus: 'released'
    })
  )
  await seedTestAgentSessionRecordStore(root, {
    records: [{ ...record, location: { ...record.location, workspaceId: workspace } }],
    sessionTabs: [{ tabId: structuredAgentSessionTabId(B), sessionId: B }]
  })
  const initial = withChatTabChanges('local', getDefaultWorkspaceSession(), workspace, [
    { open: { sessionId: B, agent: 'claude', tabId: structuredAgentSessionTabId(B) } }
  ])
  if (!initial) {
    throw new Error('legacy history must have a saved row')
  }
  profile.setWorkspaceSession(initial)
  await profile.flushPendingOrThrowAsync()
  const rig = await openAuthorityRuntime({
    profile,
    workspace,
    groupId: group.id,
    folderId: folder.id
  })
  expect(rig.store.getConversation(B)?.location.workspaceId).toBe(workspace)
  const releaseStartup = await holdStartup(rig)
  const { closeStructuredAgentSessionChild } =
    await import('./agent-session/structured-agent-session-close')
  await closeStructuredAgentSessionChild(B, { runtime: rig.runtime })
  await chatTabCommandsSettled()
  expect(savedIds(rig)).toEqual([])
  const gate = authority.pause()
  const holding = profile.runDurableMutation(() => {
    profile.updateSettings({ theme: 'dark' })
    return { value: undefined }
  })
  await gate.started.promise
  const applied = vi.spyOn(profile, 'applyLayoutCommand')
  const allow = rejectVisibility(rig)
  try {
    await rig.runtime.publishStructuredAgentSessionTab({
      workspaceId: workspace,
      sessionId: B,
      agent: 'claude',
      activate: true
    })
    await vi.waitFor(() => expect(applied).toHaveBeenCalled())
    expect(rig.runtime.live(B)).toBe(true)
    expect(savedIds(rig)).toEqual([])
    gate.finish.resolve()
    await holding
    const replies = await Promise.all(applied.mock.results.map((result) => result.value))
    expect(replies).toMatchObject([{ ok: true }])
    expect(rig.runtime.live(B)).toBe(true)
    await releaseStartup()
    await chatTabCommandsSettled()
    expect(savedIds(rig)).toEqual([B])
    await rig.runtime.publishStructuredAgentSessionTab({
      workspaceId: workspace,
      sessionId: B,
      agent: 'claude',
      activate: true
    })
    await Promise.all(applied.mock.results.map((result) => result.value))
    await chatTabCommandsSettled()
    expect(savedIds(rig)).toEqual([B])
    expect(rig.runtime.live(B)).toBe(true)
    expect(rig.store.isSessionTabVisible(B)).toBe(false)
    expect(rig.acquire).not.toHaveBeenCalled()
  } finally {
    gate.finish.resolve()
    await holding
    await releaseStartup()
    allow()
    layoutOwner.main = false
  }
})
