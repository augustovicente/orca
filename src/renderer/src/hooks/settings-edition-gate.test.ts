import { describe, expect, it } from 'vitest'
import { isSettingsSectionAvailable } from './settings-edition-gate'

const DEVELOPER_SECTIONS = ['git', 'tasks', 'accounts', 'orchestration'] as const

describe('isSettingsSectionAvailable', () => {
  it('keeps every developer settings section in the full edition', () => {
    for (const section of DEVELOPER_SECTIONS) {
      expect(isSettingsSectionAvailable(section, 'full')).toBe(true)
    }
  })

  it('drops Git, tasks, agent accounts and orchestration in the contadorca edition', () => {
    for (const section of DEVELOPER_SECTIONS) {
      expect(isSettingsSectionAvailable(section, 'contadorca')).toBe(false)
    }
  })

  it('keeps sections without a capability reachable in every edition', () => {
    expect(isSettingsSectionAvailable('appearance', 'contadorca')).toBe(true)
    expect(isSettingsSectionAvailable('repo-example', 'contadorca')).toBe(true)
  })
})
