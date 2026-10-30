import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'
import {
  applyAgentPickerEdit,
  type AgentPickerEdit
} from '../../../../shared/agent-launch-picker-edits'
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
    const draft = applyAgentPickerEdit(entry, sourceControlPickerDraft(selection, entry), {
      kind: 'choice',
      patch: { model: 'sonnet' }
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
    const draft = applyAgentPickerEdit(
      entry,
      sourceControlPickerDraft(selection, entry, 'terminal'),
      { kind: 'arguments', text: '--model sonnet --verbose' }
    )
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
    draft = applyAgentPickerEdit(entry, draft, { kind: 'permission', value: 'full-access' })
    draft = applyAgentPickerEdit(entry, draft, {
      kind: 'speed',
      key: 'fastMode',
      value: 'true',
      model: 'opus'
    })
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
    const draft = applyAgentPickerEdit(entry, sourceControlPickerDraft(selection, entry), {
      kind: 'choice',
      patch: { model: 'sonnet' }
    })
    const next = applySourceControlPickerDraft(selection, entry, draft)
    expect(next.current.agentArgs).toBeUndefined()
    expect(next.current.argumentChoices).toBeUndefined()
    expect(project(next).sessionOptions?.model).toBe('sonnet')
  })

  it('retains explicit empty Args without pinning a model', () => {
    const selection = canonicalSourceControlActionSelection({ agentId: 'claude' })
    const draft = applyAgentPickerEdit(
      entry,
      sourceControlPickerDraft(selection, entry, 'terminal'),
      { kind: 'arguments', text: '' }
    )
    const next = applySourceControlPickerDraft(selection, entry, draft)
    expect(next.current.agentArgs).toBe('')
    expect(next.source.authoredPreferences?.modelSelection).toBeUndefined()
  })
})

it.each(['claude', 'codex'] as const)(
  'keeps %s choice-only edits sparse and explicit equal-value picks owned',
  (agent) => {
    const inventory: AgentPickerEntry = {
      ...entry,
      agent,
      arguments: '--verbose',
      terminal: { permissionMode: 'ask' }
    }
    const selection = canonicalSourceControlActionSelection({ agentId: agent })
    for (const edit of [
      { kind: 'permission', value: 'ask' },
      {
        kind: 'speed',
        key: agent === 'claude' ? 'fastMode' : 'serviceTier',
        value: agent === 'claude' ? 'true' : 'fast'
      },
      { kind: 'choice', patch: { model: agent === 'claude' ? 'claude-opus-5-5[1m]' : 'gpt-5.4' } },
      { kind: 'choice', patch: { options: { effort: 'high' } } }
    ] satisfies AgentPickerEdit[]) {
      const draft = applyAgentPickerEdit(
        inventory,
        sourceControlPickerDraft(selection, inventory, 'terminal'),
        edit
      )
      const saved = applySourceControlPickerDraft(selection, inventory, draft)
      expect(saved.current.agentArgs).toBeUndefined()
      expect(saved.current.argumentChoices).toBeUndefined()
      if (edit.kind === 'permission') {
        expect(saved.source.authoredPreferences?.permissionMode).toBe('ask')
      } else {
        expect(saved.source.authoredPreferences?.permissionMode).toBeUndefined()
      }
    }
  }
)

it.each(['claude', 'codex'] as const)(
  'separates generated %s chips from typed input and folds both event orders',
  (agent) => {
    const inventory: AgentPickerEntry = {
      ...entry,
      agent,
      arguments: '--verbose',
      terminal: { permissionMode: 'ask' }
    }
    const selection = canonicalSourceControlActionSelection({ agentId: agent })
    const raw: AgentPickerEdit = { kind: 'arguments', text: '--debug' }
    const permission: AgentPickerEdit = { kind: 'permission', value: 'full-access' }
    const speed: AgentPickerEdit = {
      kind: 'speed',
      key: agent === 'claude' ? 'fastMode' : 'serviceTier',
      value: agent === 'claude' ? 'true' : 'fast'
    }
    for (const events of [
      [raw],
      [raw, permission],
      [permission, raw],
      [raw, speed],
      [speed, raw]
    ]) {
      const draft = events.reduce(
        (draft, edit) => applyAgentPickerEdit(inventory, draft, edit),
        sourceControlPickerDraft(selection, inventory, 'terminal')
      )
      const saved = applySourceControlPickerDraft(selection, inventory, draft)
      if (events.includes(speed)) {
        expect(saved.current.agentArgs).toContain('--debug')
      } else {
        expect(saved.current.agentArgs).toBe('--debug')
      }
      expect(saved.source.authoredPreferences?.permissionMode).toBe(
        events.includes(permission) ? 'full-access' : undefined
      )
      if (events.includes(speed)) {
        expect(
          projectSourceControlActionLaunch(selectSourceControlActionRecipe(saved), agent, {
            basePrompt: 'fix'
          }).sessionOptions
        ).toMatchObject({ [speed.key]: speed.value })
      }
    }
  }
)

