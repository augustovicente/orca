import { reconcileAgentChoiceArgs } from '../../../../shared/agent-choice-reconciliation'
import {
  normalizeAgentModelOptionChoices,
  type AgentDedicatedChoices
} from '../../../../shared/agent-launch-choices'
import {
  findCatalogModel,
  getAgentSessionOptionLaunchCatalog
} from '../../../../shared/agent-session-option-catalog'
import type { SourceControlActionLaunchPreferences } from '../../../../shared/source-control-ai-actions'
import {
  sourceControlActionAgentPicksModel,
  sourceControlActionOptions
} from '../../../../shared/source-control-action-launch-preferences'
import { encodeCatalogOptionValue } from '../../../../shared/structured-agent-session-option-codec'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { AgentChoiceMenu } from './AgentChoiceMenu'
import { sourceControlActionRouteHint } from './SourceControlActionOptionField'
import { translate } from '@/i18n/i18n'

const AGENT_DEFAULT_VALUE = '__agent_default__'

export type AgentChoiceControlsProps = {
  agent: TuiAgent | null | undefined
  value: AgentDedicatedChoices | undefined
  disabled?: boolean
  onOpenChange?: (open: boolean) => void
  optionIds?: readonly string[]
  defaultLabels?: { model?: string; options?: Record<string, string> }
  layout?: 'stacked' | 'contents' | 'rows'
  onChange: (value: AgentDedicatedChoices | undefined) => void
}

export function AgentChoiceControls({
  agent,
  value,
  disabled,
  onOpenChange,
  optionIds,
  defaultLabels,
  layout = 'stacked',
  onChange
}: AgentChoiceControlsProps): React.JSX.Element | null {
  const picksModel = sourceControlActionAgentPicksModel(agent)
  if (!agent || !picksModel) {
    return null
  }
  const catalog = picksModel ? getAgentSessionOptionLaunchCatalog(agent) : null
  const selected = value
  // Model and permission mode are saved independently; a model change keeps the mode.
  const save = (next: AgentDedicatedChoices): void =>
    onChange({
      ...normalizeAgentModelOptionChoices(next),
      ...(next.permissionMode ? { permissionMode: next.permissionMode } : {})
    })
  const model = catalog && selected?.model ? findCatalogModel(catalog, selected.model) : undefined
  const unlistedModel = catalog && selected?.model && !model ? selected.model : undefined
  const options = sourceControlActionOptions(agent, selected?.model ?? '').filter(
    // CLI carrier mappings remain available to Args badges without advertising a mode control.
    ({ option }) =>
      (Boolean(model) || option.category !== 'mode') &&
      (!optionIds || optionIds.includes(option.id))
  )
  const defaultLabel = translate('settings.sourceControl.actionModel.effortDefault', 'Default')
  return (
    <div className={layout === 'contents' ? 'contents' : 'grid min-w-0 grid-cols-1 gap-2'}>
      {catalog ? (
        <AgentChoiceMenu
          label={translate('settings.sourceControl.actionModel.model', 'Model')}
          row={layout === 'rows'}
          value={selected?.model ?? AGENT_DEFAULT_VALUE}
          disabled={disabled}
          onOpenChange={onOpenChange}
          choices={[
            {
              value: AGENT_DEFAULT_VALUE,
              label:
                defaultLabels?.model ??
                translate('settings.sourceControl.actionModel.agentDefault', 'Agent default')
            },
            ...catalog.models.map(({ id, label }) => ({ value: id, label })),
            ...(unlistedModel ? [{ value: unlistedModel, label: unlistedModel }] : [])
          ]}
          onChange={(model) =>
            onChange(
              reconcileAgentChoiceArgs({
                agent,
                choices: selected ?? {},
                userArgs: '',
                mode: 'choice-edit',
                keys: new Set(['model']),
                patch: { model: model === AGENT_DEFAULT_VALUE ? null : model }
              }).choices
            )
          }
        />
      ) : null}
      {options.map(({ option, route }) => {
        const choices =
          option.kind.type === 'select'
            ? option.kind.choices
            : [
                {
                  value: 'true',
                  label: translate('settings.sourceControl.actionModel.on', 'On')
                },
                {
                  value: 'false',
                  label: translate('settings.sourceControl.actionModel.off', 'Off')
                }
              ]
        const current = selected?.options?.[option.id]
        return (
          <AgentChoiceMenu
            key={option.id}
            label={option.label}
            row={layout === 'rows'}
            hint={sourceControlActionRouteHint(route)}
            value={current ?? AGENT_DEFAULT_VALUE}
            disabled={disabled}
            onOpenChange={onOpenChange}
            choices={[
              {
                value: AGENT_DEFAULT_VALUE,
                label: defaultLabels?.options?.[option.id] ?? defaultLabel
              },
              ...choices,
              ...(current && !choices.some((choice) => choice.value === current)
                ? [{ value: current, label: current }]
                : [])
            ]}
            onChange={(next) => {
              const { [option.id]: _old, ...rest } = selected?.options ?? {}
              const encoded =
                next === AGENT_DEFAULT_VALUE
                  ? null
                  : encodeCatalogOptionValue(
                      option.kind,
                      option.kind.type === 'boolean' ? next === 'true' : next
                    )
              const values = {
                ...rest,
                ...(encoded === null ? {} : { [option.id]: encoded })
              }
              save({ ...selected, options: values })
            }}
          />
        )
      })}
    </div>
  )
}

export function SourceControlActionModelPicker(
  props: Omit<AgentChoiceControlsProps, 'value' | 'onChange'> & {
    value: SourceControlActionLaunchPreferences | undefined
    onChange: (value: SourceControlActionLaunchPreferences | undefined) => void
  }
): React.JSX.Element {
  return (
    <AgentChoiceControls
      {...props}
      value={props.value?.agentId === props.agent ? props.value : undefined}
      onChange={(value) =>
        props.onChange(
          props.agent && value && Object.keys(value).length
            ? { agentId: props.agent, ...value }
            : undefined
        )
      }
    />
  )
}
