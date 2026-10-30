import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as cliTranscript from '../../../ai-vault/structured-chat-cli-fork'
import { structuredAgentRuntimeMetadata } from '../../structured-agent-runtime-metadata'
import { agentSessionProviderHandleChainHead } from '../../../../shared/agent-session-provider-handle'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createRestTestRig,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import {
  createTestParams,
  CREATE_TEST_CALLER as caller
} from '../../../native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import { HOST_TEST_SESSION as id } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  setupMainOwnedWorkspace,
  WORKTREE_ID,
  TAB_ID,
  LEAF_A,
  PTY_A,
  PTY_B,
  LEAF_B
} from '../../main-owned-workspace-runtime-fixture'
import { executeStructuredSessionSwitch } from './structured-agent-session-switch-execution'
import { DaemonRequestTimeoutError } from '../../../daemon/daemon-errors'
import type { RuntimeMobileSessionTerminalClientTab } from '../../../../shared/runtime-mobile-session-tab-contracts'

let rig: RestTestRig
beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  const params = createTestParams()
  expect(
    await rig.host.create(
      caller,
      createTestParams(undefined, {
        location: { ...params.location, workspaceId: WORKTREE_ID }
      })
    )
  ).toMatchObject({ ok: true })
  setStructuredAgentSessionHost(rig.host)
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  vi.restoreAllMocks()
})
async function savedTranscript() {
  await rig.host.switchToChat(id)
  await rig.host.switchToTerminal(id)
  const record = rig.store.getRecord(id)!
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)!
  const filePath = join(rig.root, 'switch-source.jsonl')
  const nativeId = head.handle.nativeId
  await writeFile(
    filePath,
    `${[
      { type: 'session_meta', payload: { id: nativeId } },
      {
        timestamp: '2026-10-26T12:00:00Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'cli-turn' }
      },
      {
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'A terminal prompt'
        }
      },
      {
        timestamp: '2026-10-26T12:00:01Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'cli-turn' }
      }
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')}\n`
  )
  vi.spyOn(cliTranscript, 'resolveStructuredChatCliSource').mockResolvedValue({
    host: rig.host,
    record,
    head,
    agent: 'codex',
    cwd: rig.root,
    providerSessionId: nativeId,
    requireCurrent: vi.fn(),
    metadata: structuredAgentRuntimeMetadata('codex')!
  })
  vi.spyOn(cliTranscript, 'prepareStructuredChatCliTranscript').mockResolvedValue({
    useRealCodexHome: false,
    cliForkSource: {
      agent: 'codex',
      sourceAgent: 'codex',
      sessionId: nativeId,
      filePath,
      cwd: rig.root,
      codexHome: null,
      executionHostPlatform: process.platform
    }
  })
}