it('preserves explicit raw replacement back to default/parent, empty, and raw-last permission precedence', () => {
  for (const selection of [
    canonicalSourceControlActionSelection({ agentId: 'claude' }),
    captured()
  ]) {
    for (const text of ['--verbose', '']) {
      let draft = sourceControlPickerDraft(selection, entry, 'terminal')
      for (const value of ['--debug', text]) {
        draft = applyAgentPickerEdit(entry, draft, { kind: 'arguments', text: value })
      }
      const saved = applySourceControlPickerDraft(selection, entry, draft)
      expect(saved.current.agentArgs).toBe(text)
      expect(draft.recipeEdits?.argumentsAuthored).toBe(true)
      if (saved.source.scope === 'repo') {
        expect(saved.source.ownsArgs).toBe(true)
      }
    }
  }
  const selection = canonicalSourceControlActionSelection({ agentId: 'claude' })
  let draft = applyAgentPickerEdit(entry, sourceControlPickerDraft(selection, entry, 'terminal'), {
    kind: 'permission',
    value: 'full-access'
  })
  draft = applyAgentPickerEdit(entry, draft, {
    kind: 'arguments',
    text: '--permission-mode default --verbose'
  })
  expect(
    applySourceControlPickerDraft(selection, entry, draft).source.authoredPreferences
      ?.permissionMode
  ).toBe('ask')
})

it('keeps captured parent Args and independent permission/model sources on choice edits', () => {
  const selection = captured()
  let draft = applyAgentPickerEdit(entry, sourceControlPickerDraft(selection, entry, 'terminal'), {
    kind: 'permission',
    value: 'full-access'
  })
  draft = applyAgentPickerEdit(entry, draft, {
    kind: 'speed',
    key: 'fastMode',
    value: 'true',
    model: 'opus'
  })
  const saved = applySourceControlPickerDraft(selection, entry, draft)
  expect(saved.current.agentArgs).toBe('--verbose')
  expect(saved.source).toMatchObject({
    scope: 'repo',
    ownsArgs: false,
    parentPreferences:
      selection.source.scope === 'repo' ? selection.source.parentPreferences : undefined
  })
  expect(project(saved).sessionOptions).toMatchObject({
    model: 'opus',
    permissionMode: 'full-access',
    fastMode: 'true'
  })
  const inheritedCarriers = {
    ...selection,
    current: {
      ...selection.current,
      agentArgs: `--permission-mode default --settings '{"fastMode":true}' --verbose`
    },
    source: { ...selection.source, authoredPreferences: undefined }
  }
  const raw = applyAgentPickerEdit(
    entry,
    sourceControlPickerDraft(inheritedCarriers, entry, 'terminal'),
    { kind: 'arguments', text: '--debug' }
  )
  const rawSaved = applySourceControlPickerDraft(inheritedCarriers, entry, raw)
  expect(rawSaved.current.agentArgs).toBe('--debug')
  expect(rawSaved.source.authoredPreferences).toBeUndefined()
})

it('folds chip removal, literal model changes and opaque settings without an edit-count journal', () => {
  const selection = canonicalSourceControlActionSelection({ agentId: 'claude' })
  const start = sourceControlPickerDraft(selection, entry, 'terminal')
  let draft = applyAgentPickerEdit(entry, start, {
    kind: 'arguments',
    text: '--model "sonnet" --effort high --add-dir "a b"'
  })
  draft = applyAgentPickerEdit(entry, draft, { kind: 'choice', patch: { model: 'opus' } })
  const saved = applySourceControlPickerDraft(selection, entry, draft)
  expect(project(saved).agentArgs).toContain('--add-dir "a b"')
  expect(project(saved).sessionOptions).toMatchObject({ model: 'opus' })
  expect(project(saved).sessionOptions).not.toHaveProperty('effort')
  draft = applyAgentPickerEdit(entry, draft, { kind: 'permission', value: 'ask' })
  draft = applyAgentPickerEdit(entry, draft, { kind: 'remove-chip', key: 'permissionMode' })
  expect(
    applySourceControlPickerDraft(selection, entry, draft).source.authoredPreferences
      ?.permissionMode
  ).toBe('own')
  const sizes: number[] = []
  for (const count of [10, 100]) {
    let next = start
    for (let i = 0; i < count; i++) {
      next = applyAgentPickerEdit(entry, next, {
        kind: 'arguments',
        text: '--settings settings.json --add-dir "a b"'
      })
    }
    sizes.push(JSON.stringify(next.recipeEdits).length)
    expect(project(applySourceControlPickerDraft(selection, entry, next)).agentArgs).toContain(
      '--settings settings.json'
    )
  }
  expect(sizes[1]).toBe(sizes[0])
})

