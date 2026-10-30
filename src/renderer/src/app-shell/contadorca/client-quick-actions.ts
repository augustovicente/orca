import { translate } from '@/i18n/i18n'

export type ClientQuickAction = {
  id: string
  label: string
  prompt: string
}

/** Routine shortcuts only; the prompt text is the whole behaviour. */
export function clientQuickActions(): readonly ClientQuickAction[] {
  return [
    {
      id: 'import-statement',
      label: translate('contadorca.clientHome.quickActions.importStatement', 'Importar extrato'),
      prompt: translate(
        'contadorca.clientHome.quickActions.importStatementPrompt',
        'Importe o extrato bancário desta pasta e liste as movimentações encontradas para conferência.'
      )
    },
    {
      id: 'reconcile-bank',
      label: translate('contadorca.clientHome.quickActions.reconcileBank', 'Conciliar banco'),
      prompt: translate(
        'contadorca.clientHome.quickActions.reconcileBankPrompt',
        'Concilie as movimentações do extrato com os lançamentos deste cliente e mostre as divergências.'
      )
    },
    {
      id: 'process-invoices',
      label: translate('contadorca.clientHome.quickActions.processInvoices', 'Processar notas'),
      prompt: translate(
        'contadorca.clientHome.quickActions.processInvoicesPrompt',
        'Processe as notas fiscais desta pasta e organize os lançamentos por competência.'
      )
    },
    {
      id: 'issue-guide',
      label: translate('contadorca.clientHome.quickActions.issueGuide', 'Emitir guia'),
      prompt: translate(
        'contadorca.clientHome.quickActions.issueGuidePrompt',
        'Calcule e prepare a guia de impostos do período atual deste cliente.'
      )
    },
    {
      id: 'organize-spreadsheet',
      label: translate(
        'contadorca.clientHome.quickActions.organizeSpreadsheet',
        'Organizar planilha'
      ),
      prompt: translate(
        'contadorca.clientHome.quickActions.organizeSpreadsheetPrompt',
        'Organize as planilhas desta pasta e aponte inconsistências nos lançamentos.'
      )
    }
  ]
}
