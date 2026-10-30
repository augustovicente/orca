import { Button } from '@/components/ui/button'
import { NativeChatComposerTabStrip } from './NativeChatComposerTabStrip'

// Mock only: the strip a temporary orchestration chat worker shows until it is kept open.
export function NativeChatWorkerLifetimeStrip({
  text,
  onKeepOpen
}: {
  text: string
  onKeepOpen: () => void
}): React.JSX.Element {
  return (
    <NativeChatComposerTabStrip data-native-chat-worker-lifetime="">
      <p className="min-w-0 flex-1 truncate py-1 tabular-nums">{text}</p>
      <Button type="button" variant="ghost" size="xs" className="shrink-0" onClick={onKeepOpen}>
        Keep open
      </Button>
    </NativeChatComposerTabStrip>
  )
}
