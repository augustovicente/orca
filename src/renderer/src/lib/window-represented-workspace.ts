import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import { isLocalPathOpenBlocked } from '@/lib/local-path-open-guard'
import { resolveWorktreeDisplayName } from '@/lib/worktree-default-display-name'
import { shouldShowWorktreeCreationSurface } from '@/lib/worktree-creation-surface'
import type { WindowRepresentedWorkspace } from '../../../shared/window-represented-workspace'

/** The workspace this window shows, when its folder is on this computer. */
export function selectWindowRepresentedWorkspace(state: AppState): WindowRepresentedWorkspace {
  const worktreeId = state.activeWorktreeId
  if (
    state.activeView !== 'terminal' ||
    !worktreeId ||
    shouldShowWorktreeCreationSurface({
      activeView: state.activeView,
      activePendingCreationId: state.activePendingCreationId,
      hasActivePendingCreation:
        state.activePendingCreationId !== null &&
        state.pendingWorktreeCreations[state.activePendingCreationId] !== undefined
    }) ||
    isLocalPathOpenBlocked(getResolvedExecutionHostIdForWorktree(state, worktreeId) ?? 'unresolved')
  ) {
    return null
  }
  const worktree = findKnownWorktreeById(
    state,
    worktreeId,
    state.activeWorkspaceExecutionHostId ?? undefined
  )
  return worktree ? { path: worktree.path, name: resolveWorktreeDisplayName(worktree) } : null
}

/** Main mirrors this into the macOS window title and AXDocument for time trackers and window managers. */
export function installWindowRepresentedWorkspaceReporter(): () => void {
  const report = window.api.ui.setRepresentedWorkspace
  // Dev reloads can pair a new renderer with an older preload.
  if (typeof report !== 'function') {
    return () => {}
  }
  let last: WindowRepresentedWorkspace | undefined
  const sync = (state: AppState): void => {
    const next = selectWindowRepresentedWorkspace(state)
    if (last !== undefined && next?.path === last?.path && next?.name === last?.name) {
      return
    }
    last = next
    report(next)
  }
  sync(useAppStore.getState())
  return useAppStore.subscribe(sync)
}
