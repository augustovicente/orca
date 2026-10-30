import { getKnownExecutionHostIdForWorktree } from './worktree-runtime-owner'
import { resolveAgentTerminalCreateOptions } from '../../../main/runtime/runtime-agent-terminal-startup'
import { partialRuntimeStore } from '../../../main/runtime/runtime-store-partial-fixture'
import { buildAiVaultCopiedSessionStartupForWorktree } from './ai-vault-session-fork-startup'
import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { createTestStore, makeTab } from '@/store/slices/store-test-helpers'
import { buildAgentResumeStartupPlan } from './tui-agent-startup'
import { buildAiVaultResumeStartupForWorktree } from './ai-vault-resume-command'

const worktreeId = 'repo-1::/repo'

async function planResume(
  agent: 'opencode' | 'omp',
  selected: ReturnType<typeof buildAiVaultResumeStartupForWorktree>
) {
  expect(selected.resume?.recipe.source).toBe('current-inputs')
  return resolveAgentTerminalCreateOptions(
    { id: worktreeId, path: '/repo', connectionId: null, repo: null, folderWorkspace: null },
    {
      resume: selected.resume,
      cwd: selected.cwd,
      startupAgent: agent,
      launchRuntime: { platform: 'linux', pty: {} }
    },
    { store: partialRuntimeStore(), hostIdentity: 'local', toSessionOptions: () => undefined }
  )
}

describe('AI Vault OMP cold resume', () => {
  it('preserves local OpenCode standalone mode and existing custom host settings', async () => {
    const store = createTestStore()
    const state = store.getState()
    Object.assign(state, {
      settings: {
        agentDefaultArgs: { opencode: '--model synthetic-model' },
        agentDefaultEnv: {
          opencode: {
            OPENCODE_AUTH_CONTENT: 'synthetic-local-auth',
            HOME: '/host-home',
            OPENCODE_CONFIG_DIR: '/host-config'
          }
        }
      }
    })
    const selected = buildAiVaultCopiedSessionStartupForWorktree(
      {
        state,
        session: {
          agent: 'opencode',
          sessionId: 'copy-session',
          cwd: '/repo',
          codexHome: null,
          executionHostId: 'local'
        }
      },
      'opencode2'
    )
    expect(selected.agent).toBe('opencode')
    const startup = await planResume('opencode', selected)
    expect(startup.cwd).toBe('/repo')
    expect(startup.resumeProviderSession).toEqual({ key: 'session_id', id: 'copy-session' })
    expect(startup.launchConfig).toMatchObject({
      agentArgs: "'--standalone' --model synthetic-model",
      agentEnv: state.settings?.agentDefaultEnv?.opencode
    })
    expect(startup.command).toContain("'--standalone'")
    expect(startup.command).toContain("'--model' 'synthetic-model'")
    expect(startup.env).toMatchObject({
      OPENCODE_AUTH_CONTENT: 'synthetic-local-auth',
      HOME: '/host-home',
      OPENCODE_CONFIG_DIR: '/host-config'
    })
  })

  it('keeps the custom session store after the resumed process reports its id', async () => {
    const store = createTestStore()
    const rawPath = String.raw`\\wsl$\Ubuntu\custom\omp-sessions\project\session.jsonl`
    store.setState({
      activeRepoId: 'repo-1',
      folderWorkspaces: [],
      projectGroups: [],
      projects: [{ id: 'repo-1', sourceRepoIds: ['repo-1'] }],
      repos: [{ id: 'repo-1', path: '/repo', executionHostId: 'local' }],
      settings: {
        agentDefaultArgs: { omp: '--model custom' },
        agentDefaultEnv: { omp: { OMP_PROFILE: 'custom' } }
      } as unknown as NonNullable<AppState['settings']>,
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId })]
      },
      worktreesByRepo: {
        'repo-1': [{ id: worktreeId, repoId: 'repo-1', path: '/repo', hostId: 'local' }]
      }
    } as unknown as Partial<AppState>)

    expect(getKnownExecutionHostIdForWorktree(store.getState(), worktreeId)).toBe('local')
    const selected = buildAiVaultResumeStartupForWorktree({
      state: store.getState(),
      worktreeId,
      session: {
        agent: 'omp',
        executionHostId: 'local',
        sessionId: 'omp-session-1',
        filePath: rawPath,
        cwd: '/repo',
        codexHome: null
      }
    })
    expect(selected.resume?.ompResumeFilePath).toBe(rawPath)
    const startup = await planResume('omp', selected)

    expect(startup).toMatchObject({
      command: "omp '--model' 'custom' '--resume' '/custom/omp-sessions/project/session.jsonl'",
      cwd: '/repo',
      env: { OMP_PROFILE: 'custom' },
      launchConfig: {
        agentCommand: "omp '--model' 'custom'",
        agentArgs: '--model custom',
        agentEnv: { OMP_PROFILE: 'custom' },
        ompResumeFilePath: '/custom/omp-sessions/project/session.jsonl'
      },
      resumeProviderSession: { key: 'session_id', id: 'omp-session-1' }
    })

    store.getState().registerAgentLaunchConfig('tab-1:leaf-1', startup.launchConfig!, {
      agentType: 'omp',
      launchToken: 'launch-1',
      tabId: 'tab-1',
      leafId: 'leaf-1'
    })
    store
      .getState()
      .recordAgentProviderSession(
        'tab-1:leaf-1',
        'omp',
        startup.resumeProviderSession!,
        { updatedAt: 10 },
        { tabId: 'tab-1', worktreeId },
        { launchToken: 'launch-1' }
      )
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'resume', agentType: 'omp' },
        'OMP',
        { updatedAt: 20, stateStartedAt: 20 },
        { tabId: 'tab-1', worktreeId },
        { providerSession: startup.resumeProviderSession, launchToken: 'launch-1' }
      )
    store.getState().captureAllSleepingAgentSessions('quit')

    const record = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']!
    const coldStartup = buildAgentResumeStartupPlan({
      agent: record.agent,
      providerSession: record.providerSession,
      cmdOverrides: {},
      agentArgs: record.launchConfig?.agentArgs,
      agentEnv: record.launchConfig?.agentEnv,
      agentCommand: record.launchConfig?.agentCommand,
      ompResumeFilePath: record.launchConfig?.ompResumeFilePath,
      platform: 'linux'
    })

    expect(record).toMatchObject({
      providerSession: { key: 'session_id', id: 'omp-session-1' },
      launchConfig: startup.launchConfig,
      origin: 'quit'
    })
    expect(coldStartup).toMatchObject({
      launchCommand: startup.command,
      env: startup.env
    })
  })
})
