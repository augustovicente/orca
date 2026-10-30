import { listSessions } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as transcriptFs from '../native-chat/wsl-transcript-fs-access'
import { renameClaudeTranscript } from './claude-provider-session-rename'

let home: string
let conversation: string
let transcript: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'orca-claude-rename-'))
  conversation = randomUUID()
  const project = join(home, 'projects', 'workspace')
  await mkdir(project, { recursive: true })
  transcript = join(project, `${conversation}.jsonl`)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(home, { recursive: true, force: true })
})

it('appends a standalone SDK title after a crash-torn tail and reads it back through the SDK', async () => {
  const user = {
    type: 'user',
    uuid: randomUUID(),
    sessionId: conversation,
    message: { role: 'user', content: 'ship it' }
  }
  const prefix = `${JSON.stringify(user)}\n{"type":"assistant","mess`
  await writeFile(transcript, prefix)
  const otherAccount = join(home, 'other-account', 'projects', 'workspace')
  await mkdir(otherAccount, { recursive: true })
  const otherTranscript = join(otherAccount, `${conversation}.jsonl`)
  await writeFile(otherTranscript, 'another account\n')
  await renameClaudeTranscript(home, conversation, ' Release notes ')
  const lines = (await readFile(transcript, 'utf8')).split('\n')
  expect(lines.slice(0, 2).join('\n')).toBe(prefix)
  const title = JSON.parse(lines[2] ?? '')
  expect(title).toMatchObject({
    type: 'custom-title',
    sessionId: conversation,
    customTitle: 'Release notes'
  })
  expect(title.uuid).toEqual(expect.any(String))
  expect(await readFile(otherTranscript, 'utf8')).toBe('another account\n')
  const listed = await listSessions({
    sessionStore: {
      load: async () => [user, title],
      append: async () => {},
      listSessions: async () => [{ sessionId: conversation, mtime: 1_700_000_000_000 }]
    }
  })
  expect(listed[0]?.customTitle).toBe('Release notes')
})

it('refuses missing, empty, multiple and incomplete inventories without mutating another candidate', async () => {
  await expect(renameClaudeTranscript(home, conversation, 'Missing')).rejects.toThrow(
    'no transcript'
  )
  await writeFile(transcript, '')
  await expect(renameClaudeTranscript(home, conversation, 'Empty')).rejects.toThrow('no transcript')
  await writeFile(transcript, 'old\n')
  const second = join(home, 'projects', 'hash-or-worktree')
  await mkdir(second)
  const duplicate = join(second, `${conversation}.jsonl`)
  await writeFile(duplicate, 'other\n')
  await expect(renameClaudeTranscript(home, conversation, 'Ambiguous')).rejects.toThrow(
    'multiple transcripts'
  )
  expect(await readFile(transcript, 'utf8')).toBe('old\n')
  expect(await readFile(duplicate, 'utf8')).toBe('other\n')
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
  vi.spyOn(transcriptFs, 'wslGatedStat').mockRejectedValue(denied)
  await expect(renameClaudeTranscript(home, conversation, 'Denied')).rejects.toBe(denied)
  expect(await readFile(transcript, 'utf8')).toBe('old\n')
})

it.each([10, 100])(
  'bounds literal candidate discovery at %i projects regardless of transcript count',
  async (count) => {
    await writeFile(transcript, 'old\n')
    for (let i = 0; i < count; i++) {
      const project = join(home, 'projects', `project-${i}`)
      await mkdir(project)
      await Promise.all(
        Array.from({ length: 20 }, (_, j) => writeFile(join(project, `history-${j}.jsonl`), ''))
      )
    }
    const readDirectory = vi.spyOn(transcriptFs, 'wslGatedReaddir')
    const stat = vi.spyOn(transcriptFs, 'wslGatedStat')
    await renameClaudeTranscript(home, conversation, 'Final')
    expect(readDirectory).toHaveBeenCalledTimes(1)
    expect(stat).toHaveBeenCalledTimes(count + 1)
    expect(new Set(stat.mock.calls.map(([path]) => path)).size).toBe(count + 1)
    expect((await readFile(transcript, 'utf8')).trim().split('\n').at(-1)).toContain('Final')
  }
)
