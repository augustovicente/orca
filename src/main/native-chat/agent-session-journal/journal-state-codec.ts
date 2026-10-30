// Versioned reducer snapshots preserve insertion order and the presence of undefined echo declarations.

import { z } from 'zod'
import type { journalStateLayout } from './journal-state-layout'
import {
  isAdmissibleAgentJournalRenderItem,
  isAdmissibleAgentJournalMessageBody,
  AgentJournalTurnScopeSchema
} from '../../../shared/agent-session-journal-schemas'
import { AgentJournalSubmissionSchema } from '../../../shared/agent-session-journal-submission-schema'
import { AgentSessionExecutionOptionsSchema } from '../../../shared/agent-session-execution-options'
import { AgentSessionFailureFactSchema } from '../../../shared/agent-session-failure-fact-schema'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import type { QueuedMessageRow } from './queued-message-table'
import type { JournalReducerState } from './journal-reducer'
import { JournalDerivedTurnScope } from './journal-derived-turn-scope'

// Version 1 was an unreleased whole-state layout; it decodes to null and its chat replays.
export const JOURNAL_STATE_CODEC_VERSION = 2

const number = z.number().finite()
const cursor = z.object({ epoch: z.string(), sequence: number })
const place = z.object({
  sequence: number,
  observedAt: number,
  turnScope: AgentJournalTurnScopeSchema.optional()
})
const handle = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('codex'), threadId: z.string() }),
  z.object({ kind: z.literal('claude'), sessionId: z.string(), leafUuid: z.string().nullable() }),
  z.object({ kind: z.literal('opaque'), agent: z.string(), value: z.string() })
])
const pauseMarks = z.object({
  cleared: z
    .object({
      sequence: number,
      operationId: z.string(),
      messageIds: z.array(z.string()),
      lifted: z.literal(true).optional()
    })
    .optional(),
  latestStop: z
    .object({
      sequence: number,
      event: z.object({
        reason: z.string(),
        at: number,
        turnId: z.string().optional(),
        caller: z.string().optional()
      })
    })
    .nullable(),
  resumedSequence: number,
  reopenedSequence: number
})
const card = z.object({
  messageId: z.string(),
  position: number,
  body: z.custom<AgentJournalMessageItem>(isAdmissibleAgentJournalMessageBody),
  fingerprint: z.string(),
  state: z.enum(['waiting', 'dispatched', 'returned', 'withdrawn']),
  holdReason: z.string().nullable(),
  returnedReason: z.string().nullable(),
  returnedRejection: AgentSessionFailureFactSchema.nullable(),
  consumedAs: z.string().nullable(),
  queuedAt: cursor.nullable(),
  options: AgentSessionExecutionOptionsSchema.optional()
})
const submission = AgentJournalSubmissionSchema.extend({
  acceptedSequence: number.optional(),
  origin: z.enum(['client', 'host']).optional()
})

function checked<T>(schema: z.ZodType): z.ZodType<T> {
  // SAFETY: each schema below checks the stored shape; retain the original object, including unknown annotations.
  return z.custom<T>((value) => schema.safeParse(value).success)
}

function entries<T>(value: z.ZodType<T>) {
  return z.array(z.tuple([z.string(), value]))
}

