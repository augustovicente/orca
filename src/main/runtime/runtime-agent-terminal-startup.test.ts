import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { partialRuntimeStore } from './runtime-store-partial-fixture'
import { isAgentResumeNotDispatchedResponse } from '../../shared/agent-terminal-resume-outcome'
import { mapRuntimeError } from './rpc/errors'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectAgentCommandsOnHost } from '../preflight/agent-detection'
import { resolveAgentTerminalCreateOptions } from './runtime-agent-terminal-startup'
import { _resetWslCachesForTests, _setWslCachesForTests } from '../wsl'

vi.mock('../preflight/agent-detection', () => ({
  detectAgentCommandsOnHost: vi.fn(async () => new Set(['qoder']))
}))

const workspace = { id: 'w', path: '/repo', connectionId: null, repo: null, folderWorkspace: null }
let resumeShellSetting = 'cmd.exe'
const host = {
  store: partialRuntimeStore({
    getSettings: () => ({
      terminalWindowsShell: resumeShellSetting,
      agentDefaultArgs: { codex: '--model host-model' },
      agentDefaultEnv: { codex: { SETTINGS: 'host' } }
    })
  }),
  hostIdentity: 'host-1',
  toSessionOptions: () => undefined
}
const original = process.platform
const setPlatform = (value: string) =>
  Object.defineProperty(process, 'platform', { configurable: true, value })
beforeEach(() => setPlatform('win32'))
afterEach(() => {
  setPlatform(original)
  _resetWslCachesForTests()
})

