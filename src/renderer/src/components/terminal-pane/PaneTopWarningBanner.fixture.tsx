import { Pin, Timer, TimerOff, UserRound, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { PaneTopWarningBanner } from './PaneTopWarningBanner'

// Mocks for the finished-worker strip; copy is the proposal, not shipped strings.
function WorkerPane(props: {
  icon: LucideIcon
  title: string
  body?: string
  action?: string
}): React.JSX.Element {
  return (
    <div className="pane relative h-32 bg-background">
      <PaneTopWarningBanner
        tone="neutral"
        icon={props.icon}
        title={props.title}
        body={props.body}
        primaryAction={
          props.action ? (
            <Button type="button" variant="outline" size="xs">
              {props.action}
            </Button>
          ) : null
        }
      />
      <pre className="absolute inset-x-0 bottom-0 px-3 pb-2 font-mono text-xs text-muted-foreground">
        {'$ worker_done --summary "Parser fixed, tests pass"\n$ '}
      </pre>
    </div>
  )
}

const finishedViewing = {
  icon: Timer,
  title: "Finished · Auto-close paused while you're viewing.",
  action: 'Keep open'
}
const keptOpen = {
  icon: Pin,
  title: "Kept open · Close it when you're done.",
  action: 'Allow auto-close'
}
const takenOver = {
  icon: UserRound,
  title: "You control this worker · The coordinator can't close or reuse it."
}
const autoCloseOff = {
  icon: TimerOff,
  title: 'Finished · Auto-close is off. The coordinator can still close or reuse it.',
  action: 'Keep open'
}

export const finished = defineFixture({
  width: 960,
  render: () => <WorkerPane {...finishedViewing} />
})
export const kept = defineFixture({ width: 960, render: () => <WorkerPane {...keptOpen} /> })
export const control = defineFixture({ width: 960, render: () => <WorkerPane {...takenOver} /> })
export const off = defineFixture({ width: 960, render: () => <WorkerPane {...autoCloseOff} /> })
export const finishedNarrow = defineFixture({
  width: 360,
  render: () => <WorkerPane {...finishedViewing} />
})
export const keptNarrow = defineFixture({ width: 360, render: () => <WorkerPane {...keptOpen} /> })
