import { useRef, useState, type Ref } from 'react'
import type {
  AgentChoicePatch,
  AgentModelOptionChoices
} from '../../../../shared/agent-launch-choices'
import { AGENT_LAUNCH_CHOICE_KEYS } from '../../../../shared/agent-launch-choices'
import { reconcileAgentChoiceArgs } from '../../../../shared/agent-choice-reconciliation'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { translate } from '@/i18n/i18n'
import { AgentChoiceControls } from './SourceControlActionModelPicker'
import { AgentDefaultArgsInput } from './AgentLaunchDefaultsEditor'
import { AgentPermissionMenu, type AgentPermissionChoiceRow } from './AgentPermissionChoiceControls'
import { agentModelChoiceChips } from './agent-model-choice-chips'
import { useAgentLaunchFieldWrite } from './use-agent-launch-field-write'

export function AgentLaunchChoiceEditor({
  agent,
  label,
  choices,
  userArgs,
  permission,
  permissionControlRef,
  save
}: {
  agent: TuiAgent
  label: string
  choices: AgentModelOptionChoices | undefined
  userArgs: string
  permission: AgentPermissionChoiceRow | undefined
  permissionControlRef?: Ref<HTMLDivElement>
  save: (patch: AgentChoicePatch | undefined, userArgs: string) => Promise<void>
}): React.JSX.Element {
  const menu = useRef({ open: false, committed: false })
  const editorRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? userArgs
  const { pending, write } = useAgentLaunchFieldWrite()
  const saveArgs = (raw: string): void => {
    if (raw === userArgs.trim()) {
      setDraft(null)
      return
    }
    write(
      JSON.stringify([null, raw]),
      () => save(undefined, raw),
      () => setDraft((current) => (current === raw ? null : current))
    )
  }
  const onOpenChange = (open: boolean): void => {
    if (!open && !menu.current.committed) {
      saveArgs(text.trim())
    }
    menu.current = { open, committed: false }
  }
  const commit = (patch: AgentChoicePatch, raw = text): string => {
    menu.current.committed = true
    const result = reconcileAgentChoiceArgs({
      agent,
      choices: { ...choices, permissionMode: permission?.choice },
      userArgs: raw,
      mode: 'choice-edit',
      keys: AGENT_LAUNCH_CHOICE_KEYS,
      patch
    })
    setDraft(raw)
    write(
      JSON.stringify([patch, raw]),
      () => save(patch, raw),
      () => setDraft((current) => (current === raw ? null : current))
    )
    return result.userArgs
  }
  const chips = agentModelChoiceChips(agent, label, choices, commit)
  if (permission?.flag && !permission.argsSetPermission) {
    chips.push({
      key: 'permissionMode',
      label,
      flag: permission.flag,
      onRemove: (raw) => commit({ permissionMode: 'own' }, raw)
    })
  }
  return (
    <div ref={editorRef} className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <AgentChoiceControls
          agent={agent}
          value={choices}
          disabled={pending}
          layout="contents"
          onOpenChange={onOpenChange}
          optionIds={['effort']}
          onChange={(next) =>
            commit({
              ...(choices?.model !== next?.model ? { model: next?.model ?? null } : {}),
              options: Object.fromEntries(
                [
                  ...new Set([
                    ...Object.keys(choices?.options ?? {}),
                    ...Object.keys(next?.options ?? {})
                  ])
                ]
                  .filter((key) => choices?.options?.[key] !== next?.options?.[key])
                  .map((key) => [key, next?.options?.[key] ?? null])
              )
            })
          }
        />
        {permission ? (
          <div ref={permissionControlRef}>
            <AgentPermissionMenu
              agentId={agent}
              label={label}
              disabled={pending}
              onOpenChange={onOpenChange}
              permission={{
                ...permission,
                onSelect: (permissionMode) => commit({ permissionMode })
              }}
            />
          </div>
        ) : null}
      </div>
      <AgentDefaultArgsInput
        defaultArgs=""
        argsOverride={text}
        disabled={pending}
        onDraftChange={setDraft}
        containsFocus={(target) =>
          menu.current.open ||
          (target instanceof Node && Boolean(editorRef.current?.contains(target)))
        }
        onDiscardArgs={() => setDraft(null)}
        choiceChips={chips}
        note={
          permission?.argsSetPermission
            ? translate(
                'settings.agents.permissionArgsTerminalOnly',
                'These arguments may control {{agent}}’s terminal permissions, so Orca adds no flag. Chats use the Permissions choice above.',
                { agent: label }
              )
            : undefined
        }
        onSaveArgs={saveArgs}
      />
    </div>
  )
}
