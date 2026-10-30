import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import {
  useWorkerAutoClose,
  workerAutoCloseStripText,
  workerKeepOpenLabel
} from '@/lib/worker-auto-close'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { PaneTopWarningBanner } from './PaneTopWarningBanner'

/** Across a temporary orchestration worker's pane: when it closes, and Keep open. */
export function WorkerAutoCloseBanner({
  tabId,
  leafId,
  worktreeId,
  isVisible
}: {
  tabId: string
  leafId: string
  worktreeId: string
  isVisible: boolean
}): React.JSX.Element | null {
  const environmentId = useAppStore((state) =>
    runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId)
  )
  const target = useMemo(
    () =>
      environmentId !== null
        ? { kind: 'environment' as const, environmentId }
        : { kind: 'local' as const },
    [environmentId]
  )
  const subject = useMemo(() => ({ paneKey: makePaneKey(tabId, leafId) }), [tabId, leafId])
  const { state, nowMs, keepOpen } = useWorkerAutoClose(target, subject, isVisible)
  const title = workerAutoCloseStripText(state, nowMs)
  if (!title) {
    return null
  }
  return (
    <PaneTopWarningBanner
      tone="neutral"
      title={title}
      primaryAction={
        <Button type="button" variant="outline" size="xs" onClick={keepOpen}>
          {workerKeepOpenLabel()}
        </Button>
      }
    />
  )
}
