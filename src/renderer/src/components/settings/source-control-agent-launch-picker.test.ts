import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'
import { editAgentPickerDraft } from '../../../../shared/agent-launch-picker'
import { editAgentPickerPanelText } from '../../../../shared/agent-launch-picker-arguments'
import { editAgentPickerPermission } from '../../../../shared/agent-launch-picker-permission'
import { editAgentPickerSpeed } from '../../../../shared/agent-launch-picker-speed'
import { captureSourceControlActionSelection } from '../../../../shared/source-control-ai-operation-policy'
import {
  canonicalSourceControlActionSelection,
  selectSourceControlActionRecipe
} from '../../../../shared/source-control-action-selection'
import { projectSourceControlActionLaunch } from '../../../../shared/source-control-action-launch-preferences'
import {
  applySourceControlPickerDraft,
  sourceControlPickerDraft
} from './source-control-agent-launch-picker'

const entry: AgentPickerEntry = {
  agent: 'claude',
  label: 'Claude',
  ownerKey: 'recipe-test',
  rows: [{ agent: 'claude', kind: 'chat' }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'chat',
  terminal: { permissionMode: 'own' },
  structured: { model: 'sonnet', permissionMode: 'ask' },
  arguments: '--agents-default',
  catalog: {
    origin: 'probe',
    fetchedAt: 1,
    models: [
      { id: 'opus', label: 'Opus', isDefault: true, efforts: [], supportsFastMode: true },
      { id: 'sonnet', label: 'Sonnet', isDefault: false, efforts: [] }
    ]
  }
}
const captured = () =>
  captureSourceControlActionSelection({
    actionId: 'resolveConflicts',
    settings: {
      sourceControlAi: {
        ...getDefaultSettings('/tmp/picker-test').sourceControlAi!,
        actions: {
          resolveConflicts: {
            agentId: 'claude',
            agentArgs: '--verbose',
            launchPreferences: { agentId: 'claude', model: 'opus', options: { effort: 'high' } }
          }
        }
      }
    },
    repo: {
      sourceControlAi: {
        actionOverrides: {
          resolveConflicts: { launchPreferences: { agentId: 'claude', permissionMode: 'ask' } }
        }
      }
    }
  })
const project = (selection: ReturnType<typeof captured>) =>
  projectSourceControlActionLaunch(selectSourceControlActionRecipe(selection), 'claude', {
    basePrompt: 'fix'
  })

describe('Source Control shared picker projection', () => {
  it('keeps a no-op sparse, including inherited model and independently authored permission', () => {
    const selection = captured()
    const draft = sourceControlPickerDraft(selection, entry)
    expect(draft).toMatchObject({
      choices: { model: 'opus', options: { effort: 'high' }, permissionMode: 'ask' },
      arguments: '--verbose'
    })
    expect(applySourceControlPickerDraft(selection, entry, draft)).toBe(selection)
  })

  it('changes the model and resets its previous effort with the common panel', () => {
    const selection = captured()
    const draft = editAgentPickerDraft(sourceControlPickerDraft(selection, entry), {
      model: 'sonnet'
    })
    const next = applySourceControlPickerDraft(selection, entry, draft)
    expect(next.source.authoredPreferences).toMatchObject({
      permissionMode: 'ask',
      modelSelection: { base: 'inherit', model: { agentId: 'claude', value: 'sonnet' } }
    })
    expect(next.source.authoredPreferences?.modelSelection?.options?.effort).toEqual({
      agentId: 'claude',
      value: null
    })
    expect(project(next).sessionOptions).toMatchObject({ model: 'sonnet', permissionMode: 'ask' })
  })

  it('settles raw model replacement with the captured sources, then saves and reopens it', () => {
    const selection = captured()
    const draft = {
      ...sourceControlPickerDraft(selection, entry, 'terminal'),
      arguments: '--model sonnet --verbose'
    }
    const next = applySourceControlPickerDraft(selection, entry, draft)
    expect(project(next)).toMatchObject({
      agentArgs: '--verbose',
      sessionOptions: { model: 'sonnet', permissionMode: 'ask' }
    })
    expect(project(next).sessionOptions).not.toHaveProperty('effort')
    expect(sourceControlPickerDraft(next, entry).choices.model).toBe('sonnet')
    expect(next.current.argumentChoices?.nodes.map((node) => node.text)).toEqual(['--model sonnet'])
  })

  it('carries shared permission and Fast edits through the existing recipe projection', () => {
    const selection = canonicalSourceControlActionSelection({
      agentId: 'claude',
      agentArgs: '--verbose'
    })
    let draft = sourceControlPickerDraft(selection, entry, 'terminal')
    draft = editAgentPickerPermission(entry, draft, 'full-access')
    draft = editAgentPickerSpeed(entry, draft, 'fastMode', 'true', 'opus')
    const next = applySourceControlPickerDraft(selection, entry, draft)
    expect(project(next).sessionOptions).toMatchObject({
      permissionMode: 'full-access',
      fastMode: 'true'
    })
    expect(project(next).agentArgs).toContain('--verbose')
    expect(next.source.authoredPreferences?.permissionMode).toBe('full-access')
  })

  it('does not materialize an Args override for a model-only edit', () => {
    const selection = canonicalSourceControlActionSelection({ agentId: 'claude' })
    const draft = editAgentPickerDraft(sourceControlPickerDraft(selection, entry), {
      model: 'sonnet'
    })
    const next = applySourceControlPickerDraft(selection, entry, draft)
    expect(next.current.agentArgs).toBeUndefined()
    expect(next.current.argumentChoices).toBeUndefined()
    expect(project(next).sessionOptions?.model).toBe('sonnet')
  })

  it('retains explicit empty Args without pinning a model', () => {
    const selection = canonicalSourceControlActionSelection({ agentId: 'claude' })
    const draft = editAgentPickerPanelText(
      entry,
      sourceControlPickerDraft(selection, entry, 'terminal'),
      ''
    )
    const next = applySourceControlPickerDraft(selection, entry, draft)
    expect(next.current.agentArgs).toBe('')
    expect(next.source.authoredPreferences?.modelSelection).toBeUndefined()
  })
})
