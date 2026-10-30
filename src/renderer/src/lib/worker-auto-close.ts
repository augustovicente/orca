import { useCallback, useEffect, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  formatWorkerAutoCloseCountdown,
  readWorkerAutoCloseReply,
  WORKER_AUTO_CLOSE_IDLE_POLL_MS,
  WORKER_AUTO_CLOSE_POLL_MS,
  type WorkerAutoCloseState
} from '../../../shared/worker-auto-close'

/** A terminal pane, or a chat named by session: its owning host resolves the pane credential. */
export type WorkerAutoCloseSubject = { paneKey: string } | { sessionId: string }

// An older host has no such method; reuse its failure so the strip just stays away.
const RPC_OPTIONS = { suppressFeatureInteraction: true, reuseRecentCompatibilityFailure: true }

export function readWorkerAutoClose(
  target: RuntimeClientTarget,
  subject: WorkerAutoCloseSubject
): Promise<WorkerAutoCloseState | null> {
  return callRuntimeRpc<unknown>(target, 'orchestration.workerAutoClose', subject, RPC_OPTIONS)
    .then(readWorkerAutoCloseReply)
    .catch(() => null)
}

export function setWorkerKeptOpen(
  target: RuntimeClientTarget,
  subject: WorkerAutoCloseSubject,
  keep: boolean
): Promise<WorkerAutoCloseState | null> {
  return callRuntimeRpc<unknown>(
    target,
    'orchestration.workerKeepOpen',
    { ...subject, keep },
    RPC_OPTIONS
  ).then(readWorkerAutoCloseReply)
}

/** The host's auto-close state for a shown worker, re-read while `active`, plus the clock its countdown ticks on. */
export function useWorkerAutoClose(
  target: RuntimeClientTarget | null,
  subject: WorkerAutoCloseSubject | null,
  active: boolean
): { state: WorkerAutoCloseState | null; nowMs: number; keepOpen: () => void } {
  const [state, setState] = useState<WorkerAutoCloseState | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const key = target && subject ? JSON.stringify([target, subject]) : null

  useEffect(() => {
    setState(null)
    if (!key || !active || !target || !subject) {
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = (): void => {
      void readWorkerAutoClose(target, subject).then((next) => {
        if (cancelled) {
          return
        }
        setState(next)
        const temporary = next !== null && !next.kept
        timer = setTimeout(
          poll,
          temporary ? WORKER_AUTO_CLOSE_POLL_MS : WORKER_AUTO_CLOSE_IDLE_POLL_MS
        )
      })
    }
    poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- key covers target and subject by value.
  }, [key, active])

  const ticking = state !== null && !state.kept && state.closesAt !== null
  useEffect(() => {
    if (!ticking) {
      return
    }
    setNowMs(Date.now())
    const interval = setInterval(() => setNowMs(Date.now()), 1_000)
    return () => clearInterval(interval)
  }, [ticking])

  const keepOpen = useCallback(() => {
    if (target && subject) {
      setState({ kept: true })
      void setWorkerKeptOpen(target, subject, true).then(setState, () => setState(null))
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- key covers target and subject by value.
  }, [key])

  return { state, nowMs, keepOpen }
}

/** The strip's line; null when no strip shows (kept open, or nothing closes the worker). */
export function workerAutoCloseStripText(
  state: WorkerAutoCloseState | null,
  nowMs: number
): string | null {
  if (!state || state.kept) {
    return null
  }
  return state.closesAt === null
    ? translate(
        'components.orchestration.workerAutoClose.running',
        'Temporary orchestration worker · Closes 2 minutes after it finishes'
      )
    : translate(
        'components.orchestration.workerAutoClose.finished',
        'Temporary orchestration worker finished · Closes in {{countdown}}',
        { countdown: formatWorkerAutoCloseCountdown(state.closesAt, nowMs) }
      )
}

export function workerKeepOpenLabel(): string {
  return translate('components.orchestration.workerAutoClose.keepOpen', 'Keep open')
}
