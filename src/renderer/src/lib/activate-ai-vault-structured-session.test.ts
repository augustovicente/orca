import { expect, it, vi } from 'vitest'
import {
  activateAiVaultStructuredSession,
  openDesktopStructuredSession,
  type StructuredSessionRevealOutcome
} from './activate-ai-vault-structured-session'
import type { StructuredSessionOpenTab } from '../../../shared/open-structured-agent-session'

const session = { structuredSession: { sessionId: 'session-1', workspaceId: 'workspace-1' } }
const owner = { kind: 'local' } as const
function rig() {
  let rows: StructuredSessionOpenTab[] = [{ id: 'issued', sessionId: 'session-1', agent: 'codex' }]
  const parts = {
    tabs: vi.fn(() => rows),
    activate: vi.fn(() => true),
    refresh: vi.fn(async () => undefined),
    reveal: vi.fn(async (): Promise<StructuredSessionRevealOutcome> => ({
      sessionId: 'session',
      worktreeId: 'workspace'
    })),
    unavailable: vi.fn(),
    gone: vi.fn(),
    hostCannotOpen: vi.fn()
  }
  return {
    parts,
    rows: (next: StructuredSessionOpenTab[]) => {
      rows = next
    }
  }
}
it('selects the exact History view immediately without calling discovery or refresh', async () => {
  const { parts } = rig()
  const locate = vi.fn(async () => {
    throw new Error('offline')
  })
  expect(
    await openDesktopStructuredSession({ kind: 'history', ...session }, owner, parts, locate)
  ).toMatchObject({ kind: 'opened', tab: { id: 'issued' } })
  expect(locate).not.toHaveBeenCalled()
  expect(parts.refresh).not.toHaveBeenCalled()
  expect(parts.activate).toHaveBeenCalledWith({
    sessionId: 'session-1',
    worktreeId: 'workspace-1',
    agent: undefined,
    target: owner
  })
})
it.each([
  ['gone', 'gone'],
  ['unsupported', 'hostCannotOpen'],
  ['unknown', 'unavailable'],
  ['unreachable', 'unavailable']
] as const)('maps semantic %s to existing desktop feedback', async (reason, feedback) => {
  const r = rig()
  r.rows([])
  const locate = vi.fn(async () => ({ reason, beforeEffects: reason !== 'unreachable' }))
  if (reason === 'unsupported') {
    r.parts.reveal.mockImplementation(async () => 'host-cannot-open')
  }
  expect(
    await openDesktopStructuredSession({ kind: 'history', ...session }, owner, r.parts, locate)
  ).toMatchObject({ kind: 'failed' })
  expect(r.parts[feedback]).toHaveBeenCalledOnce()
})
it('coalesces the same owned History attempt and releases it after completion', async () => {
  const r = rig()
  const held = Promise.withResolvers<void>()
  r.rows([])
  r.parts.refresh.mockImplementation(async () => {
    await held.promise
    r.rows([{ id: 'issued', sessionId: 'session-1' }])
  })
  const first = activateAiVaultStructuredSession(session, r.parts, owner)
  const second = activateAiVaultStructuredSession(session, r.parts, owner)
  held.resolve()
  expect(await Promise.all([first, second])).toEqual([true, true])
  expect(r.parts.refresh).toHaveBeenCalledOnce()
  await activateAiVaultStructuredSession(session, r.parts, owner)
  expect(r.parts.activate).toHaveBeenCalledTimes(2)
})
it('keeps simultaneous different hosts independent and ignores terminal History', async () => {
  const { parts } = rig()
  expect(
    await Promise.all([
      activateAiVaultStructuredSession(session, parts, owner),
      activateAiVaultStructuredSession(session, parts, {
        kind: 'environment',
        environmentId: 'other'
      })
    ])
  ).toEqual([true, true])
  expect(parts.activate).toHaveBeenCalledTimes(2)
  expect(await activateAiVaultStructuredSession({ structuredSession: null }, parts)).toBe(false)
})
