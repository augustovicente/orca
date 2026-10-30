import { mkdtemp, rm, writeFile, readFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { importLegacyTranscriptIntoJournal } from '../agent-session-journal/journal-legacy-import'
import {
  captureSwitchStoppedCliTurn,
  catchUpSwitchedCliTranscript
} from './structured-agent-session-switch-import'

vi.mock('../../ai-vault/session-scanner-opencode-sqlite-worker-spawn', async () => {
  const query = await import('../transcript-opencode-sqlite-query')
  return {
    readOpenCodeTranscriptPageViaWorker: async (
      args: Parameters<typeof query.readOpenCodeTranscriptPage>[0]
    ) => query.readOpenCodeTranscriptPage(args),
    readOpenCodeTranscriptSignalViaWorker: async (args: { dbPath: string; sessionId: string }) =>
      query.readOpenCodeTranscriptSignal(args.dbPath, args.sessionId)
  }
})
const journals = createTrackedJournalOpener()
let root: string
let deadline: ReturnType<typeof agentSessionSwitchDeadline>
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-switch-import-'))
  deadline = agentSessionSwitchDeadline()
})
afterEach(async () => {
  deadline.dispose()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})
function options() {
  return {
    stateDirectory: root,
    identity: {
      sessionId: 'native',
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'codex' as const,
      providerHandle: codexProviderHandle('019aef12-1234-7000-8000-123456789abc')
    }
  }
}
const claudeRecording = await readFile(
  join(import.meta.dirname, '__fixtures__', 'claude-cli-switch-2.1.302.jsonl'),
  'utf8'
)
const claudeRecordingId: string = JSON.parse(claudeRecording.split('\n')[0]!).sessionId
it.each([
  ['claude', claudeRecordingId],
  ['codex', '01a183db-b8d6-7170-af39-e004651c1e1e'],
  ['pi', '01a1841b-2daa-7238-ade8-4b2474dcac14'],
  ['grok', '01a105db-937d-7ec0-b1d1-5396ae618abf'],
  ['opencode', 'ses_e7afa14d9ffernpe5xoa3e21SL'],
  ['opencode2', 'ses_e7bc5544cffeP7rTuOdvcklM2n']
] as const)(
  'settles recorded %s storage durably without replacing native completion or duplicating imported tools',
  async (agent, recordedId) => {
    const fixtures = join(import.meta.dirname, '__fixtures__', 'recorded-native-switch', agent)
    const sqlite = agent === 'opencode' || agent === 'opencode2'
    const filePath = join(root, sqlite ? 'native.db' : 'native.jsonl')
    const source = { agent, sessionId: agent === 'pi' ? filePath : recordedId, filePath }
    async function install(completed: boolean) {
      if (agent === 'claude') {
        const rows = claudeRecording.trimEnd().split('\n')
        expect(rows).toHaveLength(4)
        // Fixture truncation at genuine tool use, not a recording of Stop or exit.
        await writeFile(filePath, completed ? claudeRecording : `${rows.slice(0, 2).join('\n')}\n`)
      } else if (agent === 'grok') {
        const directory = join(fixtures, completed ? 'completed' : 'interrupted-prefix')
        await copyFile(join(directory, 'chat_history.jsonl'), filePath)
        await copyFile(join(directory, 'events.jsonl'), join(root, 'events.jsonl'))
      } else if (agent === 'pi') {
        const recording = await readFile(join(fixtures, 'completed.jsonl'), 'utf8')
        const rows = recording.trimEnd().split('\n')
        expect(JSON.parse(rows[0]!).id).toBe(recordedId)
        expect(source.sessionId).not.toBe(recordedId)
        // Fixture truncation at a genuine tool result; no captured Stop or physical exit.
        await writeFile(filePath, completed ? recording : `${rows.slice(0, 6).join('\n')}\n`)
      } else {
        await copyFile(
          join(
            fixtures,
            `${completed ? 'completed' : 'recorded-prefix'}.${sqlite ? 'db' : 'jsonl'}`
          ),
          filePath
        )
      }
    }
    const recordedOptions = {
      ...options(),
      identity: {
        ...options().identity,
        agent,
        providerHandle:
          agent === 'codex'
            ? codexProviderHandle(recordedId)
            : agent === 'claude'
              ? claudeProviderHandle(recordedId, null)
              : null
      }
    }
    async function imported(sessionId: string) {
      const journal = await journals.open({
        ...recordedOptions,
        identity: { ...recordedOptions.identity, sessionId }
      })
      const result = await importLegacyTranscriptIntoJournal({
        journal,
        agent,
        sessionId: source.sessionId,
        fence: 1,
        options: { filePath }
      })
      expect(result).toMatchObject({ ok: true, replaced: true })
      return journal
    }
    const turns = (journal: AgentSessionJournal) =>
      journal
        .snapshot()
        .items.filter((item) => item.body.kind === 'turn')
        .map((item) => item.body)
    const blocks = (journal: AgentSessionJournal) =>
      journal
        .snapshot()
        .items.flatMap(({ body }) =>
          body.kind === 'message'
            ? body.blocks.map((block) => block.type)
            : body.kind === 'tool-call'
              ? ['tool-call']
              : []
        )
    await install(false)
    const historical = await imported('historical-recording')
    await catchUpSwitchedCliTranscript({ journal: historical, source, fence: 1, deadline })
    expect(turns(historical)).toEqual([])
    const stopped = await captureSwitchStoppedCliTurn(source, true, deadline)
    expect(stopped).toMatchObject({ sessionId: source.sessionId })
    let journal = await imported('switched-recording')
    const content = journal.snapshot().items
    expect(
      content.filter(({ body }) => body.kind === 'message' && body.role === 'user')
    ).toHaveLength(1)
    expect(blocks(journal)).toContain('tool-call')
    await catchUpSwitchedCliTranscript({ journal, source, fence: 1, deadline, stopped })
    expect(turns(journal)).toEqual([expect.objectContaining({ state: 'interrupted' })])
    expect(journal.snapshot().items.filter(({ body }) => body.kind !== 'turn')).toEqual(content)
    const interrupted = journal.snapshot()
    await journal.close()
    journal = await journals.open({
      ...recordedOptions,
      identity: { ...recordedOptions.identity, sessionId: 'switched-recording' }
    })
    await catchUpSwitchedCliTranscript({ journal, source, fence: 1, deadline, stopped })
    expect(journal.snapshot()).toEqual(interrupted)
    await install(true)
    const completed = await imported('completed-recording')
    await catchUpSwitchedCliTranscript({ journal: completed, source, fence: 1, deadline, stopped })
    expect(turns(completed)).toEqual([expect.objectContaining({ state: 'completed' })])
    expect(blocks(completed)).toContain('tool-result')
    const final = completed.snapshot()
    await catchUpSwitchedCliTranscript({ journal: completed, source, fence: 1, deadline, stopped })
    expect(completed.snapshot()).toEqual(final)
  }
)
