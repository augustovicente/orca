import { z } from 'zod'
import type { AgentJournalQuestionItem } from '../../shared/agent-session-journal-types'
import { MAX_JOURNAL_PROMPT_OPTIONS } from '../native-chat/agent-session-journal/journal-prompt-body-bounds'
import { readRecord } from './codex-item-field-readers'
import {
  CODEX_PROMPT_MAX_QUESTIONS,
  CODEX_PROMPT_MAX_QUESTION_BYTES,
  encodeCodexJournalQuestionOptionId
} from './codex-prompt-registry-bounds'

const base = { title: z.string().optional(), description: z.string().optional() }
const fieldSchema = z.union([
  z.strictObject({
    ...base,
    type: z.literal('string'),
    enum: z.array(z.string()).min(1),
    enumNames: z.array(z.string()).optional(),
    default: z.string().optional()
  }),
  z.strictObject({
    ...base,
    type: z.literal('string'),
    oneOf: z.array(z.strictObject({ const: z.string(), title: z.string() })).min(1),
    default: z.string().optional()
  }),
  z.strictObject({
    ...base,
    type: z.literal('string'),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    format: z.enum(['email', 'uri', 'date', 'date-time']).optional(),
    default: z.string().optional()
  }),
  z.strictObject({
    ...base,
    type: z.enum(['number', 'integer']),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    default: z.number().optional()
  }),
  z.strictObject({ ...base, type: z.literal('boolean'), default: z.boolean().optional() })
])
const formSchema = z.strictObject({
  $schema: z.string().optional(),
  type: z.literal('object'),
  properties: z.record(z.string(), fieldSchema),
  required: z.array(z.string()).optional()
})
const urlSchema = z.url({ protocol: /^https?$/ }).max(8192)

export type CodexMcpFormField = {
  name: string
  required: boolean
  schema: z.infer<typeof fieldSchema>
}
export type CodexMcpElicitation =
  | { kind: 'url'; message: string; url: string }
  | { kind: 'form'; message: string; fields: CodexMcpFormField[] }

function fieldChoices(field: CodexMcpFormField): { label: string; value: string | boolean }[] {
  const schema = field.schema
  if ('enum' in schema) {
    return schema.enum.map((value, index) => ({ label: schema.enumNames?.[index] ?? value, value }))
  }
  if ('oneOf' in schema) {
    return schema.oneOf.map((option) => ({ label: option.title, value: option.const }))
  }
  return schema.type === 'boolean'
    ? [
        { label: 'Yes', value: true },
        { label: 'No', value: false }
      ]
    : []
}

function optionId(field: CodexMcpFormField, token: string): string {
  return encodeCodexJournalQuestionOptionId(field.name, token)
}

export function codexMcpFieldOptions(field: CodexMcpFormField) {
  const choices = fieldChoices(field).map((choice, index) => ({
    id: optionId(field, `value:${index}`),
    label: choice.label
  }))
  if (
    field.schema.type === 'string' &&
    fieldChoices(field).length === 0 &&
    (!('minLength' in field.schema) || !field.schema.minLength)
  ) {
    choices.push({ id: optionId(field, 'empty'), label: 'Use empty text' })
  }
  if (!field.required) {
    choices.push({ id: optionId(field, 'skip'), label: 'Skip this field' })
  }
  return [
    ...choices,
    { id: optionId(field, 'decline'), label: 'Decline request' },
    { id: optionId(field, 'cancel'), label: 'Cancel request' }
  ]
}

function validateFieldValue(field: CodexMcpFormField, value: unknown): void {
  const schema = field.schema
  const choices = fieldChoices(field)
  if (choices.length > 0) {
    if (!choices.some((choice) => choice.value === value)) {
      throw new Error('Choose an offered value.')
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') {
      throw new Error('Enter text.')
    }
    const length = [...value].length
    if ('minLength' in schema && schema.minLength !== undefined && length < schema.minLength) {
      throw new Error(`Enter at least ${schema.minLength} characters.`)
    }
    if ('maxLength' in schema && schema.maxLength !== undefined && length > schema.maxLength) {
      throw new Error(`Enter at most ${schema.maxLength} characters.`)
    }
    if ('format' in schema && schema.format) {
      const formats = {
        email: z.email(),
        uri: z.url(),
        date: z.iso.date(),
        'date-time': z.iso.datetime({ offset: true })
      }
      if (!formats[schema.format].safeParse(value).success) {
        throw new Error(`Enter a valid ${schema.format} value.`)
      }
    }
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('Enter a finite number.')
    }
    if (schema.type === 'integer' && !Number.isSafeInteger(value)) {
      throw new Error('Enter a whole number within the supported range.')
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new Error(`Enter a value of at least ${schema.minimum}.`)
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      throw new Error(`Enter a value of at most ${schema.maximum}.`)
    }
  }
}

