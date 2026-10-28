import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'

export type WhitelabelProfile = {
  formatVersion: number
  version: number
  brand?: { productName?: string; appId?: string; supportEmail?: string }
  settingsOverrides?: Partial<GlobalSettings>
}

export function loadWhitelabelProfile(resourcesPath: string): WhitelabelProfile | null {
  const profilePath = join(resourcesPath, 'whitelabel', 'profile.json')
  if (!existsSync(profilePath)) {
    return null
  }
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: profile JSON shape validated by caller/defaults.
    return JSON.parse(readFileSync(profilePath, 'utf8')) as WhitelabelProfile
  } catch {
    return null
  }
}

// One-time, versioned seed. Returns updated settings + whether it applied.
export function applyWhitelabelSeed(
  settings: GlobalSettings,
  profile: WhitelabelProfile | null
): { settings: GlobalSettings; applied: boolean } {
  if (!profile) {
    return { settings, applied: false }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: runtime field not in base type.
  const appliedVersion = (settings as GlobalSettings & { whitelabelAppliedVersion?: number })
    .whitelabelAppliedVersion
  if (appliedVersion !== undefined && appliedVersion >= profile.version) {
    return { settings, applied: false }
  }
  const overrides = profile.settingsOverrides ?? {}
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: runtime field not in base type.
  const next = { ...settings, ...overrides } as GlobalSettings & {
    whitelabelAppliedVersion?: number
  }
  next.whitelabelAppliedVersion = profile.version
  return { settings: next, applied: true }
}