it.each(['claude', 'codex'] as const)(
  'lets later typed %s speed replace earlier controls without pinning inherited permission',
  (agent) => {
    const inventory: AgentPickerEntry = { ...entry, agent, terminal: { permissionMode: 'ask' } }
    const selection = canonicalSourceControlActionSelection({ agentId: agent })
    const key = agent === 'claude' ? 'fastMode' : 'serviceTier'
    let draft = applyAgentPickerEdit(
      inventory,
      sourceControlPickerDraft(selection, inventory, 'terminal'),
      { kind: 'speed', key, value: agent === 'claude' ? 'true' : 'fast', model: 'opus' }
    )
    draft = applyAgentPickerEdit(inventory, draft, {
      kind: 'arguments',
      text:
        agent === 'claude'
          ? `--settings '{"fastMode":false}' --debug`
          : '-c service_tier=default --debug'
    })
    const saved = applySourceControlPickerDraft(selection, inventory, draft)
    const launch = projectSourceControlActionLaunch(selectSourceControlActionRecipe(saved), agent, {
      basePrompt: 'fix'
    })
    expect(launch.sessionOptions).toMatchObject({ [key]: agent === 'claude' ? 'false' : 'default' })
    expect(saved.source.authoredPreferences?.permissionMode).toBeUndefined()
  }
)

it('retains captured full model names and absent readback/catalog fields through sparse recipe edits', async () => {
  const schema = z.object({
    frame: z.object({ type: z.literal('system'), subtype: z.literal('init'), model: z.string() })
  })
  const init = readFileSync(
    new URL(
      '../../../../main/claude/__fixtures__/claude-adapter-capture-fold.jsonl',
      import.meta.url
    ),
    'utf8'
  )
    .trim()
    .split('\n')
    .map((line) => schema.safeParse(JSON.parse(line)))
    .find((result) => result.success)
  if (!init?.success) {
    throw new Error('Captured init missing')
  }
  const { default: recorded } =
    await import('../../../../shared/fixtures/agent-picker-cli-recordings.json')
  for (const [agent, model] of [
    ['claude', init.data.frame.model],
    ['codex', recorded.modelList.data[0].model]
  ] as const) {
    const inventory: AgentPickerEntry = {
      ...entry,
      agent,
      catalog: { origin: 'unknown' },
      terminal: { permissionMode: 'ask' },
      structured: {}
    }
    const selection = canonicalSourceControlActionSelection({ agentId: agent })
    let draft = applyAgentPickerEdit(
      inventory,
      sourceControlPickerDraft(selection, inventory, 'chat'),
      { kind: 'choice', patch: { model } }
    )
    draft = applyAgentPickerEdit(inventory, draft, { kind: 'permission', value: 'ask' })
    const saved = applySourceControlPickerDraft(selection, inventory, draft)
    expect(
      projectSourceControlActionLaunch(selectSourceControlActionRecipe(saved), agent, {
        basePrompt: 'fix'
      }).sessionOptions
    ).toMatchObject({ model, permissionMode: 'ask' })
    expect(saved.current.agentArgs).toBeUndefined()
  }
})

it('distinguishes identical complete projections with different authored ownership', () => {
  const inventory = { ...entry, arguments: '--verbose' }
  const selection = canonicalSourceControlActionSelection({ agentId: 'claude' })
  const start = sourceControlPickerDraft(selection, inventory, 'terminal')
  const permission: AgentPickerEdit = { kind: 'permission', value: 'ask' }
  const h1 = applyAgentPickerEdit(inventory, start, permission)
  let h2 = applyAgentPickerEdit(inventory, start, { kind: 'arguments', text: '--debug' })
  h2 = applyAgentPickerEdit(inventory, h2, { kind: 'arguments', text: '--verbose' })
  h2 = applyAgentPickerEdit(inventory, h2, permission)
  const { recipeEdits: _receipt1, ...view1 } = h1
  const { recipeEdits: _receipt2, ...view2 } = h2
  expect(view1).toEqual(view2)
  expect(applySourceControlPickerDraft(selection, inventory, h1).current.agentArgs).toBeUndefined()
  expect(applySourceControlPickerDraft(selection, inventory, h2).current.agentArgs).toBe(
    '--verbose'
  )
})

it.each(['claude', 'codex'] as const)(
  'removes a %s speed chip from an existing raw carrier without replaying it',
  (agent) => {
    const key = agent === 'claude' ? 'fastMode' : 'serviceTier'
    const inventory: AgentPickerEntry = { ...entry, agent, terminal: { permissionMode: 'own' } }
    const selection = canonicalSourceControlActionSelection({
      agentId: agent,
      agentArgs:
        agent === 'claude'
          ? `--settings '{"fastMode":true}' --verbose`
          : '-c service_tier=fast --verbose'
    })
    const draft = applyAgentPickerEdit(
      inventory,
      sourceControlPickerDraft(selection, inventory, 'terminal'),
      { kind: 'remove-chip', key, model: 'opus' }
    )
    const saved = applySourceControlPickerDraft(selection, inventory, draft)
    expect(saved.current.agentArgs).toContain('--verbose')
    expect(saved.current.agentArgs).not.toContain('fastMode":true')
    expect(saved.current.agentArgs).not.toContain('service_tier=fast')
    expect(
      projectSourceControlActionLaunch(selectSourceControlActionRecipe(saved), agent, {
        basePrompt: 'fix'
      }).sessionOptions
    ).toMatchObject({ [key]: agent === 'claude' ? 'false' : 'default' })
  }
)