/** Validate the whole form before exposing any field; partial schemas cannot be answered safely. */
export function readCodexMcpElicitation(params: unknown): CodexMcpElicitation | null {
  const record = readRecord(params)
  const message = typeof record.message === 'string' ? record.message : 'Codex needs information'
  if (Buffer.byteLength(message, 'utf8') > 8192) {
    return null
  }
  if (record.mode === 'url') {
    const url = urlSchema.safeParse(record.url)
    return url.success &&
      typeof record.elicitationId === 'string' &&
      record.elicitationId.length > 0
      ? { kind: 'url', message, url: url.data }
      : null
  }
  if (record.mode !== 'form') {
    return null
  }
  const parsed = formSchema.safeParse(record.requestedSchema)
  if (!parsed.success) {
    return null
  }
  const required = parsed.data.required ?? []
  if (required.some((name) => !Object.hasOwn(parsed.data.properties, name))) {
    return null
  }
  const fields = Object.entries(parsed.data.properties).map(([name, schema]) => ({
    name,
    schema,
    required: required.includes(name)
  }))
  const result: CodexMcpElicitation = { kind: 'form', message, fields }
  if (
    fields.length > CODEX_PROMPT_MAX_QUESTIONS ||
    Buffer.byteLength(JSON.stringify(result), 'utf8') > CODEX_PROMPT_MAX_QUESTION_BYTES
  ) {
    return null
  }
  try {
    for (const field of fields) {
      const schema = field.schema
      const choices = fieldChoices(field)
      if (
        !field.name ||
        field.name === '__proto__' ||
        Buffer.byteLength(field.name, 'utf8') > 256 ||
        codexMcpFieldOptions(field).length > MAX_JOURNAL_PROMPT_OPTIONS ||
        choices.some((choice) => Buffer.byteLength(choice.label, 'utf8') > 1024) ||
        new Set(choices.map((choice) => choice.value)).size !== choices.length ||
        ('enumNames' in schema && schema.enumNames && schema.enumNames.length !== choices.length) ||
        ('minimum' in schema &&
          schema.minimum !== undefined &&
          schema.maximum !== undefined &&
          schema.minimum > schema.maximum) ||
        ('minLength' in schema &&
          schema.minLength !== undefined &&
          schema.maxLength !== undefined &&
          schema.minLength > schema.maxLength)
      ) {
        return null
      }
      if (schema.default !== undefined) {
        validateFieldValue(field, schema.default)
      }
    }
  } catch {
    return null
  }
  return result
}

export function codexMcpFieldQuestion(
  field: CodexMcpFormField,
  message: string
): AgentJournalQuestionItem {
  const schema = field.schema
  const freeText = fieldChoices(field).length === 0
  return {
    kind: 'question',
    question: [message, schema.title ?? field.name, schema.description]
      .filter(Boolean)
      .join('\n\n'),
    options: codexMcpFieldOptions(field),
    ...(freeText
      ? {
          freeTextQuestionId: field.name,
          freeTextInput: {
            allowEmpty: schema.type === 'string',
            placeholder: schema.type === 'string' ? 'Enter text' : 'Enter a number',
            ...(schema.default === undefined ? {} : { initialValue: String(schema.default) })
          }
        }
      : {}),
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
}

export type CodexMcpFieldAnswer =
  | { kind: 'decision'; decision: 'decline' | 'cancel' }
  | { kind: 'answer'; questionId: string; answer: string }

/** Choice tokens select schema values; literal text can never become a request decision. */
export function prepareCodexMcpFieldAnswer(
  field: CodexMcpFormField,
  input: { optionIds: string[]; other?: string }
): CodexMcpFieldAnswer {
  const selected = input.optionIds[0]
  if (input.optionIds.length > 1 || (selected !== undefined && input.other !== undefined)) {
    throw new Error('Choose one value.')
  }
  for (const decision of ['decline', 'cancel'] as const) {
    if (selected === optionId(field, decision)) {
      return { kind: 'decision', decision }
    }
  }
  if (!field.required && selected === optionId(field, 'skip')) {
    return { kind: 'answer', questionId: field.name, answer: '' }
  }
  const choices = fieldChoices(field)
  const choice = choices.find((_, index) => selected === optionId(field, `value:${index}`))
  let value: unknown = choice?.value
  if (
    selected === optionId(field, 'empty') &&
    codexMcpFieldOptions(field).some((o) => o.id === selected)
  ) {
    value = ''
  } else if (selected === undefined && choices.length === 0 && input.other !== undefined) {
    value = input.other
    if (field.schema.type !== 'string') {
      if (!input.other.trim()) {
        throw new Error('Enter a number.')
      }
      try {
        value = JSON.parse(input.other)
      } catch {
        throw new Error('Enter a number.')
      }
    }
  } else if (!choice) {
    throw new Error('Choose an offered value.')
  }
  validateFieldValue(field, value)
  return { kind: 'answer', questionId: field.name, answer: JSON.stringify(value) }
}
