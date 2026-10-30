import { beforeEach, describe, expect, it, vi } from 'vitest'

const DEVELOPER_ROUTES = [
  'sourceControl',
  'taskProviders',
  'hostedReview',
  'agentPicker',
  'gitWorkflows'
] as const

describe('mobile edition capabilities', () => {
  beforeEach(() => {
    vi.resetModules()
    delete process.env.EXPO_PUBLIC_ORCA_EDITION
  })

  it('shows every developer route in the full edition', async () => {
    const { MOBILE_ORCA_EDITION, mobileEditionSupports } = await import('./mobile-edition')

    expect(MOBILE_ORCA_EDITION).toBe('full')
    for (const capability of DEVELOPER_ROUTES) {
      expect(mobileEditionSupports(capability)).toBe(true)
    }
  })

  it('hides developer routes in the contadorca edition', async () => {
    process.env.EXPO_PUBLIC_ORCA_EDITION = 'contadorca'
    const { MOBILE_ORCA_EDITION, mobileEditionSupports } = await import('./mobile-edition')

    expect(MOBILE_ORCA_EDITION).toBe('contadorca')
    for (const capability of DEVELOPER_ROUTES) {
      expect(mobileEditionSupports(capability)).toBe(false)
    }
    expect(mobileEditionSupports('mobile')).toBe(true)
  })

  it('falls back to the full edition for an unknown value', async () => {
    process.env.EXPO_PUBLIC_ORCA_EDITION = 'accounting'
    const { MOBILE_ORCA_EDITION, resolveMobileEdition, mobileEditionSupports } =
      await import('./mobile-edition')

    expect(resolveMobileEdition('accounting')).toBe('full')
    expect(resolveMobileEdition(undefined)).toBe('full')
    expect(MOBILE_ORCA_EDITION).toBe('full')
    expect(mobileEditionSupports('sourceControl')).toBe(true)
  })

  it('resolves an explicit edition argument, including unknown values', async () => {
    const { mobileEditionSupports } = await import('./mobile-edition')

    expect(mobileEditionSupports('sourceControl', 'full')).toBe(true)
    expect(mobileEditionSupports('sourceControl', 'contadorca')).toBe(false)
    expect(mobileEditionSupports('sourceControl', 'accounting')).toBe(true)
    expect(mobileEditionSupports('sourceControl', undefined)).toBe(true)
  })
})
