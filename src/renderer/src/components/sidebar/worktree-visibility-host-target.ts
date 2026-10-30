import type { Repo } from '../../../../shared/repo-types'
import type { DetectedWorktreeListResult, Worktree } from '../../../../shared/worktree/types'
import { getRepoHostSummaries } from '@/store/slices/worktrees/listing/worktree-host-ownership'
import { getRepoHostIdentityForParts } from '../../../../shared/repo-host-identity'
import { useCallback } from 'react'
import type { AppState } from '@/store/types'
import { findRepoForHost, getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import {
  toRuntimeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { selectDetectedWorktreesByRepo } from '@/store/workspace-record-selectors'

export function resolveWorktreeVisibilityHostTarget(
  state: Pick<AppState, 'repos' | 'settings' | 'detectedWorktreesByRepo'>,
  repoId: string,
  modalHostId: unknown
) {
  const requestedHostId =
    typeof modalHostId === 'string' ? parseExecutionHostId(modalHostId)?.id : undefined
  const repo = findRepoForHost(state.repos, repoId, {
    hostId: requestedHostId,
    settings: state.settings
  })
  const detected = repo
    ? partitionDetectedWorktreesByHost(state.repos, selectDetectedWorktreesByRepo(state)).get(
        getRepoHostIdentity(repo)
      )
    : undefined
  const scope = repo ? getRepoHostIdentity(repo) : `${requestedHostId ?? ''}\0${repoId}`
  return { detected, repo, requestedHostId, scope }
}

export function useWorktreeVisibilityHostActions(
  fetchWorktrees: AppState['fetchWorktrees'],
  updateRepo: AppState['updateRepo'],
  requestedHostId: ExecutionHostId | undefined
) {
  const refreshTargetRepo = useCallback(
    (repoId: string, options?: { requireAuthoritative?: boolean }) =>
      fetchWorktrees(repoId, {
        ...options,
        ...(requestedHostId ? { executionHostId: requestedHostId } : {})
      }),
    [fetchWorktrees, requestedHostId]
  )
  const updateTargetRepo = useCallback(
    (repoId: string, updates: Parameters<AppState['updateRepo']>[1]) =>
      requestedHostId
        ? updateRepo(repoId, updates, { hostId: requestedHostId })
        : updateRepo(repoId, updates),
    [requestedHostId, updateRepo]
  )
  return { refreshTargetRepo, updateTargetRepo }
}

export function getDetectedWorktreeOwnerHost(
  worktree: Pick<Worktree, 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'>,
  summary: { count: number; onlyHostId?: ExecutionHostId } | undefined
): ExecutionHostId {
  return worktree.runtimeOwnerEnvironmentId
    ? toRuntimeExecutionHostId(worktree.runtimeOwnerEnvironmentId)
    : (worktree.hostId ?? (summary?.count === 1 ? summary.onlyHostId : undefined) ?? 'local')
}

export function partitionDetectedWorktreesByHost(
  repos: readonly Repo[],
  detectedByRepo: Readonly<Record<string, DetectedWorktreeListResult | undefined>>
): Map<string, DetectedWorktreeListResult> {
  const summaries = getRepoHostSummaries(repos)
  const result = new Map<string, DetectedWorktreeListResult>()
  for (const repo of repos) {
    const detected = detectedByRepo[repo.id]
    const identity = getRepoHostIdentity(repo)
    if (detected && !result.has(identity)) {
      result.set(identity, { ...detected, worktrees: [] })
    }
  }
  for (const [repoId, detected] of Object.entries(detectedByRepo)) {
    if (!detected) {
      continue
    }
    const summary = summaries.get(repoId)
    for (const worktree of detected.worktrees) {
      const identity = getRepoHostIdentityForParts(
        repoId,
        getDetectedWorktreeOwnerHost(worktree, summary)
      )
      result.get(identity)?.worktrees.push(worktree)
    }
  }
  return result
}
