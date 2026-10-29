// @vitest-environment happy-dom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { AgentLaunchChoiceEditor } from './AgentLaunchChoiceEditor'
import { TooltipProvider } from '../ui/tooltip'
import {
  agentLaunchSettingsMutationUpdates,
  projectAgentLaunchSettings,
  type AgentLaunchSettingsSource
} from '../../../../shared/agent-launch-settings'
import { resolveAgentPermission } from '../../../../shared/tui-agent-permission-choice'

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
)
afterEach(cleanup)
const initial: AgentLaunchSettingsSource = {
  agentPermissionDefault: 'ask',
  agentDefaultArgs: { claude: '--verbose' },
  agentLaunchChoices: { claude: { model: 'opus', options: { effort: 'high' } } }
}
function Fixture({ save }: { save: ReturnType<typeof vi.fn> }) {
  const [settings, setSettings] = useState(initial)
  const projected = projectAgentLaunchSettings(settings)
  return (
    <TooltipProvider>
      <AgentLaunchChoiceEditor
        agent="claude"
        label="Claude Code"
        choices={settings.agentLaunchChoices?.claude}
        userArgs={projected.agentChoices?.userArgs.claude ?? ''}
        permission={{
          ...resolveAgentPermission('claude', settings),
          choices: ['own', 'ask'],
          defaultChoice: 'ask',
          onSelect: () => {},
          flag: '--permission-mode default',
          argsSetPermission: false
        }}
        save={async (patch, userArgs) => {
          await save({ type: 'launch-choices', agent: 'claude', patch, userArgs })
          setSettings((latest) => ({
            ...latest,
            ...agentLaunchSettingsMutationUpdates(
              latest,
              { type: 'launch-choices', agent: 'claude', patch, userArgs },
              'darwin'
            )
          }))
        }}
      />
    </TooltipProvider>
  )
}

it('removes a choice with dirty conflicting text in one mutation and shares two-Backspace removal', async () => {
  const save = vi.fn(async () => {})
  render(<Fixture save={save} />)
  const input = screen.getByRole('textbox', { name: 'Arguments' })
  if (!(input instanceof HTMLTextAreaElement)) {
    throw new Error('Missing Arguments textarea')
  }
  fireEvent.change(input, { target: { value: '--model sonnet --verbose' } })
  fireEvent.click(screen.getByRole('button', { name: 'Remove --model opus' }))
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  expect(save).toHaveBeenLastCalledWith({
    type: 'launch-choices',
    agent: 'claude',
    patch: { model: null },
    userArgs: '--model sonnet --verbose'
  })
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Remove --model opus' })).toBeNull()
  )
  expect(input.value).toBe('--model sonnet --verbose')
  fireEvent.change(input, { target: { value: '--permission-mode default --verbose' } })
  input.focus()
  input.setSelectionRange(0, 0)
  fireEvent.keyDown(input, { key: 'Backspace' })
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: /Remove --permission-mode default/ })
  )
  fireEvent.keyDown(document.activeElement ?? input, { key: 'Backspace' })
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
  expect(save).toHaveBeenLastCalledWith({
    type: 'launch-choices',
    agent: 'claude',
    patch: { permissionMode: 'own' },
    userArgs: '--permission-mode default --verbose'
  })
  await waitFor(() => expect(input.value).toBe('--verbose'))
})

it('keeps the dirty text and badge after a failed coupled save', async () => {
  const save = vi.fn(async () => {
    throw new Error('disk full')
  })
  render(<Fixture save={save} />)
  const input = screen.getByRole('textbox', { name: 'Arguments' })
  if (!(input instanceof HTMLTextAreaElement)) {
    throw new Error('Missing Arguments textarea')
  }
  fireEvent.change(input, { target: { value: '--model opus --verbose retry' } })
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Remove --model opus' }))
  )
  expect(save).toHaveBeenCalledTimes(1)
  expect(input.value).toBe('--model opus --verbose retry')
  expect(screen.getByRole('button', { name: 'Remove --model opus' }).hasAttribute('disabled')).toBe(
    false
  )
})

it('saves a dirty Arguments edit with a menu choice once, and shares pending state with Reset', async () => {
  const save = vi.fn(async () => {})
  render(<Fixture save={save} />)
  const input = screen.getByRole('textbox', { name: 'Arguments' })
  fireEvent.change(input, { target: { value: '--model sonnet --verbose changed' } })
  input.focus()
  await userEvent.click(screen.getByRole('combobox', { name: 'Opus' }))
  expect(save).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('option', { name: 'Haiku' }))
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  expect(save).toHaveBeenCalledWith({
    type: 'launch-choices',
    agent: 'claude',
    patch: { model: 'haiku', options: { effort: null } },
    userArgs: '--model sonnet --verbose changed'
  })
  await waitFor(() => expect(input).toHaveProperty('value', '--verbose changed'))
  const pending = Promise.withResolvers<void>()
  save.mockImplementationOnce(() => pending.promise)
  fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
  expect(save).toHaveBeenCalledTimes(2)
  expect(save).toHaveBeenLastCalledWith({
    type: 'launch-choices',
    agent: 'claude',
    patch: undefined,
    userArgs: ''
  })
  expect(screen.getByRole('combobox', { name: 'Haiku' }).hasAttribute('disabled')).toBe(true)
  await act(async () => pending.resolve())
  await waitFor(() => expect(input).toHaveProperty('value', ''))
})
