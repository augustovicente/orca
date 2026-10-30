import {
  formatKeybindingList,
  getEffectiveKeybindingsForAction,
  keybindingMatchesAction,
  keybindingMatchesInput,
  parseKeybinding,
  platformModifiers,
  type TerminalShortcutPolicy
} from '../../../../shared/keybindings'
import {
  readAgentTabShortcutActions,
  resolveAgentTabShortcutAction
} from '../terminal-agent-tab-shortcut'
import type { KeybindingOverrides } from '../../../../shared/keybindings'
import type { TuiAgent } from '../../../../shared/tui-agent'

export function agentMenuShortcutLabels(
  worktreeId: string,
  keybindings: KeybindingOverrides,
  platform: NodeJS.Platform,
  terminalShortcutPolicy: TerminalShortcutPolicy | undefined
): Map<TuiAgent, string> {
  const actions = readAgentTabShortcutActions(worktreeId, keybindings).map((action) => ({
    ...action
  }))
  const labels = new Map<TuiAgent, string[]>()
  for (const action of actions) {
    const agent = action.agent
    if (!agent) {
      continue
    }
    for (const binding of getEffectiveKeybindingsForAction(
      action.actionId,
      platform,
      keybindings
    )) {
      const parsed = parseKeybinding(binding)
      // Ordinary workspace listeners deliver raw key events, without a double-tap producer.
      if (!parsed || parsed.doubleTapModifier) {
        continue
      }
      const key =
        parsed.key === 'NumpadAdd' ? '+' : parsed.key === 'NumpadSubtract' ? '-' : parsed.key
      // AltGr punctuation can come from a text key; numpad chords require their physical code.
      const codes = parsed.key.startsWith('Numpad') ? [parsed.key] : [parsed.key, 'Digit8']
      const opensAgent = codes.some((code) => {
        const input = { key, code, ...platformModifiers(parsed, platform) }
        if (!keybindingMatchesInput(binding, input, platform)) {
          return false
        }
        return (
          resolveAgentTabShortcutAction(actions, (actionId) =>
            keybindingMatchesAction(actionId, input, platform, keybindings, {
              context: 'app',
              terminalShortcutPolicy
            })
          )?.agent === agent
        )
      })
      if (opensAgent) {
        const label = formatKeybindingList([binding], platform)
        labels.set(agent, [...new Set([...(labels.get(agent) ?? []), label])])
      }
    }
  }
  return new Map([...labels].map(([agent, chords]) => [agent, chords.join(', ')]))
}
