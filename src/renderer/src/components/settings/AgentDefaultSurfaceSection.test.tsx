// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { AgentDefaultSurfaceSection } from './AgentDefaultSurfaceSection'

const store = vi.hoisted((): { settings: GlobalSettings | null } => ({ settings: null }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (value: unknown) => unknown) => selector(store), {
    getState: () => store
  })
}))
vi.mock('@/lib/chat-provider-agents', () => ({
  chatProviderAgents: () => ['claude', 'codex', 'grok', 'opencode']
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), dismiss: vi.fn() } }))

// Applies writes the way the settings store does, so later reads see them.
const updateSettings = vi.fn(async (updates: Partial<GlobalSettings>) => {
  store.settings = { ...store.settings!, ...updates }
})

function renderSection(settings: Partial<GlobalSettings>): void {
  store.settings = createGlobalSettingsFixture(settings)
  render(<AgentDefaultSurfaceSection settings={store.settings} updateSettings={updateSettings} />)
}

beforeEach(() => {
  updateSettings.mockClear()
  vi.mocked(toast.success).mockClear()
})
afterEach(cleanup)

describe('Open agents as', () => {
  it('sets only the default, names agents set to the other surface, and Set all makes them follow', async () => {
    renderSection({
      agentDefaultSurface: 'terminal',
      // Grok already matches Chat; OpenCode is off, so its row offers no choice.
      nativeChatProviders: { claude: false, codex: false, grok: true, opencode: false },
      disabledTuiAgents: ['opencode']
    })
    expect(screen.getByRole('radio', { name: /^Terminal/ })).toHaveProperty('checked', true)

    fireEvent.click(screen.getByRole('radio', { name: /^Chat/ }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))
    expect(updateSettings).toHaveBeenCalledExactlyOnceWith({ agentDefaultSurface: 'chat' })
    const [title, options] = vi.mocked(toast.success).mock.calls[0]
    expect(title).toBe('Agents now open as chats')
    expect(options?.description).toBe('Claude and Codex stay in the terminal, as you set.')
    const action = options?.action as { label: string; onClick: () => void }
    expect(action.label).toBe('Set all to Chat')

    action.onClick()
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2))
    expect(updateSettings).toHaveBeenLastCalledWith({
      nativeChatProviders: { grok: true, opencode: false }
    })
  })

  it('shows no toast when every agent’s own choice already matches the new default', async () => {
    renderSection({ agentDefaultSurface: 'chat', nativeChatProviders: { claude: false } })
    fireEvent.click(screen.getByRole('radio', { name: /^Terminal/ }))
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledExactlyOnceWith({ agentDefaultSurface: 'terminal' })
    )
    await Promise.resolve()
    expect(toast.success).not.toHaveBeenCalled()
  })
})
