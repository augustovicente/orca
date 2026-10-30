import { describe, expect, it } from 'vitest'
import {
  CLIENT_FIRST_RUN_WIZARD_STORAGE_KEY,
  readClientFirstRunWizardDismissed,
  shouldShowClientFirstRunWizard,
  writeClientFirstRunWizardDismissed
} from './first-run-wizard'

const FIRST_RUN = {
  customerShell: true,
  clientCount: 0,
  hasConversation: false,
  dismissed: false
}

describe('shouldShowClientFirstRunWizard', () => {
  it('shows on a customer-shell first run', () => {
    expect(shouldShowClientFirstRunWizard(FIRST_RUN)).toBe(true)
  })

  it.each([
    ['another edition', { customerShell: false }],
    ['a client folder exists', { clientCount: 1 }],
    ['a conversation exists', { hasConversation: true }],
    ['the wizard was dismissed', { dismissed: true }]
  ])('hides with %s', (_label, override) => {
    expect(shouldShowClientFirstRunWizard({ ...FIRST_RUN, ...override })).toBe(false)
  })
})

describe('client first-run dismissal', () => {
  it('remembers a dismissal', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      }
    }
    expect(readClientFirstRunWizardDismissed(storage)).toBe(false)
    writeClientFirstRunWizardDismissed(storage)
    expect(values.get(CLIENT_FIRST_RUN_WIZARD_STORAGE_KEY)).toBe('1')
    expect(readClientFirstRunWizardDismissed(storage)).toBe(true)
  })
})
