// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, cleanup, fireEvent, screen, within, waitFor } from '@testing-library/react'
import '../../__fixtures__/settings-persistence-test-fixture'
import React from 'react'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import { createRepoActionTextDraftEditors } from '../../repository-source-control-ai-text-draft'
import { normalizeRepoSourceControlAiOverrides } from '../../../../../../shared/source-control-ai-repo-settings'
import type { RepoSourceControlAiOverrides } from '../../../../../../shared/source-control-ai-types'
import { setSourceControlActionAgentDefault } from '../../../../../../shared/source-control-ai-actions'
import {
  computeActionDirtyById,
  dropRepoLegacyInstructionForAction,
  withRepoAiActionMode,
  withRepoAiActionRecipeText
} from './repository-source-control-ai-draft'
import { withRepoAiActionAgent } from '../../repository-source-control-ai-action-agent-draft'
import { resolveSourceControlActionRecipe } from '../../../../../../shared/source-control-ai-operation-policy'
import {
  saveSourceControlActionRecipe,
  toSourceControlAiRepoUpdate
} from '../../../../../../shared/source-control-ai-recipe-save'
import { sourceControlActionRecipeMatchesTarget } from '../../../right-sidebar/source-control-action-recipe-match'
import { SourceControlActionAgentPicker } from '../../SourceControlActionAgentPicker'
import { RepositorySourceControlAiActionRows } from './RepositorySourceControlAiActionRows'
import { SourceControlAiActionRecipeDefaults } from '../../SourceControlAiActionRecipeDefaults'
import { useAppStore } from '../../../../store/index'
import { TooltipProvider } from '../../../ui/tooltip'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { projectAgentLaunchSettings } from '../../../../../../shared/agent-launch-settings'
import { TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { clearHostAgentMenuSettingsForTests } from '../../use-host-agent-launch-preferences'
import { mutateHostAgentLaunchSettings } from '../../agent-launch-settings-transport'
import { getRuntimeAgentInventoryKey } from '@/store/slices/runtime-agent-inventory-key'
import { resetHostStructuredAgentsForTests } from '@/runtime/host-structured-agents'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc,
  runtimeEnvironmentSupportsCapability: async () => true
}))
afterEach(() => {
  cleanup()
  clearHostAgentMenuSettingsForTests()
  resetHostStructuredAgentsForTests()
  setLocalRuntimeCapabilitiesForTests(null)
})
describe('saved chat-or-CLI pick', () => {
  it('stays bound to its agent through reads, inheritance, Customize, agent changes and saves', () => {
    const base = useAppStore.getState().settings!
    const actions = { fixChecks: { agentId: 'codex' as const, surface: 'terminal' as const } }
    const settings = { ...base, sourceControlAi: { ...base.sourceControlAi!, actions } }
    const resolve = (sourceControlAi: RepoSourceControlAiOverrides) =>
      resolveSourceControlActionRecipe({
        settings,
        repo: { sourceControlAi },
        actionId: 'fixChecks'
      }).surface
    expect(resolve({})).toBe('terminal')
    // A repo on its own agent never inherits the global agent's pick.
    expect(resolve({ actionOverrides: { fixChecks: { agentId: 'claude' } } })).toBeUndefined()

    const customized = withRepoAiActionMode({}, settings, 'fixChecks', 'override')
    expect(customized.actionOverrides?.fixChecks?.surface).toBe('terminal')
    const repoSurface = (agent: 'codex' | 'claude') =>
      withRepoAiActionAgent(customized, settings, 'fixChecks', agent).actionOverrides?.fixChecks
        ?.surface
    expect([repoSurface('codex'), repoSurface('claude')]).toEqual(['terminal', undefined])
    // Changing the agent (or choosing "Use default agent") drops it even with no saved model.
    const globalSurface = (agent: 'codex' | 'claude' | null) =>
      setSourceControlActionAgentDefault(actions, 'fixChecks', agent).fixChecks?.surface
    expect([globalSurface('codex'), globalSurface('claude'), globalSurface(null)]).toEqual([
      'terminal',
      undefined,
      undefined
    ])

    const recipe = { agentId: 'codex' as const, commandInputTemplate: '{basePrompt}' }
    const saved = saveSourceControlActionRecipe({
      target: { type: 'repo', repoId: 'repo-1' },
      settings,
      repo: { sourceControlAi: {} },
      actionId: 'fixChecks',
      recipe: { ...recipe, surface: 'terminal' }
    })
    const savedRepoAi = 'update' in saved ? saved.update.sourceControlAi : null
    expect(savedRepoAi?.actionOverrides?.fixChecks?.surface).toBe('terminal')
    const matches = (surface: 'chat' | 'terminal') =>
      sourceControlActionRecipeMatchesTarget({
        actionId: 'fixChecks',
        target: { type: 'repo', repoId: 'repo-1' },
        recipe: { ...recipe, surface },
        settings,
        repo: { sourceControlAi: savedRepoAi ?? undefined }
      })
    expect([matches('terminal'), matches('chat')]).toEqual([true, false])
  })
})

