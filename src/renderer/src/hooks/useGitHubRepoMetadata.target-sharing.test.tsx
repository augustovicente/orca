// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useRepoAssignees, useRepoLabels } from './useGitHubRepoMetadata'
import { GitHubWorkItemTargetContext } from '@/components/github-item-dialog/load-item-details/github-work-item-target-context'
import { listAssignableUsers, listLabels } from '../../../main/github/issue-field-options'
import { create } from 'zustand'

const provider = vi.hoisted(() => ({ exec: vi.fn(), pages: 0 }))
const metadataStore = create(() => ({
  unrelated: 0,
  repos: [
    { id: 'shared', path: '/shared', ghAccount: 'account-a' },
    { id: 'other', path: '/other', ghAccount: 'account-a' }
  ]
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (...args: Parameters<typeof metadataStore>) => metadataStore(...args),
    { getState: () => metadataStore.getState() }
  )
}))
vi.mock('../../../main/github/gh-utils', () => ({
  acquire: vi.fn(),
  release: vi.fn(),
  ghExecFileAsync: provider.exec
}))
vi.mock('../../../main/github/github-api-repository', () => ({
  resolveGitHubRepoExecution: async (
    _path: string,
    ownerRepo: object,
    _connection: unknown,
    options: object
  ) => ({ ownerRepo, ghOptions: options })
}))
const roots: ReturnType<typeof createRoot>[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount())
  }
  vi.unstubAllGlobals()
})

it.each([10, 100])(
  'shares production repository lists across %i addressed items, with scope and render isolation',
  async (count) => {
    provider.pages = 0
    provider.exec.mockReset().mockImplementation(async (args: string[]) => {
      // Real list implementations invoke gh --paginate once; model a two-page provider response.
      expect(args).toContain('--paginate')
      provider.pages += 2
      return {
        stdout: args.some((arg) => arg.includes('/assignees'))
          ? '{"login":"one"}\n{"login":"two"}'
          : 'one\ntwo'
      }
    })
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const api = {
      listLabels: vi.fn((args) => listLabels(args.repoPath, 'origin', null, {}, args.ownerRepo)),
      listAssignableUsers: vi.fn((args) =>
        listAssignableUsers(args.repoPath, 'origin', null, {}, args.ownerRepo)
      )
    }
    Object.defineProperty(window, 'api', { configurable: true, value: { gh: api } })
    const renders = new Map<string, number>()
    function Lists({ repoId }: { repoId: string }) {
      renders.set(repoId, (renders.get(repoId) ?? 0) + 1)
      const labels = useRepoLabels(`/${repoId}`, repoId)
      const users = useRepoAssignees(`/${repoId}`, repoId)
      return (
        <span>
          {labels.data.join(',')}:{users.data.map((user) => user.login).join(',')}
        </span>
      )
    }
    const host = `github-${count}.corp`
    const entries = Array.from({ length: count }, (_, index) => ({
      resource: {
        repository: { owner: 'fork', repo: 'widgets', host },
        type: index % 2 ? ('pr' as const) : ('issue' as const),
        number: index + 1
      },
      target: { kind: 'local' as const }
    }))
    const other = otherRepositoryTarget(entries[0])
    const root = createRoot(document.createElement('div'))
    roots.push(root)
    await act(async () =>
      root.render(
        <>
          {entries.map((bound, index) => (
            <GitHubWorkItemTargetContext.Provider key={index} value={bound}>
              <Lists repoId="shared" />
            </GitHubWorkItemTargetContext.Provider>
          ))}
          <GitHubWorkItemTargetContext.Provider value={other}>
            <Lists repoId="other" />
          </GitHubWorkItemTargetContext.Provider>
        </>
      )
    )
    expect(api.listLabels).toHaveBeenCalledTimes(2)
    expect(api.listAssignableUsers).toHaveBeenCalledTimes(2)
    expect(provider.pages).toBe(8)
    const before = new Map(renders)
    await act(async () => metadataStore.setState({ unrelated: 1 }))
    expect(renders).toEqual(before)
    await act(async () =>
      metadataStore.setState((state) => ({
        repos: state.repos.map((repo) =>
          repo.id === 'shared' ? { ...repo, ghAccount: `account-${count}` } : repo
        )
      }))
    )
    expect(api.listLabels).toHaveBeenCalledTimes(3)
    expect(api.listAssignableUsers).toHaveBeenCalledTimes(3)
    expect(provider.pages).toBe(12)
    expect(renders.get('other')).toBe(before.get('other'))
    expect(renders.get('shared')).toBeGreaterThan(before.get('shared')!)
    // Reopening many same-repo items consumes the warm lists, regardless of kind/number.
    const extra = createRoot(document.createElement('div'))
    roots.push(extra)
    await act(async () =>
      extra.render(
        <GitHubWorkItemTargetContext.Provider value={entries[0]}>
          <Lists repoId="shared" />
        </GitHubWorkItemTargetContext.Provider>
      )
    )
    expect(api.listLabels).toHaveBeenCalledTimes(3)
    expect(api.listAssignableUsers).toHaveBeenCalledTimes(3)
  }
)

function otherRepositoryTarget(
  bound: NonNullable<React.ContextType<typeof GitHubWorkItemTargetContext>>
) {
  return {
    ...bound,
    resource: { ...bound.resource, repository: { ...bound.resource.repository, owner: 'other' } }
  }
}
