import { isSessionTabSelectionRequest } from '../../../shared/session-tab-placement'
import type { AgentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'
import { createBrowserUuid } from './browser-uuid'

type Destination = { worktreeId: string; tabId: string }
type Request = {
  token: string
  order: number
  revision: number
  deadline: Pick<AgentSessionSwitchDeadline, 'check'>
  outcome: 'pending' | 'fulfilled' | 'superseded'
  destination?: Destination
}

let lifetime = createBrowserUuid()
let navigationRevision = 0
let actionOrder = 0
let acceptedOrder = 0
let current: Request | undefined

/** Explicit navigation only; automatic layout repair/publication never calls this ingress. */
export function noteViewerNavigation(): void {
  navigationRevision += 1
  if (current) {
    current.outcome = 'superseded'
  }
}

/** Capture before preparation/consent; accepting an older dialog cannot replace a newer action. */
export function beginViewerSelectionRequest(
  invocationId: string,
  deadline: Pick<AgentSessionSwitchDeadline, 'check'>
) {
  const candidate: Request = {
    token: `selection-v1:${lifetime}:${invocationId}:${++actionOrder}`,
    order: actionOrder,
    revision: navigationRevision,
    deadline,
    outcome: 'pending'
  }
  return {
    token: candidate.token,
    accept: () => {
      if (candidate.order <= acceptedOrder) {
        candidate.outcome = 'superseded'
        return
      }
      acceptedOrder = candidate.order
      if (current) {
        current.outcome = 'superseded'
      }
      current = candidate
      if (candidate.revision !== navigationRevision) {
        candidate.outcome = 'superseded'
      }
    },
    discard: () => {
      candidate.outcome = 'superseded'
    }
  }
}

export function viewerSelectionOutcome(token: string): 'pending' | 'fulfilled' | 'superseded' {
  if (!isSessionTabSelectionRequest(token) || current?.token !== token) {
    return 'superseded'
  }
  if (current.outcome === 'pending') {
    try {
      current.deadline.check()
    } catch {
      current.outcome = 'superseded'
    }
    if (current.revision !== navigationRevision) {
      current.outcome = 'superseded'
    }
  }
  return current.outcome
}

/** Called inside the accepted ordinary writer after resolving membership, before its subscribers. */
export function commitViewerSelection(
  token: string,
  destination: Destination,
  apply: () => boolean
): boolean {
  if (viewerSelectionOutcome(token) !== 'pending' || !current) {
    return false
  }
  const request = current
  if (
    request.destination &&
    (request.destination.worktreeId !== destination.worktreeId ||
      request.destination.tabId !== destination.tabId)
  ) {
    return false
  }
  request.destination = destination
  request.outcome = 'fulfilled'
  try {
    if (apply()) {
      return true
    }
  } catch (error) {
    if (current === request) {
      request.outcome = 'pending'
    }
    throw error
  }
  // Missing membership is not success; no state was applied.
  if (current === request && request.outcome === 'fulfilled') {
    request.outcome = 'pending'
  }
  return false
}

/** The ordinary publication owner knows the destination before it can be drawn. */
export function bindViewerSelectionDestination(
  token: string | undefined,
  destination: Destination
): void {
  if (token && viewerSelectionOutcome(token) === 'pending' && current) {
    current.destination ??= destination
  }
}

/** A definite close/withdrawal cannot leave an undrawn destination's selection armed. */
export function endViewerSelectionForDestination(worktreeId: string, tabId: string): void {
  if (current?.destination?.worktreeId === worktreeId && current.destination.tabId === tabId) {
    current.outcome = 'superseded'
  }
}

/** Pointer focus on another pane is navigation; typing/copying in the current pane is not. */
export function noteViewerGroupNavigation(
  state: {
    activeWorktreeId: string | null
    activeGroupIdByWorktree: Record<string, string | undefined>
  },
  worktreeId: string,
  groupId: string
): void {
  if (
    state.activeWorktreeId !== worktreeId ||
    state.activeGroupIdByWorktree[worktreeId] !== groupId
  ) {
    noteViewerNavigation()
  }
}

export function disposeViewerSelection(): void {
  current = undefined
  lifetime = createBrowserUuid()
  navigationRevision = actionOrder = acceptedOrder = 0
}
