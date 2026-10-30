import type { EditionCapabilities, EditionCapability, OrcaEdition } from '../../src/shared/edition'

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

const FULL_CAPABILITIES: EditionCapabilities = {
  gitWorkflows: true,
  sourceControl: true,
  hostedReview: true,
  taskProviders: true,
  sshHosts: true,
  wslHosts: true,
  emulators: true,
  agentPicker: true,
  automations: true,
  artifacts: true,
  activity: true,
  workspaceSpace: true,
  onboarding: true,
  computerUse: true,
  browser: true,
  skills: true,
  mobile: true,
  dictation: true,
  experimental: true,
  developerTools: true
}

const CONTADORCA_CAPABILITIES: EditionCapabilities = {
  ...FULL_CAPABILITIES,
  gitWorkflows: false,
  sourceControl: false,
  hostedReview: false,
  taskProviders: false,
  sshHosts: false,
  wslHosts: false,
  emulators: false,
  agentPicker: false,
  automations: false,
  artifacts: false,
  activity: false,
  workspaceSpace: false,
  onboarding: false,
  dictation: false,
  experimental: false,
  developerTools: false
}

const CAPABILITIES_BY_EDITION: Record<MobileEdition, EditionCapabilities> = {
  full: FULL_CAPABILITIES,
  contadorca: CONTADORCA_CAPABILITIES
}

export function mobileEditionSupports(
  capability: EditionCapability,
  edition: unknown = MOBILE_ORCA_EDITION
): boolean {
  return CAPABILITIES_BY_EDITION[resolveMobileEdition(edition)][capability]
}

export const editionSupports = mobileEditionSupports

export function isMobileEditionCapabilityAvailable(
  capability: EditionCapability,
  edition: unknown = MOBILE_ORCA_EDITION
): boolean {
  return mobileEditionSupports(capability, edition)
}
