// @vitest-environment happy-dom
import React, { act } from 'react'
import type { DiffSectionItem } from '@/components/editor/DiffSectionItem'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { GHCommentComposer as PageComposer } from '@/components/pull-request-page/comments/composer'
import { GHCommentComposer as DialogComposer } from '../discuss-item/gh-comment-composer'
import { PRFilesCombinedDiffViewer } from '@/components/pull-request-page/files/combined-diff-viewer'
import { useGitHubWorkItemDetails } from './use-github-work-item-details'
import {
  invalidateWorkItemDetailsCacheForKey,
  optimisticWorkItemComments,
  touchWorkItemDetailsCache,
  workItemDetailsCache,
  WORK_ITEM_DETAILS_CACHE_MAX
} from './work-item-details-cache'
import type {
  GitHubWorkItem,
  GitHubWorkItemDetails
} from '../../../../../shared/github/work-item-types'
import type { Repo } from '../../../../../shared/repo-types'

const io = vi.hoisted(() => ({
  add: vi.fn(),
  viewed: vi.fn(),
  details: vi.fn(),
  renders: new Map<string, number>()
}))
vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  return {
    useAppStore: create(() => ({ repos: [], settings: {}, recordFeatureInteraction: () => {} }))
  }
})
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/hooks/use-document-dark-theme', () => ({ useDocumentDarkTheme: () => false }))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: () => null
}))
vi.mock('@/components/ui/button', () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: React.ComponentProps<'button'> & { size?: string; variant?: string }) => <button {...props} />
}))
vi.mock('@/components/github/GitHubMarkdownComposer', () => ({
  GitHubMarkdownComposer: ({
    value,
    onChange,
    disabled
  }: {
    value: string
    onChange: (value: string) => void
    disabled: boolean
  }) => (
    <textarea
      value={value}
      disabled={disabled}
      onInput={(event) => onChange(event.currentTarget.value)}
    />
  )
}))
vi.mock('@/components/pull-request-page/mentions/textarea', () => ({
  MentionTextarea: ({
    value,
    onValueChange
  }: {
    value: string
    onValueChange: (value: string) => void
  }) => <textarea value={value} onInput={(event) => onValueChange(event.currentTarget.value)} />
}))
// Replace layout/Monaco I/O only; the production viewer chooses file identity, pending and toggle admission.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    measure: () => {},
    measureElement: () => {},
    getTotalSize: () => count * 80,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 80 })),
    scrollToIndex: () => {}
  })
}))
vi.mock('@/components/editor/DiffSectionItem', () => ({
  DiffSectionItem: ({
    section,
    renderHeaderTrailingContent
  }: React.ComponentProps<typeof DiffSectionItem>) => (
    <div>{renderHeaderTrailingContent?.(section, 0)}</div>
  )
}))
vi.mock('@/components/editor/combined-diff/browse-files/combined-diff-file-tree', () => ({
  CombinedDiffFileTree: () => null
}))
vi.mock('@/components/pull-request-page/files/toolbar', () => ({ PRFilesDiffToolbar: () => null }))
vi.mock('@/components/pull-request-page/files/view-restore', () => ({
  usePRFilesDiffViewPersistence: () => {}
}))
vi.mock('@/components/pull-request-page/files/section-loader', () => ({
  usePRFileSectionLoader: () => ({
    loadSection: () => {},
    retrySection: () => {},
    toggleSection: () => {},
    setAllSectionsCollapsed: () => {}
  })
}))

