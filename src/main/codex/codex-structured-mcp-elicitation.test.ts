import { describe, expect, it, vi } from 'vitest'
import {
  acquireReadyCodexForTest,
  THREAD_ID,
  adapterFor,
  fakeCodex,
  identityFor,
  lifecycleRecorder
} from './codex-structured-session-adapter-fixture'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { AgentSessionPromptResponse } from '../../shared/agent-session-question-answer'
import { readCodexMcpElicitation } from './codex-mcp-elicitation'

const recordedElicitations = z
  .array(
    z.object({
      id: z.union([z.string(), z.number()]),
      method: z.string(),
      params: z.record(z.string(), z.unknown())
    })
  )
  .parse(
    JSON.parse(
      readFileSync(
        new URL('./__fixtures__/codex-app-server-mcp-elicitations.json', import.meta.url),
        'utf8'
      )
    )
  )

async function elicitationSession(mode: 'url' | 'form', cancellationAdmitted = true) {
  const frame = recordedElicitations.find((frame) => frame.params.mode === mode)
  if (!frame) {
    throw new Error('Missing recorded elicitation')
  }
  const codex = fakeCodex()
  const recorded = lifecycleRecorder(cancellationAdmitted)
  const adapter = adapterFor(codex)
  await acquireReadyCodexForTest(adapter, {
    identity: identityFor('session-1'),
    fence: 7,
    spawnToken: 'spawn-9',
    events: recorded.sink
  })
  const request = { ...frame, params: { ...frame.params, threadId: THREAD_ID, turnId: 'turn-1' } }
  codex.connections[0].handlers.onServerRequest?.(request)
  const cards = [...recorded.bodies].flatMap(([id, body]) =>
    body.kind === 'approval' || body.kind === 'question' ? [{ id, body }] : []
  )
  const answer = async (id: string, response: AgentSessionPromptResponse) => {
    const body = recorded.bodies.get(id)
    if (!body || (body.kind !== 'approval' && body.kind !== 'question')) {
      throw new Error('Missing card')
    }
    return adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: id,
      kind: body.kind,
      fence: 7,
      response,
      commit: async () => {
        recorded.bodies.set(id, {
          ...body,
          resolution: {
            state: 'resolved',
            selectedOptionId:
              response.kind === 'option'
                ? response.optionId
                : (response.answers[0]?.optionIds[0] ?? null),
            resolvedBy: 'client',
            resolvedAt: 1
          }
        })
      }
    })
  }
  return { codex, adapter, recorded, cards, request, answer }
}

