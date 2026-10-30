import { pickSourceControlLaunchAgent } from '../../../../shared/source-control-launch-agent-selection'
import { AgentLaunchPicker } from '@/components/agent/AgentLaunchPicker'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import {
  sourceControlPickerDraft,
  applySourceControlPickerDraft
} from './source-control-agent-launch-picker'
import {
  canonicalSourceControlActionSelection,
  pickSourceControlActionAgent,
  type CurrentActionSelection
} from '../../../../shared/source-control-action-selection'
import { useAgentMenuObservation } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import { useAppStore } from '@/store'
import {
  sourceControlRepoAgentRows,
  savedSurfaceForPick,
  type SourceControlAgentRows
} from '@/lib/source-control-agent-picker'
import { buildAgentLaunchRouteInput } from '@/lib/agent-launch-route-input'
import { AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import type { SourceControlActionRecipe } from '../../../../shared/source-control-ai-actions'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { translate } from '@/i18n/i18n'

/** The shared surface rows configure a recipe here; they never start an agent. */
type PickerProps = {
  agent: TuiAgent | null
  surface?: SourceControlActionRecipe['surface']
  repoId?: string
  disabled?: boolean
  selection?: CurrentActionSelection
  onSetupPick?: (selection: CurrentActionSelection, previous: CurrentActionSelection) => void
  onPick: (agent: TuiAgent | null, choice: Pick<SourceControlActionRecipe, 'surface'>) => void
}

export function SourceControlActionAgentPicker(props: PickerProps) {
  const repo = useAppStore((state) => state.repos.find((repo) => repo.id === props.repoId) ?? null)
  const rows = props.repoId
    ? sourceControlRepoAgentRows(repo)
    : {
        target: { workspace: { kind: 'git-worktree' as const } },
        detectionTarget: { kind: 'local' as const }
      }
  const observation = useAgentMenuObservation(rows.target, !props.disabled, rows.detectionTarget)
  const canSaveSurface = canSaveSourceControlActionSurface(rows.target, props.agent ?? 'claude')
  return (
    <SourceControlActionAgentPickerView
      {...props}
      observation={observation}
      canSaveSurface={canSaveSurface}
    />
  )
}

export function canSaveSourceControlActionSurface(
  target: SourceControlAgentRows['target'],
  agent: TuiAgent = 'claude'
): boolean {
  const route = buildAgentLaunchRouteInput(useAppStore.getState(), {
    agent,
    workspace:
      typeof target === 'string' ? { kind: 'git-worktree', worktreeId: target } : target.workspace
  })
  return route.hostCapabilities?.includes(AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY) === true
}

export function sourceControlActionAgentPreview(
  observation: ReturnType<typeof useAgentMenuObservation>,
  agent: TuiAgent | null
) {
  return observation.preferencesPending || observation.detection.detectedIds === null
    ? { status: 'pending' as const }
    : {
        status: 'ready' as const,
        agent: pickSourceControlLaunchAgent({
          savedAgent: agent,
          defaultAgent: observation.preferences.defaultTuiAgent,
          disabledAgents: observation.preferences.disabledTuiAgents,
          detectedAgents: observation.detection.detectedIds
        })
      }
}

export function SourceControlActionAgentPickerView({
  observation,
  canSaveSurface,
  ...props
}: PickerProps & {
  observation: ReturnType<typeof useAgentMenuObservation>
  canSaveSurface: boolean
}) {
  const selection =
    props.selection ??
    canonicalSourceControlActionSelection({ agentId: props.agent, surface: props.surface })
  const preview = sourceControlActionAgentPreview(observation, props.agent)
  return (
    <AgentLaunchPicker
      model={observation.model}
      agent={props.agent}
      disabled={props.disabled}
      emptyLabel={translate(
        'auto.components.settings.SourceControlAiActionRecipeDefaults.ee0e5c2a48',
        'Use default agent'
      )}
      draftForEntry={(entry) =>
        sourceControlPickerDraft(selection, entry, props.surface ?? entry.defaultSurface)
      }
      onPick={(agent, draft, entry, surface) => {
        const saved = canSaveSurface
          ? savedSurfaceForPick(observation.model, agent, surface)
          : undefined
        if (!draft || props.agent !== agent || props.surface !== saved) {
          props.onPick(agent, { surface: saved })
        }
        if (draft && entry) {
          const picked = pickSourceControlActionAgent(
            selection,
            agent,
            preview.status === 'ready' ? preview.agent : null,
            surface
          )
          const next = applySourceControlPickerDraft(picked, entry, draft)
          if (next !== picked) {
            props.onSetupPick?.(next, selection)
          }
        }
      }}
    >
      <DropdownMenuItem onSelect={() => props.onPick(null, {})}>
        {translate(
          'auto.components.settings.SourceControlAiActionRecipeDefaults.ee0e5c2a48',
          'Use default agent'
        )}
      </DropdownMenuItem>
    </AgentLaunchPicker>
  )
}
