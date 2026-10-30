import { withSelectedChatTab } from '../agent-session/agent-session-tab-layout'
import type { OrcaRuntimeWithScheduleMobileSessionTabsChanged as ScheduleMobileSessionTabsChangedMethods } from './session-tabs-change-publication'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { restoredChatTabChanges } from './restored-chat-tab-changes'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'
import {
  isSessionTabSelectionRequest,
  type SessionTabOpenPlacement
} from '../../../shared/session-tab-placement'
import { projectStructuredSessionTab } from './structured-session-tab-projection'
import { OrcaRuntimeWithStructuredSessionLaunchRuntime } from './structured-session-launch-runtime'

export type AgentLaunchScope = Parameters<
  OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce['getAgentLaunchPlatformForWorkspace']
>[0]

export abstract class OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce extends OrcaRuntimeWithStructuredSessionLaunchRuntime {
  protected abstract notifyMobileSessionTabSnapshots(
    ...args: Parameters<ScheduleMobileSessionTabsChangedMethods['notifyMobileSessionTabSnapshots']>
  ): ReturnType<ScheduleMobileSessionTabsChangedMethods['notifyMobileSessionTabSnapshots']>

  protected async restoreStructuredAgentSessionTabsOnce(): Promise<void> {
    await this.prepareStructuredAgentSessionStartupRestoration()
    const host = getStructuredAgentSessionHost()
    if (host?.getPersistedVisibleSessionTabIndex?.().present !== true) {
      await host?.deps?.store?.initializeSessionTabs?.().catch((error: unknown) =>
        host.deps.logger.warn('recording restored chat tabs failed', {
          scope: 'tab-index-seed',
          error
        })
      )
    }
    await host?.seedSessionTabs()
    for (const worktreeId of this.getKnownWorkspaceSessionWorktreeIds()) {
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true
      })
    }
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession()
    // Every session here is of an agent this host registered: its store holds no other agent's records.
    const restored = (host?.listSessionTabs() ?? []).flatMap((session) => {
      let sessionId = session.sessionId
      while (sessionId.startsWith('agent-session:')) {
        sessionId = sessionId.slice('agent-session:'.length)
      }
      return [{ ...session, agent: session.agent, sessionId }]
    })
    const changes = restoredChatTabChanges(
      this.store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID)?.unifiedTabs ?? {},
      host,
      restored,
      (id) => this.hasCurrentLocalStructuredSessionTab(id)
    )
    for (const [worktreeId, worktreeChanges] of changes) {
      this.changeWindowlessChatTabs(worktreeId, worktreeChanges, (change) =>
        this.passiveStructuredSessionTabChangeEligible(change)
      )
    }
    for (const session of restored) {
      if (host?.isSessionTabVisible(session.sessionId)) {
        this.projectStructuredAgentSessionTab({ ...session, activate: false, notify: false })
      }
    }
    const wasUnverifiable = this.structuredAgentSessionInventoryUnverifiable
    // No host means no one can say which chats exist; with none on disk, empty is the answer.
    this.structuredAgentSessionInventoryUnverifiable =
      !host && this.hasPersistedStructuredAgentSessionStore()
    // This restore published quietly; subscribers still hold the frames that said "cannot tell".
    if (wasUnverifiable && !this.structuredAgentSessionInventoryUnverifiable) {
      this.notifyMobileSessionTabSnapshots()
    }
  }

  captureSessionSwitchSelection(
    _worktreeId?: string,
    viewerSelection?: string,
    deferAcceptance = false
  ) {
    // A window request is transported to its viewer; it grants no host-view authority.
    return viewerSelection !== undefined
      ? Object.assign((_consume = false) => false, { accept: () => {} })
      : this.clientSessionTabSelections.captureHostSelection(deferAcceptance)
  }

  async publishStructuredAgentSessionTab(input: {
    workspaceId: string
    sessionId: string
    agent: StructuredAgentId
    activate: boolean
    check?: () => void
    selectionCurrent?: (consume?: boolean) => boolean
    viewerSelection?: string
    focusWindow?: boolean
    notify?: boolean
    /** The host tab id a create reserved; a session that already has a tab keeps its own. */
    tabId?: string
    /** This machine's window made the create; its own open places the tab. */
    placedByWindow?: boolean
    /** Where the creating paired client opens the chat. */
    /** A ChatTabPlacement, typed in place: this file is at its line limit. */
    placement?: { groupId?: string; afterTabId?: string; index?: number }
    openPlacement?: SessionTabOpenPlacement
  }): Promise<void> {
    const host = getStructuredAgentSessionHost()
    input.check?.()
    // First membership includes placement, even while visibility or the durable queue is awaited.
    if (input.openPlacement) {
      this.projectStructuredAgentSessionTab({ ...input, activate: false, notify: false })
    }
    if (input.check && host) {
      await host.deps.store.setSessionTabVisibility(input.sessionId, true, input.tabId, input.check)
    } else if (typeof host?.setSessionTabVisibility === 'function') {
      // Restore-index failures (newer records/disk errors) are reported without preventing tab open.
      await host
        .setSessionTabVisibility(input.sessionId, true, ...(input.tabId ? [input.tabId] : []))
        .catch((error: unknown) => {
          host.deps.logger.warn('recording an opened chat tab failed', {
            scope: 'tab-visibility-open',
            sessionId: input.sessionId,
            error
          })
        })
    }
    // Window creates retain the window's own placement decision.
    input.check?.()
    if (input.check && (ORCA_LAYOUT_OWNER_IS_MAIN || !this.getAvailableAuthoritativeWindow())) {
      const check = input.check
      const applied = await this.queueChatTabChanges(
        () => [
          {
            worktreeId: input.workspaceId,
            change: { open: { ...input, tabId: input.tabId ?? `agent-session:${input.sessionId}` } }
          }
        ],
        () => {
          check()
          return true
        }
      )
      if (!applied) {
        throw new Error('tab_not_found')
      }
    } else if (!(ORCA_LAYOUT_OWNER_IS_MAIN && input.placedByWindow)) {
      this.saveWindowlessAgentSessionTab(input.workspaceId, input)
    }
    input.check?.()
    const viewerRequest = isSessionTabSelectionRequest(input.viewerSelection)
    const activate = input.activate && !viewerRequest && (input.selectionCurrent?.() ?? true)
    if (activate) {
      input.check?.()
      input.selectionCurrent?.(true)
    }
    this.projectStructuredAgentSessionTab({
      ...input,
      activate,
      ...(input.openPlacement
        ? {
            openPlacement: {
              ...input.openPlacement,
              activate: viewerRequest ? input.openPlacement.activate : activate
            }
          }
        : {})
    })
    if (activate) {
      input.check?.()
      this.commitWindowlessChatSession(input.workspaceId, (session) =>
        withSelectedChatTab(
          this.getWorkspaceSessionHostIdForWorktree(input.workspaceId),
          session,
          input.workspaceId,
          input.sessionId
        )
      )
    }
    if ((activate || (viewerRequest && input.activate)) && input.focusWindow !== false) {
      input.check?.()
      this.notifier?.focusEditorTab?.(
        input.tabId ?? host?.getSessionTabId(input.sessionId) ?? `agent-session:${input.sessionId}`,
        input.workspaceId,
        input.viewerSelection
      )
    }
  }

  /** The runtime's own snapshot of a chat tab. Records nothing: the caller owns the store write. */
  projectStructuredAgentSessionTab(input: {
    workspaceId: string
    sessionId: string
    agent: StructuredAgentId
    activate: boolean
    notify?: boolean
    openPlacement?: SessionTabOpenPlacement
  }): void {
    const next = projectStructuredSessionTab(
      this.mobileSessionTabsByWorktree.get(input.workspaceId),
      input
    )
    if (!next) {
      return
    }
    const stored = this.storeMobileSessionSnapshot(input.workspaceId, next)
    if (input.openPlacement) {
      this.markPaneLiveTitlesDirty()
    }
    if (input.notify !== false) {
      this.emitMobileSessionTabsSnapshot(stored)
    }
  }

  /** A startup's fact: the workspace it starts in, else the new worktree a create is making. */
}
