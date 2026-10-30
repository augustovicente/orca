import type { AgentPickerDraft, AgentPickerEntry } from '../../../../shared/agent-launch-picker'
import type { AgentChoicePatch } from '../../../../shared/agent-launch-choices'
import {
  commitSourceControlActionArguments,
  editSourceControlActionArguments,
  selectSourceControlActionRecipe,
  type CurrentActionSelection
} from '../../../../shared/source-control-action-selection'
import {
  sourceControlActionExecutionArgs,
  selectedSourceControlActionPreferences
} from '../../../../shared/source-control-action-launch-preferences'
import { editActionArgumentChoices } from '../../../../shared/source-control-action-argument-choices'

export function sourceControlPickerDraft(
  selection: CurrentActionSelection,
  entry: AgentPickerEntry,
  surface = entry.defaultSurface
): AgentPickerDraft {
  const recipe = selectSourceControlActionRecipe(selection)
  const preferences = selectedSourceControlActionPreferences(recipe, entry.agent)
  return {
    agent: entry.agent,
    surface,
    choices: {
      ...(preferences?.model ? { model: preferences.model } : {}),
      ...(preferences?.options ? { options: preferences.options } : {}),
      ...(preferences?.permissionMode ? { permissionMode: preferences.permissionMode } : {})
    },
    arguments: sourceControlActionExecutionArgs(recipe, entry.agent),
    argumentsOwner: entry.ownerKey
  }
}

/** Save only authored deltas; inherited choices remain owned by their existing recipe scope. */
export function applySourceControlPickerDraft(
  selection: CurrentActionSelection,
  entry: AgentPickerEntry,
  draft: AgentPickerDraft
): CurrentActionSelection {
  const initial = sourceControlPickerDraft(selection, entry, draft.surface)
  let next = selection
  if (draft.arguments !== initial.arguments) {
    next = commitSourceControlActionArguments(
      editSourceControlActionArguments(next, draft.arguments ?? ''),
      entry.agent
    ).selection
  }
  const previous = initial.choices
  const choices = draft.choices
  const options = Object.fromEntries(
    [...new Set([...Object.keys(previous.options ?? {}), ...Object.keys(choices.options ?? {})])]
      .filter((key) => previous.options?.[key] !== choices.options?.[key])
      .map((key) => [key, choices.options?.[key] ?? null])
  )
  const patch: AgentChoicePatch = {
    ...(previous.model !== choices.model ? { model: choices.model ?? null } : {}),
    ...(Object.keys(options).length ? { options } : {}),
    ...(previous.permissionMode !== choices.permissionMode
      ? { permissionMode: choices.permissionMode ?? 'default' }
      : {})
  }
  if (!Object.keys(patch).length) {
    return next
  }
  const selected = selectSourceControlActionRecipe(next)
  const edited = editActionArgumentChoices(
    { ...next.current, launchPreferences: next.source.authoredPreferences },
    entry.agent,
    selectedSourceControlActionPreferences(selected, entry.agent) ?? {},
    patch,
    next.current.agentArgs ?? '',
    next.source.scope === 'repo' && !next.source.ownsArgs ? 'inherit' : 'default'
  )
  return {
    current: {
      ...next.current,
      agentArgs:
        edited.agentArgs === (next.current.agentArgs ?? '')
          ? next.current.agentArgs
          : edited.agentArgs,
      argumentChoices: edited.argumentChoices
    },
    source: { ...next.source, authoredPreferences: edited.launchPreferences }
  }
}
