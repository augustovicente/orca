// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type {
  TerminalTabCloseRequest,
  TerminalTabCloseResponse
} from '../../src/shared/terminal-tab-close'
import type { WorkspaceSessionState } from '../../src/shared/workspace-session-state-types'
import { registerMobileAndTerminalCloseIpcBridge } from '@/hooks/ipc-events/mobile-terminal-close-ipc-bridge'
import { mountedOwner } from '@/components/terminal-pane/terminal-presentation-retirement.test-fixture'
import {
  createHarness,
  WORKTREE_ID,
  TAB_ID,
  LEAF_ID,
  PTY_ID
} from '../../src/main/runtime/__fixtures__/orca-runtime-terminal-close-continuity-fixtures'

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
beforeEach(() => {
  localStorage.clear()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it.each([false, true])(
  'persists the actual renderer effects after caught disposal failure before one failed IPC receipt (write fails=%s)',
  async (writeFails) => {
    const harness = createHarness({ registerPtyBacked: true, publishMobileSurface: true })
    const session = harness.getSession()
    useAppStore.setState({
      tabsByWorktree: session.tabsByWorktree,
      terminalLayoutsByTabId: session.terminalLayoutsByTabId
    })
    const source = harness.runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_ID}`, WORKTREE_ID)
    if (!source.presentation || !source.incarnationId) {
      throw new Error('Expected original')
    }
    const { presentation, incarnationId } = source
    const owner = mountedOwner({
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      leafId: LEAF_ID,
      ptyId: PTY_ID
    })
    vi.spyOn(owner.source.terminal, 'dispose').mockImplementation(() => {
      throw new Error('terminal dispose failed')
    })
    let request: ((value: TerminalTabCloseRequest) => void) | undefined
    let rejectReceipt = (_error: Error): void => {}
    const receipt = new Promise<void>((_resolve, reject) => {
      rejectReceipt = reject
    })
    const respond = vi.fn((response: TerminalTabCloseResponse) => {
      rejectReceipt(new Error(response.error ?? 'Unexpected success'))
    })
    const set = vi.fn(async (_state: WorkspaceSessionState) => {
      expect(owner.manager.destroy).toHaveBeenCalledOnce()
      expect(useAppStore.getState().terminalLayoutsByTabId[TAB_ID]).toBeUndefined()
      if (writeFails) {
        throw new Error('persistence failed')
      }
    })
    const flush = vi.fn(async () => {})
    Object.assign(window, {
      api: {
        ...window.api,
        session: { set, flush },
        ui: {
          onOpenFileFromMobile: () => () => {},
          onOpenDiffFromMobile: () => () => {},
          onCloseTerminal: () => () => {},
          onWorkspaceSleep: () => () => {},
          onResumeSleepingAgents: () => () => {},
          onTerminalTabCloseRequest: (listener: (value: TerminalTabCloseRequest) => void) => {
            request = listener
            return () => {}
          },
          respondTerminalTabClose: respond
        }
      }
    })
    const unsubs: (() => void)[] = []
    registerMobileAndTerminalCloseIpcBridge(unsubs, vi.fn())
    if (!request) {
      throw new Error('Expected IPC listener')
    }
    const dispatch = request
    harness.setVerifiedStopResult(true)
    harness.setCloseTerminalTabAction(() => {
      dispatch({
        requestId: 'close',
        tabId: TAB_ID,
        localPtyTeardownOwnedExternally: true,
        originalSurface: presentation.identity
      })
      return receipt
    })
    try {
      await expect(
        harness.runtime.closeTerminal(source.handle, incarnationId, presentation)
      ).rejects.toThrow('terminal_tab_close_failed')
      expect(harness.flushOrThrow).not.toHaveBeenCalled()
      expect(harness.getSession().closedTerminalTabTombstonesByTabId?.[TAB_ID]).toBeUndefined()
      await vi.waitFor(() =>
        expect(respond).toHaveBeenCalledExactlyOnceWith({
          requestId: 'close',
          error: 'terminal_tab_close_failed'
        })
      )
      expect(set).toHaveBeenCalledOnce()
      expect(set.mock.calls[0][0].tabsByWorktree[WORKTREE_ID]).toEqual([])
      expect(flush).toHaveBeenCalledTimes(writeFails ? 0 : 1)
      expect(owner.sourceTransport.detach).toHaveBeenCalledOnce()
    } finally {
      unsubs.forEach((unsubscribe) => unsubscribe())
      owner.unregister()
    }
  }
)