describe('RepositorySourceControlAiActionRows', () => {
  it.each([
    { agent: 'codex', detected: ['codex'], surface: undefined },
    { agent: 'codex', detected: ['codex'], surface: 'terminal' },
    { agent: 'codex', detected: ['codex'], surface: 'chat' },
    { agent: 'opencode', detected: ['opencode'], surface: undefined },
    { agent: 'codex', detected: ['claude'], surface: undefined }
  ] as const)(
    'keeps saved $agent/$surface controls bound across detection returning $detected',
    async ({ agent, detected, surface }) => {
      useAppStore.getState().clearLocalDetectedAgents()
      const settings = useAppStore.getState().settings!
      const recipe = {
        agentId: agent,
        surface,
        launchPreferences: {
          agentId: agent,
          permissionMode: 'ask' as const,
          model: 'saved',
          options: { fastMode: 'false' }
        },
        agentArgs: '--saved-cli',
        commandInputTemplate: 'kept-template'
      }
      const source = {
        ...settings.sourceControlAi!,
        enabled: true,
        actions: { fixCommitFailure: recipe }
      }
      const originalRecipe = JSON.stringify(recipe)
      let finish: (ids: string[]) => void = () => {}
      const detectAgents = vi.fn(
        () =>
          new Promise<string[]>((resolve) => {
            finish = resolve
          })
      )
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { preflight: { detectAgents } }
      })
      useAppStore.setState({
        repos: [{ ...TEST_REPO, id: 'repo-1' }],
        settings: {
          ...settings,
          experimentalNativeChat: false,
          defaultTuiAgent: 'claude',
          sourceControlAi: source
        },
        settingsSearchQuery: '',
        localDetectedAgentIdsByContext: {}
      })
      const ensure = vi.spyOn(useAppStore.getState(), 'ensureNativeDetectedAgents')
      const writeConfig = vi.fn()
      const onEdit = vi.fn()
      const view = render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(SourceControlAiActionRecipeDefaults, {
            config: source,
            defaultTuiAgent: 'claude',
            searchQuery: '',
            writeConfig
          }),
          React.createElement(RepositorySourceControlAiActionRows, {
            repoId: 'repo-1',
            repoAi: { actionOverrides: { fixCommitFailure: recipe } },
            source,
            defaultTuiAgent: 'claude',
            savingActionIds: {},
            actionDirtyById: computeActionDirtyById({}, {}, {}),
            onActionModeChange: onEdit,
            onActionAgentChange: onEdit,
            onActionLaunchPreferencesChange: onEdit,
            onActionTemplateChange: onEdit,
            onActionAgentArgsChange: onEdit,
            onAppendVariable: onEdit,
            onActionDiscard: onEdit,
            onActionSave: onEdit
          })
        )
      )
      await act(async () => {})
      const cards = Array.from(view.container.querySelectorAll('textarea'))
        .filter((field) => field.value === 'kept-template')
        .map((field) => field.parentElement!.closest('.rounded-md')!)
      expect(cards).toHaveLength(2)
      expect(ensure).toHaveBeenCalledTimes(2)
      expect(detectAgents).toHaveBeenCalledTimes(1)
      const triggers = () =>
        cards.map((card) =>
          card.querySelector<HTMLButtonElement>('button[aria-label="Select agent"]')!
        )
      expect(triggers().every((trigger) => trigger.disabled)).toBe(true)
      await act(async () => finish([...detected]))
      expect(triggers().every((trigger) => !trigger.disabled)).toBe(true)
      for (const experimentalNativeChat of [true, false]) {
        await act(() =>
          useAppStore.setState({
            settings: { ...useAppStore.getState().settings!, experimentalNativeChat }
          })
        )
        for (const card of cards) {
          expect(
            card.querySelector('button[aria-label="Select agent"]')?.textContent?.toLowerCase()
          ).toContain(agent)
          expect(card.querySelector('textarea[aria-label="Arguments"]')).toBeNull()
          expect(card.querySelector('textarea')?.value).toBe('kept-template')
        }
      }
      expect(JSON.stringify(source.actions.fixCommitFailure)).toBe(originalRecipe)
      expect(writeConfig).not.toHaveBeenCalled()
      expect(onEdit).not.toHaveBeenCalled()
    }
  )
})

