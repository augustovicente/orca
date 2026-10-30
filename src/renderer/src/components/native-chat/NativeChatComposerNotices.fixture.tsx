import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatPromptSlotNotices } from './NativeChatComposerNotices'

// Mocks for the temporary-worker strip; copy is the owner's, the countdown is frozen at 1:42.
function workerNotice(text: string) {
  return defineFixture({
    width: 640,
    render: () => (
      <div className="native-chat-appearance bg-background pb-2">
        <NativeChatPromptSlotNotices
          notices={[
            {
              kind: 'worker',
              key: 'worker',
              text,
              action: { label: 'Keep open', onClick: () => {} }
            }
          ]}
        />
      </div>
    )
  })
}

export const workerRunning = workerNotice(
  'Temporary orchestration worker · Closes 2 min after it finishes'
)
export const workerFinished = workerNotice(
  'Temporary orchestration worker finished · Closes in 1:42'
)
