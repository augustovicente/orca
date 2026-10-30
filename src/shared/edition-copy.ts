// Pure, locale-aware copy transform for the contadorca edition.
// Applied to translated strings; identity-equivalent when not contadorca.

export type EditionCopyLanguage = 'pt' | 'en'

export type EditionCopyRule = {
  id: string
  kind: 'brand' | 'vocabulary'
  /** Source forms matched as whole words/phrases (longest first within a rule). */
  from: string[]
  /** Replacement forms per language, parallel to `from`. */
  to: { pt: string[]; en: string[] }
  /** Defaults to true. */
  enabled?: boolean
  /** Defaults: brand rules case-sensitive, vocabulary rules case-insensitive. */
  caseSensitive?: boolean
}

export const EDITION_COPY_RULES: EditionCopyRule[] = [
  {
    id: 'brand-orca-mobile',
    kind: 'brand',
    from: ['Orca Mobile'],
    to: { pt: ['Contadorca no celular'], en: ['Contadorca Mobile'] },
    caseSensitive: true
  },
  {
    id: 'brand-orca-cli',
    kind: 'brand',
    from: ['Orca CLI'],
    to: { pt: ['comando interno'], en: ['comando interno'] },
    caseSensitive: true
  },
  {
    id: 'brand-orca',
    kind: 'brand',
    from: ['Orca'],
    to: { pt: ['Contadorca'], en: ['Contadorca'] },
    caseSensitive: true
  },
  {
    id: 'brand-orca-lower',
    kind: 'brand',
    from: ['orca'],
    to: { pt: ['contadorca'], en: ['contadorca'] },
    caseSensitive: true
  },
  {
    id: 'brand-stably',
    kind: 'brand',
    from: ['Stably', 'stably', 'stablyai', 'Stablyai'],
    to: {
      pt: ['Contadorca', 'contadorca', 'contadorca', 'Contadorca'],
      en: ['Contadorca', 'contadorca', 'contadorca', 'Contadorca']
    },
    caseSensitive: true
  },
  {
    id: 'vocab-worktree',
    kind: 'vocabulary',
    from: ['worktree', 'worktrees'],
    to: { pt: ['pasta do cliente', 'pastas dos clientes'], en: ['client folder', 'client folders'] }
  },
  {
    id: 'vocab-repository',
    kind: 'vocabulary',
    from: ['repositório', 'repositórios', 'repo', 'repos'],
    to: {
      pt: ['cliente', 'clientes', 'cliente', 'clientes'],
      en: ['client', 'clients', 'client', 'clients']
    }
  },
  {
    id: 'vocab-branch',
    kind: 'vocabulary',
    from: ['branch', 'branches'],
    to: { pt: ['versão', 'versões'], en: ['version', 'versions'] }
  },
  {
    id: 'vocab-commit',
    kind: 'vocabulary',
    from: ['commit', 'commits'],
    to: { pt: ['alteração salva', 'alterações salvas'], en: ['saved change', 'saved changes'] }
  },
  {
    id: 'vocab-merge',
    kind: 'vocabulary',
    from: ['merge'],
    to: { pt: ['mesclar'], en: ['mesclar'] }
  },
  {
    id: 'vocab-pull-request',
    kind: 'vocabulary',
    from: ['pull request', 'pull requests', 'PR', 'PRs'],
    to: {
      pt: ['revisão', 'revisões', 'revisão', 'revisões'],
      en: ['revisão', 'revisões', 'revisão', 'revisões']
    }
  },
  {
    id: 'vocab-agent',
    kind: 'vocabulary',
    from: ['agente', 'agentes', 'agent', 'agents'],
    to: {
      pt: ['assistente', 'assistentes', 'assistente', 'assistentes'],
      en: ['assistant', 'assistants', 'assistant', 'assistants']
    }
  },
  {
    id: 'vocab-session',
    kind: 'vocabulary',
    from: ['sessão', 'sessões', 'session', 'sessions'],
    to: {
      pt: ['conversa', 'conversas', 'conversa', 'conversas'],
      en: ['conversation', 'conversations', 'conversation', 'conversations']
    }
  },
  {
    id: 'vocab-skill',
    kind: 'vocabulary',
    from: ['skill', 'skills'],
    to: { pt: ['rotina', 'rotinas'], en: ['routine', 'routines'] }
  },
  {
    id: 'vocab-token',
    kind: 'vocabulary',
    from: ['token', 'tokens'],
    to: { pt: ['crédito', 'créditos'], en: ['credit', 'credits'] },
    enabled: false
  }
]

