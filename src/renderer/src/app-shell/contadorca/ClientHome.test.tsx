// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import { translate } from '@/i18n/i18n'
import { makeWorktree, makeUnifiedTab } from '@/store/slices/store-test-helpers'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import { ClientHome } from './ClientHome'
import { clientQuickActions } from './client-quick-actions'

const mocks = vi.hoisted(() => {
  const state: Partial<AppState> = {}
  return { state, startClientConversation: vi.fn() }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Partial<AppState>) => unknown) => selector(mocks.state)
}))

vi.mock('./client-chat-launch', () => ({
  startClientConversation: mocks.startClientConversation
}))

function seedState(overrides: Partial<AppState>): void {
  mocks.state = {
    worktreesByRepo: {},
    folderWorkspaces: [],
    unifiedTabsByWorktree: {},
    activeWorktreeId: null,
    openModal: vi.fn(),
    setActiveWorktree: vi.fn(),
    setActiveFolderWorkspace: vi.fn(),
    activateTab: vi.fn(),
    ...overrides
  }
}

const addClientFolderLabel = (): string =>
  translate('contadorca.clientHome.addClientFolder', 'Adicionar pasta do cliente')
const newConversationLabel = (): string =>
  translate('contadorca.clientHome.newConversation', 'Nova conversa')

describe('ClientHome', () => {
  beforeEach(() => {
    seedState({})
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows the empty state and opens the add-repo modal', () => {
    const { getByRole, getByText } = render(<ClientHome />)

    expect(
      getByText(translate('contadorca.clientHome.welcomeTitle', 'Bem-vindo ao Contadorca'))
    ).toBeTruthy()
    expect(
      getByText(translate('contadorca.clientHome.noClients', 'Nenhum cliente cadastrado.'))
    ).toBeTruthy()

    fireEvent.click(getByRole('button', { name: addClientFolderLabel() }))

    expect(mocks.state.openModal).toHaveBeenCalledWith('add-repo')
  })

  it('lists worktree and folder workspaces as clients', () => {
    seedState({
      worktreesByRepo: {
        repo: [
          makeWorktree({
            id: 'repo::/clientes/aurora',
            repoId: 'repo',
            displayName: 'Aurora Ltda',
            path: '/clientes/aurora'
          })
        ]
      },
      folderWorkspaces: [
        makeFolderWorkspace({ id: 'bravo', name: 'Bravo ME', folderPath: '/clientes/bravo' })
      ]
    })

    const { getByText, queryByText } = render(<ClientHome />)

    expect(getByText('Aurora Ltda')).toBeTruthy()
    expect(getByText('/clientes/aurora')).toBeTruthy()
    expect(getByText('Bravo ME')).toBeTruthy()
    expect(
      queryByText(translate('contadorca.clientHome.noClients', 'Nenhum cliente cadastrado.'))
    ).toBeNull()
  })

  it('starts a chat for the selected client', () => {
    const worktree = makeWorktree({
      id: 'repo::/clientes/aurora',
      repoId: 'repo',
      displayName: 'Aurora Ltda'
    })
    seedState({ worktreesByRepo: { repo: [worktree] }, activeWorktreeId: worktree.id })

    const { getByRole } = render(<ClientHome />)
    fireEvent.click(getByRole('button', { name: newConversationLabel() }))

    expect(mocks.startClientConversation).toHaveBeenCalledWith({ worktreeId: worktree.id })
  })

  it('starts a chat with the routine prompt', () => {
    const worktree = makeWorktree({
      id: 'repo::/clientes/aurora',
      repoId: 'repo',
      displayName: 'Aurora Ltda'
    })
    seedState({ worktreesByRepo: { repo: [worktree] }, activeWorktreeId: worktree.id })
    const action = clientQuickActions()[0]

    const { getByRole } = render(<ClientHome />)
    fireEvent.click(getByRole('button', { name: action.label }))

    expect(mocks.startClientConversation).toHaveBeenCalledWith({
      worktreeId: worktree.id,
      prompt: action.prompt
    })
  })

  it('lists and reopens recent native chat conversations', () => {
    const worktree = makeWorktree({
      id: 'repo::/clientes/aurora',
      repoId: 'repo',
      displayName: 'Aurora Ltda'
    })
    const conversation = makeUnifiedTab({
      id: 'chat-1',
      worktreeId: worktree.id,
      groupId: 'group-1',
      contentType: 'agent-session',
      entityId: 'session-1',
      agentSessionAgent: 'opencode',
      label: 'Conferência de outubro',
      lastFocusedAt: 10
    })
    seedState({
      worktreesByRepo: { repo: [worktree] },
      activeWorktreeId: worktree.id,
      unifiedTabsByWorktree: { [worktree.id]: [conversation] }
    })

    const { getByText } = render(<ClientHome />)
    fireEvent.click(getByText('Conferência de outubro'))

    expect(mocks.state.activateTab).toHaveBeenCalledWith('chat-1', {
      worktreeId: worktree.id
    })
  })
})
