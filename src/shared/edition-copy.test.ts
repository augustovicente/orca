import { describe, expect, it } from 'vitest'

import { createEditionCopyTransform, EDITION_COPY_RULES, mergeCopyOverlay } from './edition-copy'
import { createOrcaI18n } from './orca-i18n-instance'

describe('edition-copy', () => {
  it('is identity in the full edition by default', () => {
    const instance = createOrcaI18n({
      loadCatalog: () => undefined,
      englishResources: { sample: 'Orca worktree agent' }
    })
    expect(instance.translate('sample', 'Orca worktree agent')).toBe('Orca worktree agent')
  })

  it('replaces brand names (pt)', () => {
    const transform = createEditionCopyTransform('pt')
    expect(transform('Orca Mobile and Orca CLI and Orca')).toBe(
      'Contadorca no celular and comando interno and Contadorca'
    )
    expect(transform('see orca command')).toBe('see contadorca command')
  })

  it('does not match orca inside Contadorca', () => {
    const transform = createEditionCopyTransform('pt')
    expect(transform('Contadorca')).toBe('Contadorca')
    expect(transform('contadorca')).toBe('contadorca')
  })

  it('skips replacements inside backticks', () => {
    const transform = createEditionCopyTransform('pt')
    expect(transform('use `orca-cli` and `Orca`')).toBe('use `orca-cli` and `Orca`')
    expect(transform('visit https://orca.example.com now')).toBe(
      'visit https://orca.example.com now'
    )
  })

  it('handles plurals case-preservingly', () => {
    const transform = createEditionCopyTransform('pt')
    expect(transform('worktrees')).toBe('pastas dos clientes')
    expect(transform('Worktree')).toBe('Pasta do cliente')
    expect(transform('agents')).toBe('assistentes')
  })

  it('applies no double replacement', () => {
    const transform = createEditionCopyTransform('pt')
    const once = transform('Orca worktree')
    expect(once).toBe('Contadorca pasta do cliente')
    expect(transform(once)).toBe('Contadorca pasta do cliente')
  })

  it('exports a rule table containing token (disabled)', () => {
    const tokenRule = EDITION_COPY_RULES.find((r) => r.id === 'vocab-token')
    expect(tokenRule).toBeDefined()
    expect(tokenRule?.enabled).toBe(false)
  })

  it('mergeCopyOverlay is one-level-deep and only overrides existing leaves', () => {
    const catalog = { ns: { a: 'old', nested: { b: 'deep' } } }
    const overlay = { ns: { a: 'new', missing: 'x', nested: { b: 'changed' } }, other: { z: '1' } }
    const merged = mergeCopyOverlay(catalog, overlay)
    expect(merged).toMatchObject({ ns: { a: 'new', nested: { b: 'deep' } } })
    // unknown keys and deeper objects are not merged (one level deep)
    expect(merged.ns).not.toHaveProperty('missing')
    expect(merged).not.toHaveProperty('other')
  })

  it('mergeCopyOverlay preserves plural sibling keys', () => {
    const catalog = { ns: { item_one: '{{count}} item', item_other: '{{count}} items' } }
    const overlay = { ns: { item_one: '{{count}} coisa' } }
    const merged = mergeCopyOverlay(catalog, overlay)
    expect(merged).toMatchObject({
      ns: { item_one: '{{count}} coisa', item_other: '{{count}} items' }
    })
  })
})
