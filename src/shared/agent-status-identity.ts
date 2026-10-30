import {
  normalizeCompatibleAgentTitleForOwner,
  resolveCompatibleAgentTypeForOwner
} from './agent-title-owner'
import { sameAgentStatusTerminalOwner } from './agent-status-terminal-owner'
import type { AgentStatusEntry } from './agent-status-types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  isFreshNonDoneAgentStatus,
  type AgentStatusState,
  type AgentType
} from './agent-status-types'
import {
  hasOtherAgentProcessOwner,
  type AgentProcessIdentity,
  type AgentProcessPresence
} from './agent-process-presence'
import { resolveCanonicalPaneAgentIdentity } from './pane-agent-identity-adapter'
import type { TuiAgent } from './tui-agent'

type ExistingAgentIdentity = {
  agentType?: AgentType
  state: AgentStatusState
  updatedAt: number
  restoredUnconfirmed?: boolean
  agentPresence?: AgentProcessPresence
}

type AgentIdentityResolution = {
  agentType: AgentType
  inheritedFromActivePane: boolean
}

export function shouldSuppressInheritedTerminalStatus(args: {
  inheritedFromActivePane: boolean
}): boolean {
  // Nested CLIs inherit the pane key, but own neither its turn nor its children.
  return args.inheritedFromActivePane
}

function normalizedKnownAgentType(agentType: AgentType | null | undefined): AgentType | null {
  if (!agentType || agentType === 'unknown') {
    return null
  }
  return agentType
}

function isActiveExistingIdentity(
  existing: ExistingAgentIdentity,
  now: number,
  staleAfterMs: number
): boolean {
  return isFreshNonDoneAgentStatus(existing, now, staleAfterMs)
}

type PaneIdentityState = {
  paneForegroundAgentByPaneKey: Record<
    string,
    {
      agent: AgentType | null
      agentEvidence?: string
      shellForeground: boolean
    }
  >
  agentStatusByPaneKey: Record<string, { agentType?: AgentType }>
  agentLaunchConfigByPaneKey: Record<string, { identity?: { agentType?: AgentType } }>
  recentlyRetiredAgentStatusPaneKeys: Record<string, unknown>
}

/** Applied launch and accepted hook identity span inconclusive reads; shell proof and retirement end applicability. */
export function resolveAgentStatusPaneEvidence(state: PaneIdentityState, paneKey: string) {
  const foreground = state.paneForegroundAgentByPaneKey[paneKey]
  if (
    state.recentlyRetiredAgentStatusPaneKeys[paneKey] !== undefined ||
    foreground?.shellForeground
  ) {
    return {}
  }
  const hook = state.agentStatusByPaneKey[paneKey]?.agentType
  const processAgent = foreground?.agentEvidence === 'process-read' ? foreground.agent : undefined
  const launchAgent =
    foreground?.agentEvidence === 'launch-record'
      ? (foreground.agent ?? undefined)
      : state.agentLaunchConfigByPaneKey[paneKey]?.identity?.agentType
  return { processAgent, launchAgent, hookAgent: hook === 'unknown' ? undefined : hook }
}

export function resolveAgentStatusPaneOwner(
  state: PaneIdentityState,
  paneKey: string
): AgentType | undefined {
  const { processAgent, launchAgent, hookAgent } = resolveAgentStatusPaneEvidence(state, paneKey)
  return processAgent ?? resolveCompatibleAgentTypeForOwner(hookAgent, launchAgent) ?? launchAgent
}

/** Resolve accepted identity and title together while keeping reporter ownership raw at admission. */
export function resolveAgentStatusFrameIdentity(args: {
  existing?: AgentStatusEntry
  incoming?: AgentType
  incomingOwner?: AgentProcessPresence
  incomingSession?: string
  observedAgentType?: AgentType
  terminalOwner: { connectionId: string | null; worktreeId?: string }
  terminalTitle?: string
  now: number
}) {
  const existing = args.existing
  const reportedTitle = args.terminalTitle ?? existing?.terminalTitle
  return {
    ...resolveAgentStatusIdentity({
      ...args,
      existing:
        existing &&
        sameAgentStatusTerminalOwner(
          { connectionId: existing.connectionId ?? null, worktreeId: existing.worktreeId },
          args.terminalOwner
        )
          ? { ...existing, agentPresence: args.incomingOwner }
          : undefined
    }),
    terminalTitle: reportedTitle
      ? normalizeCompatibleAgentTitleForOwner(reportedTitle, args.observedAgentType)
      : reportedTitle
  }
}

export function resolveAgentStatusIdentity(args: {
  existing?: ExistingAgentIdentity
  incoming?: AgentType
  incomingProcess?: AgentProcessIdentity
  incomingSession?: string
  observedAgentType?: AgentType
  now: number
  staleAfterMs?: number
}): AgentIdentityResolution {
  const staleAfterMs = args.staleAfterMs ?? AGENT_STATUS_STALE_AFTER_MS
  const existingAgentType = normalizedKnownAgentType(
    resolveCompatibleAgentTypeForOwner(args.existing?.agentType, args.observedAgentType)
  )
  const incomingAgentType = normalizedKnownAgentType(
    resolveCompatibleAgentTypeForOwner(args.incoming, args.observedAgentType)
  )

  if (!incomingAgentType) {
    return {
      agentType: existingAgentType ?? 'unknown',
      inheritedFromActivePane: false
    }
  }
  if (!args.existing || !existingAgentType) {
    return {
      agentType: incomingAgentType,
      inheritedFromActivePane: false
    }
  }
  const otherProcessOwner = hasOtherAgentProcessOwner(args.existing.agentPresence, {
    agent: args.incoming ?? incomingAgentType,
    process: args.incomingProcess
  })
  if (existingAgentType === incomingAgentType) {
    return {
      agentType: incomingAgentType,
      // Why: a nested `claude -p` shares the pane key; only the owner's own process speaks for it.
      inheritedFromActivePane: otherProcessOwner
    }
  }
  const owner = args.existing.agentPresence
  if (
    owner?.session &&
    !owner.ended &&
    owner.agent === args.incoming &&
    owner.session === args.incomingSession &&
    !otherProcessOwner
  ) {
    // Why: a child that posted while the owner idled must not silence the owner's own session.
    return { agentType: incomingAgentType, inheritedFromActivePane: false }
  }
  const canonical = resolveCanonicalPaneAgentIdentity({
    hookAgent: incomingAgentType as TuiAgent,
    hookIsLive: true,
    completedHookAgent: args.existing.state === 'done' ? (existingAgentType as TuiAgent) : undefined
  })
  if (
    !args.existing.agentPresence?.suspended &&
    (otherProcessOwner || isActiveExistingIdentity(args.existing, args.now, staleAfterMs))
  ) {
    return {
      // Inherited ORCA_PANE_KEY does not grant child CLI ownership; idle leaves foreground process/resume identity intact.
      agentType: existingAgentType,
      inheritedFromActivePane: true
    }
  }

  return {
    agentType: canonical.agent ?? incomingAgentType,
    inheritedFromActivePane: false
  }
}
