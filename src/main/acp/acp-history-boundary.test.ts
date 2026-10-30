import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentSessionHostStatusBody } from '../../shared/agent-session-host-status-rows'
import * as historyBoundary from './acp-history-boundary'
import { continuedOutsideNotice } from '../native-chat/agent-session-wire/structured-agent-session-history-catch-up'
import {
  closeProviderTimelineRigs,
  AGENT,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { OPENCODE_ACP_DIALECT } from './acp-dialects/opencode-dialect'
import {
  setup,
  dividers,
  chatSend,
  userReplay,
  answerReplay
} from './acp-history-catch-up.test-support'

afterEach(async () => {
  vi.restoreAllMocks()
  await closeProviderTimelineRigs()
})

describe('ACP recovered history boundaries', () => {
  it.each(['neutral', 'none'] as const)(
    'corrects a repeated root once and imports unrelated content with the %s boundary',
    async (presentation) => {
      vi.spyOn(historyBoundary, 'acpHistoryBoundary').mockReturnValue(
        presentation === 'neutral' ? agentSessionHostStatusBody('history-loaded') : null
      )
      const { fixture, catchUp, warn } = await setup(OPENCODE_ACP_DIALECT, 'user-message-id')
      await chatSend(fixture, 'retained', 'keep')
      await catchUp([userReplay('recovered', 'old')])
      await fixture.rig.journal.appendItem(
        {
          provider: 'legacy',
          agent: AGENT,
          sessionId: SESSION,
          recordId: 'continued-outside:recovered'
        },
        continuedOutsideNotice(true),
        { fence: 1, turnScope: { kind: 'thread' } }
      )
      const saved = (await fixture.rig.rows()).find((row) => row.body.kind === 'status')!
      await fixture.restart()
      const replay = [
        userReplay('recovered', 'old'),
        userReplay('new', 'new'),
        userReplay('recovered', 'old')
      ]
      await catchUp(replay)
      const imported = await fixture.rig.rows()
      expect(
        imported.some(
          (row) =>
            row.body.kind === 'message' &&
            row.body.role === 'user' &&
            row.body.blocks.some((block) => block.type === 'text' && block.text === 'new')
        )
      ).toBe(true)
      if (presentation === 'neutral') {
        expect(imported.find((row) => row.itemId === saved.itemId)).toMatchObject({
          sequence: saved.sequence,
          revision: saved.revision + 1,
          body: { kind: 'status', presentation: 'history-loaded' }
        })
      } else {
        expect(imported.find((row) => row.itemId === saved.itemId)).toBeUndefined()
      }
      expect(JSON.stringify(imported)).not.toContain('continued-outside-rewound')
      await catchUp(replay)
      expect(await fixture.rig.rows()).toEqual(imported)
      expect(warn).not.toHaveBeenCalled()
    }
  )

  it.each(['neutral', 'none'] as const)(
    'corrects an old notice and completes imported history with the %s boundary',
    async (presentation) => {
      if (presentation === 'none') {
        vi.spyOn(historyBoundary, 'acpHistoryBoundary').mockReturnValue(null)
      }
      const { fixture, catchUp } = await setup(OPENCODE_ACP_DIALECT, 'user-message-id')
      await chatSend(fixture, 'retained', 'my earlier message')
      const partial = [userReplay('recovered'), answerReplay('prefix')]
      await catchUp(partial)
      const identity = {
        provider: 'legacy',
        agent: AGENT,
        sessionId: SESSION,
        recordId: 'continued-outside:recovered'
      } as const
      await fixture.rig.journal.appendItem(identity, continuedOutsideNotice(true), {
        fence: 1,
        turnScope: { kind: 'thread' }
      })
      const before = await fixture.rig.rows()
      const saved = before.find((row) => row.body.kind === 'status')!
      await fixture.restart()
      // Correct unchanged content too; partial-import coverage already prevents a second divider.
      await catchUp(partial)
      const corrected = await fixture.rig.rows()
      expect(corrected.filter((row) => row.itemId !== saved.itemId)).toEqual(
        before.filter((row) => row.itemId !== saved.itemId)
      )
      const boundary = corrected.find((row) => row.itemId === saved.itemId)
      if (presentation === 'neutral') {
        expect(boundary).toMatchObject({
          sequence: saved.sequence,
          revision: saved.revision + 1,
          body: { kind: 'status', presentation: 'history-loaded' }
        })
      } else {
        expect(boundary).toBeUndefined()
      }
      const full = [userReplay('recovered'), answerReplay('prefix and tail')]
      await catchUp(full)
      const complete = await fixture.rig.rows()
      expect(dividers(complete)).toHaveLength(presentation === 'neutral' ? 1 : 0)
      expect(
        complete.some(
          (row) =>
            row.body.kind === 'message' &&
            row.body.role === 'assistant' &&
            row.body.blocks.some(
              (block) => block.type === 'text' && block.text === 'prefix and tail'
            )
        )
      ).toBe(true)
      expect(JSON.stringify(complete)).not.toContain('continued-outside-rewound')
      await catchUp(full)
      expect(await fixture.rig.rows()).toEqual(complete)
    }
  )

  it('abandons an old-notice correction if its saved revision changes before commit', async () => {
    const { fixture, catchUp } = await setup(OPENCODE_ACP_DIALECT, 'user-message-id')
    await chatSend(fixture, 'retained', 'keep')
    const replay = [userReplay('recovered'), answerReplay('answer')]
    await catchUp(replay)
    const identity = {
      provider: 'legacy',
      agent: AGENT,
      sessionId: SESSION,
      recordId: 'continued-outside:recovered'
    } as const
    await fixture.rig.journal.appendItem(identity, continuedOutsideNotice(true), {
      fence: 1,
      turnScope: { kind: 'thread' }
    })
    const append = fixture.rig.eventSink.tryAppendTransition!
    fixture.rig.eventSink.tryAppendTransition = (transition) => {
      void fixture.rig.journal.appendItem(identity, continuedOutsideNotice(false), {
        fence: 1,
        turnScope: { kind: 'thread' }
      })
      return append(transition)
    }
    await catchUp(replay)
    const rows = await fixture.rig.rows()
    expect(rows.find((row) => row.body.kind === 'status')?.body).toEqual(
      continuedOutsideNotice(false)
    )
  })
})
