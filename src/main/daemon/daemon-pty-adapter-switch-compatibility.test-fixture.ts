import './mock-descendant-sweep'
import { expect, it, vi } from 'vitest'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { agentSessionSwitchDeadline } from '../../shared/agent-session-switch-execution'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'
export function registerDaemonSwitchCompatibilityTests(fixture: {
  server: DaemonServer
  adapter: DaemonPtyAdapter
  socketPath: string
  tokenPath: string
}) {
  it.each([53, 54, 55])(
    'uses v%i creation with its supported switch authority',
    async (protocolVersion) => {
      fixture.adapter.dispose()
      await fixture.server.shutdown()
      const spawn = vi.fn(() => createMockSubprocess())
      fixture.server = new DaemonServer({
        socketPath: fixture.socketPath,
        tokenPath: fixture.tokenPath,
        protocolVersion,
        spawnSubprocess: spawn
      })
      await fixture.server.start()
      fixture.adapter = new DaemonPtyAdapter({
        socketPath: fixture.socketPath,
        tokenPath: fixture.tokenPath,
        protocolVersion
      })
      const request = vi.spyOn(DaemonClient.prototype, 'request')
      const deadline = agentSessionSwitchDeadline()
      try {
        expect(
          await fixture.adapter.spawn({ sessionId: 'legacy-ordinary', cols: 80, rows: 24 })
        ).toMatchObject({ id: 'legacy-ordinary' })
        await expect(
          fixture.adapter.spawn({
            sessionId: 'switch-destination',
            cols: 80,
            rows: 24,
            switchExecution: { invocationId: 'new-click', ...deadline }
          })
        ).resolves.toMatchObject({ id: 'switch-destination' })
        expect(spawn).toHaveBeenCalledTimes(2)
        const creates = request.mock.calls.filter(([type]) => type === 'createOrAttach')
        if (protocolVersion < 55) {
          expect(creates).toHaveLength(2)
          for (const create of creates) {
            expect(create[1]).not.toHaveProperty('switchExecution')
          }
        } else {
          expect(creates).toHaveLength(3)
          expect(creates[1]?.[1]).toMatchObject({ switchExecution: { phase: 'prepare' } })
          expect(creates[2]?.[1]).toMatchObject({ switchExecution: { phase: 'commit' } })
        }
        expect(request.mock.calls.some(([type]) => type === 'cancelCreateOrAttach')).toBe(false)
      } finally {
        deadline.dispose()
        request.mockRestore()
      }
    }
  )
}
