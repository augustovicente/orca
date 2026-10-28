import { TerminalResidentRegistry, type TerminalResident } from './terminal-resident-registry'
import type { createTerminalResidentPolicy } from './terminal-resident-policy'
import type { TerminalResidentLegacySource } from './terminal-resident-legacy-source'

export type TerminalSemanticResident = TerminalResident<
  ReturnType<typeof createTerminalResidentPolicy>
>
export const residentRegistry = new TerminalResidentRegistry<
  ReturnType<typeof createTerminalResidentPolicy>
>()
export const residentsByPtyId = new Map<string, TerminalSemanticResident>()
export const legacySourcesByPtyId = new Map<
  string,
  {
    resident: TerminalSemanticResident
    source: TerminalResidentLegacySource
    unsubscribe?: () => void
  }
>()

export function disposeLegacySource(ptyId: string): void {
  const legacy = legacySourcesByPtyId.get(ptyId)
  if (!legacy) {
    return
  }
  legacySourcesByPtyId.delete(ptyId)
  legacy.unsubscribe?.()
}

export function getTerminalSemanticResident(ptyId: string): TerminalSemanticResident | undefined {
  return residentsByPtyId.get(ptyId)
}

export function retireCapturedResident(resident: TerminalSemanticResident): void {
  if (residentsByPtyId.get(resident.identity.ptyId) !== resident) {
    return
  }
  residentsByPtyId.delete(resident.identity.ptyId)
  disposeLegacySource(resident.identity.ptyId)
  residentRegistry.retire(resident)
}

export function retireTerminalSemanticResident(ptyId: string, incarnationId?: string): void {
  const resident = residentsByPtyId.get(ptyId)
  if (
    !resident ||
    (incarnationId !== undefined && resident.identity.incarnationId !== incarnationId)
  ) {
    return
  }
  retireCapturedResident(resident)
}

export function retireTerminalSemanticResidentsForTab(
  tabId: string,
  paneKeys?: ReadonlySet<string>
): void {
  for (const resident of residentsByPtyId.values()) {
    if (
      resident.policy.binding.tabId === tabId &&
      (!paneKeys || paneKeys.has(resident.policy.binding.paneKey))
    ) {
      retireCapturedResident(resident)
    }
  }
}
