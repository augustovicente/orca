// @vitest-environment happy-dom
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTabsSliceMockApi } from '../store/slices/tabs-slice-test-harness'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type * as SessionOwner from '@/runtime/structured-agent-session-owner'
import { useAppStore } from '@/store'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../shared/structured-agent-session-reducer'
import { runConversationSwitch, runNativeChatCliSwitch } from './conversation-surface-switch'
import { pendingNativeChatCliSwitches } from './pending-conversation-surface-switches'
const mocks = vi.hoisted(() => {
  function makeTarget(): { current: RuntimeClientTarget } {
    return { current: { kind: 'local' } }
  }
  return {
    target: makeTarget(),
    support: vi.fn(),
    rpc: vi.fn(),
    capture: vi.fn(),
    prepare: vi.fn(),
    pairedRefresh: vi.fn(),
    call: vi.fn(),
    legacy: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    error: vi.fn(),
    info: vi.fn(),
    reader: vi.fn(),
    listeners: new Set<() => void>(),
    subscribe: (listener: () => void) => {
      mocks.listeners.add(listener)
      return () => mocks.listeners.delete(listener)
    }
  }
})
vi.mock('sonner', () => ({ toast: { error: mocks.error, info: mocks.info } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  supportsInPlaceSwitch: mocks.support,
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/structured-agent-session-owner', async (original) => ({
  ...(await original<typeof SessionOwner>()),
  structuredAgentSessionTargetForHost: () => mocks.target.current
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<object>()),
  callRuntimeRpc: mocks.rpc
}))
vi.mock('@/components/tab-bar/cli-chat-resume-terminal-capture', () => ({
  captureSourceTerminal: mocks.capture
}))
vi.mock('./ai-vault-session-resume-preparation', () => ({
  prepareAiVaultSessionForResume: mocks.prepare
}))
vi.mock('@/runtime/web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: mocks.pairedRefresh
}))
vi.mock('./in-place-switch-support', () => ({
  useInPlaceSwitchCapability: () => true
}))
vi.mock('@/runtime/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: () => ({
    subscribe: mocks.subscribe,
    getSnapshot: () => new Map()
  })
}))
vi.mock('@/components/native-chat/structured-agent-session-read-owner-registry', () => ({
  findStructuredAgentSessionReadOwner: mocks.reader
}))
vi.mock('@/components/tab-bar/cli-chat-resume-run', () => ({
  runLegacyCliChatResume: mocks.legacy
}))
vi.mock('@/components/tab-bar/native-chat-cli-switch-run', () => ({
  runLegacyNativeChatCliSwitch: mocks.legacy
}))
vi.mock('@/components/tab-bar/cli-chat-resume-feedback', () => ({
  switchIntoOwnerLegacy: mocks.legacy
}))
vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionWorktreeTabs: mocks.refresh
}))
vi.mock('@/components/right-sidebar/ai-vault-session-resume-in-chat-launch', () => ({
  resumeAiVaultSessionInNewChat: mocks.legacy,
  adoptingAgentOnHost: async (agent: string) => agent
}))

const subject = {
  direction: 'terminal' as const,
  executionHostId: 'local',
  workspaceId: 'workspace',
  sessionId: 'codex_chat',
  agent: 'codex' as const,
  chatTabId: 'source'
}
beforeEach(() => {
  vi.clearAllMocks()
  createTabsSliceMockApi()
  mocks.target.current = { kind: 'local' }
  mocks.rpc.mockResolvedValue({})
  mocks.pairedRefresh.mockResolvedValue(undefined)
  mocks.capture.mockResolvedValue({
    handle: 'terminal-source',
    incarnationId: 'incarnation',
    presentation: {}
  })
  mocks.reader.mockReturnValue(undefined)
  mocks.support.mockResolvedValue(true)
  mocks.call.mockResolvedValue({ status: 'completed', sessionId: subject.sessionId })
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings!, experimentalNativeChat: true }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  pendingNativeChatCliSwitches.clear()
})
it('reserves pending before negotiation, sends one execution request and leaves all launching to the host', async () => {
  const negotiation = Promise.withResolvers<boolean>()
  mocks.support.mockReturnValue(negotiation.promise)
  const first = runConversationSwitch(subject)
  expect(await runConversationSwitch(subject)).toBe(false)
  negotiation.resolve(true)
  expect(await first).toBe(true)
  expect(mocks.support).toHaveBeenCalledOnce()
  expect(mocks.call).toHaveBeenCalledWith(
    { kind: 'local' },
    'agentSession.switchToTerminal',
    expect.objectContaining({
      sessionId: subject.sessionId,
      execution: expect.objectContaining({ sourceTabId: 'source' })
    }),
    expect.objectContaining({ signal: expect.any(AbortSignal), beforeSend: expect.any(Function) })
  )
  expect(mocks.legacy).not.toHaveBeenCalled()
  expect(pendingNativeChatCliSwitches.size).toBe(0)
})
it('formats real refusal categories once, with agent and next step, never raw errors or platform-wrong job control', async () => {
  mocks.call.mockRejectedValue(new Error('secret raw transport/provider failure'))
  await runConversationSwitch({ ...subject, direction: 'chat' })
  expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
    'Codex could not start in chat. Check its setup and try again.'
  )
})

