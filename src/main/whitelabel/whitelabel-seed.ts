import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'

export type WhitelabelProfile = {
  formatVersion: number
  version: number
  brand?: { productName?: string; appId?: string; supportEmail?: string }
  /** Edition invariants: enforced on every load, never user-editable. */
  locked?: Partial<GlobalSettings>
  /** Applied only when the persisted key is absent (undefined). */
  defaults?: Partial<GlobalSettings>
  /** Legacy shape: parsed as `defaults` (fill-if-absent) for migration. */
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

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true
  }
  if (left === null || right === null) {
    return false
  }
  if (typeof left !== 'object' || typeof right !== 'object') {
    return false
  }
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

// Seed semantics: `locked` is enforced every load; `defaults` fill absent keys only.
export function applyWhitelabelSeed(
  settings: GlobalSettings,
  profile: WhitelabelProfile | null
): { settings: GlobalSettings; applied: boolean } {
  if (!profile) {
    return { settings, applied: false }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mutable working copy.
  const next = { ...settings } as GlobalSettings & { whitelabelAppliedVersion?: number }
  let changed = false

  const locked = profile.locked
  if (locked) {
    for (const [key, desired] of Object.entries(locked)) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dynamic key from profile.
      const typedKey = key as keyof GlobalSettings
      if (!valuesEqual(next[typedKey], desired)) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dynamic key from profile.
        ;(next as Record<string, unknown>)[key] = desired
        changed = true
      }
    }
  }

  const defaultsSource = profile.defaults ?? profile.settingsOverrides
  if (defaultsSource) {
    for (const [key, desired] of Object.entries(defaultsSource)) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dynamic key from profile.
      const typedKey = key as keyof GlobalSettings
      if (next[typedKey] === undefined) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dynamic key from profile.
        ;(next as Record<string, unknown>)[key] = desired
        changed = true
      }
    }
  }

  // Migration bookkeeping only: never gates defaults/locked application.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: runtime field not in base type.
  const appliedVersion = (next as GlobalSettings & { whitelabelAppliedVersion?: number })
    .whitelabelAppliedVersion
  if (appliedVersion !== profile.version) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: runtime field not in base type.
    ;(next as GlobalSettings & { whitelabelAppliedVersion?: number }).whitelabelAppliedVersion =
      profile.version
    changed = true
  }

  if (!changed) {
    return { settings, applied: false }
  }
  return { settings: next, applied: true }
}
