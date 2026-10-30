import { Pin, Timer, TimerOff, UserRound } from 'lucide-react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatPromptSlotNotices } from './NativeChatComposerNotices'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'

// Mocks for the finished-worker strip; copy is the proposal, not shipped strings.
const noop = (): void => {}
function notice(n: Omit<Extract<NativeChatComposerNotice, { kind: 'worker' }>, 'kind' | 'key'>) {
  return defineFixture({
    width: 640,
    render: () => (
      <div className="native-chat-appearance bg-background pb-2">
        <NativeChatPromptSlotNotices notices={[{ kind: 'worker', key: 'worker', ...n }]} />
      </div>
    )
  })
}

export const finished = notice({
  icon: Timer,
  text: "Finished · Auto-close paused while you're viewing.",
  action: { label: 'Keep open', onClick: noop }
})
export const kept = notice({
  icon: Pin,
  text: "Kept open · Close it when you're done.",
  action: { label: 'Allow auto-close', onClick: noop }
})
export const control = notice({
  icon: UserRound,
  text: "You control this worker · The coordinator can't close or reuse it."
})
export const off = notice({
  icon: TimerOff,
  text: 'Finished · Auto-close is off. The coordinator can still close or reuse it.',
  action: { label: 'Keep open', onClick: noop }
})
