import { useMemo, useState } from 'react'
import { FolderPlus, MessageSquare, Plus } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAppStore } from '@/store'
import { clientQuickActions } from './client-quick-actions'
import { startClientConversation } from './client-chat-launch'
import type { ClientWorkspaceRow } from './client-workspace-rows'
import {
  useClientConversations,
  useClientWorkspaces,
  type ClientConversationRow
} from './use-client-workspaces'

function ClientFolderRow({
  client,
  selected,
  onSelect
}: {
  client: ClientWorkspaceRow
  selected: boolean
  onSelect: (client: ClientWorkspaceRow) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-current={selected ? 'true' : undefined}
      onClick={() => onSelect(client)}
      className={`flex w-full min-w-0 flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors ${
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'
      }`}
    >
      <span className="w-full truncate text-[13px] font-medium">{client.name}</span>
      <span className="w-full truncate font-mono text-2xs text-muted-foreground">
        {client.path}
      </span>
    </button>
  )
}

function ClientFolderColumn({
  clients,
  query,
  selectedId,
  onQueryChange,
  onSelect,
  onAddClient
}: {
  clients: readonly ClientWorkspaceRow[]
  query: string
  selectedId: string | null
  onQueryChange: (query: string) => void
  onSelect: (client: ClientWorkspaceRow) => void
  onAddClient: () => void
}): React.JSX.Element {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border">
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center justify-between">
          <h2 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            {translate('contadorca.clientHome.clientsTitle', 'Clientes')}
          </h2>
          <span className="text-2xs text-muted-foreground">{clients.length}</span>
        </div>
        <Input
          density="compact"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={translate('contadorca.clientHome.searchPlaceholder', 'Buscar cliente')}
          aria-label={translate('contadorca.clientHome.searchPlaceholder', 'Buscar cliente')}
        />
        <Button variant="outline" size="sm" className="w-full" onClick={onAddClient}>
          <Plus />
          {translate('contadorca.clientHome.addClient', 'Adicionar cliente')}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto scrollbar-sleek px-2 pb-3">
        {clients.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            {query.trim() === ''
              ? translate('contadorca.clientHome.noClients', 'Nenhum cliente cadastrado.')
              : translate('contadorca.clientHome.noSearchResults', 'Nenhum cliente encontrado.')}
          </p>
        ) : (
          clients.map((client) => (
            <ClientFolderRow
              key={client.id}
              client={client}
              selected={client.id === selectedId}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </aside>
  )
}

function ClientWelcome({ onAddClient }: { onAddClient: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <FolderPlus className="size-8 text-muted-foreground" />
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">
          {translate('contadorca.clientHome.welcomeTitle', 'Bem-vindo ao Contadorca')}
        </h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          {translate(
            'contadorca.clientHome.welcomeBody',
            'Adicione a pasta de um cliente para conversar com o assistente sobre os arquivos dele.'
          )}
        </p>
      </div>
      <Button onClick={onAddClient}>
        <Plus />
        {translate('contadorca.clientHome.addClientFolder', 'Adicionar pasta do cliente')}
      </Button>
    </div>
  )
}

function ClientNoSelection(): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
      {translate('contadorca.clientHome.selectClient', 'Selecione um cliente na lista.')}
    </div>
  )
}

