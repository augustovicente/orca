import type { SettingsNavTarget } from '@/lib/settings-navigation-types'
import { editionSupports, type EditionCapability } from '../../../shared/edition'

const SECTION_CAPABILITY_TUPLES: [SettingsNavTarget, EditionCapability][] = [
  ['git', 'gitWorkflows'],
  ['tasks', 'taskProviders'],
  ['linear', 'taskProviders'],
  ['integrations', 'hostedReview'],
  ['ssh', 'sshHosts'],
  ['servers', 'sshHosts'],
  ['orchestration', 'agentPicker'],
  ['artifacts', 'artifacts'],
  ['automations', 'automations'],
  ['share-skills', 'artifacts'],
  ['orca-account', 'artifacts'],
  ['voice', 'dictation'],
  ['mobile-emulator', 'emulators'],
  ['experimental', 'experimental'],
  ['developer-permissions', 'developerTools'],
  ['stats', 'developerTools'],
  ['setup-guide', 'onboarding']
]

const SECTION_CAPABILITY = new Map<string, EditionCapability>(SECTION_CAPABILITY_TUPLES)

/** Sections without a capability stay reachable in every edition; repo-* panes always do. */
export function isSettingsSectionAvailable(sectionId: string): boolean {
  const capability = SECTION_CAPABILITY.get(sectionId)
  return capability === undefined || editionSupports(capability)
}
