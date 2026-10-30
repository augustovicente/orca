// @vitest-environment happy-dom
import { act, useState } from 'react'
import { fireEvent } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  sourceControlPickerDraft,
  applySourceControlPickerDraft
} from '../settings/source-control-agent-launch-picker'
import { canonicalSourceControlActionSelection } from '../../../../shared/source-control-action-selection'
import { AgentLaunchSetupButton, useAgentPickerDraftScope } from './AgentLaunchSetupButton'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'

vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
const entry: AgentPickerEntry = {
  agent: 'codex',
  label: 'Codex',
  rows: [{ agent: 'codex', kind: 'chat' }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'chat',
  terminal: {},
  structured: {},
  catalog: {
    origin: 'probe',
    fetchedAt: 1,
    models: [
      { id: 'astra', label: 'Astra', isDefault: true, efforts: [{ value: 'low', label: 'Low' }] }
    ]
  }
}
let root: Root
let host: HTMLDivElement
let owner = 0
const launch = vi.fn()
function show(value: AgentPickerEntry, others: AgentPickerEntry[] = []) {
  const entries = [value, ...others]
  act(() =>
    root.render(
      <TooltipProvider>
        <DropdownMenu defaultOpen modal={false}>
          <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
          <DropdownMenuContent>
            <AgentLaunchPickerMenu
              entries={entries}
              model={{
                state: 'settled',
                rows: entries.flatMap((entry) => entry.rows),
                detection: {
                  detectedIds: entries.map((entry) => entry.agent),
                  isLoading: false,
                  isRefreshing: false,
                  detectionFailed: false,
                  needsServerUpdate: false,
                  refresh: async () => entries.map((entry) => entry.agent)
                }
              }}
              runLaunch={launch}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </TooltipProvider>
    )
  )
}
beforeEach(() => {
  entry.ownerKey = `menu-test-${owner++}`
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  launch.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  show(entry)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each(['button', 'enter'] as const)(
  'reopens a form selection and preserves its route on %s',
  (activation) => {
    const initial = {
      agent: 'codex' as const,
      surface: 'terminal' as const,
      choices: { model: 'astra', options: { effort: 'low' } }
    }
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupButton entry={entry} initial={initial} mode="select" onUse={launch} />
        </TooltipProvider>
      )
    )
    fireEvent.click(
      document.querySelector<HTMLButtonElement>('button[aria-label="Configure Codex"]')!
    )
    expect(launch).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Open terminal')
    if (activation === 'enter') {
      fireEvent.keyDown(document.querySelector('input[aria-label="Search models"]')!, {
        key: 'Enter'
      })
    } else {
      fireEvent.click(
        [...document.querySelectorAll('button')].find((button) => button.textContent === 'Use')!
      )
    }
    expect(launch).toHaveBeenCalledExactlyOnceWith(initial)
  }
)

it('rebases accepted recipe receipts and retires independent form scopes with equal baselines', () => {
  const inventory = { ...entry, defaultSurface: 'terminal' as const, arguments: '--base' }
  function Form({ request }: { request: string }) {
    const scope = useAgentPickerDraftScope(request)
    const [selection, update] = useState(() =>
      canonicalSourceControlActionSelection({ agentId: 'codex' })
    )
    return (
      <AgentLaunchSetupButton
        entry={inventory}
        draftScope={scope}
        initial={sourceControlPickerDraft(selection, inventory, 'terminal')}
        mode="select"
        onUse={(draft) => {
          launch(draft)
          update((current) => applySourceControlPickerDraft(current, inventory, draft))
        }}
      />
    )
  }
  const showForm = (request: string) =>
    act(() =>
      root.render(
        <TooltipProvider>
          <Form request={request} />
        </TooltipProvider>
      )
    )
  const open = () =>
    fireEvent.click(
      document.querySelector<HTMLButtonElement>('button[aria-label="Configure Codex"]')!
    )
  showForm('first')
  open()
  fireEvent.change(document.querySelector('textarea')!, { target: { value: '--accepted' } })
  fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Use')!)
  expect(launch.mock.calls.at(-1)?.[0].recipeEdits.changed).toBe(true)
  open()
  expect(document.querySelector('textarea')).toHaveProperty('value', '--accepted')
  fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Use')!)
  expect(launch.mock.calls.at(-1)?.[0].recipeEdits.changed).toBe(false)
  open()
  fireEvent.change(document.querySelector('textarea')!, { target: { value: '--unaccepted' } })
  showForm('second')
  expect(document.querySelector('textarea')).toHaveProperty('value', '--accepted')
  act(() =>
    root.render(
      <TooltipProvider>
        <Form key="new-controller" request="second" />
      </TooltipProvider>
    )
  )
  open()
  expect(document.querySelector('textarea')).toHaveProperty('value', '--base')
})
