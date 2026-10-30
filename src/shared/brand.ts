// Compile-time brand source. Falls back to Orca when edition is full or define absent.
declare const ORCA_BRAND:
  | {
      name: string
      mobileName: string
      legalName: string
      supportEmail: string
      website: string
      tagline: string
    }
  | undefined

import { ORCA_EDITION_ID } from './edition'

const FALLBACK_BRAND = {
  name: 'Orca',
  mobileName: 'Orca',
  legalName: 'Stably',
  supportEmail: 'support@stably.ai',
  website: 'https://stably.ai',
  tagline: 'Orca'
}

// oxlint-disable-next-line unicorn/no-typeof-undefined
const injected = typeof ORCA_BRAND !== 'undefined' && ORCA_BRAND !== null ? ORCA_BRAND : undefined

export const BRAND = ORCA_EDITION_ID === 'contadorca' && injected ? injected : FALLBACK_BRAND
