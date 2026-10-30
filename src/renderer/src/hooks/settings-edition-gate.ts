import type { SettingsNavTarget } from '@/lib/settings-navigation-types'
import { CONTADORCA_SETTINGS_COMMAND_ALLOWLIST } from '@/components/cmd-j/edition-command-allowlist'
import { editionSupports, ORCA_EDITION_ID, type EditionCapability } from '../../../shared/edition'

const SECTION_CAPABILITY_TUPLES: [SettingsNavTarget, EditionCapability][] = [
  ['git', 'gitWorkflows'],
  ['tasks', 'taskProviders'],
  ['linear', 'taskProviders'],
  ['integrations', 'hostedReview'],
  ['ssh', 'sshHosts'],
  ['servers', 'sshHosts'],
  ['orchestration', 'agentPicker'],
  ['agents', 'agentPicker'],
  ['accounts', 'accountsPane'],
  ['artifacts', 'artifacts'],
  ['automations', 'automations'],
  ['share-skills', 'artifacts'],
  ['orca-account', 'artifacts'],
  ['session-history', 'artifacts'],
  ['voice', 'dictation'],
  ['mobile-emulator', 'emulators'],
  ['experimental', 'experimental'],
  ['developer-permissions', 'developerTools'],
  ['stats', 'developerTools'],
  ['dev', 'developerTools'],
  ['setup-guide', 'onboarding'],
  ['terminal', 'terminalPane'],
  ['quick-commands', 'quickCommands'],
  ['plugins', 'plugins'],
  ['floating-workspace', 'terminalPane'],
  ['input', 'contentInput'],
  ['notifications', 'notificationsPane'],
  ['shortcuts', 'shortcutsPane']
]

const SECTION_CAPABILITY = new Map<string, EditionCapability>(SECTION_CAPABILITY_TUPLES)

/** Sections without a capability stay reachable in every edition; repo-* panes always do. */
export function isSettingsSectionAvailable(sectionId: string): boolean {
  if (sectionId.startsWith('repo-')) {
    return true
  }
  // Why: the accounting edition is an explicit allowlist so new panes stay out by default.
  if (ORCA_EDITION_ID === 'contadorca') {
    return CONTADORCA_SETTINGS_COMMAND_ALLOWLIST.has(sectionId)
  }
  const capability = SECTION_CAPABILITY.get(sectionId)
  return capability === undefined || editionSupports(capability)
}