// The host planner's inputs. Relied on by C2, whose pane spawns run this plan.
describe('host agent planner', () => {
  it("quotes for the fact's shell and hands that same fact to the spawn", async () => {
    const launch = await resolveAgentTerminalCreateOptions(
      workspace,
      { startupAgent: 'claude', agentArgs: '--model opus' },
      host
    )
    expect(launch.command).toBe('claude "--model" "opus"')
    expect(launch.launchRuntime).toEqual({
      platform: 'win32',
      pty: { shellOverride: 'cmd.exe', terminalWindowsWslDistro: null }
    })
  })

  // As on main: a disabled agent is refused as disabled, before its runtime is looked at.
  it('refuses a disabled agent before a runtime that needs repair', async () => {
    _setWslCachesForTests({ available: true, distros: ['Debian'] })
    const repo = { id: 'r', path: 'C:\\r' }
    const preference = { kind: 'wsl', distro: 'Ubuntu' }
    const store = {
      getSettings: () => ({ disabledTuiAgents: ['claude'] }),
      getProjects: () => [
        { id: 'p', sourceRepoIds: ['r'], localWindowsRuntimePreference: preference }
      ],
      getRepo: () => repo
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the planner reads only these members and fields.
    const scope = { ...workspace, id: 'r', path: repo.path, repo } as never
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    const planHost = { ...host, store: store as never }
    const plan = resolveAgentTerminalCreateOptions(scope, { startupAgent: 'claude' }, planHost)
    await expect(plan).rejects.toThrow('Agent claude is disabled')
  })

  it("rewrites Qoder once, probing where the fact's PTY runs (C2 skips the window copy)", async () => {
    vi.mocked(detectAgentCommandsOnHost).mockClear()
    const launch = await resolveAgentTerminalCreateOptions(
      workspace,
      {
        startupAgent: 'qoder',
        agentArgs: null,
        launchRuntime: {
          platform: 'linux',
          pty: { shellOverride: 'wsl.exe', terminalWindowsWslDistro: 'Ubuntu' }
        }
      },
      host
    )
    expect(launch.command).toBe('qoder')
    expect(detectAgentCommandsOnHost).toHaveBeenCalledTimes(1)
    expect(vi.mocked(detectAgentCommandsOnHost).mock.calls[0]?.[1]).toMatchObject({
      context: { wslDistro: 'Ubuntu' }
    })
  })

  // A `\\wsl$` cwd runs in WSL whatever the project says, so a WSL shell is what this agent gets.
  it('applies --shell wsl.exe for an agent in a WSL-share repo set to Windows host', async () => {
    const repo = { id: 'r', path: '\\\\wsl$\\Ubuntu\\r' }
    const preference = { kind: 'windows-host' }
    const store = {
      getSettings: () => ({ terminalWindowsShell: 'cmd.exe' }),
      getProjects: () => [
        { id: 'p', sourceRepoIds: ['r'], localWindowsRuntimePreference: preference }
      ],
      getRepo: () => repo
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the planner reads only these members and fields.
    const share = { ...workspace, id: 'r', path: repo.path, repo } as never
    const opts = { startupAgent: 'claude', shellOverride: 'wsl.exe' } as const
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    const planHost = { ...host, store: store as never }
    const launch = await resolveAgentTerminalCreateOptions(share, opts, planHost)
    expect(launch.launchRuntime?.pty.shellOverride).toBe('wsl.exe')
  })
})

const wslRuntime = {
  platform: 'linux',
  pty: { shellOverride: 'wsl.exe', terminalWindowsWslDistro: 'Ubuntu' }
} as const

it.each([
  ['cmd.exe', undefined, undefined, `codex "resume" "session's"`],
  ['powershell.exe', 'cmd.exe', undefined, `codex "resume" "session's"`],
  ['powershell.exe', undefined, undefined, "codex 'resume' 'session''s'"],
  [
    'cmd.exe',
    undefined,
    wslRuntime,
    `codex '-c' 'disable_paste_burst=true' 'resume' 'session'"'"'s'`
  ]
] as const)(
  'quotes saved identity with setting %s and override %s for runtime %j',
  async (setting, shellOverride, launchRuntime, expected) => {
    resumeShellSetting = setting
    const launch = await resolveAgentTerminalCreateOptions(
      workspace,
      {
        startupAgent: 'codex',
        resume: { recipe: { source: 'saved' }, codexHome: null },
        resumeProviderSession: { key: 'session_id', id: "session's" },
        shellOverride,
        launchRuntime,
        envToDelete: ['EXPLICIT_DELETE']
      },
      host
    )
    expect(launch.command).toBe(expected)
    expect(launch.launchConfig?.agentArgs).toBe('')
    expect(launch.env).toEqual({})
    expect(launch.resumeProviderSession).toEqual({ key: 'session_id', id: "session's" })
    expect(launch.launchRuntime?.platform).toBe(launchRuntime ? 'linux' : 'win32')
    expect(launch.startupCommandDelivery).toBe('shell-ready')
    expect(launch.envToDelete).toEqual(['EXPLICIT_DELETE', 'CODEX_HOME', 'ORCA_CODEX_HOME'])
  }
)

it('maps actual ordinary C1 null without typed refusal evidence', async () => {
  const failure = await resolveAgentTerminalCreateOptions(
    workspace,
    { startupAgent: 'claude', agentArgs: '"' },
    host
  ).catch((error: unknown) => error)
  const response = mapRuntimeError('request', { runtimeId: 'host' }, failure)
  expect(response.error).toEqual({
    code: 'runtime_error',
    message: 'Could not build launch command for claude.'
  })
  expect(isAgentResumeNotDispatchedResponse(response)).toBe(false)
})

it.skipIf(original === 'win32')(
  'composes the selected home with recorded cwd through typed C1',
  async () => {
    resumeShellSetting = 'cmd.exe'
    const cwd = realpathSync(tmpdir())
    for (const resumeInLaunchCwd of [undefined, false, true]) {
      const launch = await resolveAgentTerminalCreateOptions(
        workspace,
        {
          startupAgent: 'codex',
          launchRuntime: wslRuntime,
          resume: {
            recipe: {
              source: 'saved',
              launchConfig: {
                agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'",
                agentArgs: '--dangerously-bypass-approvals-and-sandbox',
                agentEnv: { SELECTED: 'recipe', CODEX_HOME: '/recipe' }
              }
            },
            codexHome: String.raw`\\wsl.localhost\Ubuntu\selected`,
            resumeInLaunchCwd
          },
          resumeProviderSession: { key: 'session_id', id: 'saved', cwd: '/' },
          cwd,
          env: { CODEX_HOME: '/caller' },
          accountEnv: { CODEX_HOME: '/account' }
        },
        host
      )
      const argv = [
        '-c',
        'disable_paste_burst=true',
        ...(resumeInLaunchCwd ? ['-c', 'tui.resume_cwd=current'] : []),
        'resume',
        'saved'
      ]
      expect(launch.launchConfig).toMatchObject({ agentCommand: 'codex', agentArgs: '' })
      expect(launch.env).toEqual({ SELECTED: 'recipe', CODEX_HOME: '/account' })
      expect(launch.resumeProviderSession).toEqual({ key: 'session_id', id: 'saved', cwd: '/' })
      expect(launch.startupCommandDelivery).toBe('shell-ready')
      const observed = execFileSync(
        '/bin/sh',
        [
          '-c',
          `codex() { printf '%s\n' "$CODEX_HOME" "$PWD" "$SELECTED" "$@"; }\n${launch.command}`
        ],
        { cwd, env: launch.env, encoding: 'utf8' }
      )
      expect(observed.trim().split('\n')).toEqual([
        '/selected',
        resumeInLaunchCwd ? cwd : '/',
        'recipe',
        ...argv
      ])
    }
  }
)
