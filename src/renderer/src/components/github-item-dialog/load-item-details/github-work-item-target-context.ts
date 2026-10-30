import { useAppStore } from '@/store'
import { useGitHubOperationScope } from '@/hooks/useGitHubOperationScope'
import {
  canUseGitHubRepoContext,
  getGitHubRepoRoutingTarget
} from '@/lib/github-source-runtime-context'
import {
  resolvePullRequestRepo,
  parseOwnerRepoFromItemUrl
} from '@/components/github/github-work-item-identity'
import { getTaskSourceCacheScope } from '../../../../../shared/task-source-context'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { GitHubItemDialogProjectOrigin } from './github-item-dialog-types'
import { getWorkItemDetailsCacheKey } from './work-item-details-cache'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { createContext, useContext, useMemo } from 'react'
import type { GitHubWorkItemTarget } from '../../../../../shared/github/work-item-target'

export const GitHubWorkItemTargetContext = createContext<{
  resource: GitHubWorkItemTarget
  target: RuntimeClientTarget
  sourceContext?: TaskSourceContext | null
} | null>(null)

export function useGitHubWorkItemTarget() {
  return useContext(GitHubWorkItemTargetContext)
}

export function useGitHubItemTargetIdentity({
  workItem,
  repoPath,
  effectiveRepoId,
  sourceContext,
  projectOrigin
}: {
  workItem: GitHubWorkItem | null
  repoPath: string | null
  effectiveRepoId: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin?: GitHubItemDialogProjectOrigin
}) {
  // Include source preference so origin/upstream switches cannot reuse details from the wrong repository.
  const issueSourcePreference = useAppStore((s) => {
    if (!repoPath && !effectiveRepoId) {
      return undefined
    }
    return s.repos.find((r) => (effectiveRepoId ? r.id === effectiveRepoId : r.path === repoPath))
      ?.issueSourcePreference
  })
  const canUseDetailsRepoContext = canUseGitHubRepoContext(repoPath, sourceContext)
  const repository = useMemo(
    () =>
      workItem
        ? workItem.type === 'pr'
          ? resolvePullRequestRepo(workItem, projectOrigin)
          : (projectOrigin ?? parseOwnerRepoFromItemUrl(workItem.url))
        : null,
    [projectOrigin, workItem]
  )
  const resource = useMemo(
    () =>
      workItem && repository
        ? { repository: repository, type: workItem.type, number: workItem.number }
        : null,
    [workItem, repository]
  )
  const target = getGitHubRepoRoutingTarget(useAppStore.getState(), effectiveRepoId, sourceContext)
  const operationScope = useGitHubOperationScope(target, effectiveRepoId, repoPath)
  const detailsCacheKey = useMemo(() => {
    if (!workItem || !effectiveRepoId || !canUseDetailsRepoContext) {
      return null
    }
    return getWorkItemDetailsCacheKey({
      repoPath: repoPath ?? '',
      repoId: effectiveRepoId,
      issueSourcePreference,
      sourceContext,
      sourceCacheScope:
        sourceContext?.provider === 'github'
          ? `${getTaskSourceCacheScope(sourceContext)}::${operationScope}`
          : operationScope,
      type: workItem.type,
      number: workItem.number,
      ownerRepo: repository
    })
  }, [
    canUseDetailsRepoContext,
    repoPath,
    effectiveRepoId,
    sourceContext,
    workItem,
    issueSourcePreference,
    repository,
    operationScope
  ])

  return { resource, detailsCacheKey, canUseDetailsRepoContext }
}

export function useGitHubItemTargetContext({
  resource,
  effectiveRepoId,
  sourceContext
}: {
  resource: GitHubWorkItemTarget | null
  effectiveRepoId: string | null
  sourceContext?: TaskSourceContext | null
}) {
  return useMemo(() => {
    if (!resource || !effectiveRepoId) {
      return null
    }
    const target = getGitHubRepoRoutingTarget(
      useAppStore.getState(),
      effectiveRepoId,
      sourceContext
    )
    return {
      resource,
      target,
      sourceContext
    }
  }, [resource, effectiveRepoId, sourceContext])
}
