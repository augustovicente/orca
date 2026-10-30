import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { flushAsyncTicks } from './pty-connection-test-async'
import { sendTerminalInputThroughPane } from './pty-connection-test-dom'
import {
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import { connectMockPanePty } from './pty-connection-test-connect-mock-pane'

const takeover = vi.hoisted(() => ({ report: vi.fn() }))
vi.mock('@/lib/worker-terminal-takeover-report', () => ({
  reportWorkerTerminalUserInput: takeover.report
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  transportFactoryQueue = []
  mockStoreState = createInitialStoreState(() => mockStoreState)
  let storeSubscribers: ((state: StoreState) => void)[] = []
  bindPtyConnectionTestMocks({
    getState: () => mockStoreState,
    getTransportQueue: () => transportFactoryQueue,
    getTransportOptions: () => [],
    getStoreSubscribers: () => storeSubscribers,
    setStoreSubscribers: (subscribers) => {
      storeSubscribers = subscribers
    }
  })
  await installTerminalTestGlobals()
})

afterEach(async () => {
  await restoreTerminalTestGlobals()
})

it('takes a worker over on a typed key, never on the mouse moving over its terminal', async () => {
  // Regression: agents enable any-motion mouse tracking, so hovering a visible worker made xterm's user-input reports and kept the worker as the user's.
  transportFactoryQueue.push(createMockTransport('pty-worker'))
  const pane = createPane(1)
  const userInputListeners = new Set<() => void>()
  ;(pane.terminal as unknown as { _core: unknown })._core = {
    coreService: {
      onUserInput: vi.fn((listener: () => void) => {
        userInputListeners.add(listener)
        return { dispose: () => userInputListeners.delete(listener) }
      })
    }
  }
  await connectMockPanePty(
    pane,
    createManager(1),
    buildPaneConnectionDeps(() => mockStoreState)
  )
  await flushAsyncTicks()
  const sendUserInput = (data: string): void => {
    for (const listener of userInputListeners) {
      listener()
    }
    sendTerminalInputThroughPane(pane, data)
  }

  sendUserInput('\x1b[<35;7;6M')
  sendUserInput('\x1b[<64;7;6M')
  await flushAsyncTicks()
  expect(takeover.report).not.toHaveBeenCalled()

  sendUserInput('x')
  await flushAsyncTicks()
  expect(takeover.report).toHaveBeenCalledTimes(1)
})
