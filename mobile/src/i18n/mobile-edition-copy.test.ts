import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('applyMobileEditionCopy', () => {
  beforeEach(() => {
    vi.resetModules()
    delete process.env.EXPO_PUBLIC_ORCA_EDITION
  })

  it('is a no-op in the full edition', async () => {
    const { applyMobileEditionCopy } = await import('./mobile-edition-copy')
    expect(applyMobileEditionCopy('Orca worktree branch commit')).toBe(
      'Orca worktree branch commit'
    )
  })

  it('transforms brand and vocabulary in contadorca edition', async () => {
    process.env.EXPO_PUBLIC_ORCA_EDITION = 'contadorca'
    const { applyMobileEditionCopy } = await import('./mobile-edition-copy')
    expect(applyMobileEditionCopy('Orca Mobile opens a worktree on a branch')).toBe(
      'Contadorca opens a pasta do cliente on a versão'
    )
    expect(applyMobileEditionCopy('Stably agente sessão skill')).toBe(
      'Contadorca assistente conversa rotina'
    )
  })

  it('preserves case', async () => {
    process.env.EXPO_PUBLIC_ORCA_EDITION = 'contadorca'
    const { applyMobileEditionCopy } = await import('./mobile-edition-copy')
    expect(applyMobileEditionCopy('Worktree Branch')).toBe('Pasta do cliente Versão')
  })

  it('never transforms inside backticks', async () => {
    process.env.EXPO_PUBLIC_ORCA_EDITION = 'contadorca'
    const { applyMobileEditionCopy } = await import('./mobile-edition-copy')
    expect(applyMobileEditionCopy('Orca `Orca worktree` outside')).toBe(
      'Contadorca `Orca worktree` outside'
    )
  })

  it('transforms unknown values as no-op for missing/unknown', async () => {
    process.env.EXPO_PUBLIC_ORCA_EDITION = 'contadorca'
    const { applyMobileEditionCopy } = await import('./mobile-edition-copy')
    expect(applyMobileEditionCopy(42)).toBe(42)
  })
})
