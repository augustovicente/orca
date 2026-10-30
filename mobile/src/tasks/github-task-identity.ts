import { useCallback, useEffect, useRef } from 'react'
import type { DetailPayload } from './mobile-tasks-provider-detail-types'
import type { RpcClient } from '../transport/rpc-client'
import {
  githubWorkItemTargetKey,
  resolveGitHubWorkItemTarget,
  matchesGitHubWorkItemTarget
} from '../../../src/shared/github/work-item-target'
import type { GitHubWorkItem } from './mobile-tasks-provider-detail-types'
import type { TaskItem } from './mobile-tasks-legacy-foundation'

export function githubTaskKey(source: GitHubWorkItem): string {
  const target = resolveGitHubWorkItemTarget(source)
  return [source.repoId, target ? githubWorkItemTargetKey(target) : source.url].join('\0')
}

export function sameGitHubTask(
  current: TaskItem | null,
  item: Extract<TaskItem, { provider: 'github' }>
): current is Extract<TaskItem, { provider: 'github' }> {
  return (
    current?.provider === 'github' && githubTaskKey(current.source) === githubTaskKey(item.source)
  )
}

export function requireGitHubTaskTarget(source: GitHubWorkItem) {
  const target = resolveGitHubWorkItemTarget(source)
  if (!target || !matchesGitHubWorkItemTarget(source, target)) {
    throw new Error('Unable to identify this GitHub item. Open it again from Tasks.')
  }
  return target
}

export function useGitHubTaskPublication(model: {
  actionItem: TaskItem | null
  client: RpcClient | null
  detailPayload?: DetailPayload | null
}) {
  const latest = useRef(model)
  latest.current = model
  const connection = useRef({ client: model.client, revision: 0 })
  if (connection.current.client !== model.client) {
    connection.current = { client: model.client, revision: connection.current.revision + 1 }
  }
  useEffect(
    () =>
      model.client?.onStateChange((state) => {
        if (state !== 'connected') {
          connection.current.revision += 1
        }
      }),
    [model.client]
  )
  return useCallback((item: TaskItem, details?: DetailPayload | null) => {
    const client = latest.current.client
    const generation = client?.getGeneration?.()
    const revision = connection.current.revision
    return () =>
      item.provider !== 'github' ||
      (latest.current.client === client &&
        connection.current.revision === revision &&
        client?.getState() === 'connected' &&
        client.getGeneration?.() === generation &&
        sameGitHubTask(latest.current.actionItem, item) &&
        (details?.provider !== 'github' ||
          (latest.current.detailPayload?.provider === 'github' &&
            latest.current.detailPayload.headSha === details.headSha &&
            latest.current.detailPayload.baseSha === details.baseSha)))
  }, [])
}
