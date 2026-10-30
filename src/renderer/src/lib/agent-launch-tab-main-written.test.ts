import {
  beginViewerSelectionRequest,
  disposeViewerSelection,
  viewerSelectionOutcome
} from './viewer-selection-request'
import { agentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'
import { noteUserWorkspaceSwitch } from './workspace-switch-user-act'
import { _resetLayoutFramePositionForTests } from '@/runtime/layout-frame-position'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { AgentLaunchTabPublishRequest } from '../../../shared/agent-launch-tab-publication'
import { createTabsSliceMockApi } from '../store/slices/tabs-slice-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentStatusModule>()),
  detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
}))

const testStore = vi.hoisted(() => {
  const ref: { current: ReturnType<typeof createTestStore> | null } = { current: null }
  return ref
})
vi.mock('@/store', () => {
  const current = () => {
    if (!testStore.current) {
      throw new Error('no test store')
    }
    return testStore.current
  }
  return {
    useAppStore: {
      getState: () => current().getState(),
      setState: (...args: Parameters<ReturnType<typeof createTestStore>['setState']>) =>
        current().setState(...args),
      subscribe: (listener: () => void) => current().subscribe(listener)
    }
  }
})
const focusTerminalInitiatedTab = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/ipc-events/terminal-command-state', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  focusTerminalInitiatedTab
}))

const frames = vi.hoisted(() => ({ flowing: false, holdsTab: true }))
vi.mock('@/runtime/layout-frame-position', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  layoutFramesFlowing: () => frames.flowing
}))
vi.mock('@/runtime/layout-frame-terminal-panes', () => ({
  layoutFrameTerminalTab: () => (frames.holdsTab ? { id: 'main-tab' } : undefined)
}))
const revealWorkspaceSurface = vi.hoisted(() => vi.fn())
vi.mock('./workspace-surface-reveal', () => ({ revealWorkspaceSurface }))

createTabsSliceMockApi()

const { keepAgentLaunchTabMainWrote, _resetUndrawnLaunchTabsForTests } =
  await import('./agent-launch-tab-main-written')
const { applyAgentLaunchPaneVerdict } = await import('./agent-launch-pane-verdict-application')
const { agentLaunchPanePrompt } = await import('./agent-launch-pane-prompt')

const WT = 'repo1::/tmp/feature'
const TAB_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const LEAF_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

let store: ReturnType<typeof createTestStore>

function request(
  overrides: Partial<AgentLaunchTabPublishRequest> = {}
): AgentLaunchTabPublishRequest {
  return {
    requestId: 'request-1',
    worktreeId: WT,
    tabId: TAB_ID,
    leafId: LEAF_ID,
    launchAgent: 'claude',
    viewMode: 'terminal',
    viewer: 'none',
    operationId: 'op-1',
    shownByMain: { frameSeq: 3, created: true },
    ...overrides
  }
}

function drawMainTab(): void {
  store.getState().createTab(WT, undefined, undefined, {
    id: TAB_ID,
    initialLeafId: LEAF_ID,
    activate: false
  })
}

const launchPane = () =>
  store.getState().tabsByWorktree[WT]?.find((tab) => tab.id === TAB_ID)?.agentLaunchPane

beforeEach(() => {
  _resetLayoutFramePositionForTests()
  store = createTestStore()
  testStore.current = store
  focusTerminalInitiatedTab.mockClear()
  store.getState().setActiveWorktree(WT)
})
afterEach(() => {
  disposeViewerSelection()
  _resetUndrawnLaunchTabsForTests()
  frames.flowing = false
  frames.holdsTab = true
  revealWorkspaceSurface.mockClear()
})