function RecentConversations({
  conversations,
  onOpen
}: {
  conversations: readonly ClientConversationRow[]
  onOpen: (conversation: ClientConversationRow) => void
}): React.JSX.Element | null {
  if (conversations.length === 0) {
    return null
  }
  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        {translate('contadorca.clientHome.recentConversations', 'Conversas recentes')}
      </h2>
      <div className="flex flex-col gap-0.5">
        {conversations.map((conversation) => (
          <button
            key={conversation.id}
            type="button"
            onClick={() => onOpen(conversation)}
            className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent"
          >
            <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{conversation.label}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

function SelectedClientPanel({
  client,
  conversations,
  onStartConversation,
  onOpenConversation
}: {
  client: ClientWorkspaceRow
  conversations: readonly ClientConversationRow[]
  onStartConversation: (prompt?: string) => void
  onOpenConversation: (conversation: ClientConversationRow) => void
}): React.JSX.Element {
  return (
    <div className="flex w-full max-w-2xl flex-col gap-6 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{client.name}</h1>
        <p className="truncate font-mono text-xs text-muted-foreground">{client.path}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => onStartConversation()}>
          <MessageSquare />
          {translate('contadorca.clientHome.newConversation', 'Nova conversa')}
        </Button>
      </div>
      <section className="flex flex-col gap-2">
        <h2 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          {translate('contadorca.clientHome.routinesTitle', 'Rotinas do cliente')}
        </h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {clientQuickActions().map((action) => (
            <Button
              key={action.id}
              variant="outline"
              className="justify-start"
              onClick={() => onStartConversation(action.prompt)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      </section>
      <RecentConversations conversations={conversations} onOpen={onOpenConversation} />
    </div>
  )
}

function ClientMainColumn({
  hasClients,
  selectedClient,
  conversations,
  onAddClient,
  onStartConversation,
  onOpenConversation
}: {
  hasClients: boolean
  selectedClient: ClientWorkspaceRow | null
  conversations: readonly ClientConversationRow[]
  onAddClient: () => void
  onStartConversation: (prompt?: string) => void
  onOpenConversation: (conversation: ClientConversationRow) => void
}): React.JSX.Element {
  if (!hasClients) {
    return <ClientWelcome onAddClient={onAddClient} />
  }
  if (!selectedClient) {
    return <ClientNoSelection />
  }
  return (
    <div className="flex min-h-0 flex-1 justify-center overflow-y-auto scrollbar-sleek px-8">
      <SelectedClientPanel
        client={selectedClient}
        conversations={conversations}
        onStartConversation={onStartConversation}
        onOpenConversation={onOpenConversation}
      />
    </div>
  )
}

/** Contadorca workspace home: pick a client folder, then start a native chat there. */
export function ClientHome(): React.JSX.Element {
  useUiLanguageRevision()
  const [query, setQuery] = useState('')
  const filteredClients = useClientWorkspaces(query)
  const allClients = useClientWorkspaces()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const openModal = useAppStore((s) => s.openModal)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const setActiveFolderWorkspace = useAppStore((s) => s.setActiveFolderWorkspace)
  const activateTab = useAppStore((s) => s.activateTab)

  const selectedClient = useMemo(
    () => allClients.find((client) => client.id === activeWorktreeId) ?? null,
    [allClients, activeWorktreeId]
  )
  const conversations = useClientConversations(selectedClient?.id ?? null)

  const handleAddClient = (): void => openModal('add-repo')
  const handleSelectClient = (client: ClientWorkspaceRow): void => {
    if (client.folderWorkspaceId) {
      setActiveFolderWorkspace(client.folderWorkspaceId, client.hostId)
      return
    }
    setActiveWorktree(client.id, client.hostId)
  }
  const handleStartConversation = (prompt?: string): void => {
    if (!selectedClient) {
      return
    }
    startClientConversation({ worktreeId: selectedClient.id, ...(prompt ? { prompt } : {}) })
  }
  const handleOpenConversation = (conversation: ClientConversationRow): void => {
    if (!selectedClient) {
      return
    }
    activateTab(conversation.id, { worktreeId: selectedClient.id })
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden" data-contadorca-client-home="">
      <ClientFolderColumn
        clients={filteredClients}
        query={query}
        selectedId={selectedClient?.id ?? null}
        onQueryChange={setQuery}
        onSelect={handleSelectClient}
        onAddClient={handleAddClient}
      />
      <ClientMainColumn
        hasClients={allClients.length > 0}
        selectedClient={selectedClient}
        conversations={conversations}
        onAddClient={handleAddClient}
        onStartConversation={handleStartConversation}
        onOpenConversation={handleOpenConversation}
      />
    </div>
  )
}

export default ClientHome
