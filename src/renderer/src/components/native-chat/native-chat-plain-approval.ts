import { translate } from '@/i18n/i18n'
import { parseOrcaBrowserCommand } from '../../../../shared/orca-browser-cli-commands'
import { isPlanApprovalSubject } from '../../../../shared/agent-session-approval-subject'
import type { ChatApproval } from '../../../../shared/native-chat-interactive-prompt'

type PlainApprovalIntent = 'browser' | 'file' | 'command' | 'plan' | 'other'

const BROWSER_TITLE =
  /\b(browser|navigate|webfetch|web fetch|open (?:a |the )?(?:site|page|url))\b/i
const FILE_TITLE = /\b(file|files|changes?|patch|write|edit)\b/i
const COMMAND_TITLE = /\b(command|shell|bash|terminal|run)\b/i

function plainApprovalIntent(approval: ChatApproval): PlainApprovalIntent {
  if (isPlanApprovalSubject(approval.subject)) {
    return 'plan'
  }
  if (approval.detail && parseOrcaBrowserCommand(approval.detail) !== null) {
    return 'browser'
  }
  if (BROWSER_TITLE.test(approval.title)) {
    return 'browser'
  }
  if (FILE_TITLE.test(approval.title)) {
    return 'file'
  }
  if (COMMAND_TITLE.test(approval.title)) {
    return 'command'
  }
  if (approval.blockedPath) {
    return 'file'
  }
  return 'other'
}

function plainApprovalHeadline(intent: PlainApprovalIntent): string {
  switch (intent) {
    case 'browser':
      return translate(
        'contadorca.chat.approval.browser',
        'O assistente quer abrir o navegador e acessar um site'
      )
    case 'file':
      return translate('contadorca.chat.approval.file', 'O assistente quer alterar um arquivo')
    case 'command':
      return translate(
        'contadorca.chat.approval.command',
        'O assistente quer executar uma ação no computador'
      )
    case 'plan':
      return translate(
        'contadorca.chat.approval.plan',
        'O assistente quer que você revise o plano antes de continuar'
      )
    case 'other':
      return translate('contadorca.chat.approval.other', 'O assistente quer continuar')
  }
}

const OPTION_LABELS: Record<string, () => string> = {
  allow: () => translate('contadorca.chat.approval.allowOnce', 'Permitir uma vez'),
  'allow for this session': () =>
    translate('contadorca.chat.approval.allowAlways', 'Permitir sempre'),
  approve: () => translate('contadorca.chat.approval.allowOnce', 'Permitir uma vez'),
  deny: () => translate('contadorca.chat.approval.deny', 'Negar'),
  stop: () => translate('contadorca.chat.approval.stop', 'Parar'),
  'approve plan': () => translate('contadorca.chat.approval.approvePlan', 'Aprovar plano'),
  'keep planning': () => translate('contadorca.chat.approval.keepPlanning', 'Continuar planejando'),
  yes: () => translate('contadorca.chat.approval.yes', 'Sim'),
  no: () => translate('contadorca.chat.approval.no', 'Não'),
  cancel: () => translate('contadorca.chat.approval.cancelOption', 'Cancelar')
}

/** Display-only wording: each option keeps the transport token the host sent. */
function plainApprovalOptionLabel(label: string): string {
  return OPTION_LABELS[label.trim().toLowerCase()]?.() ?? label
}

export type PlainChatApproval = {
  headline: string
  options: ChatApproval['options']
}

export function plainChatApproval(approval: ChatApproval): PlainChatApproval {
  return {
    headline: plainApprovalHeadline(plainApprovalIntent(approval)),
    options: approval.options.map((option) => ({
      ...option,
      label: plainApprovalOptionLabel(option.label)
    }))
  }
}
