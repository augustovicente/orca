import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import type * as TerminalOperation from '@/runtime/web-runtime-terminal-create-operation'
import type * as WebEnvironment from '@/runtime/web-runtime-session-environment'
import { stubRuntimeEnvironmentBridge } from '@/runtime/runtime-environment-bridge-fixture'
import { AGENT_LAUNCH_CHOICES_CAPABILITY } from '../../src/shared/agent-launch-runtime-capability'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { consumeOldHostPreparedCommand } from './prepared-action-launch.test-fixture'
import { clearHostAgentMenuSettingsForTests } from '@/components/settings/use-host-agent-launch-preferences'
import { projectAgentLaunchSettings } from '../../src/shared/agent-launch-settings'
import type { AgentLaunchChoices } from '../../src/shared/agent-launch-choices'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  actualOperation: false,
  createTab: vi.fn(),
  closeTab: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  setActiveTabType: vi.fn(),
  toastError: vi.fn(),
  capability: vi.fn(async () => false),
  hostRpc: vi.fn()
}))

const choices: AgentLaunchChoices = {}
const hostStatuses = new Map<string, { status: { hostPlatform: string; capabilities: string[] } }>([
  ['web-runtime', { status: { hostPlatform: 'linux', capabilities: [] } }]
])
const store = {
  activeRepoId: 'repo-1',
  activeWorktreeId: 'wt-1',
  settings: {
    agentLaunchChoices: choices,
    agentCmdOverrides: {} as Record<string, string>,
    agentDefaultArgs: {} as Record<string, string>,
    agentDefaultEnv: {} as Record<string, Record<string, string>>,
    activeRuntimeEnvironmentId: 'web-runtime' as string | null
  },
  projects: [{ id: 'repo-1', localWindowsRuntimePreference: { kind: 'inherit-global' as const } }],
  // The client stamps a server's rows on arrival; focus alone never names the owner.
  repos: [
    { id: 'repo-1', connectionId: null, path: '/repo', executionHostId: 'runtime:web-runtime' }
  ],
  worktreesByRepo: {
    'repo-1': [
      {
        id: 'wt-1',
        repoId: 'repo-1',
        projectId: 'repo-1',
        path: '/repo/worktree',
        displayName: 'main'
      }
    ]
  },
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] as { id: string; launchAgent?: string }[] },
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  terminalLayoutsByTabId: {},
  ptyIdsByTabId: {},
  sshConnectionStates: new Map(),
  sshStateByEnvironment: new Map(),
  runtimeStatusByEnvironmentId: hostStatuses,
  transientClearedAgentStatusConnectionIds: {},
  allWorktrees: vi.fn(() => store.worktreesByRepo['repo-1']),
  createTab: mocks.createTab,
  closeTab: mocks.closeTab,
  queueTabStartupCommand: vi.fn(),
  setActiveTabType: mocks.setActiveTabType,
  setActiveWorktree: vi.fn(),
  setTabBarOrder: vi.fn(),
  setAgentStatus: vi.fn(),
  seedNativeChatLaunchPrompt: vi.fn(),
  markNativeChatLaunchPromptFailed: vi.fn()
}

vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.capability,
  callRuntimeRpc: mocks.hostRpc
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: mocks.toastError } }))
vi.mock('@/components/tab-bar/reconcile-order', () => ({ reconcileTabOrder: vi.fn(() => []) }))
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn() }))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/runtime/web-runtime-terminal-create-operation', async (importOriginal) => {
  const actual = await importOriginal<typeof TerminalOperation>()
  return {
    createWebRuntimeSessionTerminalResult: (
      ...args: Parameters<typeof actual.createWebRuntimeSessionTerminalResult>
    ) =>
      mocks.actualOperation
        ? actual.createWebRuntimeSessionTerminalResult(...args)
        : mocks.createWebRuntimeSessionTerminal(...args)
  }
})
vi.mock('@/runtime/web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: vi.fn(async () => {})
}))
vi.mock('@/runtime/web-runtime-terminal-placement-settlement', () => ({
  settleWebRuntimeTerminalPlacement: vi.fn(async () => {})
}))
vi.mock('@/runtime/web-runtime-session-environment', async (importOriginal) => ({
  ...(await importOriginal<typeof WebEnvironment>()),
  isWebRuntimeSessionActive: vi.fn(() => true)
}))
afterEach(() => vi.unstubAllGlobals())

