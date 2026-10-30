// A user's click on a cwd-less gh action may start the stopped default distro its gh lives in (E9);
// work that also runs unprompted (the board table reload) must not.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WslModule from '../wsl'

const { handlers, getDefaultWslDistroMock, ranAsUserAct } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args?: unknown) => unknown>(),
  getDefaultWslDistroMock: vi.fn(),
  // Each stub answers whether it ran inside a user act for the default distro.
  ranAsUserAct: async (): Promise<boolean> =>
    (await import('../wsl/wsl-user-act-scope')).isWslUserActFor('Ubuntu')
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args?: unknown) => unknown) =>
      handlers.set(channel, handler)
  }
}))

vi.mock('../wsl', async (importOriginal) => ({
  ...(await importOriginal<typeof WslModule>()),
  getDefaultWslDistro: getDefaultWslDistroMock
}))

vi.mock('../github/auth-diagnose', () => ({ diagnoseGhAuth: vi.fn(ranAsUserAct) }))

vi.mock('../github/project-view', () => ({
  addIssueCommentBySlug: vi.fn(ranAsUserAct),
  clearProjectItemFieldValue: vi.fn(ranAsUserAct),
  deleteIssueCommentBySlug: vi.fn(ranAsUserAct),
  getProjectViewTable: vi.fn(ranAsUserAct),
  getWorkItemDetailsBySlug: vi.fn(ranAsUserAct),
  listAccessibleProjects: vi.fn(ranAsUserAct),
  listAssignableUsersBySlug: vi.fn(ranAsUserAct),
  listIssueTypesBySlug: vi.fn(ranAsUserAct),
  listLabelsBySlug: vi.fn(ranAsUserAct),
  listProjectViews: vi.fn(ranAsUserAct),
  resolveProjectRef: vi.fn(ranAsUserAct),
  updateIssueBySlug: vi.fn(ranAsUserAct),
  updateIssueCommentBySlug: vi.fn(ranAsUserAct),
  updateIssueTypeBySlug: vi.fn(ranAsUserAct),
  updateProjectItemFieldValue: vi.fn(ranAsUserAct),
  updatePullRequestBySlug: vi.fn(ranAsUserAct)
}))

import { registerGitHubProjectViewHandlers } from './github-project-view-handlers'
import { registerGitHubAccountHandlers } from './github-account-handlers'
import type { Store } from '../persistence'

const originalPlatform = process.platform

beforeEach(() => {
  handlers.clear()
  getDefaultWslDistroMock.mockReset().mockReturnValue('Ubuntu')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  registerGitHubProjectViewHandlers()
  registerGitHubAccountHandlers(unusedStore())
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})

function unusedStore(): Store {
  const store: Partial<Store> = {}
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers invoked here never read the store.
  return store as Store
}

function invoke(channel: string): unknown {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`no handler for ${channel}`)
  }
  return handler({}, {})
}

describe('cwd-less gh clicks run as a user act on the default distro', () => {
  it.each([
    'gh:diagnoseAuth',
    'gh:listAccessibleProjects',
    'gh:resolveProjectRef',
    'gh:listProjectViews',
    'gh:projectWorkItemDetailsBySlug',
    'gh:updateProjectItemField',
    'gh:clearProjectItemField',
    'gh:updateIssueBySlug',
    'gh:updatePullRequestBySlug',
    'gh:addIssueCommentBySlug',
    'gh:updateIssueCommentBySlug',
    'gh:deleteIssueCommentBySlug',
    'gh:updateIssueTypeBySlug'
  ])('%s', async (channel) => {
    await expect(invoke(channel)).resolves.toBe(true)
  })

  it.each([
    'gh:getProjectViewTable',
    'gh:listLabelsBySlug',
    'gh:listAssignableUsersBySlug',
    'gh:listIssueTypesBySlug'
  ])('but not %s, which also loads unprompted', async (channel) => {
    await expect(invoke(channel)).resolves.toBe(false)
  })
})