it.each(['single', 'split'] as const)(
  'uses ordinary exact physical exit and source placement, retaining siblings: %s',
  async (shape) => {
    const split = shape !== 'single'
    await savedTranscript()
    const { runtime, session } = setupMainOwnedWorkspace({ split: shape === 'split' })
    const incarnationId = '11111111-1111-4111-8111-111111111111'
    runtime.registerPty(PTY_A, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_A, incarnationId })
    const source = runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_A}`, WORKTREE_ID)
    if (!source.presentation) {
      throw new Error('missing captured source')
    }
    const exit = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const stopped = vi.fn(async (ptyId: string) => {
      expect(ptyId).toBe(PTY_A)
      entered.resolve()
      await exit.promise
      await runtime.onPtyExit(PTY_A, 0, incarnationId, { hostExitConfirmed: true })
      return true
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: stopped,
      getForegroundProcess: async () => 'codex'
    })
    expect(
      await runtime.applyLayoutCommand({
        type: 'openAgentSessionTab',
        workspace: WORKTREE_ID,
        sessionId: 'later-tab',
        agent: 'codex',
        tabId: 'agent-session:later-tab'
      })
    ).toMatchObject({ ok: true })
    const acquisitions = rig.adapter.acquire.mock.calls.length
    const operation = executeStructuredSessionSwitch(
      {
        sessionId: id,
        execution: {
          invocationId: 'from-pane',
          source: {
            terminal: source.handle,
            expectedIncarnationId: incarnationId,
            originalPresentation: source.presentation
          }
        }
      },
      { runtime },
      'chat'
    )
    await Promise.race([
      entered.promise,
      operation.then((answer) => {
        throw new Error(JSON.stringify(answer))
      })
    ])
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquisitions)
    exit.resolve()
    expect(await operation).toEqual({ status: 'completed', sessionId: id })
    await vi.waitFor(() => expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquisitions + 1))
    expect(stopped).toHaveBeenCalledOnce()
    const destination = `agent-session:${id}`
    const group = session().tabGroups?.[WORKTREE_ID]?.find((row) =>
      row.tabOrder.includes(destination)
    )
    expect(group?.tabOrder).toEqual([
      ...(split ? [TAB_ID] : []),
      destination,
      'agent-session:later-tab'
    ])
    expect(group?.activeTabId).toBe(destination)
    const published = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    expect(published.activeTabId).toBe(destination)
    expect(published.tabs.find((tab) => tab.id === destination)).toMatchObject({
      openPlacement: {
        invocationId: 'from-pane',
        generation: expect.any(String),
        placement: { afterTabId: TAB_ID, index: 0 },
        source: source.presentation.identity
      }
    })
    const layout = session().terminalLayoutsByTabId[TAB_ID]
    if (split) {
      expect(layout?.ptyIdsByLeafId?.[LEAF_B]).toBe(PTY_B)
      expect(layout?.root).toEqual({ type: 'leaf', leafId: LEAF_B })
    } else {
      expect(session().tabsByWorktree[WORKTREE_ID]?.some((tab) => tab.id === TAB_ID)).toBe(false)
    }
    expect(rig.adapter.dispatch).not.toHaveBeenCalled()
  }
)

it('does not acquire or retire a terminal whose physical stop is unproven', async () => {
  await savedTranscript()
  const { runtime, session } = setupMainOwnedWorkspace()
  const incarnationId = '11111111-1111-4111-8111-111111111111'
  runtime.registerPty(PTY_A, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_A, incarnationId })
  const source = runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_A}`, WORKTREE_ID)
  if (!source.presentation) {
    throw new Error('missing captured source')
  }
  const acquisitions = rig.adapter.acquire.mock.calls.length
  const stop = vi.fn(async () => false)
  runtime.setPtyController({
    write: () => true,
    kill: () => false,
    stopAndWait: stop,
    getForegroundProcess: async () => null
  })
  const result = await executeStructuredSessionSwitch(
    {
      sessionId: id,
      execution: {
        invocationId: 'unproven',
        source: {
          terminal: source.handle,
          expectedIncarnationId: incarnationId,
          originalPresentation: source.presentation
        }
      }
    },
    { runtime },
    'chat'
  )
  expect(result.status).toBe('refused')
  expect(stop).toHaveBeenCalledOnce()
  expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquisitions)
  expect(session().tabsByWorktree[WORKTREE_ID]?.some((tab) => tab.id === TAB_ID)).toBe(true)
})

it('reports a dispatched terminal with a lost answer as uncertain, preserving its source', async () => {
  const { runtime } = setupMainOwnedWorkspace()
  await rig.store.setSessionTabVisibility(id, false)
  await rig.store.setSessionTabVisibility(id, true, 'source-chat')
  vi.spyOn(runtime, 'createSessionSwitchTerminal').mockRejectedValue(
    new DaemonRequestTimeoutError('raw daemon text must not become start-failed copy')
  )
  const result = await executeStructuredSessionSwitch(
    { sessionId: id, execution: { invocationId: 'lost', sourceTabId: 'source-chat' } },
    { runtime },
    'terminal'
  )
  expect(result).toMatchObject({
    status: 'uncertain',
    refusal: { code: 'agent_session_operation_unknown', details: { reason: 'outcomeUnknown' } }
  })
  expect(rig.store.getSessionTabId(id)).toBe('source-chat')
})

