import { PERMISSION_LAUNCH_GRAMMARS } from './agent-permission-args'
import type { AgentStartupShell } from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'
import { analyzeChoiceArgs, type ChoiceOccurrence } from './agent-choice-args-analysis'

export type AgentChoicePublicationContext = {
  shell: AgentStartupShell
  generatedArgs: string
}

/** Arbitrary raw and native splicing keep their all-grammar proof. */
export function analyzeAgentChoiceArgs(
  agent: TuiAgent,
  text: string,
  publication?: AgentChoicePublicationContext
) {
  const strict = analyzeChoiceArgs(agent, text, PERMISSION_LAUNCH_GRAMMARS)
  if (!publication) {
    return strict
  }
  const generated = analyzeChoiceArgs(agent, publication.generatedArgs, [publication.shell])
  const generatedCarriers = new Set(
    generated.occurrences.map(
      (entry) => `${entry.key}:${publication.generatedArgs.slice(entry.start, entry.end)}`
    )
  )
  const current = analyzeChoiceArgs(agent, text, [publication.shell], generatedCarriers)
  const generatedByKey = new Map<string, ChoiceOccurrence[]>()
  const counts = new Map<string, number>()
  const strictBySpan = new Map(
    strict.occurrences.map((entry) => [`${entry.key}:${entry.start}:${entry.end}`, entry])
  )
  for (const entry of generated.occurrences) {
    const existing = generatedByKey.get(entry.key) ?? []
    existing.push(entry)
    generatedByKey.set(entry.key, existing)
  }
  for (const entry of current.occurrences) {
    counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1)
  }
  const occurrences = current.occurrences.map((entry) => {
    const matching = generatedByKey.get(entry.key)
    const previous = strictBySpan.get(`${entry.key}:${entry.start}:${entry.end}`)
    const publicationOwned =
      entry.owned &&
      counts.get(entry.key) === 1 &&
      matching?.length === 1 &&
      matching[0].value === entry.value &&
      generated.cut(matching) !== null
    return {
      ...entry,
      owned: previous?.owned ?? false,
      lift: previous?.lift ?? false,
      publicationOwned
    }
  })
  return {
    ...current,
    occurrences,
    publishedKeys: new Set(generated.occurrences.map((entry) => entry.key))
  }
}