describe('dropRepoLegacyInstructionForAction', () => {
  it('prevents legacy text instructions from remigrating after an action override is cleared', () => {
    const next = dropRepoLegacyInstructionForAction(
      {
        instructionsByOperation: {
          commitMessage: 'Use repo style.',
          pullRequest: 'Use PR style.'
        },
        actionOverrides: {}
      },
      'commitMessage'
    )

    expect(next.instructionsByOperation).toEqual({ pullRequest: 'Use PR style.' })
    const normalized = normalizeRepoSourceControlAiOverrides(next)
    expect(normalized?.actionOverrides?.commitMessage).toBeUndefined()
    expect(normalized?.actionOverrides?.pullRequest).toEqual({
      commandInputTemplate: '{basePrompt}\n\nUse PR style.'
    })
  })
})

it.each(['', '--model raw'])(
  'a repository agent/surface edit keeps its owned Arguments group without pinning global choices (%s)',
  (agentArgs) => {
    const settings = useAppStore.getState().settings!
    const launchPreferences = {
      agentId: 'codex' as const,
      model: 'saved',
      permissionMode: 'ask' as const
    }
    const sourceSettings = {
      ...settings,
      sourceControlAi: {
        ...settings.sourceControlAi!,
        actions: { fixChecks: { agentId: 'codex' as const, agentArgs: '', launchPreferences } }
      }
    }
    const edited = withRepoAiActionAgent(
      { actionOverrides: { fixChecks: { commandInputTemplate: '{basePrompt}', agentArgs } } },
      sourceSettings,
      'fixChecks',
      'codex',
      { surface: 'terminal' }
    )
    expect(edited.actionOverrides?.fixChecks).toMatchObject({
      agentId: 'codex',
      agentArgs,
      surface: 'terminal'
    })
    expect(edited.actionOverrides?.fixChecks?.launchPreferences).toBeUndefined()
    const payload = toSourceControlAiRepoUpdate(edited).sourceControlAi
    const replay = resolveSourceControlActionRecipe({
      settings: sourceSettings,
      repo: { sourceControlAi: payload ?? undefined },
      actionId: 'fixChecks'
    })
    expect(replay).toMatchObject({ agentArgs, surface: 'terminal' })
    expect(replay.launchPreferences).toBeUndefined()
    expect(replay.launchPreferencesYieldToAgentArgs).toBeUndefined()
    const changedAgent = withRepoAiActionAgent(edited, sourceSettings, 'fixChecks', 'claude', {
      surface: 'chat'
    })
    expect(changedAgent.actionOverrides?.fixChecks?.launchPreferences).toBeUndefined()
  }
)

it('keeps default and missing-agent editors disabled only until the host inventory settles', async () => {
  const settings = useAppStore.getState().settings!
  useAppStore.setState({
    settings: { ...settings, experimentalNativeChat: false },
    detectedAgentIds: null,
    ensureDetectedAgents: vi.fn(() => new Promise<TuiAgent[]>(() => {}))
  })
  const onPick = vi.fn()
  const picker = (agent: 'codex' | null) =>
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(SourceControlActionAgentPicker, { agent, onPick })
    )
  const view = render(picker(null))
  expect(view.getByRole('button', { name: 'Select agent' }).hasAttribute('disabled')).toBe(true)
  view.rerender(picker('codex'))
  expect(view.getByRole('button', { name: 'Select agent' }).hasAttribute('disabled')).toBe(true)
  await act(async () => useAppStore.setState({ detectedAgentIds: ['claude'] }))
  expect(view.getByRole('button', { name: 'Select agent' }).hasAttribute('disabled')).toBe(false)
  expect(onPick).not.toHaveBeenCalled()
  fireEvent.pointerDown(view.getByRole('button', { name: 'Select agent' }), {
    button: 0,
    ctrlKey: false
  })
  const available = view.getAllByRole('menuitem').find((row) => row.textContent?.includes('Claude'))
  expect(available).toBeDefined()
  fireEvent.click(available!)
  expect(onPick).toHaveBeenCalledWith('claude', {})
})

