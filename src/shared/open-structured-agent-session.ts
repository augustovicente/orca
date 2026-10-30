import { formatAgentTypeLabel } from './agent-type-label'
import type { OrchestrationPartyLocationResult } from './orchestration-caller-status'

export type StructuredSessionOpenTarget = { sessionId: string; worktreeId: string; agent?: string }
export type StructuredSessionOpenSource =
  | {
      kind: 'history'
      structuredSession: { sessionId: string; workspaceId: string }
      agent?: string
    }
  | ({ kind: 'notification' } & StructuredSessionOpenTarget)
  | {
      kind: 'sender'
      address: string
      messageIds: readonly string[]
      fallback?: StructuredSessionOpenTarget
      agent?: string
    }
export type StructuredSessionOpenFailure = {
  reason: 'gone' | 'unknown' | 'unsupported' | 'unreachable'
  beforeEffects: boolean
}
export type StructuredSessionOpenTab = { id: string; sessionId: string; agent?: string }
export type StructuredSessionOpenResult =
  | { kind: 'opened'; target: StructuredSessionOpenTarget; tab: StructuredSessionOpenTab }
  | { kind: 'terminal'; handle: string }
  | { kind: 'failed'; failure: StructuredSessionOpenFailure }
  | { kind: 'superseded' }

type Located = OrchestrationPartyLocationResult | StructuredSessionOpenFailure
export type StructuredSessionOpenDeps = {
  locate: (address: string, messageIds: readonly string[]) => Promise<Located>
  tabs: (target: StructuredSessionOpenTarget) => readonly StructuredSessionOpenTab[]
  refresh: (target: StructuredSessionOpenTarget) => Promise<void>
  activate: (
    tab: StructuredSessionOpenTab,
    target: StructuredSessionOpenTarget
  ) => boolean | Promise<boolean>
  reveal: (
    target: StructuredSessionOpenTarget
  ) => Promise<StructuredSessionOpenTarget | StructuredSessionOpenFailure>
  current?: () => boolean
}

/** Only explicit unsupported responses prove that a fallback cannot duplicate an applied operation. */
export function structuredSessionOpenFailure(error: unknown): StructuredSessionOpenFailure {
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null
  if (
    code === 'invalid_argument' ||
    code === 'method_not_found' ||
    code === 'forbidden' ||
    code === 'structured_agent_session_unsupported'
  ) {
    return { reason: 'unsupported', beforeEffects: true }
  }
  if (code === 'agent_session_identity_required') {
    return { reason: 'gone', beforeEffects: true }
  }
  return { reason: 'unreachable', beforeEffects: false }
}

export function structuredSessionOpenMessage(
  reason: StructuredSessionOpenFailure['reason'],
  agent: string
): string {
  const chat = `${formatAgentTypeLabel(agent)}'s chat`
  const messages = {
    gone: `${chat} is no longer on this host, so it cannot be reopened here.`,
    unknown: `${chat} could not be found on this host. Reconnect to its computer and try again.`,
    unsupported: `${chat} can't be reopened until Orca is updated.`,
    unreachable: `${chat} is not available yet. Retry in a moment.`
  }
  return messages[reason]
}

export async function resolveStructuredSessionOpenSource(
  source: StructuredSessionOpenSource,
  locate: StructuredSessionOpenDeps['locate']
): Promise<StructuredSessionOpenTarget | StructuredSessionOpenResult> {
  const seed =
    source.kind === 'history'
      ? {
          sessionId: source.structuredSession.sessionId,
          worktreeId: source.structuredSession.workspaceId,
          agent: source.agent
        }
      : source.kind === 'notification'
        ? source
        : source.fallback
  const address = source.kind === 'sender' ? source.address : `orca_session_id:${seed?.sessionId}`
  let found: Located
  try {
    found = await locate(address, source.kind === 'sender' ? source.messageIds : [])
  } catch (error) {
    found = structuredSessionOpenFailure(error)
  }
  if ('reason' in found) {
    if (found.reason === 'unsupported' && seed) {
      return seed
    }
    return { kind: 'failed', failure: found }
  }
  if (!found.location) {
    return {
      kind: 'failed',
      failure: { reason: found.lost ? 'gone' : 'unknown', beforeEffects: true }
    }
  }
  if (found.location.kind === 'terminal') {
    return { kind: 'terminal', handle: found.location.handle }
  }
  if (found.location.kind !== 'chat') {
    return { kind: 'failed', failure: { reason: 'unsupported', beforeEffects: true } }
  }
  return {
    sessionId: found.location.sessionId,
    worktreeId: found.location.worktreeId,
    agent: source.agent
  }
}

/** One policy for desktop and phone: refresh is advisory; reveal repairs missing publication. */
export async function openStructuredAgentSession(
  source: StructuredSessionOpenSource,
  deps: StructuredSessionOpenDeps
): Promise<StructuredSessionOpenResult> {
  const current = () => deps.current?.() !== false
  const resolved = await resolveStructuredSessionOpenSource(source, deps.locate)
  if (!current()) {
    return { kind: 'superseded' }
  }
  if ('kind' in resolved) {
    return resolved
  }
  let target: StructuredSessionOpenTarget = resolved
  const activate = async () => {
    if (!current()) {
      return null
    }
    const tab = deps.tabs(target).find((row) => row.sessionId === target.sessionId)
    return tab && (await deps.activate(tab, target)) ? tab : null
  }
  const refresh = async () => {
    try {
      await deps.refresh(target)
    } catch {
      /* Reveal can repair a failed inventory read. */
    }
  }
  let revealed = false
  const failure = (value: StructuredSessionOpenFailure): StructuredSessionOpenFailure => ({
    ...value,
    beforeEffects: value.beforeEffects && !revealed
  })
  try {
    let tab = await activate()
    if (!tab) {
      await refresh()
      tab = await activate()
      if (!tab && current()) {
        const reply = await deps.reveal(target)
        if (!current()) {
          return { kind: 'superseded' }
        }
        if ('reason' in reply) {
          return { kind: 'failed', failure: failure(reply) }
        }
        revealed = true
        target = reply
        await refresh()
        tab = await activate()
      }
    }
    if (!current()) {
      return { kind: 'superseded' }
    }
    return tab
      ? { kind: 'opened', target, tab }
      : { kind: 'failed', failure: { reason: 'unreachable', beforeEffects: false } }
  } catch (error) {
    return current()
      ? { kind: 'failed', failure: failure(structuredSessionOpenFailure(error)) }
      : { kind: 'superseded' }
  }
}
