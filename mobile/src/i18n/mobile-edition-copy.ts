import { MOBILE_ORCA_EDITION } from '../mobile-edition'

type CopyRule = { from: string; to: string }

const RULES: CopyRule[] = [
  // Brand
  { from: 'Orca Mobile', to: 'Contadorca' },
  { from: 'Orca', to: 'Contadorca' },
  { from: 'Stably', to: 'Contadorca' },
  // Vocabulary
  { from: 'worktree', to: 'pasta do cliente' },
  { from: 'repositório', to: 'cliente' },
  { from: 'repositorio', to: 'cliente' },
  { from: 'branch', to: 'versão' },
  { from: 'commit', to: 'alteração salva' },
  { from: 'agente', to: 'assistente' },
  { from: 'sessão', to: 'conversa' },
  { from: 'sessao', to: 'conversa' },
  { from: 'skill', to: 'rotina' }
]

function preserveCase(source: string, replacement: string): string {
  if (source === source.toUpperCase() && source.length > 1) {
    return replacement.toUpperCase()
  }
  if (source.length > 0 && source[0] === source[0].toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1)
  }
  return replacement
}

function protectCodeSpans(text: string): { text: string; restore: (value: string) => string } {
  const placeholders: string[] = []
  const protectedText = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, (match) => {
    const token = `\uE000${placeholders.length}\uE001`
    placeholders.push(match)
    return token
  })
  return {
    text: protectedText,
    restore: (value) =>
      value.replace(/\uE000(\d+)\uE001/g, (_, index) => placeholders[Number(index)] ?? '')
  }
}

function transformString(text: string): string {
  const { text: protectedText, restore } = protectCodeSpans(text)
  // Longest sources first so multi-word brands win over single words.
  const ordered = [...RULES].sort((a, b) => b.from.length - a.from.length)
  let result = protectedText
  for (const rule of ordered) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRegExp(rule.from)}(?![\\p{L}\\p{N}_])`,
      'giu'
    )
    result = result.replace(pattern, (match) => preserveCase(match, rule.to))
  }
  return restore(result)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function applyMobileEditionCopy<T>(value: T): T {
  if (MOBILE_ORCA_EDITION !== 'contadorca') {
    return value
  }
  if (typeof value === 'string') {
    return transformString(value) as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => applyMobileEditionCopy(item)) as T
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = applyMobileEditionCopy(entry)
    }
    return result as T
  }
  return value
}
