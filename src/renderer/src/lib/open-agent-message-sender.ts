// Open the sender through chat or terminal-handle routes; choose feedback from the answering host’s evidence, never the sender’s address shape.

import { toast } from 'sonner'
import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import { structuredSessionOpenMessage } from '../../../shared/open-structured-agent-session'
import type {
  OrchestrationPartyLocation,
  OrchestrationPartyLocationResult
} from '../../../shared/orchestration-caller-status'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { isRuntimeCompatBlockError } from '@/runtime/runtime-protocol-compat'
import {
  focusRendererTerminalHandle,
  focusRuntimeTerminalHandle
} from '@/components/terminal-pane/terminal-handle-links'
import { showAgentPaneUnavailable } from '@/components/terminal-pane/stale-agent-row'
import { openDesktopStructuredSession } from './activate-ai-vault-structured-session'
import { getKnownExecutionHostIdForWorktree } from './worktree-runtime-owner'
import {
  executionHostIdForStructuredTarget,
  resolveStructuredAgentSessionOwner,
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'

type Sender = AgentMessageSource['senders'][number]
/** older-host identifies the chat host; update may mean either side, and unreachable proves nothing. */
type LookupFailure = 'older-host' | 'update' | 'unreachable'
type Lookup = OrchestrationPartyLocationResult | LookupFailure

/** The answers that prove the terminal is gone; anything else proves nothing about it. */
const TERMINAL_GONE_CODES = new Set([
  'terminal_exited',
  'terminal_gone',
  'terminal_handle_stale',
  'terminal_not_found'
])

const opensInFlight = new Map<string, Promise<void>>()

/** Route all sender lookups to the host of the chat displaying the message. */
export function openAgentMessageSender(
  source: AgentMessageSource,
  sender: Sender,
  chatWorktreeId: string,
  target?: RuntimeClientTarget
): Promise<void> {
  const state = useAppStore.getState()
  const host =
    target ??
    (getKnownExecutionHostIdForWorktree(state, chatWorktreeId)
      ? structuredAgentSessionTargetForHost(
          resolveStructuredAgentSessionOwner(state, chatWorktreeId)
        )
      : null)
  if (!host) {
    showLookupFailure('unreachable', sender.name ?? '')
    return Promise.resolve()
  }
  const key = `${executionHostIdForStructuredTarget(host)}\0${chatWorktreeId}\0${sender.party.address}`
  const inFlight = opensInFlight.get(key)
  if (inFlight) {
    return inFlight
  }
  const opening = openSender(source, sender, host)
    .catch((error: unknown) => {
      // Every answer above shows its own words; one that threw showed none.
      console.warn('[agent-message-sender] opening the sender failed', error)
      showLookupFailure('unreachable', sender.name ?? '')
    })
    .finally(() => opensInFlight.delete(key))
  opensInFlight.set(key, opening)
  return opening
}

async function openSender(
  source: AgentMessageSource,
  { party, name }: Sender,
  host: RuntimeClientTarget
): Promise<void> {
  const environmentId = host.kind === 'environment' ? host.environmentId : null
  // Mail identifies senders beyond old terminal handles; tasks carry no mail and resolve coordinators by address.
  const mail = source.orchestration?.message === 'mail-notice' ? source.orchestration.messages : []
  const messageIds = mail
    .filter((message) => message.from === party.address)
    .map((message) => message.messageId)
  const found = await lookUpSender(party, messageIds, host)
  if (typeof found === 'string') {
    showLookupFailure(found, name ?? '')
    return
  }
  if (!found.location && found.lost === 'terminal') {
    showAgentPaneUnavailable()
    return
  }
  const result = await openDesktopStructuredSession(
    { kind: 'sender', address: party.address, messageIds, agent: name ?? undefined },
    host,
    undefined,
    async () => found
  )
  if (result.kind === 'terminal') {
    await focusTerminal(result.handle, environmentId, name ?? '')
  }
}

async function focusTerminal(
  handle: string,
  environmentId: string | null,
  agent: string
): Promise<void> {
  if (focusRendererTerminalHandle(handle, environmentId)) {
    return
  }
  try {
    await focusRuntimeTerminalHandle(handle, environmentId)
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && TERMINAL_GONE_CODES.has(error.code)) {
      showAgentPaneUnavailable()
    } else {
      showLookupFailure(isRuntimeCompatBlockError(error) ? 'update' : 'unreachable', agent)
    }
  }
}

async function lookUpSender(
  party: Sender['party'],
  messageIds: readonly string[],
  host: RuntimeClientTarget
): Promise<Lookup> {
  try {
    return await callRuntimeRpc<OrchestrationPartyLocationResult>(
      host,
      'orchestration.partyLocation',
      { address: party.address, ...(messageIds.length > 0 ? { messageIds } : {}) }
    )
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return lookUpOnOlderHost(party, host)
    }
    return isRuntimeCompatBlockError(error) ? 'update' : 'unreachable'
  }
}

/** Older hosts allow root-ID chats and terminal-handle opens; other identities require updating that host. */
function lookUpOnOlderHost(party: Sender['party'], host: RuntimeClientTarget): Lookup {
  const sessionId = party.orcaSessionId
  if (sessionId) {
    const state = useAppStore.getState()
    const tabsByWorktree = state.unifiedTabsByWorktree
    for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
      if (
        tabs.some(
          (tab) =>
            tab.contentType === 'agent-session' &&
            tab.entityId === sessionId &&
            structuredAgentSessionOwnerForTab(state, tab) ===
              executionHostIdForStructuredTarget(host)
        )
      ) {
        return located({ kind: 'chat', sessionId, worktreeId })
      }
    }
    return 'older-host'
  }
  const handle = party.terminalHandle
  return handle && !handle.startsWith('dispatch:') && !handle.startsWith('run:')
    ? located({ kind: 'terminal', handle })
    : 'older-host'
}

function located(location: OrchestrationPartyLocation): OrchestrationPartyLocationResult {
  return { location }
}

function showLookupFailure(failure: LookupFailure, agent: string): void {
  toast.error(
    structuredSessionOpenMessage(failure === 'unreachable' ? 'unreachable' : 'unsupported', agent)
  )
}
