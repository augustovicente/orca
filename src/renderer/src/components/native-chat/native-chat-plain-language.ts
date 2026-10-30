import { translate } from '@/i18n/i18n'
import { editionSupports } from '../../../../shared/edition'
import {
  isToolCallBlock,
  type NativeChatBlock,
  type NativeChatToolCallBlock
} from '../../../../shared/native-chat-types'
import {
  nativeChatToolCategory,
  type NativeChatToolCategory
} from '../../../../shared/native-chat/tools/native-chat-tool-icon'

/** Contadorca reads agent work as plain steps; the full edition keeps its shell-precise transcript. */
export function nativeChatUsesPlainLanguage(): boolean {
  return !editionSupports('developerTools')
}

function plainLabelForCategory(category: NativeChatToolCategory | null): string {
  switch (category) {
    case 'unknown':
      return translate('contadorca.chat.tool.command', 'Executando comando')
    case 'read':
      return translate('contadorca.chat.tool.read', 'Lendo arquivo')
    case 'fileChange':
      return translate('contadorca.chat.tool.write', 'Alterando arquivo')
    case 'browser':
      return translate('contadorca.chat.tool.browser', 'Abrindo site')
    case 'search':
    case 'webSearch':
      return translate('contadorca.chat.tool.search', 'Pesquisando')
    case null:
    case 'listFiles':
    case 'mcpToolCall':
    case 'subAgentActivity':
    case 'todoList':
    case 'other':
      return translate('contadorca.chat.tool.step', 'Executando etapa')
  }
}

function plainLabelForCall(call: NativeChatToolCallBlock): string {
  return plainLabelForCategory(nativeChatToolCategory(call.name, call.mcpIdentity, call.input))
}

/** One line names the work in words; the latest call is the step a reader is watching. */
export function plainToolActivityLabel(blocks: readonly NativeChatBlock[]): string {
  const latest = blocks.findLast(isToolCallBlock)
  return latest
    ? plainLabelForCall(latest)
    : translate('contadorca.chat.tool.step', 'Executando etapa')
}

export function plainToolActivityDetailsLabel(): string {
  return translate('contadorca.chat.details', 'Detalhes técnicos')
}

/** A settled run says how it ended; a live one leaves the spinner to speak. */
export function plainToolActivityOutcome(outcome: {
  live: boolean
  succeeded: boolean
  failedCallCount: number
  interruptedCallCount: number
}): string | null {
  if (outcome.live) {
    return null
  }
  if (outcome.failedCallCount > 0) {
    return translate('contadorca.chat.tool.failed', 'Falhou')
  }
  if (outcome.interruptedCallCount > 0) {
    return translate('contadorca.chat.tool.interrupted', 'Interrompido')
  }
  return outcome.succeeded ? translate('contadorca.chat.tool.done', 'Concluído') : null
}
