import { useMemo } from 'react'
import {
  useWorkerAutoClose,
  workerAutoCloseStripText,
  workerKeepOpenLabel
} from '@/lib/worker-auto-close'
import { NativeChatWorkerLifetimeStrip } from './NativeChatWorkerLifetimeStrip'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

/** A temporary orchestration worker chat says when it closes, with Keep open, on its composer. */
export function NativeChatStructuredWorkerLifetimeStrip({
  transport: { sessionId, runtimeEnvironmentId },
  isVisible
}: {
  transport: Pick<NativeChatStructuredComposerTransport, 'sessionId' | 'runtimeEnvironmentId'>
  isVisible: boolean
}): React.JSX.Element | null {
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
  return text ? (
    <NativeChatWorkerLifetimeStrip
      text={text}
      keepOpenLabel={workerKeepOpenLabel()}
      onKeepOpen={keepOpen}
    />
  ) : null
}
