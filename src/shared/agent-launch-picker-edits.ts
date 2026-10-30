import { analyzeAgentChoiceArgs } from './agent-choice-args'
import {
  editAgentPickerDraft,
  type AgentPickerDraft,
  type AgentPickerEntry
} from './agent-launch-picker'
import {
  editAgentPickerPanelText,
  agentPickerPanelArguments
} from './agent-launch-picker-arguments'
import { editAgentPickerPermission } from './agent-launch-picker-permission'
import { editAgentPickerSpeed } from './agent-launch-picker-speed'
import type { AgentChoicePatch } from './agent-launch-choices'
import type { AgentPermissionChoice } from './tui-agent-permission-choice'
import {
  canonicalSourceControlActionSelection,
  commitSourceControlActionArguments,
  editSourceControlActionArguments,
  selectSourceControlActionRecipe,
  type CurrentActionSelection
} from './source-control-action-selection'
import {
  selectedSourceControlActionPreferences,
  sourceControlActionExecutionArgs
} from './source-control-action-launch-preferences'
import { editActionArgumentChoices } from './source-control-action-argument-choices'

export type AgentPickerEdit =
  | { kind: 'choice'; patch: AgentChoicePatch }
  | { kind: 'permission'; value: AgentPermissionChoice }
  | { kind: 'speed'; key: string; value: string; model?: string }
  | { kind: 'arguments'; text: string; model?: string }
  | { kind: 'remove-chip'; key: string; model?: string }

function editRecipeChoices(
  selection: CurrentActionSelection,
  entry: AgentPickerEntry,
  patch: AgentChoicePatch
): CurrentActionSelection {
  const selected = selectSourceControlActionRecipe(selection)
  const inheritsArgs = selection.source.scope === 'repo' && !selection.source.ownsArgs
  const choices = selectedSourceControlActionPreferences(selected, entry.agent) ?? {}
  if (!inheritsArgs && selection.current.agentArgs !== undefined) {
    const analysis = analyzeAgentChoiceArgs(entry.agent, selection.current.agentArgs)
    const carriers = analysis.occurrences.filter(
      (item) =>
        (item.key === 'fastMode' || item.key === 'serviceTier') &&
        patch.options?.[item.key] !== undefined &&
        !analysis.opaqueKeys.has(item.key)
    )
    const text = analysis.cut(carriers)
    if (text !== null && text !== selection.current.agentArgs) {
      selection = editSourceControlActionArguments(selection, text)
    }
  }
  const edited = editActionArgumentChoices(
    {
      ...selection.current,
      ...(inheritsArgs ? { agentArgs: undefined, argumentChoices: undefined } : {}),
      launchPreferences: selection.source.authoredPreferences
    },
    entry.agent,
    choices,
    patch,
    inheritsArgs ? '' : (selection.current.agentArgs ?? ''),
    inheritsArgs ? 'inherit' : 'default'
  )
  return {
    current: {
      ...selection.current,
      ...(!inheritsArgs
        ? {
            agentArgs:
              edited.agentArgs === (selection.current.agentArgs ?? '')
                ? selection.current.agentArgs
                : edited.agentArgs,
            argumentChoices: edited.argumentChoices
          }
        : {})
    },
    source: { ...selection.source, authoredPreferences: edited.launchPreferences }
  }
}

function editRecipeArguments(
  selection: CurrentActionSelection,
  entry: AgentPickerEntry,
  text: string,
  model?: string
): CurrentActionSelection {
  // Reattach recipe carriers only; chips derived from Agents/parent preferences are presentation.
  const own = selectSourceControlActionRecipe(
    canonicalSourceControlActionSelection({
      ...selection.current,
      ...(selection.source.scope === 'repo' && !selection.source.ownsArgs
        ? { agentArgs: undefined, argumentChoices: undefined }
        : {}),
      launchPreferences: selection.source.authoredPreferences
    })
  )
  const sparseEntry = { ...entry, terminal: {}, structured: {}, arguments: '' }
  const sparseDraft: AgentPickerDraft = {
    agent: entry.agent,
    surface: 'terminal',
    choices: selectedSourceControlActionPreferences(own, entry.agent) ?? {},
    arguments: sourceControlActionExecutionArgs(own, entry.agent) ?? '',
    argumentsOwner: entry.ownerKey
  }
  const edited = editAgentPickerPanelText(sparseEntry, sparseDraft, text, model)
  const raw = editSourceControlActionArguments(selection, edited.arguments ?? '')
  const owned: CurrentActionSelection = {
    ...raw,
    source: raw.source.scope === 'repo' ? { ...raw.source, ownsArgs: true } : raw.source
  }
  const committed = commitSourceControlActionArguments(owned, entry.agent).selection
  const analysis = analyzeAgentChoiceArgs(entry.agent, text)
  const options: NonNullable<AgentChoicePatch['options']> = {}
  for (const key of ['fastMode', 'serviceTier']) {
    const carriers = analysis.occurrences.filter((item) => item.key === key)
    if (analysis.opaqueKeys.has(key)) {
      options[key] = null
    } else if (carriers.length && analysis.cut(carriers) !== null) {
      options[key] = edited.choices.options?.[key] ?? null
    }
  }
  if (!Object.keys(options).length) {
    return committed
  }
  const synced = editRecipeChoices(committed, entry, { options })
  return { ...synced, current: committed.current }
}

/** Accepted editor events fold into one bounded receipt beside the complete launch projection. */
export function applyAgentPickerEdit(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft,
  edit: AgentPickerEdit
): AgentPickerDraft {
  let patch: AgentChoicePatch | undefined
  let next: AgentPickerDraft
  switch (edit.kind) {
    case 'choice':
      patch = edit.patch
      next = editAgentPickerDraft(draft, patch)
      break
    case 'permission':
      patch = { permissionMode: edit.value }
      next = editAgentPickerPermission(entry, draft, edit.value)
      break
    case 'speed':
      patch = { options: { [edit.key]: edit.value } }
      next = editAgentPickerSpeed(entry, draft, edit.key, edit.value, edit.model)
      break
    case 'arguments':
      next = editAgentPickerPanelText(entry, draft, edit.text, edit.model)
      break
    case 'remove-chip': {
      const chip = agentPickerPanelArguments(entry, draft, edit.model).chips.find(
        (chip) => chip.key === edit.key
      )
      if (!chip) {
        return draft
      }
      patch =
        edit.key === 'permissionMode'
          ? { permissionMode: 'own' }
          : { options: { [edit.key]: edit.key === 'fastMode' ? 'false' : 'default' } }
      next = chip.remove()
      break
    }
  }
  const receipt = draft.recipeEdits
  if (!receipt || next === draft) {
    return next
  }
  return {
    ...next,
    recipeEdits: {
      selection:
        edit.kind === 'arguments'
          ? editRecipeArguments(receipt.selection, entry, edit.text, edit.model)
          : editRecipeChoices(receipt.selection, entry, patch ?? {}),
      changed: true,
      argumentsAuthored: receipt.argumentsAuthored || edit.kind === 'arguments'
    }
  }
}
