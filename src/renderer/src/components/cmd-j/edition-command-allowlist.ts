import { editionSupports, type OrcaEdition } from '../../../../shared/edition'

/** Command ids that remain visible in the Contadorca edition of the command palette. */
export const CONTADORCA_SETTINGS_COMMAND_ALLOWLIST = new Set<string>([
  'general',
  'appearance',
  'chat',
  'computer-use',
  'privacy',
  'mobile',
  'advanced'
])

export const CONTADORCA_QUICK_ACTION_ALLOWLIST = new Set<string>([
  'split-chat-right',
  'split-chat-down'
])

export const CONTADORCA_COMMAND_ALLOWLIST = new Set<string>([
  ...[...CONTADORCA_SETTINGS_COMMAND_ALLOWLIST].map((id) => `settings:${id}`),
  ...CONTADORCA_QUICK_ACTION_ALLOWLIST
])

function isAllowedSettingsCommand(commandId: string): boolean {
  // command id format: settings:<sectionId> or settings:<sectionId>:<target>
  const withoutPrefix = commandId.startsWith('settings:')
    ? commandId.slice('settings:'.length)
    : commandId
  const sectionId = withoutPrefix.split(':')[0]
  if (sectionId.startsWith('repo-')) {
    return true
  }
  return CONTADORCA_SETTINGS_COMMAND_ALLOWLIST.has(sectionId)
}

export function isContadorcaCommandAllowed(commandId: string): boolean {
  if (commandId.startsWith('settings:')) {
    return isAllowedSettingsCommand(commandId)
  }
  return CONTADORCA_QUICK_ACTION_ALLOWLIST.has(commandId)
}

export function filterCommandsForEdition<T extends { id: string }>(
  items: readonly T[],
  edition: OrcaEdition = 'full'
): T[] {
  if (editionSupports('commandPalette', edition)) {
    return [...items]
  }
  return items.filter((item) => isContadorcaCommandAllowed(item.id))
}