describe("a launch tab main wrote, in a layout-owner build's window", () => {
  it('keeps the launch pane and prompt on the tab main drew, and makes no tab', () => {
    drawMainTab()

    const kept = keepAgentLaunchTabMainWrote(request({ prompt: 'fix the build' }))

    expect(kept).toMatchObject({ tabId: TAB_ID, created: true })
    expect(store.getState().tabsByWorktree[WT]).toHaveLength(1)
    expect(launchPane()).toEqual({ leafId: LEAF_ID, operationId: 'op-1' })
    expect(agentLaunchPanePrompt(TAB_ID)).toBe('fix the build')
  })

  it('moves the view as the viewer rule says, only for the launch that made the tab', () => {
    drawMainTab()
    keepAgentLaunchTabMainWrote(
      request({ viewer: 'focus-in-workspace', shownByMain: { created: false } })
    )
    expect(focusTerminalInitiatedTab).not.toHaveBeenCalled()

    keepAgentLaunchTabMainWrote(request({ requestId: 'r-2', viewer: 'focus-in-workspace' }))
    expect(store.getState().activeTabId).toBe(TAB_ID)
    expect(focusTerminalInitiatedTab).toHaveBeenCalledWith(TAB_ID, LEAF_ID, WT)
  })

  it('shows the outcome the pane got on the tab main drew', () => {
    drawMainTab()
    keepAgentLaunchTabMainWrote(request())

    applyAgentLaunchPaneVerdict({
      worktreeId: WT,
      tabId: TAB_ID,
      leafId: LEAF_ID,
      operationId: 'op-1',
      verdict: { kind: 'not-started', code: 'boom' }
    })

    expect(launchPane()).toEqual({
      leafId: LEAF_ID,
      operationId: 'op-1',
      outcome: { kind: 'not-started', code: 'boom' }
    })
  })

  it('keeps the launch, and an outcome that came first, for a tab that draws later', () => {
    keepAgentLaunchTabMainWrote(request())
    applyAgentLaunchPaneVerdict({
      worktreeId: WT,
      tabId: TAB_ID,
      leafId: LEAF_ID,
      operationId: 'op-1',
      verdict: { kind: 'unconfirmed' }
    })

    drawMainTab()

    expect(launchPane()).toEqual({
      leafId: LEAF_ID,
      operationId: 'op-1',
      outcome: { kind: 'unconfirmed' }
    })
  })

  it('drops a settled launch of a tab that draws later', () => {
    keepAgentLaunchTabMainWrote(request({ prompt: 'fix the build' }))
    applyAgentLaunchPaneVerdict({
      worktreeId: WT,
      tabId: TAB_ID,
      leafId: LEAF_ID,
      operationId: 'op-1',
      verdict: { kind: 'proceed' }
    })

    drawMainTab()

    expect(launchPane()).toBeUndefined()
    expect(agentLaunchPanePrompt(TAB_ID)).toBeNull()
  })

  it('leaves the close of a withdrawn tab to main, and drops what it kept', () => {
    drawMainTab()
    keepAgentLaunchTabMainWrote(request({ prompt: 'fix the build' }))

    applyAgentLaunchPaneVerdict({
      worktreeId: WT,
      tabId: TAB_ID,
      leafId: LEAF_ID,
      operationId: 'op-1',
      verdict: { kind: 'withdrawn' }
    })

    expect(store.getState().tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([TAB_ID])
    expect(launchPane()).toBeUndefined()
    expect(agentLaunchPanePrompt(TAB_ID)).toBeNull()
  })

  it('drops a held launch once main closed its tab, never drawn', () => {
    frames.flowing = true
    keepAgentLaunchTabMainWrote(request({ prompt: 'fix the build' }))
    frames.holdsTab = false

    store.setState({})
    expect(agentLaunchPanePrompt(TAB_ID)).toBeNull()
    frames.holdsTab = true
    drawMainTab()
    expect(launchPane()).toBeUndefined()
  })

  it('holds nothing and reveals nothing for a tab main already closed', () => {
    frames.flowing = true
    frames.holdsTab = false

    keepAgentLaunchTabMainWrote(request({ viewer: 'focus-window', prompt: 'fix the build' }))

    expect(revealWorkspaceSurface).not.toHaveBeenCalled()
    expect(agentLaunchPanePrompt(TAB_ID)).toBeNull()
  })
})

it.each([false, true])(
  'the actual undrawn callback fulfils once, preserving a newer user choice=%s',
  (navigate) => {
    const other = store.getState().createTab(WT)
    const deadline = agentSessionSwitchDeadline(Date.now)
    try {
      const older = beginViewerSelectionRequest('older-dialog', deadline)
      const selection = beginViewerSelectionRequest('accepted-action', deadline)
      selection.accept()
      older.accept()
      expect(viewerSelectionOutcome(selection.token)).toBe('pending')
      keepAgentLaunchTabMainWrote(
        request({
          viewer: 'focus-window',
          openPlacement: {
            invocationId: 'accepted-action',
            generation: 'op-1',
            placement: {},
            activate: true,
            viewerSelection: selection.token
          }
        })
      )
      expect(viewerSelectionOutcome(selection.token)).toBe('pending')
      expect(revealWorkspaceSurface).not.toHaveBeenCalled()
      if (navigate) {
        noteUserWorkspaceSwitch(WT)
        store
          .getState()
          .activateTab(
            store.getState().unifiedTabsByWorktree[WT].find((tab) => tab.entityId === other.id)!.id
          )
      }
      drawMainTab()
      expect(viewerSelectionOutcome(selection.token)).toBe(navigate ? 'superseded' : 'fulfilled')
      expect(store.getState().getActiveTab(WT)?.entityId).toBe(navigate ? other.id : TAB_ID)
      const focusCount = focusTerminalInitiatedTab.mock.calls.length
      keepAgentLaunchTabMainWrote(
        request({
          viewer: 'focus-window',
          openPlacement: {
            invocationId: 'accepted-action',
            generation: 'op-1',
            placement: {},
            activate: true,
            viewerSelection: selection.token
          }
        })
      )
      expect(focusTerminalInitiatedTab).toHaveBeenCalledTimes(focusCount)
    } finally {
      deadline.dispose()
    }
  }
)
