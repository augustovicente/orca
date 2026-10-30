import { describe, expect, it } from 'vitest'
import { resolveMobileEdition } from '../mobile-edition'
import { hostStatusSchema } from './host-status-reply-schema'

describe('hostStatusSchema edition', () => {
  it('defaults to undefined when missing', () => {
    const parsed = hostStatusSchema.parse({})
    expect(parsed.edition).toBeUndefined()
  })

  it('drops unknown values', () => {
    const parsed = hostStatusSchema.parse({ edition: 'weird' })
    expect(parsed.edition).toBeUndefined()
  })

  it('accepts full', () => {
    const parsed = hostStatusSchema.parse({ edition: 'full' })
    expect(parsed.edition).toBe('full')
  })

  it('accepts contadorca', () => {
    const parsed = hostStatusSchema.parse({ edition: 'contadorca' })
    expect(parsed.edition).toBe('contadorca')
  })

  it('reads a missing or unknown host edition as full', () => {
    const missing = hostStatusSchema.parse({})
    const unknown = hostStatusSchema.parse({ edition: 'weird' })
    expect(resolveMobileEdition(missing.edition)).toBe('full')
    expect(resolveMobileEdition(unknown.edition)).toBe('full')
  })

  it('keeps an advertised contadorca host in the contadorca edition', () => {
    const parsed = hostStatusSchema.parse({ edition: 'contadorca' })
    expect(resolveMobileEdition(parsed.edition)).toBe('contadorca')
  })
})
