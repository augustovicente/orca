import { expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

const SESSION_ID = 'session-1'
const THREAD_ID = 'thread-abc'

function recorder() {
  const rows: { body: AgentJournalItemBody }[] = []
  let publications = 0
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (_identity, body) => {
      rows.push({ body })
    },
    appendTombstone: () => {},
    publish: () => {
      publications++
    }
  }
  return { rows, sink, publishes: () => publications }
}

function notification(method: string, params: unknown): CodexStructuredSessionEvent {
  return { type: 'notification', sessionId: SESSION_ID, threadId: THREAD_ID, method, params }
}

function translatorWith() {
  const tap = recorder()
  const pending = new Set<() => void>()
  const translator = createCodexJournalTranslator({
    sink: tap.sink,
    bindPromptItemId: () => {},
    schedule: (run) => {
      pending.add(run)
      return () => pending.delete(run)
    }
  })
  return {
    tap,
    translator,
    window: {
      fire: () => {
        const due = [...pending]
        pending.clear()
        due.forEach((run) => run())
      },
      idle: () => pending.size === 0
    }
  }
}

it('delivers synthetic plan text on elapsed ordinary arrivals and preserves first timing through wall rollback', () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(500000)
  const tap = recorder()
  const appended = vi.spyOn(tap.sink, 'appendItem')
  const translator = createCodexJournalTranslator({ sink: tap.sink, bindPromptItemId: () => {} })
  const delta = (text: string) =>
    translator.handle(notification('item/plan/delta', { itemId: 'plan', delta: text }))
  try {
    translator.handle(
      notification('item/started', { item: { type: 'plan', id: 'plan', text: '' } })
    )
    delta('')
    vi.advanceTimersByTime(60)
    expect(tap.rows).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(40)
    delta('P'.repeat(100))
    vi.advanceTimersByTime(59)
    expect(tap.rows).toEqual([])
    vi.advanceTimersByTime(1)
    expect(tap.rows.at(-1)?.body).toMatchObject({
      text: 'P'.repeat(100),
      presentation: 'plan-document'
    })
    const first = appended.mock.calls[0]
    delta('')
    vi.advanceTimersByTime(400)
    vi.setSystemTime(100)
    delta('T')
    vi.advanceTimersByTime(60)
    expect(tap.rows).toHaveLength(2)
    expect(tap.rows.at(-1)?.body).toMatchObject({ text: `${'P'.repeat(100)}T` })
    expect(appended.mock.calls[1][0]).toEqual(first[0])
    expect(appended.mock.calls[1][2]).toEqual(first[2])
    delta('U')
    vi.advanceTimersByTime(60)
    expect(tap.rows).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
    translator.handle(
      notification('item/completed', {
        item: { type: 'plan', id: 'plan', text: `${'P'.repeat(100)}TU final` }
      })
    )
    expect(tap.rows.at(-1)?.body).toMatchObject({
      text: `${'P'.repeat(100)}TU final`,
      presentation: 'plan-document'
    })
    expect(appended.mock.calls.at(-1)?.[0]).toEqual(first[0])
    expect(appended.mock.calls.at(-1)?.[2]).toMatchObject(first[2])
  } finally {
    translator.dispose()
    vi.useRealTimers()
  }
})

it.each(['append', 'publication'] as const)(
  'does not spend synthetic plan eligibility on %s refusal',
  (boundary) => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    const tap = recorder()
    let refused = true
    tap.sink.tryAppendItem = (id, body, options) => {
      if (refused && boundary === 'append') {
        return { accepted: false, reason: 'backpressure' }
      }
      tap.sink.appendItem(id, body, options)
      return { accepted: true }
    }
    tap.sink.tryPublish = () => {
      if (refused && boundary === 'publication') {
        return { accepted: false, reason: 'backpressure' }
      }
      tap.sink.publish()
      return { accepted: true }
    }
    const translator = createCodexJournalTranslator({ sink: tap.sink, bindPromptItemId: () => {} })
    try {
      translator.handle(notification('item/plan/delta', { itemId: 'plan', delta: 'P' }))
      vi.advanceTimersByTime(60)
      expect(tap.publishes()).toBe(0)
      refused = false
      translator.handle(notification('item/plan/delta', { itemId: 'plan', delta: 'T' }))
      vi.advanceTimersByTime(60)
      expect(tap.rows.at(-1)?.body).toMatchObject({ text: 'PT', presentation: 'plan-document' })
      expect(tap.publishes()).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      translator.dispose()
      vi.useRealTimers()
    }
  }
)

it.each([false, true])(
  'orders synthetic child plan first admission, ordinary skip and matching force; missing start=%s',
  (missingStart) => {
    const { translator, tap, window } = translatorWith()
    const child = (method: string, params: unknown) =>
      translator.handle({
        type: 'notification',
        sessionId: SESSION_ID,
        threadId: 'child',
        method,
        params
      })
    const plans = () =>
      tap.rows.filter(
        (row) => row.body.kind === 'status' && row.body.presentation === 'plan-document'
      )
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    try {
      if (!missingStart) {
        child('item/started', { item: { type: 'plan', id: 'plan', text: '' } })
      }
      child('item/plan/delta', { itemId: 'plan', delta: 'P'.repeat(100) })
      translator.handle(
        notification('item/started', {
          item: { type: 'commandExecution', id: 'root-tool', command: 'pwd' }
        })
      )
      expect(tap.rows.slice(0, 2).map((row) => row.body.kind)).toEqual(['status', 'tool-call'])
      expect(plans()).toHaveLength(1)
      clock.mockReturnValue(100)
      child('item/plan/delta', { itemId: 'plan', delta: 'T' })
      window.fire()
      for (let i = 0; i < 10; i++) {
        translator.handle(
          notification('item/started', {
            item: { type: 'commandExecution', id: `tool-${i}`, command: 'pwd' }
          })
        )
      }
      expect(plans()).toHaveLength(1)
      expect(window.idle()).toBe(true)
      child('item/started', {
        item: { type: 'commandExecution', id: 'child-tool', command: 'pwd' }
      })
      expect(plans()).toHaveLength(2)
      expect(plans().at(-1)?.body).toMatchObject({ text: `${'P'.repeat(100)}T` })
    } finally {
      clock.mockRestore()
      translator.dispose()
    }
  }
)

it.each([
  ['commandExecution', 'item/commandExecution/outputDelta'],
  ['fileChange', 'item/fileChange/outputDelta']
])('keeps %s full previews on growth checkpoints despite elapsed time', (type, method) => {
  const { translator, tap, window } = translatorWith()
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
  try {
    translator.handle(notification(method, { itemId: 'output', delta: 'P'.repeat(100) }))
    window.fire()
    const before = tap.rows.length
    clock.mockReturnValue(400)
    translator.handle(notification(method, { itemId: 'output', delta: 'T' }))
    window.fire()
    expect(tap.rows).toHaveLength(before)
    expect(window.idle()).toBe(true)
    translator.flush()
    expect(tap.rows).toHaveLength(before + 1)
    expect(tap.rows.at(-1)?.body).toMatchObject(
      type === 'commandExecution'
        ? { output: { head: `${'P'.repeat(100)}T` } }
        : { patch: { head: `${'P'.repeat(100)}T` } }
    )
  } finally {
    clock.mockRestore()
    translator.dispose()
  }
})
