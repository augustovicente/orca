import type * as ForegroundModule from './terminal-process-rows'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  observePtyForeground,
  readPtyForegroundGroup,
  resolvePtyForegroundMembers
} from './pty-master-foreground-observation'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { isTerminalForegroundObservation } from '../../shared/terminal-foreground-observation'
const mocks = vi.hoisted(() => ({ rows: vi.fn(), tty: vi.fn(), ps: vi.fn() }))
vi.mock('./terminal-process-rows', async (importOriginal) => ({
  ...(await importOriginal<typeof ForegroundModule>()),
  readPtyTerminalRows: mocks.rows,
  readTerminalTty: mocks.tty,
  readTerminalPs: mocks.ps
}))
const row = (command: string, pid = 201, pgid = 200) => ({
  pid,
  ppid: 100,
  pgid,
  tpgid: 200,
  stat: 'S+',
  command
})
const proc = () => ({
  pid: 100,
  fd: 9,
  ptsName: '/dev/pts/5',
  getForegroundProcessGroup: vi.fn((): number | null | undefined => 200)
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.rows.mockResolvedValue([row('claude')])
  mocks.tty.mockResolvedValue('pts/5')
  mocks.ps.mockResolvedValue('200 pts/5')
})
describe('physical PTY observations', () => {
  it('survives client rebind and a missing group leader/root row', async () => {
    const owner = proc()
    const first = await observePtyForeground(owner, () => true)
    const afterRebind = await observePtyForeground(owner, () => true)
    expect(first).toMatchObject({
      verdict: 'observed',
      source: 'pty-master',
      foregroundKind: 'non-shell',
      processName: 'claude',
      foregroundPgid: 200
    })
    expect(afterRebind).toEqual(first)
    expect(mocks.tty).not.toHaveBeenCalled()
  })
  it('uses all members rather than naming only a wrapper leader', async () => {
    mocks.rows.mockResolvedValue([
      row('sh ./wrapper', 200),
      { ...row('node /opt/node_modules/@openai/codex/bin/codex.js'), ppid: 200 }
    ])
    expect(await observePtyForeground(proc(), () => true)).toMatchObject({
      verdict: 'observed',
      foregroundKind: 'non-shell',
      processName: 'codex'
    })
  })
  it.each(Object.entries(TUI_AGENT_CONFIG))(
    'admits catalog agent %s regardless of its launch route',
    (_agent, config) => {
      expect(resolvePtyForegroundMembers([row(config.expectedProcess)], 200)).toMatchObject({
        verdict: 'observed',
        foregroundKind: 'non-shell'
      })
    }
  )
  it.each([
    'node /private/user/unknown-agent.js',
    'python3 custom_agent.py',
    '/home/user/.local/bin/my-agent'
  ])('preserves non-shell admission for %s', (command) => {
    expect(
      resolvePtyForegroundMembers([row('bash wrapper', 200), row(command)], 200)
    ).toMatchObject({ verdict: 'observed', foregroundKind: 'non-shell' })
  })
  it('excludes a suspended/background agent while the shell owns foreground', () => {
    expect(
      resolvePtyForegroundMembers([row('-zsh', 100, 100), { ...row('claude'), stat: 'T' }], 100)
    ).toMatchObject({ verdict: 'observed', foregroundKind: 'shell', processName: 'zsh' })
  })
  it.each(['(bash)', '(zsh)'])('cannot prove unreadable shell argv %s', (command) => {
    expect(resolvePtyForegroundMembers([row(command)], 200).verdict).toBe('unverifiable')
  })
  it.each([
    ['node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume abc', 'claude'],
    ['/home/user/.local/share/claude/versions/2.1.26', '2.1.26'],
    ['python3 /opt/work/unknown_agent.py', 'python3']
  ])(
    'resolves real installation argv without rewriting the user command: %s',
    (command, processName) => {
      const sample = resolvePtyForegroundMembers([row(command)], 200)
      expect(sample).toMatchObject({
        verdict: 'observed',
        foregroundKind: 'non-shell',
        processName
      })
    }
  )
  it('keeps unreadable non-shell identity separate from local non-shell admission', () => {
    expect(resolvePtyForegroundMembers([row('(node)')], 200)).toMatchObject({
      verdict: 'observed',
      foregroundKind: 'non-shell',
      processName: null
    })
  })

  it('never queries a retired/reused fd or rescues a supported failure with a cached name', async () => {
    const owner = proc()
    owner.fd = -1
    expect(await observePtyForeground(owner, () => true)).toMatchObject({ verdict: 'unverifiable' })
    expect(owner.getForegroundProcessGroup).not.toHaveBeenCalled()
    owner.fd = 9
    owner.getForegroundProcessGroup.mockReturnValue(null)
    expect(await observePtyForeground(owner, () => true)).toMatchObject({
      verdict: 'unverifiable',
      reason: 'master_unavailable'
    })
    expect(mocks.rows).not.toHaveBeenCalled()
  })
  it('discards late results from a replaced session', async () => {
    let current = true
    mocks.rows.mockImplementation(async () => {
      current = false
      return [row('claude')]
    })
    expect(await observePtyForeground(proc(), () => current)).toMatchObject({
      verdict: 'unverifiable',
      reason: 'session_changed'
    })
  })
  it('rereads at most once when the group changes and obeys its original deadline', async () => {
    const owner = proc()
    owner.getForegroundProcessGroup
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(300)
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(300)
    expect(await observePtyForeground(owner, () => true)).toMatchObject({ verdict: 'unverifiable' })
    expect(mocks.rows).toHaveBeenCalledTimes(2)
    mocks.rows.mockClear()
    expect(await observePtyForeground(proc(), () => true, Date.now() - 1)).toMatchObject({
      verdict: 'unverifiable'
    })
    expect(mocks.rows).not.toHaveBeenCalled()
  })
  it('supports older native images with fresh PTY-matched root proof', async () => {
    const owner = proc()
    owner.getForegroundProcessGroup.mockReturnValue(undefined)
    mocks.rows.mockResolvedValue([row('zsh', 100, 100), row('claude')])
    expect(readPtyForegroundGroup(owner)).toBeUndefined()
    expect(await observePtyForeground(owner, () => true)).toMatchObject({
      verdict: 'observed',
      source: 'posix-process-table'
    })
    mocks.tty.mockResolvedValue('pts/6')
    expect(await observePtyForeground(owner, () => true)).toMatchObject({ verdict: 'unverifiable' })
  })
  it('validates optional host observations without treating a future/malformed branch as proof', () => {
    const metadata = {
      ptyId: 'p',
      ptyIncarnationId: 'i',
      authorityGeneration: 'a',
      observationEpoch: 1,
      capturedAgeMs: 0
    }
    expect(
      isTerminalForegroundObservation({
        ...metadata,
        verdict: 'observed',
        source: 'pty-master',
        foregroundKind: 'non-shell',
        processName: 'claude',
        foregroundPgid: 200
      })
    ).toBe(true)
    expect(
      isTerminalForegroundObservation({
        ...metadata,
        verdict: 'observed',
        source: 'pty-master',
        foregroundKind: 'agent',
        processName: 'claude'
      })
    ).toBe(false)
    expect(
      isTerminalForegroundObservation({
        ...metadata,
        verdict: 'unverifiable',
        reason: 'new_host_reason'
      })
    ).toBe(true)
  })
})
