import type { StructuredAgentSessionReadSnapshot } from '@/components/native-chat/structured-agent-session-read-owner'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const live: { held?: StructuredAgentSessionReadSnapshot; view: string } = { view: 'worktrees' }
  return {
    supported: true,
    live,
    call: vi.fn(),
    launch: vi.fn((_args: unknown): { tabId: string | null; runtimeLaunch?: Promise<unknown> } => ({
      tabId: 'terminal-tab'
    })),
    closeUnifiedTab: vi.fn(),
    toast: vi.fn()
  }
})
vi.mock('sonner', () => ({ toast: { error: mocks.toast } }))
vi.mock('@/store', () => ({
  useAppStore: {
    setState: vi.fn(),
    getState: () => ({
      settings: {},
      closeUnifiedTab: mocks.closeUnifiedTab,
      activeView: mocks.live.view
    })
  }
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  subscribeLocalRuntimeCapabilityObservation: () => () => {},
  readLocalRuntimeCapabilitiesOrUnknown: () => [],
  ensureLocalRuntimeCapabilities: async () =>
    mocks.supported
      ? ['agent-session.structured.switch.v1:codex', 'agent-session.conversation-stop.v1']
      : []
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: async () => false
}))
vi.mock('@/components/native-chat/structured-agent-session-read-owner-registry', () => ({
  findStructuredAgentSessionReadOwner: () =>
    mocks.live.held ? { getSnapshot: () => mocks.live.held } : undefined
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  supportsInPlaceSwitch: async () => mocks.supported,
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({ getExecutionHostIdForWorktree: () => 'local' }))
vi.mock('@/lib/launch-ai-vault-session', () => ({ launchAiVaultSessionInNewTab: mocks.launch }))
vi.mock('@/lib/ai-vault-resume-command', () => ({
  buildAiVaultResumeStartupForWorktree: () => ({
    command: 'codex resume thread-c',
    env: { CODEX_HOME: '/accounts/a/home' },
    providerSession: { key: 'session_id', id: 'thread-c' }
  })
}))

import { runLegacyNativeChatCliSwitch as runNativeChatCliSwitch } from './native-chat-cli-switch-run'

const SWITCH = {
  sessionId: 'chat-1',
  workspaceId: 'wt-1',
  executionHostId: 'local',
  agent: 'codex' as const,
  chatTabId: 'chat-tab'
}
const SOURCE = {
  agent: 'codex',
  sourceAgent: 'codex',
  sessionId: 'thread-c',
  filePath: '/accounts/a/home/sessions/rollout-thread-c.jsonl',
  cwd: '/repo',
  codexHome: '/accounts/a/home',
  executionHostPlatform: 'darwin'
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.supported = true
  mocks.live.held = undefined
  mocks.live.view = 'worktrees'
  mocks.call.mockResolvedValue({ source: SOURCE })
})

it('preserves readable recovery and never launches from an old Close acknowledgement', async () => {
  mocks.supported = false
  await runNativeChatCliSwitch(SWITCH)
  expect(mocks.call.mock.calls.map((call) => call[1])).toEqual([
    'agentSession.close',
    'agentSession.reveal'
  ])
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(mocks.closeUnifiedTab).not.toHaveBeenCalled()
  expect(mocks.toast).toHaveBeenCalledOnce()
})
