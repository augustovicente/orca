import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

import { linearSettingsForBoardWorktree } from './use-workspace-board-task-status-sync'

const WORKTREE_ID = 'repo::/w'
type OwnerHost = 'local' | 'runtime:env-b'

function ownedBy(...hostIds: OwnerHost[]) {
  return {
    repos: hostIds.map((hostId) => ({ id: 'repo', executionHostId: hostId })),
    worktreesByRepo: {
      repo: hostIds.map((hostId) => ({
        id: WORKTREE_ID,
        repoId: 'repo',
        hostId,
        ...(hostId === 'local' ? {} : { runtimeOwnerEnvironmentId: 'env-b' })
      }))
    }
  }
}

describe('linearSettingsForBoardWorktree', () => {
  it("uses the runtime owner's Linear settings", () => {
    expect(linearSettingsForBoardWorktree(ownedBy('runtime:env-b'), WORKTREE_ID)).toEqual({
      kind: 'environment',
      environmentId: 'env-b'
    })
  })

  it("skips a local twin of a server instead of borrowing this computer's Linear", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(linearSettingsForBoardWorktree(ownedBy('local', 'runtime:env-b'), WORKTREE_ID)).toBe(
      null
    )
    expect(warn.mock.calls[0]).toContain(WORKTREE_ID)
    warn.mockRestore()
  })

  it("uses a dragged twin card's own host, not this computer's Linear", () => {
    expect(
      linearSettingsForBoardWorktree(
        ownedBy('local', 'runtime:env-b'),
        WORKTREE_ID,
        'runtime:env-b'
      )
    ).toEqual({ kind: 'environment', environmentId: 'env-b' })
  })

  it('keeps the id-only route for a workspace on one host', () => {
    const state = ownedBy('runtime:env-b')
    expect(linearSettingsForBoardWorktree(state, WORKTREE_ID, 'runtime:env-b')).toEqual(
      linearSettingsForBoardWorktree(state, WORKTREE_ID)
    )
  })
})