describe('launchAgentInNewTab paired web runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.actualOperation = false
    clearHostAgentMenuSettingsForTests()
    mocks.capability.mockResolvedValue(false)
    store.settings = {
      agentLaunchChoices: {},
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: 'web-runtime'
    }
    store.runtimeStatusByEnvironmentId = new Map([
      ['web-runtime', { status: { hostPlatform: 'linux', capabilities: [] } }]
    ])
    store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue({
      outcome: { status: 'created' },
      hostTabId: 'host-tab::leaf-1'
    })
  })

  it.each([true, false, 'failed'] as const)('delegates agent quick launch (%s)', async (mode) => {
    store.settings.agentDefaultArgs = { claude: '--model "model with spaces"' }
    const activate = mode === true
    const status = mode === 'failed' ? 'failed' : 'created'
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue({
      outcome: {
        status,
        ...(status === 'failed' ? { message: 'The host refused the launch.' } : {})
      },
      hostTabId: 'host-tab::leaf-1'
    })
    store.tabsByWorktree['wt-1'].push({ id: 'local-agent-tab', launchAgent: 'claude' })
    const { launchAgentInNewTab } =
      await import('../../src/renderer/src/lib/launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-1',
      activate,
      agent: 'claude',
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(result).toEqual(
      expect.objectContaining({
        surface: { kind: 'host-published' },
        pasteDraftAfterLaunch: false
      })
    )
    await result?.terminalCompletion
    const startupPlan = mocks.createWebRuntimeSessionTerminal.mock.calls[0][0]
    expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'web-runtime',
      targetGroupId: 'group-1',
      activate,
      ...(activate ? {} : { selectWorktree: false }),
      agentSessionKind: 'fresh',
      launchAgent: 'claude',
      preparedAgentCommand: false,
      command: startupPlan.command,
      env: startupPlan.env,
      launchConfig: startupPlan.launchConfig,
      viewMode: 'terminal'
    })
    expect(startupPlan.launchConfig.agentArgs).toBe(store.settings.agentDefaultArgs.claude)
    expect(mocks.createTab).not.toHaveBeenCalled()
    await expect(result?.terminalCompletion).resolves.toMatchObject({
      outcome: { status },
      ...(status === 'created' ? { tabId: 'web-terminal-host-tab' } : {})
    })
    expect(mocks.setActiveTabType).toHaveBeenCalledTimes(activate && status === 'created' ? 1 : 0)
    expect(mocks.toastError).toHaveBeenCalledTimes(status === 'failed' ? 1 : 0)
    if (status === 'failed') {
      expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith('The host refused the launch.')
    }
    // A local tab closes locally (the host close no-ops), so a launch leaves it alone.
    expect(mocks.closeTab).not.toHaveBeenCalled()
  })

  it('awaits the capable host map once and preserves explicit/raw and prepared command ownership', async () => {
    mocks.capability.mockResolvedValue(true)
    store.settings.agentLaunchChoices = { claude: { model: 'sonnet', options: { effort: 'low' } } }
    store.settings.agentDefaultArgs = { claude: '--verbose' }
    store.settings.agentDefaultEnv = { claude: { KEEP: 'caller' } }
    const pending = Promise.withResolvers<{
      settings: ReturnType<typeof projectAgentLaunchSettings>
    }>()
    mocks.hostRpc.mockReturnValueOnce(pending.promise)
    const { launchAgentInNewTab } =
      await import('../../src/renderer/src/lib/launch-agent-in-new-tab')
    const result = launchAgentInNewTab({
      requestId: newAgentLaunchRequestId(),
      agent: 'claude',
      worktreeId: 'wt-1',
      requestedSurface: 'terminal'
    })
    expect(mocks.createWebRuntimeSessionTerminal).not.toHaveBeenCalled()
    pending.resolve({
      settings: projectAgentLaunchSettings({
        agentLaunchChoices: { claude: { model: 'opus', options: { effort: 'high' } } }
      })
    })
    await result?.terminalCompletion
    expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledTimes(1)
    expect(mocks.createWebRuntimeSessionTerminal.mock.calls[0][0]).toMatchObject({
      command: expect.stringContaining("'opus'"),
      env: { KEEP: 'caller' },
      launchConfig: { agentArgs: '--verbose' },
      preparedAgentCommand: false
    })
    expect(mocks.createWebRuntimeSessionTerminal.mock.calls[0][0]).not.toHaveProperty(
      'launchPreferences'
    )
    mocks.createWebRuntimeSessionTerminal.mockClear()
    const picked = launchAgentInNewTab({
      requestId: newAgentLaunchRequestId(),
      agent: 'claude',
      worktreeId: 'wt-1',
      requestedSurface: 'terminal',
      agentArgs: '--model literal',
      sessionOptions: { model: 'picked' }
    })
    await picked?.terminalCompletion
    expect(mocks.createWebRuntimeSessionTerminal.mock.calls[0][0]).toMatchObject({
      command: expect.stringContaining("'picked'"),
      agentArgs: '--model literal',
      launchPreferences: { model: 'picked' },
      launchConfig: { agentArgs: '' }
    })
    clearHostAgentMenuSettingsForTests()
    mocks.hostRpc.mockResolvedValue({
      settings: projectAgentLaunchSettings({
        agentLaunchChoices: { claude: { options: { effort: 'high' } } }
      })
    })
    store.settings.agentCmdOverrides = { claude: 'cx' }
    const prepared = launchAgentInNewTab({
      requestId: newAgentLaunchRequestId(),
      agent: 'claude',
      worktreeId: 'wt-1',
      requestedSurface: 'terminal'
    })
    await prepared?.terminalCompletion
    expect(mocks.createWebRuntimeSessionTerminal.mock.calls.at(-1)?.[0]).toMatchObject({
      command: "cx '--verbose' '--effort' 'high'",
      env: { KEEP: 'caller' },
      preparedAgentCommand: true,
      launchConfig: { agentCommand: "cx '--verbose'", agentArgs: '--verbose' }
    })
    expect(mocks.createTab).not.toHaveBeenCalled()
    const dispatched = mocks.createWebRuntimeSessionTerminal.mock.calls.length
    store.settings.agentCmdOverrides = { claude: 'claude --model sonnet' }
    const refused = launchAgentInNewTab({
      requestId: newAgentLaunchRequestId(),
      agent: 'claude',
      worktreeId: 'wt-1',
      requestedSurface: 'terminal',
      prompt: 'keep this prompt',
      sessionOptions: { model: 'opus' }
    })
    await expect(refused?.terminalCompletion).resolves.toEqual({
      delivered: false,
      failureNotified: false,
      outcome: { status: 'failed', message: '' }
    })
    expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledTimes(dispatched)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it.each(['deadline', 'prepared', 'authoritative', 'old'] as const)(
    'delivers the actual %s operation once with the correct model owner and final result',
    async (route) => {
      vi.useFakeTimers()
      try {
        mocks.actualOperation = true
        mocks.capability.mockResolvedValue(route !== 'old')
        store.runtimeStatusByEnvironmentId.get('web-runtime')!.status.capabilities =
          route === 'old' ? [] : [AGENT_LAUNCH_CHOICES_CAPABILITY]
        store.settings.agentLaunchChoices = { claude: { options: { effort: 'low' } } }
        store.settings.agentDefaultArgs = { claude: '--verbose' }
        store.settings.agentDefaultEnv = { claude: { KEEP: 'caller' } }
        store.settings.agentCmdOverrides = { claude: 'cx' }
        const hostSettings = {
          agentPermissionDefault: 'own' as const,
          agentLaunchChoices: {
            claude: {
              ...(route === 'prepared' ? {} : { model: 'opus' }),
              options: { effort: 'high' }
            }
          },
          agentDefaultEnv: { claude: { KEEP: 'host' } }
        }
        const pending = Promise.withResolvers<{
          settings: ReturnType<typeof projectAgentLaunchSettings>
        }>()
        mocks.hostRpc.mockImplementation(() =>
          route === 'deadline'
            ? pending.promise
            : Promise.resolve({ settings: projectAgentLaunchSettings(hostSettings) })
        )
        const host = new OrcaRuntimeService(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the final startup owner reads only this settings store.
          { getSettings: () => hostSettings } as never
        )
        Object.assign(host, {
          resolveTerminalWorkspaceLaunchScope: vi.fn(async () => ({
            id: 'wt-1',
            path: '/host',
            connectionId: null,
            repo: null,
            folderWorkspace: null
          }))
        })
        const compiled = vi.spyOn(host, 'planAgentPaneLaunch')
        const prepared = vi.fn(consumeOldHostPreparedCommand)
        const spawn = vi
          .spyOn(host, 'createTerminal')
          .mockImplementation(async (_worktree, options) => {
            await host.planAgentPaneLaunch('wt-1', options ?? {})
            return {
              handle: 'created',
              worktreeId: 'wt-1',
              title: null,
              tabId: 'host-tab',
              paneKey: 'host-tab:leaf'
            }
          })
        const dispatch = vi.fn(async (request) => {
          if (request.method === 'terminal.createAgentSession') {
            return { ok: true, result: await host.createAgentSession(request.params) }
          }
          if (request.method === 'session.tabs.createTerminal') {
            await prepared(request.params)
            return { ok: true, result: { tab: { id: 'host-tab', leafId: 'leaf' } } }
          }
          if (request.method === 'session.tabs.move') {
            return { ok: true, result: {} }
          }
          throw new Error(`Unexpected operation ${request.method}`)
        })
        stubRuntimeEnvironmentBridge({ call: dispatch })
        const { launchAgentInNewTab } =
          await import('../../src/renderer/src/lib/launch-agent-in-new-tab')
        const result = launchAgentInNewTab({
          requestId: newAgentLaunchRequestId(),
          agent: 'claude',
          worktreeId: 'wt-1',
          requestedSurface: 'terminal',
          groupId: 'group-1',
          activate: false,
          agentArgs: '--verbose',
          ...(route === 'prepared' ? { sessionOptions: { effort: 'high' } } : {})
        })
        await vi.advanceTimersByTimeAsync(route === 'deadline' ? 3_000 : 0)
        await expect(result?.terminalCompletion).resolves.toMatchObject({
          outcome: { status: 'created' },
          tabId: 'web-terminal-host-tab'
        })
        const creates = () =>
          dispatch.mock.calls.filter(([request]) =>
            ['terminal.createAgentSession', 'session.tabs.createTerminal'].includes(request.method)
          )
        expect(creates()).toHaveLength(1)
        if (route === 'deadline' || route === 'authoritative') {
          expect(creates()[0][0]).toMatchObject({
            method: 'terminal.createAgentSession',
            params: { agent: 'claude', agentArgs: '--verbose', presentation: 'background' }
          })
          expect(creates()[0][0].params).not.toHaveProperty('launchPreferences')
          expect(spawn).toHaveBeenCalledTimes(1)
          const plan = await compiled.mock.results[0].value
          expect(plan).toMatchObject({
            command: expect.stringContaining("'opus'"),
            env: { KEEP: 'host' },
            launchConfig: { agentArgs: '--verbose' }
          })
          expect(plan?.command).toContain("'high'")
          expect(plan?.command).not.toContain("'low'")
          expect(prepared).not.toHaveBeenCalled()
        } else {
          expect(creates()[0][0]).toMatchObject({
            method: 'session.tabs.createTerminal',
            params: {
              command: `cx '--verbose' '--effort' '${route === 'old' ? 'low' : 'high'}'`,
              env: { KEEP: 'caller' },
              launchConfig: { agentCommand: "cx '--verbose'", agentArgs: '--verbose' },
              targetGroupId: 'group-1',
              activate: false,
              select: false,
              navigation: 'caller'
            }
          })
          expect(prepared).toHaveBeenCalledTimes(1)
          expect(await prepared.mock.results[0].value).toMatchObject({
            command: creates()[0][0].params.command,
            env: { KEEP: 'caller' },
            launchConfig: { agentArgs: '--verbose' }
          })
          expect(spawn).not.toHaveBeenCalled()
        }
        if (route === 'deadline') {
          pending.resolve({ settings: projectAgentLaunchSettings(hostSettings) })
          await vi.advanceTimersByTimeAsync(0)
          expect(creates()).toHaveLength(1)
        }
        expect(mocks.createTab).not.toHaveBeenCalled()
        expect(mocks.toastError).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
        vi.restoreAllMocks()
      }
    }
  )

  it('forwards prompt launch env and captured config to the host runtime', async () => {
    store.settings.agentDefaultArgs = { codex: '--model gpt-5 --reasoning-effort high' }
    store.settings.agentDefaultEnv = { codex: { CODEX_PROFILE: 'captured' } }
    const { launchAgentInNewTab } =
      await import('../../src/renderer/src/lib/launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-2',
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'fix the spinner',
      groupId: 'group-1'
    })

    expect(result).toEqual(
      expect.objectContaining({
        surface: { kind: 'host-published' },
        pasteDraftAfterLaunch: false
      })
    )
    await result?.terminalCompletion
    expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'web-runtime',
      targetGroupId: 'group-1',
      activate: true,
      agentSessionKind: 'fresh',
      launchAgent: 'codex',
      preparedAgentCommand: false,
      command:
        "codex '-c' 'disable_paste_burst=true' '--model' 'gpt-5' '--reasoning-effort' 'high' 'fix the spinner'",
      env: { CODEX_PROFILE: 'captured' },
      launchConfig: {
        agentCommand: "codex '--model' 'gpt-5' '--reasoning-effort' 'high'",
        agentArgs: '--model gpt-5 --reasoning-effort high',
        agentEnv: { CODEX_PROFILE: 'captured' }
      },
      startupCommandDelivery: 'shell-ready',
      prompt: 'fix the spinner',
      promptDelivery: 'auto-submit',
      viewMode: 'terminal'
    })
    expect(mocks.createTab).not.toHaveBeenCalled()
  })
})
