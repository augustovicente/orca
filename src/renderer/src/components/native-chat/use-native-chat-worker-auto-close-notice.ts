import { useMemo } from 'react'
import {
  useWorkerAutoClose,
  workerAutoCloseStripText,
  workerKeepOpenLabel
} from '@/lib/worker-auto-close'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

/** A temporary orchestration worker chat says when it closes, with Keep open, above its composer. */
export function useNativeChatWorkerAutoCloseNotice(
  {
    sessionId,
    runtimeEnvironmentId
  }: Pick<NativeChatStructuredComposerTransport, 'sessionId' | 'runtimeEnvironmentId'>,
  isVisible: boolean
): NativeChatComposerNotice | null {
  const target = useMemo(
    () =>
      runtimeEnvironmentId !== null
        ? { kind: 'environment' as const, environmentId: runtimeEnvironmentId }
        : { kind: 'local' as const },
    [runtimeEnvironmentId]
  )
  const subject = useMemo(() => ({ sessionId }), [sessionId])
  const { state, nowMs, keepOpen } = useWorkerAutoClose(target, subject, isVisible)
  const text = workerAutoCloseStripText(state, nowMs)
  return text
    ? {
        kind: 'worker',
        key: 'worker-auto-close',
        text,
        action: { label: workerKeepOpenLabel(), onClick: keepOpen }
      }
    : null
}