// Every reducer key must have an explicit stored representation, including separately stored items.
const fields = {
  sessionId: z.string(),
  epoch: z.string(),
  lastSequence: z.number().int().nonnegative(),
  lastActivityAt: number,
  oldestSequence: number,
  highestFence: number,
  items: z.array(z.custom<AgentJournalRenderItem>(isAdmissibleAgentJournalRenderItem)),
  itemFences: entries(number),
  itemExecutionOwners: entries(number),
  providerActivityAt: z.array(z.tuple([number, number])),
  tombstones: entries(number),
  removedTurnIds: z.array(z.string()),
  submissions: entries(checked<AgentJournalSubmission>(submission)),
  receipts: entries(
    z.object({
      clientMessageId: z.string(),
      providerItemId: z.string(),
      cursor,
      acceptedAt: number
    })
  ),
  aliases: entries(z.string()),
  itemEchoes: z.array(z.union([z.tuple([z.string()]), z.tuple([z.string(), z.unknown()])])),
  appliedSettlementIds: z.array(z.string()),
  derivedTurnScope: z.string().nullable(),
  latestAcceptedTurnSequence: number,
  queuePauseMarks: checked<JournalReducerState['queuePauseMarks']>(pauseMarks),
  stoppedHistoryCarried: entries(z.array(z.string())),
  queuedHandOffPlaces: entries(
    checked<Pick<AgentJournalRenderItem, 'sequence' | 'observedAt' | 'turnScope'>>(place)
  ),
  normalizedHandOffs: z.array(z.string()),
  queue: z.object({
    revision: number,
    cards: entries(checked<QueuedMessageRow>(card))
  }),
  historyOrigin: checked<JournalReducerState['historyOrigin']>(
    z
      .object({
        providerHandle: handle,
        raw: z.unknown()
      })
      .nullable()
  )
} satisfies Record<keyof JournalReducerState, z.ZodType>
const scalarsV2 = z
  .object(fields)
  .pick({
    sessionId: true,
    epoch: true,
    lastSequence: true,
    lastActivityAt: true,
    oldestSequence: true,
    highestFence: true,
    derivedTurnScope: true,
    latestAcceptedTurnSequence: true,
    queuePauseMarks: true,
    historyOrigin: true
  })
  .extend({ queue: fields.queue.pick({ revision: true }) })

type CollectionPath =
  | {
      [K in keyof typeof journalStateLayout]: (typeof journalStateLayout)[K] extends 'map' | 'set'
        ? K
        : never
    }[keyof typeof journalStateLayout]
  | 'queue.cards'

// Live Stop settlement belongs to its process; only the row-derived pause facts survive restart.
function durableQueuePauseMarks(
  marks: JournalReducerState['queuePauseMarks']
): JournalReducerState['queuePauseMarks'] {
  const stop = marks.latestStop
  return { ...marks, latestStop: stop && { sequence: stop.sequence, event: stop.event } }
}

export function encodeJournalState(state: JournalReducerState): {
  stateJson: string
  items: { itemId: string; itemJson: string; ordinal: number }[]
} {
  const stored = {
    sessionId: state.sessionId,
    epoch: state.epoch,
    lastSequence: state.lastSequence,
    lastActivityAt: state.lastActivityAt,
    oldestSequence: state.oldestSequence,
    highestFence: state.highestFence,
    itemFences: [...state.itemFences],
    itemExecutionOwners: [...state.itemExecutionOwners],
    providerActivityAt: [...state.providerActivityAt],
    tombstones: [...state.tombstones],
    removedTurnIds: [...state.removedTurnIds],
    submissions: [...state.submissions],
    receipts: [...state.receipts],
    aliases: [...state.aliases],
    itemEchoes: [...state.itemEchoes].map(([key, value]) =>
      value === undefined ? [key] : [key, value]
    ),
    appliedSettlementIds: [...state.appliedSettlementIds],
    derivedTurnScope: state.derivedTurnScope.snapshot(),
    latestAcceptedTurnSequence: state.latestAcceptedTurnSequence,
    queuePauseMarks: durableQueuePauseMarks(state.queuePauseMarks),
    stoppedHistoryCarried: [...state.stoppedHistoryCarried],
    queuedHandOffPlaces: [...state.queuedHandOffPlaces],
    normalizedHandOffs: [...state.normalizedHandOffs],
    queue: { revision: state.queue.revision, cards: [...state.queue.cards] },
    historyOrigin: state.historyOrigin
  } satisfies Record<Exclude<keyof JournalReducerState, 'items'>, unknown>
  return {
    stateJson: JSON.stringify(stored),
    items: [...state.items].map(([itemId, item], ordinal) => ({
      itemId,
      itemJson: JSON.stringify(item),
      ordinal
    }))
  }
}

export type JournalStateDecode = {
  item: (itemJson: string) => void
  entry: (path: string, entryJson: string) => void
  finish: () => JournalReducerState
}

/** Keep every shipped version's decoder here; future codecs migrate its decoded state forward.
 * Rows decode one at a time in storage order, so a paced reader can rest between pages. */
