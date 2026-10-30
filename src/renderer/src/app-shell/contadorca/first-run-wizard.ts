export const CLIENT_FIRST_RUN_WIZARD_STORAGE_KEY = 'contadorca.clientFirstRunWizard.dismissed.v1'

export type ClientFirstRunFacts = {
  customerShell: boolean
  clientCount: number
  hasConversation: boolean
  dismissed: boolean
}

/** First run means the customer shell has never had a client folder or a conversation. */
export function shouldShowClientFirstRunWizard(facts: ClientFirstRunFacts): boolean {
  return (
    facts.customerShell && !facts.dismissed && facts.clientCount === 0 && !facts.hasConversation
  )
}

type DismissalStorage = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): DismissalStorage | null {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function readClientFirstRunWizardDismissed(
  storage: DismissalStorage | null = defaultStorage()
): boolean {
  try {
    return storage?.getItem(CLIENT_FIRST_RUN_WIZARD_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function writeClientFirstRunWizardDismissed(
  storage: DismissalStorage | null = defaultStorage()
): void {
  try {
    storage?.setItem(CLIENT_FIRST_RUN_WIZARD_STORAGE_KEY, '1')
  } catch {
    // Storage can be unavailable; the wizard still closes for this session.
  }
}
