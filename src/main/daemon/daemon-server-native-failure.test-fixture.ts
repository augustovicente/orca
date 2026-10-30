import './mock-descendant-sweep'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createPtySubprocess } from './pty-subprocess'
import { mockPtyProcess } from './pty-subprocess-test-harness'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import type { DaemonCreationFailureFixture } from './daemon-server-creation-failure.test-fixture'
export function registerDaemonNativeFailureTests(fixture: DaemonCreationFailureFixture) {
  it('ordinary authenticated native throw releases its exact logical claim/cap before same-ID retry and delivery', async () => {
    fixture.client.disconnect()
    await fixture.server.shutdown()
    fixture.server = new DaemonServer({
      socketPath: getDaemonSocketPath(fixture.directory),
      tokenPath: join(fixture.directory, 'daemon.token'),
      spawnSubprocess: createPtySubprocess,
      preparePtySpawn: async () => {},
      ptySpawnHealthCheck: async () => {}
    })
    await fixture.server.start()
    await fixture.client.ensureConnected()
    const native = mockPtyProcess(999_999_999)
    fixture.nativePty.spawn
      .mockReset()
      .mockImplementationOnce(() => {
        throw new Error('exact native no-export failure')
      })
      .mockReturnValue(native)
    const payload = {
      sessionId: 'failed-native-ordinary',
      cols: 80,
      rows: 24,
      cwd: fixture.directory,
      agentSessionEnsure: {
        claim: {
          digestVersion: 1 as const,
          keyId: 'key',
          identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          agent: 'codex' as const
        },
        surface: {
          worktreeId: 'worktree',
          tabId: 'tab',
          leafId: '11111111-1111-4111-8111-111111111111',
          terminalHandle: 'term_native'
        }
      }
    }
    try {
      await expect(fixture.client.request('createOrAttach', payload)).rejects.toThrow(
        'exact native no-export failure'
      )
      await vi.waitFor(() => expect(fixture.server.automaticWork.gate.snapshot().terminals).toBe(0))
      expect(fixture.server.host.listSessions()).toEqual([])
      expect(await fixture.client.request('createOrAttach', payload)).toMatchObject({
        isNew: true
      })
      expect(fixture.nativePty.spawn).toHaveBeenCalledTimes(2)
      expect(fixture.server.automaticWork.gate.snapshot().terminals).toBe(1)
      await fixture.client.request('write', {
        sessionId: payload.sessionId,
        data: 'new ordinary input'
      })
      expect(native.write).toHaveBeenCalledWith('new ordinary input')
    } finally {
      // External native exit reaches the actual owner; never signal a fixture PID.
      native._simulateExit(0)
      await fixture.server.host.dispose()
    }
    expect(fixture.server.automaticWork.gate.snapshot().terminals).toBe(0)
  })
}
