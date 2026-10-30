import type { StructuredSessionSurface } from '../agent-session/structured-agent-session-close'
import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'
import { chatTabId } from '../agent-session/agent-session-tab-layout'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  newReopenedChatTabId,
  isReopenedChatTabId
} from '../agent-session/agent-session-tab-identity'

export type StructuredSessionTabPublicationInput = {
  workspaceId: string
  sessionId: string
  agent: StructuredAgentId
  activate: boolean
  navigation?: 'caller'
  capture?: (surface: StructuredSessionSurface) => void
  notify?: boolean
  /** The host tab id a create reserved; a session that already has a tab keeps its own. */
  tabId?: string
  /** This machine's window made the create; its own open places the tab. */
  placedByWindow?: boolean
  /** Where the creating paired client opens the chat. */
  placement?: { groupId?: string; afterTabId?: string }
}

/** Caller opens require a committed lifetime; legacy opens retain their best-effort Retry surface. */
export async function admitStructuredSessionTabPublication(
  input: { sessionId: string; tabId?: string; navigation?: 'caller' },
  restore: () => Promise<void>
): Promise<{ tabId: string; current: string | null }> {
  let host = getStructuredAgentSessionHost()
  let tabId = input.tabId ?? chatTabId(input.sessionId)
  if (input.navigation === 'caller') {
    await restore()
    host = getStructuredAgentSessionHost()
    if (!host) {
      throw new Error('Chat tab inventory is unavailable')
    }
    await host.setSessionTabVisibility(input.sessionId, true, newReopenedChatTabId(), {
      capture: (winner) => {
        if (winner) {
          tabId = winner
        }
      }
    })
    if (!tabId || host.getSessionTabId(input.sessionId) !== tabId) {
      throw new Error('Chat tab publication was superseded')
    }
  } else if (typeof host?.setSessionTabVisibility === 'function') {
    // Restore-index failures (newer records/disk errors) are reported without preventing tab open.
    await host
      .setSessionTabVisibility(input.sessionId, true, input.tabId, {
        capture: (winner) => {
          if (winner) {
            tabId = winner
          }
        }
      })
      .catch((error: unknown) => {
        host.deps.logger.warn('recording an opened chat tab failed', {
          scope: 'tab-visibility-open',
          sessionId: input.sessionId,
          error
        })
      })
  }
  const current = host?.getSessionTabId(input.sessionId)
  if (isReopenedChatTabId(tabId) ? current !== tabId : current && isReopenedChatTabId(current)) {
    throw new Error('Chat tab publication was superseded')
  }
  return { tabId, current: current ?? null }
}
