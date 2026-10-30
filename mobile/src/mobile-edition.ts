import type { EditionCapability, OrcaEdition } from '../../src/shared/edition'

export type MobileEdition = OrcaEdition

// Driven by Expo's public env at build time; `full` is the safe default for old/unbranded builds.
export function resolveMobileEdition(value: unknown): MobileEdition {
  return value === 'contadorca' ? 'contadorca' : 'full'
}

export const MOBILE_ORCA_EDITION: MobileEdition = resolveMobileEdition(
  process.env.EXPO_PUBLIC_ORCA_EDITION
)

// Aliases mirroring the desktop edition module so callers can use either naming.
export const MOBILE_EDITION_ID = MOBILE_ORCA_EDITION
export const ORCA_MOBILE_EDITION = MOBILE_ORCA_EDITION
export const ORCA_EDITION = MOBILE_ORCA_EDITION
export const ORCA_EDITION_ID = MOBILE_ORCA_EDITION

/**
 * Only the surfaces the accounting edition removes are listed; every other capability stays
 * available so new shared flags do not silently disappear from mobile.
 */
const CONTADORCA_HIDDEN: ReadonlySet<EditionCapability> = new Set<EditionCapability>([
  'gitWorkflows',
  'sourceControl',
  'hostedReview',
  'taskProviders',
  'sshHosts',
  'wslHosts',
  'emulators',
  'agentPicker',
  'automations',
  'artifacts',
  'activity',
  'workspaceSpace',
  'onboarding',
  'dictation',
  'experimental',
  'developerTools',
  'terminalPane',
  'editorTab',
  'diffTab',
  'checksTab',
  'rightSidebar',
  'statusBar',
  'providerUsage',
  'commandPalette',
  'starNag',
  'plugins',
  'devPane',
  'accountsPane',
  'modelPicker',
  'quickCommands',
  'telemetry',
  'ports',
  'resourceUsage',
  'contentInput',
  'notificationsPane',
  'shortcutsPane'
])

export function mobileEditionSupports(
  capability: EditionCapability,
  edition: unknown = MOBILE_ORCA_EDITION
): boolean {
  return resolveMobileEdition(edition) === 'full' || !CONTADORCA_HIDDEN.has(capability)
}

export const editionSupports = mobileEditionSupports

export function isMobileEditionCapabilityAvailable(
  capability: EditionCapability,
  edition: unknown = MOBILE_ORCA_EDITION
): boolean {
  return mobileEditionSupports(capability, edition)
}
