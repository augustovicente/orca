// @vitest-environment happy-dom
import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentLaunchSetupButton } from './AgentLaunchSetupButton'
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
