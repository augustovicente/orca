import type {
  AgentDedicatedChoices,
  AgentChoicePatch
} from '../../../../shared/agent-launch-choices'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { composeAgentLaunchModel } from '../../../../shared/agent-session-option-launch'
import { projectAgentLaunchProfile } from '../../../../shared/agent-launch-profile'
import { sourceControlActionOptions } from '../../../../shared/source-control-action-launch-preferences'
import type { AgentArgsChoice } from './AgentPermissionChoiceControls'

export function agentModelChoiceChips(
  agent: TuiAgent | null | undefined,
  label: string,
  selected: AgentDedicatedChoices | undefined,
  onRemove: (patch: AgentChoicePatch, text: string) => string
): AgentArgsChoice[] {
  return agent
    ? Object.entries({ model: selected?.model, ...selected?.options }).flatMap(([key, chosen]) => {
        if (!chosen) {
          return []
        }
        const option =
          sourceControlActionOptions(agent, selected?.model ?? '').find(
            ({ option }) => option.id === key
          )?.option ??
          sourceControlActionOptions(agent, '').find(({ option }) => option.id === key)?.option
        const flag = option?.apply.composedIntoModel
          ? `${option.label} ${chosen}`
          : projectAgentLaunchProfile(
              agent,
              { agentPermissionDefault: 'own' },
              {
                target: 'legacy-permission',
                userArgs: '',
                choices:
                  key === 'model'
                    ? {
                        model: composeAgentLaunchModel(agent, {
                          ...selected?.options,
                          model: chosen
                        })
                      }
                    : { options: { [key]: chosen } }
              }
            ).args
        return flag
          ? [
              {
                key,
                label,
                flag,
                onRemove: (text: string) =>
                  onRemove(key === 'model' ? { model: null } : { options: { [key]: null } }, text)
              }
            ]
          : []
      })
    : []
}