export function startJournalStateDecode(
  version: number,
  stateJson: string
): JournalStateDecode | null {
  if (version !== JOURNAL_STATE_CODEC_VERSION) {
    return null
  }
  const stored = scalarsV2.parse(JSON.parse(stateJson))
  const state: JournalReducerState = {
    sessionId: stored.sessionId,
    epoch: stored.epoch,
    lastSequence: stored.lastSequence,
    lastActivityAt: stored.lastActivityAt,
    oldestSequence: stored.oldestSequence,
    highestFence: stored.highestFence,
    items: new Map(),
    itemFences: new Map(),
    itemExecutionOwners: new Map(),
    providerActivityAt: new Map(),
    tombstones: new Map(),
    removedTurnIds: new Set(),
    submissions: new Map(),
    receipts: new Map(),
    aliases: new Map(),
    itemEchoes: new Map(),
    appliedSettlementIds: new Set(),
    derivedTurnScope: JournalDerivedTurnScope.restore(stored.derivedTurnScope),
    latestAcceptedTurnSequence: stored.latestAcceptedTurnSequence,
    queuePauseMarks: durableQueuePauseMarks(stored.queuePauseMarks),
    stoppedHistoryCarried: new Map(),
    queuedHandOffPlaces: new Map(),
    normalizedHandOffs: new Set(),
    queue: { revision: stored.queue.revision, cards: new Map() },
    historyOrigin: stored.historyOrigin
  }
  const collections = collectionDecoders(state)
  return {
    item: (itemJson) => {
      const item = fields.items.element.parse(JSON.parse(itemJson))
      state.items.set(item.itemId, item)
    },
    entry: (path, entryJson) => {
      const decode = collections.get(path)
      if (!decode) {
        throw new Error('unknown saved journal collection')
      }
      const entry: unknown = JSON.parse(entryJson)
      if (!Array.isArray(entry) || entry.length < 1 || entry.length > 2) {
        throw new Error('invalid saved journal entry')
      }
      decode(entry)
    },
    finish: () => state
  }
}

// Entry tuples hold [key, value] for maps and [value, value] for sets; echoes may omit an undefined value.
function collectionDecoders(state: JournalReducerState): Map<string, (entry: unknown[]) => void> {
  const map =
    <K, V>(target: Map<K, V>, schema: z.ZodType<[K, V]>) =>
    (entry: unknown[]): void => {
      const [key, value] = schema.parse(entry)
      target.set(key, value)
    }
  const set =
    <T>(target: Set<T>, schema: z.ZodType<T>) =>
    (entry: unknown[]): void => {
      target.add(schema.parse(entry[0]))
    }
  const decoders = {
    itemFences: map(state.itemFences, fields.itemFences.element),
    itemExecutionOwners: map(state.itemExecutionOwners, fields.itemExecutionOwners.element),
    providerActivityAt: map(state.providerActivityAt, fields.providerActivityAt.element),
    tombstones: map(state.tombstones, fields.tombstones.element),
    removedTurnIds: set(state.removedTurnIds, fields.removedTurnIds.element),
    submissions: map(state.submissions, fields.submissions.element),
    receipts: map(state.receipts, fields.receipts.element),
    aliases: map(state.aliases, fields.aliases.element),
    itemEchoes: (entry: unknown[]): void => {
      const echo = fields.itemEchoes.element.parse(entry)
      state.itemEchoes.set(echo[0], echo[1])
    },
    appliedSettlementIds: set(state.appliedSettlementIds, fields.appliedSettlementIds.element),
    stoppedHistoryCarried: map(state.stoppedHistoryCarried, fields.stoppedHistoryCarried.element),
    queuedHandOffPlaces: map(state.queuedHandOffPlaces, fields.queuedHandOffPlaces.element),
    normalizedHandOffs: set(state.normalizedHandOffs, fields.normalizedHandOffs.element),
    'queue.cards': map(state.queue.cards, fields.queue.shape.cards.element)
  } satisfies Record<CollectionPath, (entry: unknown[]) => void>
  return new Map(Object.entries(decoders))
}
