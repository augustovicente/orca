import type { useAppStore } from '@/store'
import { parseLegacyNumericPaneKey } from '../../../../shared/stable-pane-id'
import { getProviderSessionClaimKey } from '@/lib/sleeping-agent-pane-ownership'
import {
  agentProviderSessionsEqual,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'

export const getSleepingRecordForPane = (
  state: ReturnType<typeof useAppStore.getState>,
  binding: { paneKey: string; tabId: string; worktreeId: string; paneId?: number }
): { paneKey: string; record: SleepingAgentSessionRecord } | null => {
  const stableRecord = state.sleepingAgentSessionsByPaneKey[binding.paneKey]
  if (stableRecord) {
    return { paneKey: binding.paneKey, record: stableRecord }
  }
  const legacyMatches = Object.entries(state.sleepingAgentSessionsByPaneKey).filter(
    ([paneKey, record]) => {
      const legacy = parseLegacyNumericPaneKey(paneKey)
      return (
        legacy?.tabId === binding.tabId &&
        record.worktreeId === binding.worktreeId &&
        (!record.tabId || record.tabId === binding.tabId)
      )
    }
  )
  const exactLegacyMatch = legacyMatches.find(([paneKey]) => {
    const legacy = parseLegacyNumericPaneKey(paneKey)
    return legacy?.numericPaneId === String(binding.paneId)
  })
  const providerSessionKeys = new Set(
    legacyMatches.map(([, record]) => getProviderSessionClaimKey(record))
  )
  const oldestLegacyMatch = legacyMatches
    .slice()
    .sort(([, a], [, b]) => a.capturedAt - b.capturedAt || a.updatedAt - b.updatedAt)[0]
  // Why: duplicate legacy aliases can point at one provider session; consume
  // the oldest capture as canonical and clear its aliases after resume.
  const selectedLegacyMatch =
    exactLegacyMatch ??
    (providerSessionKeys.size === 1
      ? legacyMatches.length === 1
        ? legacyMatches[0]
        : oldestLegacyMatch
      : null)
  if (!selectedLegacyMatch) {
    return null
  }
  const [paneKey, record] = selectedLegacyMatch
  return { paneKey, record }
}
export const clearSleepingRecordProviderDuplicates = (
  state: ReturnType<typeof useAppStore.getState>,
  consumed: { paneKey: string; record: SleepingAgentSessionRecord }
): void => {
  state.clearSleepingAgentSession(consumed.paneKey)
  for (const [paneKey, record] of Object.entries(state.sleepingAgentSessionsByPaneKey)) {
    if (
      paneKey !== consumed.paneKey &&
      record.worktreeId === consumed.record.worktreeId &&
      record.agent === consumed.record.agent &&
      agentProviderSessionsEqual(
        record.agent,
        record.providerSession,
        consumed.record.providerSession
      )
    ) {
      // Why: legacy pane aliases can leave multiple sleeping rows for one
      // provider session; once this pane resumes it, every alias is stale.
      state.clearSleepingAgentSession(paneKey)
    }
  }
}