it.each([1, 10])(
  'shares one host request lifetime across %i real Settings sections and all five launch rows',
  async (sections) => {
    const settings = useAppStore.getState().settings!
    const recipe = {
      agentId: null,
      launchPreferences: { agentId: 'codex' as const, model: 'saved-model' }
    }
    const actions = Object.fromEntries(
      [
        'fixCommitFailure',
        'fixPushFailure',
        'fixChecks',
        'resolveConflicts',
        'resolveComments'
      ].map((id) => [id, recipe])
    )
    const pending = Promise.withResolvers<{
      settings: ReturnType<typeof projectAgentLaunchSettings>
    }>()
    rpc.mockImplementation((_target, method) =>
      method === 'settings.getAgentLaunch' ? pending.promise : Promise.resolve({ settings: host })
    )
    const gets = () => rpc.mock.calls.filter((call) => call[1] === 'settings.getAgentLaunch')
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const cleared = vi.spyOn(globalThis, 'clearTimeout')
    const deadlines = () =>
      timers.mock.calls.flatMap((call, i) =>
        call[1] === 3_000 ? [timers.mock.results[i].value] : []
      )
    const host = projectAgentLaunchSettings({
      defaultTuiAgent: 'codex',
      disabledTuiAgents: ['claude']
    })
    useAppStore.setState({
      settings: {
        ...settings,
        experimentalNativeChat: false,
        defaultTuiAgent: 'claude',
        disabledTuiAgents: ['codex']
      },
      repos: [{ ...TEST_REPO, executionHostId: 'runtime:alpha' }],
      runtimeDetectedAgentIds: { [getRuntimeAgentInventoryKey('alpha')]: ['claude', 'codex'] },
      ensureRuntimeDetectedAgents: vi.fn().mockResolvedValue(['claude', 'codex']),
      refreshRuntimeDetectedAgents: vi.fn().mockResolvedValue(['claude', 'codex']),
      ensureNativeDetectedAgents: vi.fn()
    })
    const edit = vi.fn()
    const props = {
      repoId: TEST_REPO.id,
      repoAi: { actionOverrides: actions },
      source: settings.sourceControlAi!,
      defaultTuiAgent: 'claude' as const,
      savingActionIds: {},
      actionDirtyById: computeActionDirtyById({}, {}, {}),
      onActionModeChange: edit,
      onActionAgentChange: edit,
      onActionLaunchPreferencesChange: edit,
      onActionTemplateChange: edit,
      onActionAgentArgsChange: edit,
      onAppendVariable: edit,
      onActionDiscard: edit,
      onActionSave: edit
    }
    const tree = (n: number) =>
      React.createElement(
        TooltipProvider,
        null,
        Array.from({ length: n }, (_, key) =>
          React.createElement(RepositorySourceControlAiActionRows, { ...props, key })
        )
      )
    const view = render(tree(sections))
    try {
      await act(async () => {})
      expect(gets()).toHaveLength(1)
      expect(deadlines()).toHaveLength(1)
      await act(async () => pending.resolve({ settings: host }))
      expect(
        deadlines().every((id) => cleared.mock.calls.some(([clearedId]) => clearedId === id))
      ).toBe(true)
      const previews = () => view.queryAllByRole('button', { name: 'Select agent' })
      expect(previews()).toHaveLength(5 * sections)
      fireEvent.change(view.container.querySelector('textarea')!, { target: { value: 'edited' } })
      expect(gets()).toHaveLength(1)
      view.rerender(tree(1))
      const refresh = Promise.withResolvers<{ settings: typeof host }>()
      rpc.mockImplementation((_target, method) =>
        method === 'settings.getAgentLaunch' ? refresh.promise : Promise.resolve({ settings: host })
      )
      await act(async () => {
        await mutateHostAgentLaunchSettings(
          { environmentId: 'alpha' },
          { type: 'availability', agent: 'claude', enabled: true }
        )
      })
      expect(gets()).toHaveLength(2)
      const signal = gets().at(-1)?.[3].signal
      await act(async () =>
        refresh.resolve({ settings: projectAgentLaunchSettings({ defaultTuiAgent: 'claude' }) })
      )
      expect(previews()).toHaveLength(5)
      rpc.mockImplementation((_target, method) =>
        method === 'settings.getAgentLaunch'
          ? new Promise(() => {})
          : Promise.resolve({ settings: host })
      )
      await act(async () => {
        await mutateHostAgentLaunchSettings(
          { environmentId: 'alpha' },
          { type: 'availability', agent: 'codex', enabled: false }
        )
      })
      view.unmount()
      await act(async () => {})
      expect(signal.aborted).toBe(false)
      expect(gets().at(-1)?.[3].signal.aborted).toBe(true)
      expect(
        deadlines().every((id) => cleared.mock.calls.some(([clearedId]) => clearedId === id))
      ).toBe(true)
    } finally {
      view.unmount()
      timers.mockRestore()
      cleared.mockRestore()
    }
  }
)

