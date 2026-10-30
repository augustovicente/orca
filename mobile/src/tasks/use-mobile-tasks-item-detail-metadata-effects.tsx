import { withGitHubTargetOperation } from './github-work-item-operation'
import { requireGitHubTaskTarget } from './github-task-identity'
import type { ListAndDetailEffectsModel } from './use-mobile-tasks-list-and-detail-effects'
import { useEffect } from './mobile-tasks-dependencies'
import {
  githubAssignableUserListRead,
  githubRepoLabelListRead
} from './mobile-task-item-detail-operations'
import { detailPayloadBody } from './mobile-tasks-provider-detail-types'

export function useMobileTasksItemDetailMetadataEffects(model: ListAndDetailEffectsModel) {
  const {
    actionItem,
    client,
    detailPayload,
    setItemAssignableUsers,
    setItemAssignableUsersError,
    setItemAssignableUsersLoading,
    setItemAvailableLabels,
    setItemBodyDraft,
    setItemLabelsError,
    setItemLabelsLoading,
    tasksSupported
  } = model
  useEffect(() => {
    if (!detailPayload) {
      setItemBodyDraft('')
      return
    }
    setItemBodyDraft(detailPayloadBody(detailPayload))
  }, [detailPayload])

  useEffect(() => {
    if (!tasksSupported || !client || actionItem?.provider !== 'github') {
      setItemAvailableLabels([])
      setItemLabelsLoading(false)
      setItemLabelsError('')
      setItemAssignableUsers([])
      setItemAssignableUsersLoading(false)
      setItemAssignableUsersError('')
      return
    }

    let stale = false
    const loadRepositoryList = async <T,>(
      send: (
        selected: typeof client,
        exact: {
          ownerRepo?: import('../../../src/shared/github/pull-request-types').GitHubOwnerRepo
        },
        options: import('../transport/rpc-client').SendRequestOptions
      ) => Promise<T>
    ) => {
      const target = requireGitHubTaskTarget(actionItem.source)
      return withGitHubTargetOperation({
        client,
        params: { repo: `id:${actionItem.source.repoId}` },
        ownerRepo: target.repository,
        send
      })
    }
    if (actionItem.source.type === 'issue' || actionItem.source.type === 'pr') {
      setItemAvailableLabels([])
      setItemLabelsError('')
      setItemLabelsLoading(true)
      void loadRepositoryList((selected, exact, options) =>
        githubRepoLabelListRead.request(
          selected,
          { repo: `id:${actionItem.source.repoId}`, ...exact },
          options
        )
      )
        .then((response) => {
          if (stale) {
            return
          }
          setItemAvailableLabels(githubRepoLabelListRead.interpret(response))
        })
        .catch((err) => {
          if (!stale) {
            setItemLabelsError(err instanceof Error ? err.message : 'Failed to load labels')
          }
        })
        .finally(() => {
          if (!stale) {
            setItemLabelsLoading(false)
          }
        })
    } else {
      setItemAvailableLabels([])
      setItemLabelsLoading(false)
      setItemLabelsError('')
    }

    setItemAssignableUsers([])
    setItemAssignableUsersError('')
    setItemAssignableUsersLoading(true)
    void loadRepositoryList((selected, exact, options) =>
      githubAssignableUserListRead.request(
        selected,
        { repo: `id:${actionItem.source.repoId}`, ...exact },
        options
      )
    )
      .then((response) => {
        if (stale) {
          return
        }
        setItemAssignableUsers(githubAssignableUserListRead.interpret(response))
      })
      .catch((err) => {
        if (!stale) {
          setItemAssignableUsersError(
            err instanceof Error ? err.message : 'Failed to load assignees'
          )
        }
      })
      .finally(() => {
        if (!stale) {
          setItemAssignableUsersLoading(false)
        }
      })

    return () => {
      stale = true
    }
  }, [actionItem, client, tasksSupported])
  return model
}

export type ItemDetailMetadataEffectsModel = ReturnType<
  typeof useMobileTasksItemDetailMetadataEffects
>
