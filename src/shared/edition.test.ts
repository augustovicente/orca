import { describe, expect, it } from 'vitest'
import {
  isTopLevelViewAvailable,
  resolveTopLevelView,
  editionSupports,
  type EditionCapability
} from './edition'
import type { TopLevelView } from './ui-chrome-types'

const ALL_VIEWS: TopLevelView[] = [
  'terminal',
  'settings',
  'tasks',
  'activity',
  'automations',
  'space',
  'skills',
  'artifacts',
  'mobile'
]

const ACCOUNTING_KEEPS: EditionCapability[] = ['computerUse', 'browser', 'chatSurface']

const ACCOUNTING_DROPS: EditionCapability[] = [
  'gitWorkflows',
  'sourceControl',
  'hostedReview',
  'taskProviders',
  'emulators',
  'agentPicker',
  'automations',
  'artifacts',
  'activity',
  'workspaceSpace',
  'onboarding',
  'skills',
  'mobile',
  'dictation',
  'experimental',
  'developerTools',
  'terminalPane',
  'editorTab',
  'diffTab',
  'checksTab',
  'rightSidebar',
  'statusBar',
  'providerUsage',
  'commandPalette',
  'starNag',
  'plugins',
  'devPane',
  'accountsPane',
  'modelPicker',
  'quickCommands',
  'telemetry',
  'ports',
  'resourceUsage',
  'contentInput',
  'notificationsPane',
  'shortcutsPane'
]

describe('editionSupports', () => {
  it('keeps the full Orca surface when no edition is compiled in', () => {
    expect(ALL_VIEWS.every((view) => isTopLevelViewAvailable(view, 'full'))).toBe(true)
  })

  it('leaves the full edition able to reach every gated capability', () => {
    for (const capability of [...ACCOUNTING_KEEPS, ...ACCOUNTING_DROPS]) {
      expect(editionSupports(capability, 'full')).toBe(true)
    }
  })

  it('keeps the accounting workflows the edition exists for', () => {
    for (const capability of ACCOUNTING_KEEPS) {
      expect(editionSupports(capability, 'contadorca')).toBe(true)
    }
  })

  it('drops development-only surfaces in the accounting edition', () => {
    for (const capability of ACCOUNTING_DROPS) {
      expect(editionSupports(capability, 'contadorca')).toBe(false)
    }
  })

  it('enables the customer shell only in the accounting edition', () => {
    expect(editionSupports('customerShell', 'contadorca')).toBe(true)
    expect(editionSupports('customerShell', 'full')).toBe(false)
  })
})

describe('resolveTopLevelView', () => {
  it('renders a persisted dev view as the workspace surface in the accounting edition', () => {
    for (const view of [
      'tasks',
      'activity',
      'automations',
      'space',
      'artifacts',
      'skills',
      'mobile'
    ] as const) {
      expect(resolveTopLevelView(view, 'contadorca')).toBe('terminal')
    }
  })

  it('keeps accounting views addressable', () => {
    for (const view of ['terminal', 'settings'] as const) {
      expect(resolveTopLevelView(view, 'contadorca')).toBe(view)
    }
  })
})
