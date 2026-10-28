import { describe, it, expect } from 'vitest'
import { applyWhitelabelSeed } from './whitelabel-seed'
import type { GlobalSettings } from '../../shared/global-settings-types'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture partial.
const base = { disabledTuiAgents: [], defaultTuiAgent: null } as unknown as GlobalSettings

describe('applyWhitelabelSeed', () => {
  it('is a no-op when profile is null', () => {
    const { applied } = applyWhitelabelSeed(base, null)
    expect(applied).toBe(false)
  })

  it('applies overrides once', () => {
    const profile = {
      formatVersion: 1,
      version: 1,
      settingsOverrides: { defaultTuiAgent: 'opencode' as const }
    }
    const { settings, applied } = applyWhitelabelSeed(base, profile)
    expect(applied).toBe(true)
    expect(settings.defaultTuiAgent).toBe('opencode')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: runtime field not in base type.
    expect((settings as { whitelabelAppliedVersion?: number }).whitelabelAppliedVersion).toBe(1)
  })

  it('does not re-apply when version already applied', () => {
    const profile = {
      formatVersion: 1,
      version: 1,
      settingsOverrides: { defaultTuiAgent: 'opencode' as const }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture partial.
    const already = { ...base, whitelabelAppliedVersion: 1 } as unknown as GlobalSettings
    const { applied } = applyWhitelabelSeed(already, profile)
    expect(applied).toBe(false)
  })
})
