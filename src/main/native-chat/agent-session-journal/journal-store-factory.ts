import type { AgentSessionJournalOptions } from './journal-store-contracts'
import { AgentSessionJournal } from './journal-store'

export async function openAgentSessionJournal(
  options: AgentSessionJournalOptions
): Promise<AgentSessionJournal> {
  const journal = new AgentSessionJournal(options)
  try {
    await journal.open()
  } catch (error) {
    // Nobody receives a handle whose open failed; stop its repair timer and drain its writes.
    await journal.close()
    throw error
  }
  return journal
}