it.each([
  { navigate: false, viewerSelection: undefined },
  { navigate: true, viewerSelection: undefined },
  { navigate: false, viewerSelection: 'selection-v1:initiating-viewer' }
])(
  'captures selection before native Stop and consumes it at the ordinary terminal snapshot: $navigate/$viewerSelection',
  async ({ navigate, viewerSelection }) => {
    const { runtime, bindPty, handleOf } = setupMainOwnedWorkspace()
    Object.assign(runtime, {
      resolveTerminalWorkspaceLaunchScope: async () => ({
        id: WORKTREE_ID,
        path: rig.root,
        connectionId: null,
        repo: null,
        folderWorkspace: null
      })
    })
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: WORKTREE_ID,
      sessionId: id,
      agent: 'codex',
      activate: true,
      check: () => {}
    })
    const other = createTestParams()
    expect(
      await rig.host.create(caller, {
        ...other,
        envelope: { ...other.envelope, sessionId: 'newer-navigation' },
        location: { ...other.location, workspaceId: WORKTREE_ID }
      })
    ).toMatchObject({ ok: true })
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: WORKTREE_ID,
      sessionId: 'newer-navigation',
      agent: 'codex',
      activate: false
    })
    await rig.host.switchToChat(id)
    const stopping = Promise.withResolvers<void>()
    const stopped = Promise.withResolvers<void>()
    const close = rig.adapter.closeSession.getMockImplementation()!
    rig.adapter.closeSession.mockImplementation(async (...args) => {
      stopping.resolve()
      await stopped.promise
      return close(...args)
    })
    const spawn = vi
      .spyOn(runtime, 'createTerminal')
      .mockImplementation(async (_selector, opts = {}) => {
        if (!opts.tabId || !opts.leafId) {
          throw new Error('missing ordinary published pane')
        }
        opts.beforePtySpawn?.()
        opts.onPtySpawnDispatched?.({
          tabId: opts.tabId,
          leafId: opts.leafId,
          launchAgent: 'codex',
          ...(opts.launchConfig ? { launchConfig: opts.launchConfig } : {})
        })
        bindPty({
          worktreeId: WORKTREE_ID,
          tabId: opts.tabId,
          leafId: opts.leafId,
          ptyId: 'switch-destination'
        })
        runtime.registerPty('switch-destination', WORKTREE_ID, null, {
          tabId: opts.tabId,
          leafId: opts.leafId,
          terminalHandle: opts.preAllocatedHandle
        })
        return {
          handle: handleOf('switch-destination'),
          ptyId: 'switch-destination',
          tabId: opts.tabId,
          paneKey: `${opts.tabId}:${opts.leafId}`,
          worktreeId: WORKTREE_ID,
          title: null,
          surface: 'background'
        }
      })
    const operation = executeStructuredSessionSwitch(
      {
        sessionId: id,
        execution: {
          invocationId: 'ordinary-native-stop',
          sourceTabId: `agent-session:${id}`,
          ...(viewerSelection ? { viewerSelection } : {})
        }
      },
      { runtime },
      'terminal'
    )
    await Promise.race([
      stopping.promise,
      operation.then((answer) => {
        throw new Error(JSON.stringify(answer))
      })
    ])
    expect(spawn).not.toHaveBeenCalled()
    runtime.projectStructuredAgentSessionTab({
      workspaceId: 'another-workspace',
      sessionId: 'automatic-publication',
      agent: 'codex',
      activate: true
    })
    if (navigate) {
      const picked = await runtime.activateMobileSessionTab(
        `id:${WORKTREE_ID}`,
        'agent-session:newer-navigation',
        undefined,
        { navigation: 'all', intent: 'user', clientNavigationId: 'host-follow-viewer' }
      )
      expect(picked.activeTabId).toBe('agent-session:newer-navigation')
    }
    stopped.resolve()
    const answer = await operation
    expect(answer).toMatchObject({ status: 'completed' })
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]![1]!.presentation).toBe('background')
    expect(spawn.mock.calls[0]![1]!.agentLaunchViewer?.()).toBe('none')
    const snapshot = await runtime.listMobileSessionTabs(
      `id:${WORKTREE_ID}`,
      navigate ? 'host-follow-viewer' : undefined
    )
    if (viewerSelection) {
      expect(
        snapshot.tabs.find(
          (tab): tab is RuntimeMobileSessionTerminalClientTab =>
            tab.type === 'terminal' && tab.ptyId === 'switch-destination'
        )?.openPlacement
      ).toMatchObject({
        activate: true,
        viewerSelection
      })
    }
    expect(snapshot.activeTabId).toBe(
      navigate
        ? 'agent-session:newer-navigation'
        : viewerSelection
          ? `agent-session:${id}`
          : `${spawn.mock.calls[0]![1]!.tabId}::${spawn.mock.calls[0]![1]!.leafId}`
    )
  }
)
