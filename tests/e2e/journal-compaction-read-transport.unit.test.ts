import { compactionTransportCorpus } from '../../src/main/native-chat/agent-session-journal/journal-compaction-frames.test-fixture'
import { STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS } from '../../src/shared/structured-agent-session-coalescer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../src/shared/structured-agent-session-reducer'
import type { AgentSessionSubscribeEvent } from '../../src/shared/agent-session-wire'

const mocks = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn(), watchHostContact: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSession: mocks.subscribe
}))

vi.mock('@/runtime/runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: mocks.watchHostContact
}))

import { startStructuredAgentSessionReadTransport } from '../../src/renderer/src/components/native-chat/structured-agent-session-read-transport'

type SubscribeAttempt = {
  closed: PromiseWithResolvers<{ unsubscribe: () => void }>
  onClose: () => void
  onError: (error: unknown) => void
  onEvent: (event: AgentSessionSubscribeEvent) => void
  unsubscribe: ReturnType<typeof vi.fn<() => void>>
}

const target = { kind: 'local' } as const

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('structured agent-session read transport generations', () => {
  const attempts: SubscribeAttempt[] = []

  beforeEach(() => {
    attempts.length = 0
    vi.clearAllMocks()
    mocks.subscribe.mockImplementation((_target, _params, onEvent, onError, onClose) => {
      const attempt: SubscribeAttempt = {
        closed: Promise.withResolvers<{ unsubscribe: () => void }>(),
        onClose,
        onError,
        onEvent,
        unsubscribe: vi.fn<() => void>()
      }
      attempts.push(attempt)
      return attempt.closed.promise
    })
  })

  it('consumes the SQLite-verified retired frames and reconnects at the applied sparse cursor', async () => {
    vi.useFakeTimers()
    const corpus = compactionTransportCorpus()
    let state = EMPTY_STRUCTURED_AGENT_SESSION
    const transport = startStructuredAgentSessionReadTransport({
      subscribeRetryNow: () => () => {},
      applyEvent: (event) => {
        state = reduceStructuredAgentSession(state, { type: 'event', event }, 0)
      },
      applyError: vi.fn(),
      getCursor: () => state.cursor,
      onContactLost: vi.fn(),
      onHistoryReadInvalidated: () => undefined,
      sessionId: 'session-1',
      target
    })
    try {
      attempts[0]!.onEvent(compactionTransportCorpus(7).snapshot)
      attempts[0]!.onEvent(corpus.frame)
      await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS)
      const expected = reduceStructuredAgentSession(
        EMPTY_STRUCTURED_AGENT_SESSION,
        { type: 'event', event: corpus.snapshot },
        0
      )
      expect(state.items).toEqual(expected.items)
      expect(state.submissions).toEqual(expected.submissions)
      expect(state.cursor).toEqual(expected.cursor)
      attempts[0]!.closed.resolve({ unsubscribe: attempts[0]!.unsubscribe })
      await flushPromises()
      attempts[0]!.onClose()
      await vi.advanceTimersByTimeAsync(750)
      expect(mocks.subscribe.mock.calls[1]?.[1]).toMatchObject({
        sessionId: 'session-1',
        cursor: expected.cursor
      })
      attempts[1]!.closed.resolve({ unsubscribe: attempts[1]!.unsubscribe })
      await flushPromises()
    } finally {
      transport.dispose()
      vi.useRealTimers()
    }
  })
})
