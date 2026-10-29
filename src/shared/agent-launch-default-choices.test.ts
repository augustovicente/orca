import { describe, expect, it } from 'vitest'
import {
  agentLaunchSettingsMutationUpdates,
  projectAgentLaunchSettings,
  type AgentLaunchSettingsSource
} from './agent-launch-settings'
import { AgentLaunchSettingsMutation } from './rpc-contract/agent-launch-settings-params'
import { migrateAgentPermissionChoice } from './tui-agent-permission-lift'
import { legacyLaunchTextUpdates } from './agent-launch-permission-updates'
import { agentLaunchSettingsRollbackUpdates } from '../main/runtime/agent-launch-settings-rollback'
import { structuredLaunchSeedOptions } from './native-chat/input/native-chat-session-option-defaults'
import { structuredAgentConfiguredArgs } from '../main/native-chat/structured-agent-configured-args'

const baseline: AgentLaunchSettingsSource = {
  agentPermissionDefault: 'ask',
  agentPermissionOverrides: {},
  agentDefaultArgs: { claude: '--verbose', codex: '--search' },
  agentLaunchChoices: {
    claude: { model: 'opus', options: { effort: 'high' } },
    codex: { model: 'opaque-id' }
  }
}
function mutate(
  settings: AgentLaunchSettingsSource,
  mutation: Parameters<typeof agentLaunchSettingsMutationUpdates>[1]
) {
  return { ...settings, ...agentLaunchSettingsMutationUpdates(settings, mutation, 'darwin') }
}