it('passes deliberate equal-parent Args through the real repository row, sparse writer and saved recipe', async () => {
  rpc.mockReset().mockResolvedValue(undefined)
  setLocalRuntimeCapabilitiesForTests([])
  const base = useAppStore.getState().settings!
  const source = {
    ...base.sourceControlAi!,
    actions: { resolveConflicts: { agentId: 'claude' as const, agentArgs: '--verbose' } }
  }
  const own = { actionOverrides: { resolveConflicts: {} } }
  useAppStore.setState({
    settings: { ...base, experimentalNativeChat: false, sourceControlAi: source },
    repos: [TEST_REPO],
    localDetectedAgentIdsByContext: { host: ['claude', 'codex'] }
  })
  const change = vi.fn()
  render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(RepositorySourceControlAiActionRows, {
        repoId: TEST_REPO.id,
        repoAi: own,
        source,
        defaultTuiAgent: 'claude',
        savingActionIds: {},
        actionDirtyById: computeActionDirtyById({}, {}, {}),
        onActionModeChange: vi.fn(),
        onActionAgentChange: vi.fn(),
        onActionLaunchPreferencesChange: change,
        onActionTemplateChange: vi.fn(),
        onActionAgentArgsChange: vi.fn(),
        onAppendVariable: vi.fn(),
        onActionDiscard: vi.fn(),
        onActionSave: vi.fn()
      })
    )
  )
  const row = within(screen.getByText('Conflict resolution').closest<HTMLElement>('[id]')!)
  const trigger = row.getByRole('button', { name: 'Select agent' })
  await waitFor(() => expect(trigger).toHaveProperty('disabled', false))
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  fireEvent.click(screen.getByRole('button', { name: 'Configure Claude' }))
  const input = screen.getByRole('textbox', { name: 'Arguments' })
  await waitFor(() => expect(input).toHaveProperty('disabled', false))
  fireEvent.change(input, { target: { value: '--debug' } })
  fireEvent.change(input, { target: { value: '--verbose' } })
  fireEvent.click(screen.getByRole('button', { name: 'Use' }))
  expect(change).toHaveBeenCalledWith('resolveConflicts', undefined, '--verbose', undefined)
  let drafts: Parameters<typeof createRepoActionTextDraftEditors>[0] extends React.Dispatch<
    React.SetStateAction<infer State>
  >
    ? State
    : never = {}
  const writers = createRepoActionTextDraftEditors(
    (update) => {
      drafts = typeof update === 'function' ? update(drafts) : update
    },
    { current: own },
    source
  )
  const [actionId, preferences, args, nodes] = change.mock.calls[0]
  writers.updateActionLaunchPreferences(actionId, preferences, args, nodes)
  const saved = withRepoAiActionRecipeText(
    own,
    { ...base, sourceControlAi: source },
    'resolveConflicts',
    drafts.resolveConflicts!
  )
  expect(saved.actionOverrides?.resolveConflicts?.agentArgs).toBe('--verbose')
  expect(
    resolveSourceControlActionRecipe({
      settings: {
        sourceControlAi: {
          ...source,
          actions: { resolveConflicts: { agentId: 'claude', agentArgs: '--new-parent' } }
        }
      },
      repo: { sourceControlAi: saved },
      actionId: 'resolveConflicts'
    }).agentArgs
  ).toBe('--verbose')
})
