import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  StructuredSessionOpenSource,
  StructuredSessionOpenResult
} from '../../../src/shared/open-structured-agent-session'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { useMobileStructuredSessionOpening } from './use-mobile-structured-session-opening'
const mocks = vi.hoisted(() => ({ executionHost: 'local', open: vi.fn(), push: vi.fn() }))
vi.mock('../navigation/workspace-execution-host', () => ({
  useWorkspaceExecutionHost: () => mocks.executionHost
}))
vi.mock('../navigation/workspace-route-handoff', () => ({
  useWorkspaceRouteHandoff: () => ({ push: mocks.push })
}))
vi.mock('./open-mobile-structured-session', async (original) => ({
  ...(await original<typeof import('./open-mobile-structured-session')>()),
  openMobileStructuredSession: mocks.open
}))
const source: StructuredSessionOpenSource = {
  kind: 'notification',
  sessionId: 'root',
  worktreeId: 'workspace'
}
const opened: StructuredSessionOpenResult = {
  kind: 'opened',
  target: { sessionId: 'live', worktreeId: 'workspace' },
  tab: { id: 'actual', sessionId: 'live', agent: 'codex' }
}
afterEach(() => vi.clearAllMocks())
it.each(['stable', 'newer-pick', 'execution-host', 'unmount'] as const)(
  'only the owning phone view applies completion: %s',
  async (mode) => {
    mocks.executionHost = 'local'
    const deferred = Promise.withResolvers<StructuredSessionOpenResult>()
    mocks.open.mockReturnValue(deferred.promise)
    const selected = { current: 'source' }
    const pending = { current: null }
    const switchSessionTab = vi.fn()
    const scope: Parameters<typeof useMobileStructuredSessionOpening>[0] = {
      hostId: 'host',
      worktreeId: 'workspace',
      client: createFakeRpcClient(),
      connState: 'connected',
      showToast: vi.fn(),
      switchSessionTab,
      activeSessionTabIdRef: { current: 'source' },
      selectedSessionTabIdRef: selected,
      pendingSelectionRef: pending,
      sessionTabsRef: {
        current: [
          {
            type: 'terminal',
            id: 'source',
            title: 'Source',
            terminal: 'terminal-source',
            isActive: true
          }
        ]
      }
    }
    let open: ((source: StructuredSessionOpenSource) => Promise<void>) | undefined
    function Probe() {
      open = useMobileStructuredSessionOpening(scope)
      return null
    }
    let tree: ReactTestRenderer | undefined
    await act(async () => {
      tree = create(createElement(Probe))
    })
    try {
      let completion: Promise<void> | undefined
      await act(async () => {
        completion = open?.(source)
      })
      if (mode === 'newer-pick') {
        selected.current = 'newer-user-pick'
      }
      if (mode === 'execution-host') {
        mocks.executionHost = 'ssh:another'
        await act(async () => tree?.update(createElement(Probe)))
      }
      if (mode === 'unmount') {
        await act(async () => tree?.unmount())
      }
      await act(async () => {
        deferred.resolve(opened)
        await completion
      })
      expect(switchSessionTab).toHaveBeenCalledTimes(mode === 'stable' ? 1 : 0)
      if (mode === 'stable') {
        expect(switchSessionTab).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'actual', sessionId: 'live' }),
          { activate: false }
        )
      }
    } finally {
      await act(async () => tree?.unmount())
    }
  }
)
