import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { Worktree } from '../../../../shared/worktree/types'

/** One customer folder: a git worktree or a non-git folder workspace, shown as the same client. */
export type ClientWorkspaceRow = {
  id: string
  name: string
  path: string
  hostId?: ExecutionHostId
  folderWorkspaceId: string | null
}

function trailingPathSegment(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? path
  )
}

function worktreeRow(worktree: Worktree): ClientWorkspaceRow {
  return {
    id: worktree.id,
    name: worktree.displayName || trailingPathSegment(worktree.path),
    path: worktree.path,
    ...(worktree.hostId ? { hostId: worktree.hostId } : {}),
    folderWorkspaceId: null
  }
}

function folderRow(folder: FolderWorkspace): ClientWorkspaceRow {
  return {
    id: folderWorkspaceKey(folder.id),
    name: folder.name,
    path: folder.folderPath,
    ...(folder.executionHostId ? { hostId: folder.executionHostId } : {}),
    folderWorkspaceId: folder.id
  }
}

/** Derive the client list from the existing worktree and folder-workspace catalogs. */
export function clientWorkspaceRows(args: {
  worktrees: readonly Worktree[]
  folderWorkspaces: readonly FolderWorkspace[]
}): ClientWorkspaceRow[] {
  const rows = [
    ...args.worktrees.filter((worktree) => !worktree.isArchived).map(worktreeRow),
    ...args.folderWorkspaces.filter((folder) => !folder.isArchived).map(folderRow)
  ]
  const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' })
  rows.sort(
    (left, right) => collator.compare(left.name, right.name) || collator.compare(left.id, right.id)
  )
  return rows
}

function foldForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('pt-BR')
}

/** Accent-insensitive search over the client name and folder path. */
export function clientWorkspaceMatchesQuery(row: ClientWorkspaceRow, query: string): boolean {
  const needle = foldForSearch(query.trim())
  if (needle === '') {
    return true
  }
  return foldForSearch(`${row.name} ${row.path}`).includes(needle)
}
