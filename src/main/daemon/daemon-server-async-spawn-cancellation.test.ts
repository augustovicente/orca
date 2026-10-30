import { registerDaemonCreationFailureTests } from './daemon-server-creation-failure.test-fixture'
import type * as LocalPtyUtils from '../providers/local-pty-utils'
import './mock-descendant-sweep'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonClient } from './client'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'
import { DaemonServer } from './daemon-server'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import * as transport from './daemon-client-socket-connect'
import type { DaemonClientConnections } from './daemon-client-connections'
import { getDaemonSocketPath } from './daemon-spawner'
const nativePty = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node-pty', () => nativePty)

vi.mock('../providers/local-pty-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof LocalPtyUtils>()),
  ensureNodePtySpawnHelperExecutable: () => {},
  getNodePtySpawnHelperCandidates: () => [process.execPath]
}))
type DaemonServerInternals = {
  preparations: {
    pending: Map<string, Set<{ canceled: boolean }>>
  }
  host: { listSessions: () => unknown[] }
}

describe('daemon async spawn cancellation', () => {
  let directory: string
  let server: DaemonServer
  let client: DaemonClient
  let releaseSpawn: () => void
  let spawnStarted: Promise<void>
  let subprocess: ReturnType<typeof createMockSubprocess>
  let preparation: Promise<void>
  let spawned: number

  beforeEach(async () => {
    spawned = 0
    directory = mkdtempSync(join(tmpdir(), 'daemon-async-spawn-cancel-'))
    let markSpawnStarted: () => void = () => {}
    spawnStarted = new Promise<void>((resolve) => {
      markSpawnStarted = resolve
    })
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve
    })
    preparation = Promise.resolve()
    spawned = 0
    server = new DaemonServer({
      socketPath: getDaemonSocketPath(directory),
      tokenPath: join(directory, 'daemon.token'),
      preparePtySpawn: () => preparation,
      spawnSubprocess: async () => {
        spawned += 1
        subprocess = createMockSubprocess()
        markSpawnStarted()
        await spawnGate
        return subprocess
      }
    })
    await server.start()
    client = new DaemonClient({
      socketPath: getDaemonSocketPath(directory),
      tokenPath: join(directory, 'daemon.token')
    })
    await client.ensureConnected()
  })

  afterEach(async () => {
    releaseSpawn?.()
    client?.disconnect()
    await server?.shutdown()
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })

  it.each(['healthy', 'release-reply-lost'] as const)(
    'consumes only after actual adoption and reclaims without a physical hold: %s',
    async (loss) => {
      const adapter = new DaemonPtyAdapter({
        socketPath: getDaemonSocketPath(directory),
        tokenPath: join(directory, 'daemon.token')
      })
      let owner: { work: Promise<unknown>; recover: () => Promise<void> } | undefined
      let blocked = false
      let releaseReplyDropped = false
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inspect only this fixture's receiver connections.
      const receiver = server as unknown as {
        connections: DaemonClientConnections
      }
      const connect = transport.connectDaemonSocket
      vi.spyOn(transport, 'connectDaemonSocket').mockImplementation(async (...args) => {
        if (blocked) {
          throw new Error('Connection lost')
        }
        const socket = await connect(...args)
        const write = socket.write.bind(socket)
        vi.spyOn(socket, 'write').mockImplementation(
          (...values: Parameters<typeof socket.write>) => {
            const frame = JSON.parse(String(values[0]))
            if (frame.payload?.switchExecution?.phase === 'commit') {
              const peer = [...receiver.connections.values()].at(-1)?.controlSocket
              if (!peer) {
                throw new Error('fixture control missing')
              }
              const respond = peer.write.bind(peer)
              vi.spyOn(peer, 'write').mockImplementation(
                (...bytes: Parameters<typeof peer.write>) => {
                  const result = JSON.parse(String(bytes[0]))
                  if (
                    loss === 'release-reply-lost' &&
                    !releaseReplyDropped &&
                    result.payload?.released === true
                  ) {
                    releaseReplyDropped = true
                    blocked = true
                    peer.destroy()
                    return true
                  }
                  return respond(...bytes)
                }
              )
            }
            return write(...values)
          }
        )
        return socket
      })
      const starting = adapter.spawn({
        sessionId: 'receipt-pane',
        cols: 80,
        rows: 24,
        switchExecution: {
          invocationId: 'adoption-click',
          signal: new AbortController().signal,
          remaining: () => 60_000,
          check: () => {},
          trackPhysical: (work, recover) => {
            if (recover) {
              owner = { work, recover }
            }
            return work
          }
        }
      })
      const observed = starting.then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      )
      try {
        await spawnStarted
        releaseSpawn()
        expect(await observed).toMatchObject({ result: { id: 'receipt-pane' } })
        if (!owner) {
          throw new Error('receiver completion was not tracked')
        }
        await owner.work
        if (loss !== 'healthy') {
          await vi.waitFor(() => expect(blocked).toBe(true))
          blocked = false
          await adapter.listProcesses()
          await expect(
            adapter.spawn({ sessionId: 'receipt-pane', cols: 80, rows: 24 })
          ).resolves.toMatchObject({ id: 'receipt-pane', isReattach: true })
        }
        expect(server.host.listSessions()).toMatchObject([
          { sessionId: 'receipt-pane', isAlive: true }
        ])
        expect(subprocess.forceKill).not.toHaveBeenCalled()
        expect(spawned).toBe(1)
        const exit = vi.fn()
        adapter.onExit(exit)
        subprocess._simulateExit(0)
        await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce())
      } finally {
        blocked = false
        releaseSpawn()
        await observed
        subprocess?._simulateExit(0)
        await owner?.recover().catch(() => {})
        await owner?.work
        adapter.dispose()
      }
    },
    15_000
  )

  it.each(['cancelCreateOrAttach', 'kill'] as const)(
    'reaps a subprocess canceled by %s during async spawn',
    async (requestType) => {
      const create = client.request('createOrAttach', {
        sessionId: 'canceled-spawn',
        cols: 80,
        rows: 24
      })
      const canceled = expect(create).rejects.toThrow('Attach canceled for session canceled-spawn')
      await spawnStarted

      await (requestType === 'kill'
        ? client.request('kill', { sessionId: 'canceled-spawn', immediate: true })
        : client.request('cancelCreateOrAttach', { sessionId: 'canceled-spawn' }))
      releaseSpawn()
      await canceled

      expect(subprocess.forceKill).toHaveBeenCalledOnce()
      await expect(client.request('listSessions', undefined)).resolves.toEqual({ sessions: [] })
    }
  )

  it('reaps a subprocess after its requesting client disconnects', async () => {
    const create = client
      .request('createOrAttach', {
        sessionId: 'disconnected-spawn',
        cols: 80,
        rows: 24
      })
      .catch(() => undefined)
    await spawnStarted

    client.disconnect()
    const daemon = server as unknown as DaemonServerInternals
    await vi.waitFor(() =>
      expect([...(daemon.preparations.pending.get('disconnected-spawn') ?? [])][0]?.canceled).toBe(
        true
      )
    )
    releaseSpawn()
    await create
    await vi.waitFor(() => expect(subprocess.forceKill).toHaveBeenCalledOnce())
    expect(daemon.host.listSessions()).toEqual([])
  })

  it('reaps a subprocess after the client request times out', async () => {
    const create = client.request(
      'createOrAttach',
      { sessionId: 'timed-out-spawn', cols: 80, rows: 24 },
      10
    )
    await spawnStarted

    await expect(create).rejects.toThrow('timed out')
    releaseSpawn()

    await vi.waitFor(() => expect(subprocess.forceKill).toHaveBeenCalledOnce())
    await expect(client.request('listSessions', undefined)).resolves.toEqual({ sessions: [] })
  })

  it('reaps a subprocess after the client aborts its request', async () => {
    const abort = new AbortController()
    const create = client.request(
      'createOrAttach',
      { sessionId: 'aborted-spawn', cols: 80, rows: 24 },
      30_000,
      abort.signal
    )
    await spawnStarted

    abort.abort()
    await expect(create).rejects.toThrow('client_disconnected')
    releaseSpawn()

    await vi.waitFor(() => expect(subprocess.forceKill).toHaveBeenCalledOnce())
    await expect(client.request('listSessions', undefined)).resolves.toEqual({ sessions: [] })
  })

  it('reaps an async spawn before daemon shutdown completes', async () => {
    const create = client
      .request('createOrAttach', {
        sessionId: 'shutdown-spawn',
        cols: 80,
        rows: 24
      })
      .catch(() => undefined)
    await spawnStarted

    const shutdown = server.shutdown()
    releaseSpawn()
    await create
    await shutdown

    expect(subprocess.forceKill).toHaveBeenCalledOnce()
    expect(subprocess.dispose).toHaveBeenCalledOnce()
  })
  registerDaemonCreationFailureTests({
    nativePty,
    get directory() {
      return directory
    },
    get server() {
      return server
    },
    set server(value) {
      server = value
    },
    get client() {
      return client
    },
    get subprocess() {
      return subprocess
    },
    get releaseSpawn() {
      return releaseSpawn
    },
    get spawnStarted() {
      return spawnStarted
    },
    get spawned() {
      return spawned
    }
  })
})
