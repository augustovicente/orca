import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

let value = 'undefined'
try {
  const profilePath = resolve('whitelabel', 'profile.json')
  if (existsSync(profilePath)) {
    const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
    const brand = profile?.brand
    if (brand?.productName) {
      value = JSON.stringify({
        name: brand.productName,
        mobileName: brand.mobileName ?? brand.productName,
        legalName: brand.legalName ?? brand.productName,
        supportEmail: brand.supportEmail,
        website: brand.website,
        tagline: brand.tagline ?? brand.productName
      })
    }
  }
} catch {
  value = 'undefined'
}

export const ORCA_BRAND_LITERAL = value
