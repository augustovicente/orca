import { describe, it, expect } from 'vitest'
import { applyWhitelabelSeed } from './whitelabel-seed'
import type { GlobalSettings } from '../../shared/global-settings-types'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture partial.
const base = { disabledTuiAgents: [], defaultTuiAgent: null } as unknown as GlobalSettings

describe('applyWhitelabelSeed', () => {
  it('is a no-op when profile is null', () => {
    const { settings, applied } = applyWhitelabelSeed(base, null)
    expect(applied).toBe(false)
    expect(settings).toBe(base)
  })

  it('fresh profile: defaults fill absent keys, locked applied', () => {
    const profile = {
      formatVersion: 1,
      version: 1,
      locked: { showTasksButton: false, defaultTuiAgent: 'opencode' as const },
      defaults: { uiLanguage: 'pt' as const }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture partial.
    const settings = { disabledTuiAgents: [], defaultTuiAgent: null } as unknown as GlobalSettings
    const { settings: next, applied } = applyWhitelabelSeed(settings, profile)
    expect(applied).toBe(true)
    expect(next.showTasksButton).toBe(false)
    expect(next.defaultTuiAgent).toBe('opencode')
    expect(next.uiLanguage).toBe('pt')
  })

  it('user overrides a default, profile.version bumps: user value survives', () => {
    const profile = {
      formatVersion: 1,
      version: 2,
      defaults: { uiLanguage: 'pt' as const }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture partial.
    const already = {
      ...base,
      uiLanguage: 'en',
      whitelabelAppliedVersion: 1
    } as unknown as GlobalSettings
    const { settings: next } = applyWhitelabelSeed(already, profile)
    expect(next.uiLanguage).toBe('en')
  })

  it('locked values are re-applied after a version bump even if on disk differs', () => {
    const profile = {
      formatVersion: 1,
      version: 2,
      locked: { showTasksButton: false }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture partial.
    const already = {
      ...base,
      showTasksButton: true,
      whitelabelAppliedVersion: 1
    } as unknown as GlobalSettings
    const { settings: next } = applyWhitelabelSeed(already, profile)
    expect(next.showTasksButton).toBe(false)
  })

  it('legacy settingsOverrides profile: parsed as defaults, does not overwrite existing user value', () => {
    const profile = {
      formatVersion: 1,
      version: 1,
      settingsOverrides: { uiLanguage: 'pt' as const }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture partial.
    const already = { ...base, uiLanguage: 'en' } as unknown as GlobalSettings
    const { settings: next } = applyWhitelabelSeed(already, profile)
    expect(next.uiLanguage).toBe('en')
  })

  it('absent profile: no settings change, applied=false', () => {
    const { settings, applied } = applyWhitelabelSeed(base, null)
    expect(applied).toBe(false)
    expect(settings).toBe(base)
  })
})
