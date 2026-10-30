import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../src/shared/agent-session-record.test-fixture'
import { agentSessionConversationView } from '../../src/shared/agent-session-conversation-view'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCompactionConsumerJournal } from '../../src/main/native-chat/agent-session-journal/journal-compaction-consumers.test-support'
import { createTrackedJournalOpener } from '../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { readStructuredAgentSessionHistoryResult } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-history-result'
import type { AgentSessionHistoryRequest } from '../../src/shared/agent-session-wire'
import type { AgentSessionHistoryScope } from '../../src/main/native-chat/agent-session-wire/agent-session-history-page'
import { RuntimeClient } from '../../src/cli/runtime-client'
import { ORCHESTRATION_WORKER_OBSERVATION_HANDLERS } from '../../src/cli/handlers/orchestration/worker-observation-handlers'
import { readStructuredWorkerTerminal } from '../../src/main/runtime/structured-worker-terminal-read'
import { structuredWorkerIdentities } from '../../src/main/runtime/structured-worker-identity'
import { OrcaRuntimeWithResolveTerminalPane } from '../../src/main/runtime/terminal/recovery/resolve-terminal-pane'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredWorkerIdentity } from '../../src/main/runtime/structured-worker-identity'

const hostRef: { current: unknown } = { current: null }

vi.mock('../../src/main/native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
vi.mock('../../src/main/runtime/rpc/methods/orchestration-structured-worker-session', () => ({
  releaseStructuredWorkerSession: vi.fn()
}))

const {
  captureStructuredWorkerArchive,
  readArchivedStructuredJournal,
  readStructuredWorkerJournal
} = await import('../../src/main/runtime/rpc/methods/orchestration-structured-worker-lifecycle')

const IDENTITY: StructuredWorkerIdentity = {
  handle: 'structworker_1',
  sessionId: 'session-1',
  agent: 'claude',
  paneKey: 'structured-agent-session-session-1:11111111-1111-4111-a111-111111111111',
  processIncarnation: 'structured:session-1',
  worktreeId: 'wt_1',
  hostScope: { kind: 'local', hostId: 'local' }
}

describe('structured worker output', () => {
  beforeEach(() => {
    hostRef.current = null
  })

  it('keeps real retired/reopened output and cursors through worker-read, CLI, terminal routing and archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-compacted-worker-output-'))
    const journals = createTrackedJournalOpener()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const client = new RuntimeClient('/tmp/orca-compaction-worker-read', 60000, null, null)
    const source: StructuredWorkerIdentity = { ...IDENTITY, agent: 'codex' }
    try {
      const scenario = await openCompactionConsumerJournal(journals, root)
      const record = agentSessionConversationView(
        agentSessionRecordFixture(
          agentSessionLeaseFixture({
            sessionId: source.sessionId,
            runtimeFence: 1,
            claimStatus: 'live',
            deathEvidence: null
          })
        )
      )
      hostRef.current = {
        deps: { store: { getConversation: () => record } },
        hasSession: () => true,
        history: (request: AgentSessionHistoryRequest, scope?: AgentSessionHistoryScope) =>
          readStructuredAgentSessionHistoryResult({
            journal: scenario.journal,
            record: null,
            request,
            scope
          })
      }
      structuredWorkerIdentities.register(source)
      const read = (cursor?: string, limit?: number) =>
        readStructuredWorkerJournal({
          identity: source,
          dispatchId: 'compacted-output',
          workerState: 'ready',
          liveness: 'live',
          agent: 'codex',
          ...(cursor ? { cursor } : {}),
          ...(limit === undefined ? {} : { limit })
        })
      const first = await read(undefined, 1)
      const baseline = await read()
      const resumed = await read(first.cursor)
      const archiveBefore = await captureStructuredWorkerArchive(source, 'codex')
      const runtime: { readTerminal: (handle: string) => Promise<unknown> } = Object.assign(
        Object.create(OrcaRuntimeWithResolveTerminalPane.prototype),
        {
          getOrchestrationDbIfAvailable: () => null,
          getLivePtyForHandle: () => {
            throw new Error('structured output must not reach PTY lookup')
          }
        }
      )
      const terminal = await runtime.readTerminal(source.handle)
      const rawTerminal = await readStructuredWorkerTerminal({ handle: source.handle, db: null })
      const call = vi.fn()
      call.mockImplementation(async (method: string) => {
        if (method !== 'orchestration.workerRead') {
          throw new Error('unexpected CLI RPC')
        }
        return { result: await read() }
      })
      vi.spyOn(client, 'call').mockImplementation(call)
      const cli = async () => {
        log.mockClear()
        await ORCHESTRATION_WORKER_OBSERVATION_HANDLERS['orchestration worker-read']!({
          flags: new Map<string, string | boolean>([
            ['dispatch', 'compacted-output'],
            ['source', 'transcript']
          ]),
          client,
          cwd: root,
          json: false
        })
        expect(log).toHaveBeenCalledOnce()
        return log.mock.calls[0]?.[0]
      }
      const printed = await cli()
      expect(printed).toContain('answer 4')
      expect(printed).not.toContain('child answer')
      await scenario.retireAndReopen()
      expect(await read()).toEqual(baseline)
      expect(await read(first.cursor)).toEqual(resumed)
      expect(await cli()).toEqual(printed)
      expect(await readStructuredWorkerTerminal({ handle: source.handle, db: null })).toEqual(
        rawTerminal
      )
      expect(await runtime.readTerminal(source.handle)).toEqual(terminal)
      const archive = await captureStructuredWorkerArchive(source, 'codex')
      expect(archive).toEqual(archiveBefore)
      hostRef.current = null
      const archived = readArchivedStructuredJournal({
        dispatchId: 'compacted-output',
        workerState: 'succeeded',
        resourceId: 'resource',
        createdAt: '2026-10-29 00:00:00',
        releaseState: 'released',
        archive
      })
      expect(archived.transcript.messages).toEqual(baseline.transcript.messages)
      expect(archived.warnings).toEqual(baseline.warnings)
      expect(archived.transcript.limited).toEqual(baseline.transcript.limited)
    } finally {
      vi.restoreAllMocks()
      structuredWorkerIdentities.clear()
      hostRef.current = null
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  })
})
