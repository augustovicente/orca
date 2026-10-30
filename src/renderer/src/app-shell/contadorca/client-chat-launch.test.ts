import { beforeEach, describe, expect, it, vi } from 'vitest'
import { translate } from '@/i18n/i18n'

const mocks = vi.hoisted(() => ({
  launchAgentInNewTab: vi.fn(),
  toastError: vi.fn(),
  defaultTuiAgent: 'claude'
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ settings: { defaultTuiAgent: mocks.defaultTuiAgent } })
  }
}))

import { defaultClientChatAgent, startClientConversation } from './client-chat-launch'

const WORKTREE_ID = 'repo::/clientes/aurora'

describe('startClientConversation', () => {
  beforeEach(() => {
    mocks.launchAgentInNewTab.mockReset()
    mocks.toastError.mockReset()
    mocks.defaultTuiAgent = 'claude'
  })

  it('launches the native chat surface with the routine prompt as a draft', () => {
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-chat', tabId: 'tab-1' },
      pasteDraftAfterLaunch: false
    })

    startClientConversation({ worktreeId: WORKTREE_ID, prompt: '  Importe o extrato  ' })

    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'claude',
        worktreeId: WORKTREE_ID,
        requestedSurface: 'chat',
        launchSource: 'native_chat',
        prompt: 'Importe o extrato',
        promptDelivery: 'draft'
      })
    )
    const args = mocks.launchAgentInNewTab.mock.calls[0]?.[0]
    expect(args.onStructuredHostDeclined()).toEqual({ opened: false })
  })

  it('opens a plain conversation without a prompt', () => {
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-chat', tabId: 'tab-1' },
      pasteDraftAfterLaunch: false
    })

    startClientConversation({ worktreeId: WORKTREE_ID })

    const args = mocks.launchAgentInNewTab.mock.calls[0]?.[0]
    expect(args).not.toHaveProperty('prompt')
    expect(args).not.toHaveProperty('promptDelivery')
  })

  it('falls back to OpenCode when the developer agent picker left no default', () => {
    mocks.defaultTuiAgent = ''

    expect(defaultClientChatAgent()).toBe('opencode')
  })

  it('tells the customer when the chat could not open', () => {
    mocks.launchAgentInNewTab.mockReturnValue(null)

    startClientConversation({ worktreeId: WORKTREE_ID })

    expect(mocks.toastError).toHaveBeenCalledWith(
      translate(
        'contadorca.clientHome.chatUnavailable',
        'Não foi possível abrir a conversa. Confira as configurações de chat.'
      )
    )
  })
})
