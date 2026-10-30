import React, { useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { createFakeRpcClient, rpcSuccess } from '../mobile-web-shell/bridge-host-test-fakes'
import type { DetailPayload, GitHubDetailFile } from './mobile-tasks-provider-detail-types'
import type { ActionableTaskItem, TaskItem } from './mobile-tasks-project-workspace-types'
import { githubTaskKey } from './github-task-identity'
import { useMobileTasksGithubCheckFileActions } from './use-mobile-tasks-github-check-file-actions'
import {
  useMobileTasksProjectFileMergeActions,
  type ProjectFileMergeActionsInput
} from './use-mobile-tasks-project-file-merge-actions'
import { useMobileTasksHostedMetadataActions } from './use-mobile-tasks-hosted-metadata-actions'

vi.mock('./mobile-tasks-legacy-foundation', async () => import('./mobile-tasks-item-mapping'))
vi.mock('./mobile-tasks-dependencies', async () => ({
  useCallback: (await import('react')).useCallback,
  colors: {}
}))
const renderers: ReactTestRenderer[] = []
afterEach(async () => {
  for (const renderer of renderers.splice(0)) {
    await act(async () => renderer.unmount())
  }
})
function item(owner: string): Extract<TaskItem, { provider: 'github' }> {
  return {
    key: owner,
    provider: 'github',
    title: owner,
    subtitle: '',
    status: 'Open',
    updatedAt: '',
    source: {
      id: 'pr:93',
      repoId: 'clone',
      type: 'pr',
      number: 93,
      title: owner,
      state: 'open',
      labels: [],
      author: null,
      updatedAt: '',
      url: `https://github.corp/${owner}/widgets/pull/93`,
      prRepo: { owner, repo: 'widgets', host: 'github.corp' }
    }
  }
}
const file: GitHubDetailFile = {
  path: 'same.ts',
  additions: 1,
  deletions: 0,
  status: 'modified',
  viewerViewedState: 'UNVIEWED'
}
function details(selected: Extract<TaskItem, { provider: 'github' }>): DetailPayload {
  return {
    provider: 'github',
    targetKey: githubTaskKey(selected.source),
    body: selected.title,
    labels: [],
    assignees: [],
    comments: [],
    reviewRequests: [],
    latestReviews: [],
    files: [file],
    checks: [],
    pullRequestId: `PR_${selected.title}`,
    headSha: `${selected.title}-head`,
    baseSha: `${selected.title}-base`
  }
}
async function mount() {
  const client = createFakeRpcClient()
  const a = item('fork')
  const b = item('upstream')
  const loadTasks = vi.fn(async () => {})
  let current!: ReturnType<typeof ProbeModel>
  let select!: (selected: typeof a) => void
  function ProbeModel() {
    const [actionItem, setActionItem] = useState<ActionableTaskItem | null>(a)
    const [payload, setDetailPayload] = useState<DetailPayload | null>(details(a))
    const [items, setItems] = useState<TaskItem[]>([a, b])
    const [mutatingStatus, setMutatingStatus] = useState(false)
    const [error, setError] = useState('')
    const [expandedPrFilePath, setExpandedPrFilePath] = useState<string | null>(null)
    const [prFileLoadingPath, setPrFileLoadingPath] = useState<string | null>(null)
    const [prFileContents, setPrFileContents] = useState<
      Record<string, { original?: string; modified?: string }>
    >({})
    const [prFileCommentDrafts, setPrFileCommentDrafts] = useState<Record<string, string>>({
      'same.ts:1': 'review'
    })
    const [, setDetailRefreshSeq] = useState(0)
    const [, setItemAddAssigneesDraft] = useState('')
    const [, setItemAddLabelsDraft] = useState('')
    const [, setItemRemoveAssigneesDraft] = useState('')
    const [, setItemRemoveLabelsDraft] = useState('')
    select = (selected) => {
      setActionItem(selected)
      setDetailPayload(details(selected))
      setMutatingStatus(false)
      setExpandedPrFilePath(null)
      setPrFileContents({})
      setPrFileLoadingPath(null)
    }
    const project: Pick<
      ProjectFileMergeActionsInput,
      | 'activeGitHubProjectHost'
      | 'findProjectRowRepo'
      | 'projectMutating'
      | 'projectRowDetail'
      | 'setGithubProjectTable'
      | 'setProjectMutating'
      | 'setProjectRowDetail'
      | 'setProjectRowDetailError'
      | 'setProjectRowItem'
    > = {
      activeGitHubProjectHost: 'github.corp',
      findProjectRowRepo: () => null,
      projectMutating: false,
      projectRowDetail: null,
      setGithubProjectTable: () => {},
      setProjectMutating: () => {},
      setProjectRowDetail: () => {},
      setProjectRowDetailError: () => {},
      setProjectRowItem: () => {}
    }
    const model = {
      ...project,
      actionItem,
      client,
      detailPayload: payload,
      setDetailPayload,
      items,
      setItems,
      setActionItem,
      loadTasks,
      mutatingStatus,
      setMutatingStatus,
      error,
      setError,
      expandedPrFilePath,
      setExpandedPrFilePath,
      prFileLoadingPath,
      setPrFileLoadingPath,
      prFileContents,
      setPrFileContents,
      prFileCommentDrafts,
      setPrFileCommentDrafts,
      setDetailRefreshSeq,
      setItemAddAssigneesDraft,
      setItemAddLabelsDraft,
      setItemRemoveAssigneesDraft,
      setItemRemoveLabelsDraft
    }
    return useMobileTasksHostedMetadataActions(
      useMobileTasksGithubCheckFileActions(useMobileTasksProjectFileMergeActions(model))
    )
  }
  function Probe() {
    current = ProbeModel()
    return null
  }
  await act(async () => {
    renderers.push(create(<Probe />))
  })
  return {
    a,
    b,
    client,
    read: () => current,
    select: async (selected: typeof a) => act(async () => select(selected)),
    loadTasks,
    async answer(result: unknown, index = client.requests.length - 1) {
      await act(async () => client.requests[index].resolve(rpcSuccess('reply', result)))
    }
  }
}
it('uses exact old PR metadata, accepted viewed node and review SHA routes without generic preflight, and settles provider errors', async () => {
  const f = await mount()
  let pending!: Promise<void>
  await act(async () => {
    pending = f
      .read()
      .updateGitHubPullRequestMetadata(f.a, { title: 'new title', body: 'new body' })
  })
  expect(f.client.requests.map((request) => request.method)).toEqual(['github.updatePR'])
  expect(f.client.requests[0].args[1]).toMatchObject({
    repo: 'id:clone',
    prNumber: 93,
    prRepo: f.a.source.prRepo,
    updates: { title: 'new title', body: 'new body' }
  })
  await f.answer({ ok: true })
  await pending
  expect(f.read()).toMatchObject({
    actionItem: { title: 'new title' },
    detailPayload: { body: 'new body' },
    mutatingStatus: false
  })
  await act(async () => {
    pending = f.read().toggleGitHubFileViewed(f.a, file)
  })
  expect(f.client.requests.at(-1)).toMatchObject({
    method: 'github.setPRFileViewed',
    args: expect.arrayContaining([
      expect.objectContaining({ pullRequestId: 'PR_fork', prRepo: f.a.source.prRepo })
    ])
  })
  await f.answer(true)
  await pending
  expect(f.read().detailPayload).toMatchObject({ files: [{ viewerViewedState: 'VIEWED' }] })
  await act(async () => {
    pending = f.read().addGitHubFileReviewComment(f.a, file, 1)
  })
  expect(f.client.requests.at(-1)?.args[1]).toMatchObject({
    commitId: 'fork-head',
    prRepo: f.a.source.prRepo,
    path: 'same.ts',
    line: 1
  })
  await f.answer({ ok: false, error: 'provider refused' })
  await pending
  expect(f.read()).toMatchObject({ mutatingStatus: false, error: 'provider refused' })
  expect(f.client.requests.some((request) => request.method === 'status.get')).toBe(false)
})
it('late file contents and finally from A cannot publish into same-number B or release B busy ownership', async () => {
  const f = await mount()
  let old!: Promise<void>
  let live!: Promise<void>
  await act(async () => {
    old = f.read().toggleGitHubFileExpansion(f.a, file)
  })
  expect(f.client.requests[0].args[1]).toMatchObject({
    headSha: 'fork-head',
    baseSha: 'fork-base',
    prRepo: f.a.source.prRepo
  })
  await f.select(f.b)
  await act(async () => {
    live = f.read().toggleGitHubFileExpansion(f.b, file)
  })
  await f.answer({ original: 'A', modified: 'A' }, 0)
  await old
  expect(f.read()).toMatchObject({ prFileContents: {}, prFileLoadingPath: 'same.ts' })
  await f.answer({ original: 'B', modified: 'B' }, 1)
  await live
  expect(f.read()).toMatchObject({
    prFileContents: { 'same.ts': { original: 'B' } },
    prFileLoadingPath: null
  })
})
it('suppresses stale publication after a same-client disconnect/reconnect while preserving the acknowledged write', async () => {
  const f = await mount()
  let pending!: Promise<void>
  await act(async () => {
    pending = f.read().updateGitHubPullRequestMetadata(f.a, { body: 'old invocation' })
  })
  await act(async () => {
    f.client.pushState('reconnecting')
    f.client.pushState('connected')
  })
  await f.answer({ ok: true })
  await pending
  expect(f.read().detailPayload).toMatchObject({ body: 'fork' })
  expect(f.loadTasks).not.toHaveBeenCalled()
  expect(f.client.requests).toHaveLength(1)
})

it('keeps the established old PR state route exact while refusing only an unsupported generic issue action', async () => {
  const f = await mount()
  let pending!: Promise<void>
  await act(async () => {
    pending = f.read().toggleGitHubStatus(f.a)
  })
  expect(f.client.requests[0]).toMatchObject({
    method: 'github.updatePRState',
    args: expect.arrayContaining([
      expect.objectContaining({
        prRepo: f.a.source.prRepo,
        prNumber: 93,
        updates: { state: 'closed' }
      })
    ])
  })
  await f.answer({ ok: true })
  await pending
  expect(f.read().actionItem).toBeNull()
  const issue = {
    ...f.a,
    source: {
      ...f.a.source,
      type: 'issue' as const,
      prRepo: undefined,
      url: 'https://github.corp/fork/widgets/issues/93'
    }
  }
  await f.select(issue)
  await act(async () => {
    pending = f.read().toggleGitHubStatus(issue)
  })
  expect(f.client.requests.at(-1)?.method).toBe('status.get')
  await f.answer({ runtimeId: 'old', capabilities: [] })
  await pending
  expect(f.read()).toMatchObject({
    actionItem: issue,
    mutatingStatus: false,
    error: expect.stringContaining('Update Orca')
  })
  expect(f.client.requests.map((request) => request.method)).toEqual([
    'github.updatePRState',
    'status.get'
  ])
})