export const BRAND_COPY_RULES = EDITION_COPY_RULES.filter((r) => r.kind === 'brand')
export const VOCABULARY_COPY_RULES = EDITION_COPY_RULES.filter((r) => r.kind === 'vocabulary')

function protect(text: string): { masked: string; spans: string[] } {
  const spans: string[] = []
  const masked = text.replace(/`[^`]*`|https?:\/\/[^\s)]+|\borca-cli\b/gi, (match) => {
    const idx = spans.length
    spans.push(match)
    return `\u0001${idx}\u0001`
  })
  return { masked, spans }
}

function unprotect(text: string, spans: string[]): string {
  // oxlint-disable-next-line no-control-regex
  return text.replace(/\u0001(\d+)\u0001/g, (_, i) => spans[Number(i)] ?? '')
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function applyRule(text: string, rule: EditionCopyRule, lang: EditionCopyLanguage): string {
  if (rule.enabled === false) {
    return text
  }
  const caseSensitive = rule.caseSensitive ?? false
  const targets = rule.to[lang]
  let out = text
  for (let i = 0; i < rule.from.length; i++) {
    const from = rule.from[i]
    const to = targets[i] ?? targets[0]
    const flags = caseSensitive ? 'g' : 'gi'
    // Unicode-aware whole-word boundaries (\\b only understands ASCII \\w).
    const regex = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRegex(from)}(?![\\p{L}\\p{N}_])`,
      `${flags}u`
    )
    out = out.replace(regex, (match) => {
      if (!caseSensitive) {
        const first = match.charAt(0)
        if (first !== first.toLowerCase() && first === first.toUpperCase()) {
          return to.charAt(0).toUpperCase() + to.slice(1)
        }
      }
      return to
    })
  }
  return out
}

function applyRules(value: string, lang: EditionCopyLanguage): string {
  const { masked, spans } = protect(value)
  let text = masked
  for (const rule of EDITION_COPY_RULES) {
    text = applyRule(text, rule, lang)
  }
  return unprotect(text, spans)
}

export function createEditionCopyTransform(locale?: string): (value: string) => string {
  const lang: EditionCopyLanguage =
    locale && locale.toLowerCase().startsWith('pt') ? 'pt' : locale ? 'en' : 'pt'
  // default to pt when no locale provided (customer-facing primary)
  const effective: EditionCopyLanguage = locale === undefined ? 'pt' : lang
  return (value: string) => applyRules(value, effective)
}

// Merge overlay over a fetched catalog. One level deep: only overrides existing leaf keys.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function mergeCopyOverlay(
  catalog: Record<string, unknown>,
  overlay: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...catalog }
  for (const [ns, overlayValue] of Object.entries(overlay ?? {})) {
    const base = catalog?.[ns]
    if (isRecord(base) && isRecord(overlayValue)) {
      const baseObj = base
      const merged: Record<string, unknown> = { ...baseObj }
      for (const [key, val] of Object.entries(overlayValue)) {
        if (Object.hasOwn(baseObj, key)) {
          const baseVal = baseObj[key]
          const isLeaf = baseVal !== null && typeof baseVal !== 'object'
          if (isLeaf) {
            merged[key] = val
          }
        }
      }
      result[ns] = merged
    } else if (base !== undefined && base !== null && typeof base !== 'object') {
      result[ns] = overlayValue
    }
  }
  return result
}
