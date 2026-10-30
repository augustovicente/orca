import { isSessionTabSelectionRequest } from '../../../../shared/session-tab-placement'
import { commitViewerSelection } from '@/lib/viewer-selection-request'
import { isFloatingWorkspaceId } from '../../../../shared/floating-workspace-worktree'
import { isWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { appendHistoryEntry } from '../../store/slices/worktree-nav-history'
import { tabActivationPatch } from '../../store/slices/tabs/tabs-focus-actions'
import { deriveActiveSurfaceForWorktree } from '../../store/slices/tabs/tabs-surface'
import { executionHostIdForSessionTabsOwner } from '../local-structured-session-owner'
import type { SnapshotOpenPlacement } from './open-placement'
import type { WebSessionTabsSyncState } from './state'
import { snapshotOpenSelectionRecords } from './store-patch'

/** Membership and original-view admission share one synchronous ordinary snapshot transaction. */
export function applySnapshotOpenSelection(
  state: WebSessionTabsSyncState,
  patch: WebSessionTabsSyncState | Partial<WebSessionTabsSyncState>,
  worktreeId: string,
  environmentId: string,
  placements: readonly SnapshotOpenPlacement[],
  hostToLocalTabId: ReadonlyMap<string, string>,
  consume = false,
  onSelection?: (patch: Partial<WebSessionTabsSyncState>) => void
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  const requested =
    placements.find(
      (entry) => entry.activate && isSessionTabSelectionRequest(entry.intent.viewerSelection)
    ) ?? placements.find((entry) => entry.activate)
  if (!requested) {
    return patch
  }
  const localId = hostToLocalTabId.get(requested.hostTabId)
  return localId
    ? applyOpenDestinationSelection(
        state,
        patch,
        worktreeId,
        environmentId,
        localId,
        requested.intent.viewerSelection,
        consume,
        onSelection
      )
    : patch
}

export function applyOpenDestinationSelection(
  state: WebSessionTabsSyncState,
  patch: Partial<WebSessionTabsSyncState>,
  worktreeId: string,
  environmentId: string,
  tabId: string,
  token: string | undefined,
  consume: boolean,
  onSelection?: (patch: Partial<WebSessionTabsSyncState>) => void
): Partial<WebSessionTabsSyncState> {
  if (token && isSessionTabSelectionRequest(token) && !consume) {
    return patch
  }
  const next = { ...state, ...patch }
  const tab = next.unifiedTabsByWorktree[worktreeId]?.find(
    (row) => row.id === tabId || row.entityId === tabId
  )
  if (
    !tab ||
    !next.groupsByWorktree[worktreeId]?.some((group) => group.tabOrder.includes(tab.id))
  ) {
    return patch
  }
  const activation = tabActivationPatch(next, tab, worktreeId, { recordFocus: false }, true)
  const activated = { ...next, ...activation }
  const surface = deriveActiveSurfaceForWorktree(activated, worktreeId, tab.groupId, {
    preferredTabId: tab.id
  })
  const selectionPatch = {
    ...activation,
    ...snapshotOpenSelectionRecords(next, worktreeId, surface),
    ...(isFloatingWorkspaceId(worktreeId)
      ? {}
      : {
          ...surface,
          ...(state.worktreeNavHistory &&
          state.worktreeNavHistoryIndex !== undefined &&
          !state.isNavigatingHistory
            ? appendHistoryEntry(
                {
                  worktreeNavHistory: state.worktreeNavHistory,
                  worktreeNavHistoryIndex: state.worktreeNavHistoryIndex
                },
                worktreeId
              )
            : {}),
          activeWorktreeId: worktreeId,
          activeWorkspaceKey: isWorkspaceKey(worktreeId)
            ? worktreeId
            : worktreeWorkspaceKey(worktreeId),
          activeWorkspaceExecutionHostId: executionHostIdForSessionTabsOwner(environmentId),
          activePendingCreationId: null,
          activeView: 'terminal' as const
        })
  }
  if (token && isSessionTabSelectionRequest(token)) {
    return consume && commitViewerSelection(token, { worktreeId, tabId: tab.id }, () => true)
      ? (onSelection?.(selectionPatch), { ...patch, ...selectionPatch })
      : patch
  }
  onSelection?.(selectionPatch)
  return { ...patch, ...selectionPatch }
}
