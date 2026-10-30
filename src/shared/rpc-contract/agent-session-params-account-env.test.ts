import { describe, expect, it } from 'vitest'
import { CreateAgentSessionParams, EnsureAgentSessionParams } from './agent-session-params'
import { TerminalCreateParams } from './terminal-unary-params'

const ACCOUNT_ENV = {
  CLAUDE_CONFIG_DIR: '/home/u/.orca-claude/a/config',
  ORCA_CLAUDE_INJECTED_CONFIG_DIR: '/home/u/.orca-claude/a/config',
  ORCA_CLAUDE_PROFILE_POINTER: '~/.orca-claude/pointer',
  CODEX_HOME: '/home/u/.orca-codex/b'
}
const CREATE = {
  clientOperationId: `${Date.now()}-${'a'.repeat(32)}`,
  worktree: 'id:wt-1',
  agent: 'claude'
}
const ENSURE = {
  kind: 'explicit',
  worktree: 'id:wt-1',
  agent: 'codex',
  providerSession: { key: 'session_id', id: 'session-1' }
}

describe.each([
  ['terminal.createAgentSession', CreateAgentSessionParams, CREATE],
  ['terminal.ensureAgentSession', EnsureAgentSessionParams, ENSURE],
  ['terminal.create', TerminalCreateParams, { worktree: 'id:wt-1' }]
] as const)('%s accountEnv wire compatibility', (_method, schema, base) => {
  it('preserves validated account routing and old-client absence', () => {
    expect(schema.parse({ ...base, accountEnv: ACCOUNT_ENV })).toMatchObject({
      accountEnv: ACCOUNT_ENV
    })
    expect(schema.parse(base)).not.toHaveProperty('accountEnv')
  })

  it.each([
    ['a non-account variable', { PATH: '/usr/bin' }],
    ['a relative home', { CLAUDE_CONFIG_DIR: 'home/u/.claude' }],
    ['a parent segment', { CODEX_HOME: '/home/u/../root/.codex' }],
    ['a Windows path', { CODEX_HOME: 'C:\\Users\\u\\.codex' }],
    ['a newline', { CODEX_HOME: '/home/u/.codex\nX=1' }]
  ])('refuses %s rather than starting another account', (_label, accountEnv) => {
    expect(schema.safeParse({ ...base, accountEnv }).success).toBe(false)
  })
})

describe('agent-session.account-env.v1', () => {
  it.each([CreateAgentSessionParams, EnsureAgentSessionParams])(
    'keeps strict requests',
    (schema) => {
      const base = schema === CreateAgentSessionParams ? CREATE : ENSURE
      expect(schema.safeParse({ ...base, futureAccountEnv: ACCOUNT_ENV }).success).toBe(false)
    }
  )

  it('is not accepted on an automatic ensure, which hosts refuse anyway', () => {
    const automatic = { kind: 'automatic', sleepingCheckpointId: 'a'.repeat(32) }
    expect(EnsureAgentSessionParams.safeParse(automatic).success).toBe(true)
    expect(
      EnsureAgentSessionParams.safeParse({ ...automatic, accountEnv: ACCOUNT_ENV }).success
    ).toBe(false)
  })
})

it.each([
  [{ CODEX_HOME: 'C:\\Users\\qa\\managed', ORCA_PANE_KEY: 'tab:leaf' }, true],
  [{ PATH: '/usr/bin', ORCA_AGENT_LAUNCH_TOKEN: 'token' }, true],
  [{ ORCA_PANE_KEY: 1 }, false],
  [{ invalid: null }, false],
  [['not-a-record'], false]
])('validates explicit ensure env %j as %s', (env, valid) => {
  expect(EnsureAgentSessionParams.safeParse({ ...ENSURE, env }).success).toBe(valid)
  expect(TerminalCreateParams.safeParse({ worktree: ENSURE.worktree, env }).success).toBe(valid)
})

it.each([
  [undefined, true],
  [[], true],
  [Array.from({ length: 32 }, (_, i) => `${i}`.padEnd(256, 'x')), true],
  [[''], false],
  [['x'.repeat(257)], false],
  [Array.from({ length: 33 }, (_, i) => `KEY_${i}`), false]
] as const)('keeps ensure/create deletion-list parity (case %#)', (envToDelete, valid) => {
  expect(EnsureAgentSessionParams.safeParse({ ...ENSURE, envToDelete }).success).toBe(valid)
  expect(TerminalCreateParams.safeParse({ worktree: ENSURE.worktree, envToDelete }).success).toBe(
    valid
  )
})

it.each([
  [undefined, true],
  ['/tmp/quoted path/é.jsonl', true],
  [String.raw`\\wsl$\Ubuntu\sessions\a.jsonl`, true],
  ['é'.repeat(8192), true],
  ['é'.repeat(8193), false],
  ['', false],
  [' /tmp/a.jsonl', false],
  ['/tmp/a.jsonl ', false],
  ...['\0', '\n', '\x1f', '\x7f'].map((control) => [`/tmp/a${control}.jsonl`, false] as const)
] as const)('validates the explicit OMP path at both typed boundaries (case %#)', (path, valid) => {
  const resume = { recipe: { source: 'host-defaults' }, ompResumeFilePath: path }
  const ensure = { ...ENSURE, agent: 'omp', resume }
  expect(EnsureAgentSessionParams.safeParse(ensure).success).toBe(valid)
  expect(EnsureAgentSessionParams.safeParse({ ...ENSURE, resume }).success).toBe(valid)
  expect(TerminalCreateParams.safeParse({ resume }).success).toBe(valid)
  expect(
    EnsureAgentSessionParams.safeParse({ ...ENSURE, agent: 'omp', ompResumeFilePath: path }).success
  ).toBe(valid)
})

it.each([undefined, '', '   ', '\\\\server\\share\\session.jsonl'])(
  'keeps saved literals and native/null homes: %j',
  (ompResumeFilePath) => {
    const resume = {
      recipe: { source: 'saved', launchConfig: { agentArgs: '', agentEnv: {}, ompResumeFilePath } },
      codexHome: null
    }
    expect(EnsureAgentSessionParams.parse({ ...ENSURE, resume })).toHaveProperty('resume', resume)
    expect(TerminalCreateParams.parse({ resume }).resume).toEqual(resume)
    const native = { ...resume, codexHome: 'C:\\Users\\qa\\.codex' }
    expect(TerminalCreateParams.parse({ resume: native }).resume).toEqual(native)
  }
)