describe('recorded MCP elicitation contracts', () => {
  it.each(['accept', 'decline', 'cancel'])(
    'journals URL requests and replies %s once to their outer id',
    async (action) => {
      const { codex, cards, request, answer } = await elicitationSession('url')
      expect(cards).toHaveLength(1)
      expect(cards[0]?.body).toMatchObject({
        kind: 'approval',
        detail: request.params.url,
        url: request.params.url
      })
      expect(codex.connections[0].replies).toEqual([])
      const id = cards[0]!.id
      await answer(id, { kind: 'option', optionId: action })
      expect(codex.connections[0].replies).toEqual([
        { id: request.id, result: { action, content: null, _meta: null } }
      ])
      await expect(answer(id, { kind: 'option', optionId: action })).rejects.toThrow(
        'no longer waiting'
      )
      expect(codex.connections[0].replies).toHaveLength(1)
    }
  )

  it.each(['  token  ', '   ', ''])(
    'accepts all typed fields, preserving exact text %j, false, zero, enum values and omission',
    async (text) => {
      const { codex, cards, request, answer } = await elicitationSession('form')
      for (const card of cards) {
        if (card.body.kind !== 'question') {
          throw new Error('Expected field question')
        }
        const name = card.body.freeTextQuestionId
        const label =
          name === 'note'
            ? 'Skip this field'
            : name === 'name' && text === ''
              ? 'Use empty text'
              : card.body.question.endsWith('confirmed')
                ? 'No'
                : card.body.question.endsWith('color')
                  ? 'Blue label'
                  : null
        const option = card.body.options.find((option) => option.label === label)
        await answer(card.id, {
          kind: 'answers',
          answers: [
            {
              questionId: name ?? 'q1',
              optionIds: option ? [option.id] : [],
              ...(!option ? { other: name === 'name' ? text : '0' } : {})
            }
          ]
        })
      }
      expect(codex.connections[0].replies).toEqual([
        {
          id: request.id,
          result: {
            action: 'accept',
            content: { name: text, count: 0, confirmed: false, color: 'blue' },
            _meta: null
          }
        }
      ])
    }
  )

  it('keeps an invalid number pending so the user can correct it before committing', async () => {
    const { cards, recorded, codex, answer } = await elicitationSession('form')
    const count = cards.find(
      (card) => card.body.kind === 'question' && card.body.freeTextQuestionId === 'count'
    )!
    const response = (other: string): AgentSessionPromptResponse => ({
      kind: 'answers',
      answers: [{ questionId: 'count', optionIds: [], other }]
    })
    await expect(answer(count.id, response('11'))).rejects.toThrow('at most 10')
    expect(recorded.bodies.get(count.id)).toMatchObject({ resolution: { state: 'pending' } })
    expect(codex.connections[0].replies).toEqual([])
    await answer(count.id, response('0'))
    expect(recorded.bodies.get(count.id)).toMatchObject({ resolution: { state: 'resolved' } })
  })

  it.each(['decline', 'cancel'])(
    'ends the whole form on %s while retaining answered cards',
    async (action) => {
      const { codex, cards, request, recorded, answer } = await elicitationSession('form')
      const named = cards.find(
        (card) => card.body.kind === 'question' && card.body.freeTextQuestionId === 'name'
      )!
      await answer(named.id, {
        kind: 'answers',
        answers: [{ questionId: 'name', optionIds: [], other: 'kept' }]
      })
      expect(codex.connections[0].replies).toEqual([])
      const chosen = cards.find((card) => card.id !== named.id)!
      const option = chosen.body.options.find(
        (option) => option.label === `${action === 'decline' ? 'Decline' : 'Cancel'} request`
      )!
      await answer(chosen.id, {
        kind: 'answers',
        answers: [{ questionId: 'q1', optionIds: [option.id] }]
      })
      expect(codex.connections[0].replies).toEqual([
        { id: request.id, result: { action, content: null, _meta: null } }
      ])
      for (const card of cards) {
        const body = recorded.bodies.get(card.id)
        if (body?.kind !== 'question') {
          throw new Error('Expected question')
        }
        expect(body.resolution.state).toBe(
          card.id === named.id || card.id === chosen.id ? 'resolved' : 'cancelled'
        )
      }
      await expect(
        answer(chosen.id, {
          kind: 'answers',
          answers: [{ questionId: 'q1', optionIds: [option.id] }]
        })
      ).rejects.toThrow('no longer waiting')
    }
  )

  it('ends the provider callback and closes the session when sibling cancellation cannot be journaled', async () => {
    const { codex, cards, request, answer } = await elicitationSession('form', false)
    const chosen = cards[0]!
    const option = chosen.body.options.find((option) => option.label === 'Decline request')!
    await expect(
      answer(chosen.id, {
        kind: 'answers',
        answers: [{ questionId: 'q1', optionIds: [option.id] }]
      })
    ).rejects.toThrow('could not be durably settled')
    expect(codex.connections[0].replies).toEqual([
      {
        id: request.id,
        code: -32001,
        message: expect.stringContaining('could not be durably settled')
      }
    ])
    await vi.waitFor(() => expect(codex.connections[0].closeCount).toBe(1))
  })

  it('declines the whole request before showing unsupported or truncated field schemas', () => {
    const fixture = recordedElicitations.find((frame) => frame.params.mode === 'form')!
    for (const schema of [
      { type: 'object', properties: { x: { type: 'object' } } },
      { type: 'object', properties: { x: { type: 'string', pattern: '.*' } } },
      {
        type: 'object',
        properties: { x: { type: 'string', enum: Array.from({ length: 63 }, (_, i) => String(i)) } }
      },
      { type: 'object', properties: { x: { type: 'number', minimum: 2, maximum: 1 } } },
      { type: 'object', properties: { x: { type: 'string', enum: ['a', 'a'] } } }
    ]) {
      expect(readCodexMcpElicitation({ ...fixture.params, requestedSchema: schema })).toBeNull()
    }
  })
})
