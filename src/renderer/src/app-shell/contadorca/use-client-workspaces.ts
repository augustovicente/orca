import { useMemo } from 'react'
import type { Tab } from '../../../../shared/tab-types'
import { isStructuredTab } from '../../../../shared/structured-agent-session-tab'
import { useAppStore } from '@/store'
import {
  clientWorkspaceRows,
  clientWorkspaceMatchesQuery,
  type ClientWorkspaceRow
} from './client-workspace-rows'

const EMPTY_TABS: Tab[] = []

export type ClientConversationRow = {
  id: string
  label: string
  lastActivityAt: number
}

function isConversationTab(tab: Tab): boolean {
  return isStructuredTab(tab) || (tab.contentType === 'terminal' && tab.viewMode === 'chat')
}

function conversationRow(tab: Tab): ClientConversationRow {
  return {
    id: tab.id,
    label: tab.customLabel ?? tab.aiVaultTitle?.title ?? tab.generatedLabel ?? tab.label,
    lastActivityAt: tab.lastFocusedAt ?? tab.createdAt
  }
}

/** Client folders for the customer home, derived from the existing workspace catalogs. */
export function useClientWorkspaces(query = ''): ClientWorkspaceRow[] {
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const folderWorkspaces = useAppStore((s) => s.folderWorkspaces)
  return useMemo(() => {
    const rows = clientWorkspaceRows({
      worktrees: Object.values(worktreesByRepo).flat(),
      folderWorkspaces
    })
    return query.trim() === ''
      ? rows
      : rows.filter((row) => clientWorkspaceMatchesQuery(row, query))
  }, [worktreesByRepo, folderWorkspaces, query])
}

/** Conversations open in the selected client, newest first. */
export function useClientConversations(clientId: string | null): ClientConversationRow[] {
  const tabs = useAppStore((s) =>
    clientId ? (s.unifiedTabsByWorktree[clientId] ?? EMPTY_TABS) : EMPTY_TABS
  )
  return useMemo(
    () =>
      tabs
        .filter(isConversationTab)
        .map(conversationRow)
        .sort((left, right) => right.lastActivityAt - left.lastActivityAt)
        .slice(0, 5),
    [tabs]
  )
}

/** Cheap first-run signal: any conversation ever opened in any workspace. */
export function useHasAnyConversation(): boolean {
  return useAppStore((s) =>
    Object.values(s.unifiedTabsByWorktree).some((tabs) => tabs.some(isConversationTab))
  )
}
