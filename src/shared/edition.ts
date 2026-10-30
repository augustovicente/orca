import type { TopLevelView } from './ui-chrome-types'

// Substituted by electron.vite.config.ts; absent in tests, the CLI, the web client and mobile.
declare const ORCA_EDITION: 'full' | 'contadorca' | undefined

export type OrcaEdition = 'full' | 'contadorca'

export const ORCA_EDITION_ID: OrcaEdition =
  // oxlint-disable-next-line unicorn/no-typeof-undefined -- undeclared outside electron-vite builds; a bare read throws.
  typeof ORCA_EDITION !== 'undefined' && ORCA_EDITION === 'contadorca' ? 'contadorca' : 'full'

/** Surfaces an edition may ship. Keep this the single source of truth for gating. */
export type EditionCapabilities = {
  gitWorkflows: boolean
  sourceControl: boolean
  hostedReview: boolean
  taskProviders: boolean
  sshHosts: boolean
  wslHosts: boolean
  emulators: boolean
  agentPicker: boolean
  automations: boolean
  artifacts: boolean
  activity: boolean
  workspaceSpace: boolean
  onboarding: boolean
  computerUse: boolean
  browser: boolean
  skills: boolean
  mobile: boolean
  dictation: boolean
  experimental: boolean
  developerTools: boolean
}

export type EditionCapability = keyof EditionCapabilities

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

/** Accounting firm edition: files, portals, GUI automation and chat; no software-development surface. */
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

const CAPABILITIES_BY_EDITION: Record<OrcaEdition, EditionCapabilities> = {
  full: FULL_CAPABILITIES,
  contadorca: CONTADORCA_CAPABILITIES
}

export function editionSupports(
  capability: EditionCapability,
  edition: OrcaEdition = ORCA_EDITION_ID
): boolean {
  return CAPABILITIES_BY_EDITION[edition][capability]
}

const VIEW_CAPABILITY: Partial<Record<TopLevelView, EditionCapability>> = {
  tasks: 'taskProviders',
  automations: 'automations',
  artifacts: 'artifacts',
  activity: 'activity',
  space: 'workspaceSpace',
  skills: 'skills',
  mobile: 'mobile'
}

export function isTopLevelViewAvailable(
  view: TopLevelView,
  edition: OrcaEdition = ORCA_EDITION_ID
): boolean {
  const capability = VIEW_CAPABILITY[view]
  return capability === undefined || editionSupports(capability, edition)
}

/** Persisted views from a wider edition must not render a blank page. */
export function resolveTopLevelView(
  view: TopLevelView,
  edition: OrcaEdition = ORCA_EDITION_ID
): TopLevelView {
  return isTopLevelViewAvailable(view, edition) ? view : 'terminal'
}
