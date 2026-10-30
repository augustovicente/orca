import {
  openStructuredAgentSession,
  structuredSessionOpenFailure,
  type StructuredSessionOpenSource,
  type StructuredSessionOpenResult,
  type StructuredSessionOpenDeps,
  type StructuredSessionOpenTarget,
  type StructuredSessionOpenTab
} from '../../../shared/open-structured-agent-session'
import type { OrchestrationPartyLocationResult } from '../../../shared/orchestration-caller-status'
import {
  findStructuredAgentSessionTab,
  activateStructuredAgentSessionById
} from './agent-session/structured-agent-session-tab-activation'
import { showAgentPaneUnavailable } from '@/components/terminal-pane/stale-agent-row'
import { translate } from '@/i18n/i18n'
import { toast } from 'sonner'
import type { AiVaultSession } from '../../../shared/ai-vault-types'
import { activateAndRevealWorktree } from './worktree-activation'
import { activateWslMovedWorkspace } from './wsl-moved-chat-activation'
import { useAppStore } from '@/store'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from './worktree-runtime-owner'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { refreshLocalStructuredSessionWorktreeTabs } from '@/runtime/local-structured-session-tabs-sync/inventory-refresh'
import { STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { isRuntimeCompatBlockError } from '@/runtime/runtime-protocol-compat'
import { executionHostIdForStructuredTarget } from '@/runtime/structured-agent-session-owner'

const STRUCTURED_SESSION_RESTORE_TIMEOUT_MS = 5_000

/** Keep distinct remedies: retry unreachable hosts, stop on a confirmed missing record, or update incompatible hosts/adapters. Failure to answer never proves a chat is gone. */
export type StructuredSessionRevealOutcome =
  | StructuredSessionOpenTarget
  | 'gone'
  | 'host-cannot-open'
  | 'unreachable'

type StructuredSessionActivationDeps = {
  activate: typeof activateStructuredAgentSessionById
  tabs: (
    target: { sessionId: string; worktreeId: string },
    owner: RuntimeClientTarget
  ) => readonly StructuredSessionOpenTab[]
  refresh: (worktreeId: string, target?: RuntimeClientTarget) => Promise<void>
  reveal: (target: {
    worktreeId: string
    sessionId: string
    target?: RuntimeClientTarget
  }) => Promise<StructuredSessionRevealOutcome>
  unavailable: (agent?: string) => void
  gone: (agent?: string) => void
  hostCannotOpen: (agent?: string) => void
}

export const structuredSessionOpenFeedback: Pick<
  StructuredSessionActivationDeps,
  'unavailable' | 'gone' | 'hostCannotOpen'
> = {
  unavailable: () =>
    toast.error(
      translate(
        'auto.lib.activateAiVaultStructuredSession.unavailable',
        'The structured agent session is not available yet. Retry in a moment.'
      )
    ),
  gone: () =>
    toast.error(
      translate(
        'auto.lib.activateAiVaultStructuredSession.gone',
        'This chat is no longer on this host, so it cannot be reopened here.'
      )
    ),
  hostCannotOpen: () =>
    toast.error(
      translate(
        'auto.lib.activateAiVaultStructuredSession.hostCannotOpen',
        "This chat can't be reopened until Orca is updated."
      )
    )
}

const defaultDeps: StructuredSessionActivationDeps = {
  activate: activateStructuredAgentSessionById,
  tabs: (target, owner) => {
    const tab = findStructuredAgentSessionTab(useAppStore.getState().unifiedTabsByWorktree, {
      workspaceId: target.worktreeId,
      sessionId: target.sessionId,
      target: owner
    })
    return tab ? [{ id: tab.id, sessionId: tab.entityId, agent: tab.agentSessionAgent }] : []
  },
  refresh: refreshStructuredSessionTabs,
  reveal: revealStructuredSession,
  ...structuredSessionOpenFeedback
}

/** Read only structuredSession so history clicks and drag payloads follow the same reveal path. */
export async function activateAiVaultStructuredSession(
  session: Pick<AiVaultSession, 'structuredSession'> & { agent?: string },
  deps: StructuredSessionActivationDeps = defaultDeps,
  target?: RuntimeClientTarget
): Promise<boolean> {
  const structured = session.structuredSession
  if (!structured) {
    return false
  }
  // Coalesce clicks across refresh/probe/reveal timeouts to avoid duplicate sequences and toasts.
  const hostKey = executionHostIdForStructuredTarget(
    target ??
      runtimeTargetForOwnerEnvironment(
        runtimeEnvironmentIdOrLocalUnlessTwin(useAppStore.getState(), structured.workspaceId)
      )
  )
  const key = `${hostKey}\0${structured.workspaceId}\0${structured.sessionId}`
  const inFlight = activationsInFlight.get(key)
  if (inFlight) {
    return inFlight
  }
  const activation = activateStructuredSession(structured, deps, target, session.agent)
  activationsInFlight.set(key, activation)
  try {
    return await activation
  } finally {
    activationsInFlight.delete(key)
  }
}

const activationsInFlight = new Map<string, Promise<boolean>>()

export async function openDesktopStructuredSession(
  source: StructuredSessionOpenSource,
  host?: RuntimeClientTarget,
  deps: StructuredSessionActivationDeps = defaultDeps,
  locate?: StructuredSessionOpenDeps['locate']
): Promise<StructuredSessionOpenResult> {
  const seedWorkspace =
    source.kind === 'history'
      ? source.structuredSession.workspaceId
      : source.kind === 'notification'
        ? source.worktreeId
        : source.fallback?.worktreeId
  const owner =
    host ??
    runtimeTargetForOwnerEnvironment(
      runtimeEnvironmentIdOrLocalUnlessTwin(useAppStore.getState(), seedWorkspace ?? '')
    )
  const result = await openStructuredAgentSession(source, {
    locate:
      locate ??
      (async (address, messageIds) => {
        try {
          return await withStructuredSessionRestoreTimeout(
            callRuntimeRpc<OrchestrationPartyLocationResult>(
              owner,
              'orchestration.partyLocation',
              { address, ...(messageIds.length ? { messageIds } : {}) },
              { timeoutMs: STRUCTURED_SESSION_RESTORE_TIMEOUT_MS }
            )
          )
        } catch (error) {
          return structuredSessionOpenFailure(error)
        }
      }),
    tabs: (target) => deps.tabs(target, owner),
    activate: (tab, target) =>
      deps
        .tabs(target, owner)
        .some((row) => row.id === tab.id && row.sessionId === target.sessionId) &&
      deps.activate({ ...target, target: owner }),
    refresh: (target) => deps.refresh(target.worktreeId, owner),
    reveal: async (target) => {
      const outcome = await deps.reveal({ ...target, target: owner })
      return typeof outcome === 'object'
        ? outcome
        : {
            reason: outcome === 'host-cannot-open' ? 'unsupported' : outcome,
            beforeEffects: outcome !== 'unreachable'
          }
    }
  })
  if (result.kind === 'opened') {
    const workspace = result.target.worktreeId
    if (
      useAppStore.getState().activeWorktreeId !== workspace &&
      !activateWslMovedWorkspace(workspace)
    ) {
      activateAndRevealWorktree(workspace)
    }
  } else if (result.kind === 'failed') {
    const agent = source.kind === 'sender' ? (source.displayName ?? '') : (source.agent ?? '')
    if (result.failure.reason === 'gone') {
      if (result.failure.surface === 'terminal') {
        showAgentPaneUnavailable()
      } else {
        deps.gone(agent)
      }
    } else if (result.failure.reason === 'unsupported') {
      deps.hostCannotOpen(agent)
    } else {
      deps.unavailable(agent)
    }
  }
  return result
}

async function activateStructuredSession(
  structured: NonNullable<AiVaultSession['structuredSession']>,
  deps: StructuredSessionActivationDeps,
  host?: RuntimeClientTarget,
  agent?: string
): Promise<boolean> {
  await openDesktopStructuredSession(
    { kind: 'history', structuredSession: structured, agent },
    host,
    deps
  )
  return true
}

/** Only revealed promises a tab; preserve distinct retry/missing/update outcomes for the other replies. */
export async function revealStructuredSession(target: {
  worktreeId: string
  sessionId: string
  target?: RuntimeClientTarget
}): Promise<StructuredSessionRevealOutcome> {
  const host =
    target.target ??
    runtimeTargetForOwnerEnvironment(
      runtimeEnvironmentIdOrLocalUnlessTwin(useAppStore.getState(), target.worktreeId)
    )
  // Probe the answering paired host’s build; the local host shares this build and needs no probe.
  if (host.kind === 'environment') {
    let supported: boolean
    try {
      // Race even cached probe promises: an older unbounded probe must not hold the session’s in-flight guard forever.
      supported = await withStructuredSessionRestoreTimeout(
        runtimeEnvironmentSupportsCapability(
          host.environmentId,
          STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY,
          STRUCTURED_SESSION_RESTORE_TIMEOUT_MS
        )
      )
    } catch (error) {
      // Only a version block proves age; other probe failures say nothing about the chat (as in remote-agent-session-launch).
      return isRuntimeCompatBlockError(error) ? 'host-cannot-open' : 'unreachable'
    }
    if (!supported) {
      return 'host-cannot-open'
    }
  }
  let result: AgentSessionRevealReply | undefined
  try {
    result = await withStructuredSessionRestoreTimeout(
      callRuntimeRpc<AgentSessionRevealReply>(
        host,
        'agentSession.reveal',
        { sessionId: target.sessionId },
        {
          timeoutMs: STRUCTURED_SESSION_RESTORE_TIMEOUT_MS
        }
      )
    )
  } catch {
    return 'unreachable'
  }
  if (result?.ok === true) {
    return { sessionId: result.sessionId, worktreeId: result.workspaceId, agent: result.agent }
  }
  // Distinguish a missing record from an existing record the host cannot open; only the first means gone.
  return result?.refusal?.code === 'agent_session_identity_required' ? 'gone' : 'host-cannot-open'
}

type AgentSessionRevealReply =
  | { ok: true; sessionId: string; workspaceId: string; agent: string }
  | { ok: false; refusal: { code?: string } }

async function refreshStructuredSessionTabs(
  worktreeId: string,
  target?: RuntimeClientTarget
): Promise<void> {
  const state = useAppStore.getState()
  const host =
    target ??
    runtimeTargetForOwnerEnvironment(runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId))
  if (host.kind === 'local') {
    await withStructuredSessionRestoreTimeout(refreshLocalStructuredSessionWorktreeTabs(worktreeId))
    return
  }
  // Paired inventories arrive through their existing host-scoped subscription.
  await withStructuredSessionRestoreTimeout(
    callRuntimeRpc(
      host,
      'session.tabs.list',
      { worktree: toRuntimeWorktreeSelector(worktreeId) },
      { timeoutMs: STRUCTURED_SESSION_RESTORE_TIMEOUT_MS }
    )
  )
}

async function withStructuredSessionRestoreTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('structured_session_restore_timeout')),
          STRUCTURED_SESSION_RESTORE_TIMEOUT_MS
        )
      })
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
