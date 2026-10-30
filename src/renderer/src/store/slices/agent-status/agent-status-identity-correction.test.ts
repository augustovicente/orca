import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '../store-test-helpers'

const PANE = 'tab-1:1'

describe('exact-pane compatible status identity correction', () => {
  afterEach(() => vi.useRealTimers())

  it.each(['process-read', 'launch-record', 'registered-launch'] as const)(
    'preserves the accepted turn and attention on late %s correction',
    (evidence) => {
      vi.useFakeTimers()
      const store = createTestStore()
      store
        .getState()
        .setAgentStatus(PANE, { state: 'done', agentType: 'pi', prompt: 'task' }, 'Pi ready')
      if (evidence === 'registered-launch') {
        store
          .getState()
          .registerAgentLaunchConfig(
            PANE,
            { agentCommand: 'omp', agentArgs: '', agentEnv: {} },
            { agentType: 'omp' }
          )
      } else {
        store.getState().setPaneForegroundAgent(PANE, {
          agent: 'omp',
          agentEvidence: evidence,
          shellForeground: false
        })
      }
      const before = store.getState()
      const entry = before.agentStatusByPaneKey[PANE]
      const foreground = before.paneForegroundAgentByPaneKey[PANE]
      const launch = before.agentLaunchConfigByPaneKey[PANE]
      expect(before.correctAgentStatusIdentity(PANE, entry, foreground, launch)).toBe(true)
      const after = store.getState()
      expect(after.agentStatusByPaneKey[PANE]).toEqual({
        ...entry,
        agentType: 'omp',
        terminalTitle: 'OMP ready'
      })
      expect(after.agentStatusEpoch).toBe(before.agentStatusEpoch)
      expect(after.sortEpoch).toBe(before.sortEpoch)
      expect(after.unreadAgentCompletionPanes).toBe(before.unreadAgentCompletionPanes)
      expect(after.correctAgentStatusIdentity(PANE, entry, foreground, launch)).toBe(false)
      if (launch) {
        const corrected = after.agentStatusByPaneKey[PANE]
        after.registerAgentLaunchConfig(PANE, launch.launchConfig, { agentType: 'pi' })
        expect(
          store.getState().correctAgentStatusIdentity(PANE, corrected, foreground, launch)
        ).toBe(false)
      }
    }
  )

  it('rejects replaced rows, replaced evidence, retired panes and incompatible owners', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store.getState().setAgentStatus(PANE, { state: 'working', agentType: 'pi', prompt: '' })
    store.getState().setPaneForegroundAgent(PANE, {
      agent: 'omp',
      agentEvidence: 'process-read',
      shellForeground: false
    })
    const old = store.getState()
    const entry = old.agentStatusByPaneKey[PANE]
    const foreground = old.paneForegroundAgentByPaneKey[PANE]
    store.setState({ agentStatusByPaneKey: { [PANE]: { ...entry, agentType: 'codex' } } })
    expect(store.getState().correctAgentStatusIdentity(PANE, entry, foreground)).toBe(false)
    const row = store.getState().agentStatusByPaneKey[PANE]
    expect(store.getState().correctAgentStatusIdentity(PANE, row, foreground)).toBe(false)
    store.getState().setPaneForegroundAgent(PANE, {
      agent: 'omp',
      agentEvidence: 'launch-record',
      shellForeground: false
    })
    expect(store.getState().correctAgentStatusIdentity(PANE, row, foreground)).toBe(false)
    store.getState().retireAgentPaneAuthority(PANE)
    expect(store.getState().correctAgentStatusIdentity(PANE, entry, foreground)).toBe(false)
    expect(store.getState().correctAgentStatusIdentity('absent:1', entry, foreground)).toBe(false)
  })
})