describe('host-authored launch defaults', () => {
  it('migrates typed-permission profiles once, preserves independent effort and initialized emptiness', () => {
    const loaded = migrateAgentPermissionChoice({
      agentPermissionDefault: 'ask',
      agentDefaultArgs: {
        claude: '--model retired-id --effort high --verbose',
        codex: '-c model_reasoning_effort=low --search'
      }
    })
    expect(loaded.agentLaunchChoices).toEqual({
      claude: { model: 'retired-id', options: { effort: 'high' } },
      codex: { options: { effort: 'low' } }
    })
    expect(loaded.agentDefaultArgs).toMatchObject({ claude: '--verbose', codex: '--search' })
    expect(migrateAgentPermissionChoice(loaded)).toEqual(loaded)
    expect(
      migrateAgentPermissionChoice({
        ...loaded,
        agentLaunchChoices: {},
        agentDefaultArgs: { claude: '--model literal' }
      }).agentDefaultArgs.claude
    ).toBe('--model literal')
  })

  it('publishes both legacy forms and reconciles no-ops, deletion and whole-map replacement', () => {
    const published = projectAgentLaunchSettings(baseline)
    expect(published.agentChoices?.userArgs.claude).toBe('--verbose')
    expect(published.agentPermission?.userArgs.claude).toBe('--model opus --effort high --verbose')
    expect(published.agentDefaultArgs.claude).toContain('--permission-mode default')
    for (const [type, value] of [
      ['arguments', published.agentDefaultArgs.claude],
      ['user-arguments', published.agentPermission?.userArgs.claude]
    ] as const) {
      expect(
        agentLaunchSettingsMutationUpdates(
          baseline,
          { type, agent: 'claude', value: value ?? '' },
          'darwin'
        )
      ).toEqual({})
      const edited = mutate(baseline, { type, agent: 'claude', value: '--verbose' })
      expect(edited.agentLaunchChoices?.claude).toBeUndefined()
      expect(edited.agentLaunchChoices?.codex).toEqual(baseline.agentLaunchChoices?.codex)
      expect(edited.agentPermissionOverrides?.claude).toBe(type === 'arguments' ? 'own' : undefined)
    }
    const replaced = {
      ...baseline,
      ...legacyLaunchTextUpdates(baseline, {
        agentDefaultArgs: { claude: published.agentDefaultArgs.claude }
      })
    }
    expect(replaced.agentLaunchChoices).toEqual({ claude: baseline.agentLaunchChoices?.claude })
  })

  it('applies option deltas to latest state and removes only matching dirty recipes atomically', () => {
    const settings = mutate(baseline, {
      type: 'launch-choices',
      agent: 'claude',
      patch: { options: { other: 'kept' } }
    })
    const cleared = mutate(settings, {
      type: 'launch-choices',
      agent: 'claude',
      patch: { options: { effort: null } },
      userArgs: '--effort low --verbose'
    })
    expect(cleared.agentLaunchChoices?.claude).toEqual({
      model: 'opus',
      options: { other: 'kept' }
    })
    expect(cleared.agentDefaultArgs?.claude).toBe('--effort low --verbose')
    const matched = mutate(settings, {
      type: 'launch-choices',
      agent: 'claude',
      patch: { options: { effort: null }, permissionMode: 'own' },
      userArgs: '--effort high --permission-mode default --verbose'
    })
    expect(matched.agentDefaultArgs?.claude).toBe('--verbose')
    expect(matched.agentPermissionOverrides?.claude).toBe('own')
    expect(matched.agentLaunchChoices?.claude?.options).toEqual({ other: 'kept' })
  })

  it('rolls back a complete failed tuple while preserving unrelated and newer agent edits', () => {
    const updates = agentLaunchSettingsMutationUpdates(
      baseline,
      {
        type: 'launch-choices',
        agent: 'claude',
        patch: { model: 'sonnet', permissionMode: 'own' },
        userArgs: '--model sonnet'
      },
      'darwin'
    )
    const applied = { ...baseline, ...updates }
    const unrelated = mutate(applied, {
      type: 'launch-choices',
      agent: 'codex',
      patch: { model: 'new-codex' }
    })
    const restored = {
      ...unrelated,
      ...agentLaunchSettingsRollbackUpdates(baseline, applied, unrelated, updates)
    }
    expect(restored.agentLaunchChoices?.claude).toEqual(baseline.agentLaunchChoices?.claude)
    expect(restored.agentDefaultArgs?.claude).toBe('--verbose')
    expect(restored.agentPermissionOverrides?.claude).toBeUndefined()
    expect(restored.agentLaunchChoices?.codex?.model).toBe('new-codex')
    const newer = mutate(applied, {
      type: 'launch-choices',
      agent: 'claude',
      userArgs: '--verbose newest'
    })
    expect(agentLaunchSettingsRollbackUpdates(baseline, applied, newer, updates)).toEqual({})
  })

  it('seeds authored defaults above remembered choices, preserves remembering on clear and keeps generated flags out of raw native args', () => {
    const settings = {
      ...baseline,
      nativeChatSessionOptions: {
        claude: { model: 'sonnet', valuesByModel: { sonnet: { effort: 'low' } } }
      },
      nativeChatPermissionMode: null
    }
    expect(structuredLaunchSeedOptions(settings, 'claude')).toMatchObject({
      model: 'opus',
      effort: 'high'
    })
    expect(
      structuredLaunchSeedOptions({ ...settings, agentLaunchChoices: {} }, 'claude')
    ).toMatchObject({ model: 'sonnet', effort: 'low' })
    expect(structuredAgentConfiguredArgs('claude', settings)).toEqual(['--verbose'])
    expect(
      structuredAgentConfiguredArgs('claude', {
        ...settings,
        agentDefaultArgs: { claude: '--model conflicting --verbose' }
      })
    ).toEqual(['--verbose'])
    expect(
      structuredAgentConfiguredArgs('claude', { agentDefaultArgs: { claude: '--model literal' } })
    ).toEqual(['--model', 'literal'])
  })

  it('validates the additive mutation strictly without changing old mutation shapes', () => {
    const valid = {
      type: 'launch-choices',
      agent: 'codex',
      patch: { options: { effort: 'high' }, model: null }
    }
    expect(AgentLaunchSettingsMutation.safeParse(valid).success).toBe(true)
    for (const invalid of [
      { type: 'launch-choices', agent: 'codex' },
      { ...valid, patch: { extra: true } },
      { ...valid, patch: { options: { model: 'bad' } } },
      { ...valid, patch: { model: 'x'.repeat(513) } }
    ]) {
      expect(AgentLaunchSettingsMutation.safeParse(invalid).success).toBe(false)
    }
  })
})