const repository = { owner: 'fork', repo: 'widgets', host: 'github.corp' }
function item(owner = 'fork'): GitHubWorkItem {
  return {
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
    prRepo: { ...repository, owner }
  }
}
function full(opened: GitHubWorkItem): GitHubWorkItemDetails {
  return {
    item: opened,
    body: opened.title,
    comments: [],
    assignees: [],
    files: [
      {
        path: 'same.ts',
        additions: 1,
        deletions: 0,
        status: 'modified',
        viewerViewedState: 'UNVIEWED'
      }
    ],
    checks: [],
    pullRequestId: `PR_${opened.title}`,
    headSha: 'head',
    baseSha: 'base'
  }
}
function row(user = 'A'): Repo {
  return {
    id: 'clone',
    path: '/clone',
    displayName: 'clone',
    badgeColor: '',
    addedAt: 0,
    ghAccount: { host: 'github.corp', user }
  }
}
function account(user: string) {
  useAppStore.setState({ repos: [row(user)] })
}
let root: ReturnType<typeof createRoot>
let container: HTMLDivElement
const views = new Map<string, ReturnType<typeof useGitHubWorkItemDetails>>()
function Surface({
  name,
  opened,
  composer,
  files = false
}: {
  name: string
  opened: GitHubWorkItem
  composer?: 'page' | 'dialog'
  files?: boolean
}) {
  const view = useGitHubWorkItemDetails({
    workItem: opened,
    repoPath: '/clone',
    effectiveRepoId: 'clone'
  })
  views.set(name, view)
  io.renders.set(name, (io.renders.get(name) ?? 0) + 1)
  const Composer = composer === 'page' ? PageComposer : DialogComposer
  return (
    <section data-name={name}>
      <output>{view.details?.comments.map((comment) => comment.body).join(',')}</output>
      {composer && (
        <Composer
          key={`${opened.url}:${composer}`}
          repoPath="/clone"
          repoId="clone"
          issueNumber={93}
          itemType="pr"
          prRepo={opened.prRepo}
          mentionOptions={[]}
          onCommentAdded={view.appendOptimisticComment}
        />
      )}
      {files && (
        <PRFilesCombinedDiffViewer
          files={view.details?.files ?? []}
          comments={[]}
          repoId="clone"
          repoPath="/clone"
          prNumber={93}
          prRepo={opened.prRepo}
          prUrl={opened.url}
          headSha="head"
          baseSha="base"
          pendingViewedPaths={view.pendingViewedPaths}
          onViewedChange={view.handlePRFileViewedChange}
          onCommentAdded={view.appendOptimisticComment}
        />
      )}
    </section>
  )
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function checkbox(): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>('[role="checkbox"]')
  if (!element) {
    throw new Error('missing rendered Viewed control')
  }
  return element
}
async function submit() {
  const input = container.querySelector('textarea')
  if (!input) {
    throw new Error('missing real composer input')
  }
  await act(async () => {
    input.value = 'confirmed origin'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const button = container.querySelector<HTMLButtonElement>('[aria-label="Send comment"]')
  if (!button || button.disabled) {
    throw new Error('composer cannot submit')
  }
  await act(async () => button.click())
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
  workItemDetailsCache.clear()
  optimisticWorkItemComments.clear()
  views.clear()
  io.renders.clear()
  account('A')
  io.add.mockReset()
  io.viewed.mockReset()
  io.details.mockReset().mockImplementation(async (args) => full(item(args.ownerRepo.owner)))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      gh: {
        workItemDetails: io.details,
        addIssueComment: io.add,
        setPRFileViewed: io.viewed,
        notifyWorkItemMutated: async () => true
      }
    }
  })
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
})

