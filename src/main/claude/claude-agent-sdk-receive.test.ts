import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { buildClaudePermissionCallbacks } from './claude-structured-inbound-control'
import { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import { openClaudeStreamJsonConnection } from './claude-stream-json-connection'
import {
  openProviderTimelineRig,
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
const mocks = vi.hoisted(() => ({
  tree: {
    capture: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    reap: vi.fn(async () => 'unverifiable' as const),
    treeVerdict: 'unverifiable' as const,
    killDelivered: true
  }
}))
vi.mock('./claude-agent-sdk-exit-proof', () => ({ createClaudeChildTreeReaper: () => mocks.tree }))
function fakeChild() {
  return Object.assign(createFakePipedChild(424242), {
    exitCode: null,
    signalCode: null,
    killed: false
  })
}
afterEach(() => {
  vi.restoreAllMocks()
})
it.each(['eof-before-close', 'close-before-eof', 'empty', 'process-error'] as const)(
  'acknowledges actual external SDK public receipt with a live root: %s',
  async (boundary) => {
    mocks.tree.refresh.mockClear()
    const child = fakeChild()
    const rig = await openProviderTimelineRig()
    const translator = createClaudeJournalTranslator({ sink: rig.eventSink })
    const seen: string[] = [],
      exits = vi.fn(),
      faults = vi.fn()
    const first = Promise.withResolvers<void>()
    let actual: ReturnType<typeof query> | undefined
    const connection = await openClaudeStreamJsonConnection(
      { pathToClaudeCodeExecutable: 'claude', options: {}, cwd: '/work/repo' },
      {
        onMessage: (message) => {
          seen.push(String(message.uuid))
          translator.handle({ type: 'message', sessionId: SESSION, message })
          if (message.uuid === 's1-result-1') {
            connection.pauseReading?.()
            first.resolve()
          }
        },
        onFault: faults,
        onExit: exits
      },
      () => child,
      (params) => {
        actual = query(params)
        return actual
      }
    )
    const sdkExitListeners = child.listenerCount('exit')
    try {
      expect(actual?.receiveCompleted).toBeInstanceOf(Promise)
      const frames =
        boundary === 'empty'
          ? []
          : [1, 2, 3].map((index) => ({
              type: 'user',
              session_id: 's1-provider',
              uuid: `s1-result-${index}`,
              message: {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: `s1-tool-${index}`,
                    content: `complete finite S1 body ${index}`
                  }
                ]
              }
            }))
      child.stdout.write(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(''))
      if (frames.length) {
        await first.promise
      }
      if (boundary === 'eof-before-close' || boundary === 'empty') {
        child.stdout.end()
      }
      if (boundary === 'process-error') {
        child.emit('error', new Error('original S1 process failure'))
      }
      const closing = connection.close()
      if (boundary === 'close-before-eof' || boundary === 'process-error') {
        child.stdout.end()
      }
      if (boundary === 'process-error') {
        await expect(actual!.receiveCompleted).rejects.toThrow('original S1 process failure')
        await expect(closing).rejects.toThrow('original S1 process failure')
        expect(faults).toHaveBeenCalled()
      } else {
        await expect(actual!.receiveCompleted).resolves.toBeUndefined()
        await expect(closing).resolves.toBe(true)
      }
      expect(seen).toEqual(frames.map((frame) => frame.uuid))
      expect(connection.exitVerdict).toMatchObject({ root: 'live', killDelivered: true })
      expect(child.exitCode).toBeNull()
      expect(child.killed).toBe(false)
      expect(child.kill).not.toHaveBeenCalled()
      expect(exits).not.toHaveBeenCalled()
      expect(child.listenerCount('exit')).toBe(sdkExitListeners - 1)
      expect(mocks.tree.refresh).toHaveBeenCalledOnce()
      await expect(connection.send({ type: 'user' })).rejects.toThrow()
      await expect(connection.setModel('after-close')).rejects.toThrow()
      await expect(rig.eventSink.written?.()).resolves.toEqual({ ok: true })
      const reopened = await rig.reopenJournal()
      const tools = reopened.snapshot().items.filter((row) => row.body.kind === 'tool-call')
      expect(tools.map((row) => row.itemId)).toEqual(
        frames.map((_, i) => `orca:claude-tool%3As1-provider%3As1-tool-${i + 1}`)
      )
      expect(tools.map((row) => row.body)).toEqual(
        frames.map((_, i) =>
          expect.objectContaining({
            callId: `s1-tool-${i + 1}`,
            output: expect.objectContaining({
              head: `complete finite S1 body ${i + 1}`,
              byteLength: 25,
              truncated: false,
              digest: createHash('sha256')
                .update(`complete finite S1 body ${i + 1}`)
                .digest('hex')
            })
          })
        )
      )
    } finally {
      child.stdout.end()
      child.stderr.end()
      connection.resumeReading?.()
      await connection.close().catch(() => {})
      translator.dispose()
      await closeProviderTimelineRigs()
    }
  }
)

it('settles the actual SDK control response before receive cleanup cancels a pending permission', async () => {
  const child = fakeChild()
  const prompts = new ClaudePromptRegistry()
  const requested = Promise.withResolvers<void>()
  const emit = vi.fn((event) => {
    if (event.type === 'prompt') {
      requested.resolve()
    }
  })
  const callbacks = buildClaudePermissionCallbacks({ sessionId: SESSION, prompts, emit })
  const requests: string[] = [],
    replies: string[] = []
  child.stdin.on('data', (bytes) => {
    for (const line of String(bytes).trim().split('\n')) {
      const frame = JSON.parse(line)
      if (frame.type === 'control_response') {
        replies.push(frame.response.request_id)
      }
      if (frame.type === 'control_request') {
        requests.push(frame.request_id)
        child.stdout.write(
          `${JSON.stringify({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: frame.request_id,
              response: { commands: [], models: [] }
            }
          })}\n`
        )
      }
    }
  })
  const connection = await openClaudeStreamJsonConnection(
    { pathToClaudeCodeExecutable: 'claude', options: {}, cwd: '/work/repo' },
    callbacks,
    () => child,
    query
  )
  try {
    await expect(connection.setModel('original-control-model')).resolves.toBeUndefined()
    expect(requests.length).toBeGreaterThanOrEqual(2)
    child.stdout.write(
      `${JSON.stringify({
        type: 'control_request',
        request_id: 'pending-original-permission',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          tool_use_id: 'pending-tool',
          input: { command: 'git status' }
        }
      })}\n`
    )
    await requested.promise
    child.stdout.end()
    await expect(connection.close()).resolves.toBe(true)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt-cancelled' }))
    expect(prompts.clear()).toEqual([])
    expect(replies).not.toContain('pending-original-permission')
    expect(child.kill).not.toHaveBeenCalled()
  } finally {
    child.stdout.end()
    child.stderr.end()
    await connection.close().catch(() => {})
  }
})
