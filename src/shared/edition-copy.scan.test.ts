import { describe, expect, it } from 'vitest'
import { createEditionCopyTransform } from './edition-copy'
import ptCatalog from '../renderer/src/i18n/locales/pt.json'

describe('edition-copy scan', () => {
  it('removes visible Orca from a sample of high-traffic pt keys', () => {
    const transform = createEditionCopyTransform('pt')
    const samples: string[] = []
    function walk(o: unknown) {
      if (o && typeof o === 'object') {
        for (const v of Object.values(o)) {
          walk(v)
        }
      } else if (typeof o === 'string' && /orca/i.test(o)) {
        samples.push(o as string)
      }
    }
    walk(ptCatalog)
    const picked = samples.slice(0, 50)
    expect(picked.length).toBeGreaterThan(0)
    for (const s of picked) {
      const out = transform(s)
      // "Orca" as a standalone visible brand token should be gone (backticked/internal allowed).
      expect(out).not.toMatch(/\bOrca\b/)
    }
  })
})