it.each(['page', 'dialog'] as const)(
  'real %s composer delivers deferred local success after close/switch, bounded eviction and in-flight origin refresh',
  async (composer) => {
    const answer = deferred<Awaited<ReturnType<typeof window.api.gh.addIssueComment>>>()
    io.add.mockReturnValueOnce(answer.promise)
    await act(async () =>
      root.render(
        <>
          <Surface name="A" opened={item()} composer={composer} />
          <Surface name="observer" opened={item()} />
        </>
      )
    )
    const originKey = views.get('A')!.detailsCacheKey!
    await submit()
    expect(io.add).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: 'clone', prRepo: repository, body: 'confirmed origin' })
    )
    // Closing the composing view unmounts it; the concurrent origin observer remains.
    await act(async () =>
      root.render(
        <>
          <Surface name="B" opened={item('upstream')} />
          <Surface name="observer" opened={item()} />
        </>
      )
    )
    const pending = deferred<GitHubWorkItemDetails | null>()
    await act(async () =>
      touchWorkItemDetailsCache(originKey, {
        ...workItemDetailsCache.get(originKey)!,
        pending: pending.promise
      })
    )
    const beforeB = io.renders.get('B')
    const comment = { id: 9001, body: 'confirmed origin', author: 'me', createdAt: '' }
    await act(async () => answer.resolve({ ok: true, comment }))
    expect(workItemDetailsCache.get(originKey)?.pending).toBe(pending.promise)
    expect(container.querySelector('[data-name="observer"] output')?.textContent).toBe(
      'confirmed origin'
    )
    expect(container.querySelector('[data-name="B"] output')?.textContent).toBe('')
    expect(io.renders.get('B')).toBe(beforeB)
    await act(async () =>
      root.render(<Surface name="reopen" opened={item()} composer={composer} />)
    )
    expect(container.querySelector('output')?.textContent).toBe('confirmed origin')
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Send comment"]')?.disabled
    ).toBe(true)
    // A second actual submit settles after its origin has been evicted; no optimistic-only orphan is created.
    const late = deferred<Awaited<ReturnType<typeof window.api.gh.addIssueComment>>>()
    io.add.mockReturnValueOnce(late.promise)
    await submit()
    await act(async () => root.render(<Surface name="B" opened={item('upstream')} />))
    await act(async () => {
      for (let index = 0; index < WORK_ITEM_DETAILS_CACHE_MAX + 1; index++) {
        touchWorkItemDetailsCache(`eviction-${index}`, { details: null, fetchedAt: 0 })
      }
    })
    expect(workItemDetailsCache.has(originKey)).toBe(false)
    await act(async () => late.resolve({ ok: true, comment }))
    expect(workItemDetailsCache.size).toBeLessThanOrEqual(WORK_ITEM_DETAILS_CACHE_MAX)
    expect(workItemDetailsCache.get(originKey)?.details).toBeNull()
    expect(optimisticWorkItemComments.get(originKey)).toEqual([comment])
    await act(async () =>
      root.render(<Surface name="reopen" opened={item()} composer={composer} />)
    )
    expect(container.querySelector('output')?.textContent).toBe('confirmed origin')
  }
)
it.each(['page', 'dialog'] as const)(
  'real %s composer does not append false/throw, releases live submit and permits explicit retry',
  async (composer) => {
    await act(async () => root.render(<Surface name="A" opened={item()} composer={composer} />))
    io.add.mockResolvedValueOnce({ ok: false, error: 'denied' })
    await submit()
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Send comment"]')?.disabled
    ).toBe(false)
    expect(container.querySelector('output')?.textContent).toBe('')
    io.add.mockRejectedValueOnce(new Error('transport closed'))
    await submit()
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Send comment"]')?.disabled
    ).toBe(false)
    io.add.mockResolvedValueOnce({
      ok: true,
      comment: { id: 2, body: 'retry', author: 'me', createdAt: '' }
    })
    await submit()
    expect(container.querySelector('output')?.textContent).toBe('retry')
  }
)
it.each(['success', 'false', 'throw'] as const)(
  'real Viewed account A-B-A drains origin pending off-current on %s and permits a fresh press',
  async (outcome) => {
    const answer = deferred<boolean>()
    io.viewed.mockReturnValueOnce(answer.promise)
    await act(async () => root.render(<Surface name="files" opened={item()} files />))
    const aKey = views.get('files')!.detailsCacheKey!
    await act(async () => checkbox().click())
    expect(checkbox().disabled).toBe(true)
    expect(io.viewed).toHaveBeenCalledWith(
      expect.objectContaining({ prRepo: repository, pullRequestId: 'PR_fork', path: 'same.ts' })
    )
    await act(async () => account('B'))
    expect(views.get('files')!.detailsCacheKey).not.toBe(aKey)
    const before = io.renders.get('files')
    await act(async () =>
      outcome === 'throw'
        ? answer.reject(new Error('failed'))
        : answer.resolve(outcome === 'success')
    )
    expect(io.renders.get('files')).toBe(before)
    await act(async () => account('A'))
    expect(checkbox().disabled).toBe(false)
    expect(checkbox().getAttribute('aria-checked')).toBe(outcome === 'success' ? 'true' : 'false')
    io.viewed.mockResolvedValueOnce(true)
    await act(async () => checkbox().click())
    expect(checkbox().disabled).toBe(false)
    expect(io.viewed).toHaveBeenCalledTimes(2)
  }
)
it('production invalidation creates a same-key Viewed successor immune to old false rollback and release', async () => {
  const old = deferred<boolean>()
  const fresh = deferred<boolean>()
  io.viewed.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
  await act(async () => root.render(<Surface name="files" opened={item()} files />))
  await act(async () => checkbox().click())
  const key = views.get('files')!.detailsCacheKey!
  await act(async () => invalidateWorkItemDetailsCacheForKey(key))
  expect(checkbox().disabled).toBe(false)
  await act(async () => checkbox().click())
  expect(checkbox().disabled).toBe(true)
  await act(async () => old.resolve(false))
  expect(checkbox().disabled).toBe(true)
  expect(checkbox().getAttribute('aria-checked')).toBe('true')
  await act(async () => fresh.resolve(true))
  expect(checkbox().disabled).toBe(false)
})