it.each([false, true])(
  'asks once for a live reply; consent=%s has only the authorized effects',
  async (yes) => {
    mocks.reader.mockReturnValue({
      getSnapshot: () => ({
        current: true,
        state: {
          ...EMPTY_STRUCTURED_AGENT_SESSION,
          working: true,
          latestTurn: { itemId: 'turn', observedAt: 1, turn: { turnId: 'turn', state: 'running' } }
        }
      })
    })
    const answer = Promise.withResolvers<boolean>()
    const confirm = vi.fn(() => answer.promise)
    const first = runConversationSwitch({ ...subject, confirm })
    expect(await runConversationSwitch({ ...subject, confirm })).toBe(false)
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    expect(confirm).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: 'Codex is replying. Stop it and switch?',
        compact: true
      })
    )
    expect(mocks.support).toHaveBeenCalledOnce()
    expect(mocks.call).not.toHaveBeenCalled()
    answer.resolve(yes)
    expect(await first).toBe(yes)
    expect(mocks.call).toHaveBeenCalledTimes(yes ? 1 : 0)
    expect(mocks.refresh).toHaveBeenCalledTimes(yes ? 1 : 0)
  }
)

it.each(['codex'] as const)(
  'dispatches idle %s once through the common host command, preserving configured commands',
  async (agent) => {
    const confirm = vi.fn()
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        agentCmdOverrides: { [agent]: 'my-alias --option' }
      }
    })
    expect(await runConversationSwitch({ ...subject, agent, confirm })).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith(
      { kind: 'local' },
      'agentSession.switchToTerminal',
      expect.objectContaining({
        sessionId: subject.sessionId,
        execution: expect.objectContaining({ commandOverride: 'my-alias --option' })
      }),
      expect.any(Object)
    )
  }
)

it('does not offer chat switching while Chat UI is off', async () => {
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings!, experimentalNativeChat: false }
  })
  expect(await runConversationSwitch({ ...subject, direction: 'chat' })).toBe(false)
  expect(mocks.support).not.toHaveBeenCalled()
  expect(mocks.call).not.toHaveBeenCalled()
})

it('Continue with Chat UI off uses the same host switch identity, never copied/fork startup', async () => {
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings!, experimentalNativeChat: false }
  })
  const legacyContinue = vi.fn(async () => {})
  await runNativeChatCliSwitch({ ...subject, legacyContinue })
  expect(mocks.call).toHaveBeenCalledExactlyOnceWith(
    { kind: 'local' },
    'agentSession.switchToTerminal',
    expect.objectContaining({
      sessionId: subject.sessionId,
      execution: expect.objectContaining({
        sourceTabId: subject.chatTabId,
        viewerSelection: expect.stringMatching(/^selection-v1:/)
      })
    }),
    expect.any(Object)
  )
  expect(legacyContinue).not.toHaveBeenCalled()
  expect(mocks.legacy).not.toHaveBeenCalled()
})

it('old-host Continue while replying reports its copy outcome without promising Stop', async () => {
  mocks.support.mockResolvedValue(false)
  mocks.reader.mockReturnValue({
    getSnapshot: () => ({
      current: true,
      state: {
        ...EMPTY_STRUCTURED_AGENT_SESSION,
        working: true,
        latestTurn: { itemId: 'turn', observedAt: 1, turn: { turnId: 'turn', state: 'running' } }
      }
    })
  })
  const confirm = vi.fn()
  const legacyContinue = vi.fn(async () => {})
  await runNativeChatCliSwitch({ ...subject, confirm, legacyContinue })
  expect(mocks.support).toHaveBeenCalledOnce()
  expect(confirm).not.toHaveBeenCalled()
  expect(mocks.call).not.toHaveBeenCalled()
  expect(legacyContinue).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^selection-v1:/))
})
