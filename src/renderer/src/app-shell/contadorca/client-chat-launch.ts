import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../../shared/tui-agent'

const FALLBACK_CHAT_AGENT: TuiAgent = 'opencode'

/** Chat needs a provider even when the developer agent picker is hidden. */
export function defaultClientChatAgent(): TuiAgent {
  const agent = useAppStore.getState().settings?.defaultTuiAgent
  return agent && agent !== 'blank' ? agent : FALLBACK_CHAT_AGENT
}

function showChatUnavailable(): void {
  toast.error(
    translate(
      'contadorca.clientHome.chatUnavailable',
      'Não foi possível abrir a conversa. Confira as configurações de chat.'
    )
  )
}

/** Reuse the app's new-agent-tab launch, forced onto the native chat surface. */
export function startClientConversation(args: { worktreeId: string; prompt?: string }): void {
  const prompt = args.prompt?.trim()
  const result = launchAgentInNewTab({
    requestId: newAgentLaunchRequestId(),
    agent: defaultClientChatAgent(),
    worktreeId: args.worktreeId,
    requestedSurface: 'chat',
    launchSource: 'native_chat',
    ...(prompt ? { prompt, promptDelivery: 'draft' as const } : {}),
    // A declined chat must not silently become a terminal in this edition.
    onStructuredHostDeclined: () => ({ opened: false })
  })
  if (result === null) {
    showChatUnavailable()
    return
  }
  result.structuredSettlement?.then((settlement) => {
    if (settlement.kind === 'failed' && settlement.notified !== true) {
      showChatUnavailable()
    }
  })
}
