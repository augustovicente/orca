import {
  openHandoffFactBuffer,
  bufferHandoffFactBatch,
  drainHandoffFactBuffer,
  resetHandoffFacts
} from './terminal-handoff-facts'
import { resetTerminalSideEffectAuthorityForTest } from './terminal-side-effect-authority'
export { isMainTerminalSideEffectAuthorityForPty } from './terminal-side-effect-authority'
import {
  attachResidentConsumer,
  type ConsumerEntry,
  type TerminalSideEffectFactConsumerOptions
} from './terminal-side-effect-consumer'
export type {
  TerminalSideEffectFactConsumerCallbacks,
  TerminalSideEffectFactConsumerOptions
} from './terminal-side-effect-consumer'
import { useAppStore } from '@/store'
import { isProvenProcessExit } from '../../../../shared/terminal-exit-cause'
import { deferPtyShutdownExit } from './pty-shutdown-exit-deferral'
import { createTerminalResidentPolicy } from './terminal-resident-policy'
import { resolveTerminalResidentBinding } from './terminal-resident-binding'
import { subscribeToPtyData } from './pty-data-sidecar-subscriptions'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { getPtyExecutionHost } from '../../../../shared/terminal-execution-host'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { subscribeResidentRemoteSource } from './terminal-resident-remote-source'
import { onRuntimeEnvironmentsRetired } from '@/runtime/runtime-environment-revision'
import type { TerminalResidentBinding, TerminalResidentServices } from './terminal-resident-policy'

import {
  sourceSubscriptionsByPtyId,
  residentRegistry,
  residentsByPtyId,
  legacySourcesByPtyId,
  disposeLegacySource,
  retireCapturedResident,
  type TerminalSemanticResident
} from './terminal-semantic-residents'
export {
  getTerminalSemanticResident,
  retireTerminalSemanticResident,
  retireTerminalSemanticResidentsForTab,
  type TerminalSemanticResident
} from './terminal-semantic-residents'

export function admitLegacyTerminalSemanticResident(options: {
  ptyId: string
  incarnationId?: string | null
  binding: TerminalResidentBinding
  byteSource: boolean
  services?: TerminalResidentServices
}): TerminalSemanticResident {
  const existing = residentsByPtyId.get(options.ptyId)
  const sameExecution =
    existing &&
    (!options.incarnationId || existing.identity.incarnationId === options.incarnationId)
  if (sameExecution && existing.identity.runtimeId !== null) {
    return existing
  }
  const paired = parseRemoteRuntimePtyId(options.ptyId)
  const identity = {
    endpoint: paired?.environmentId ?? 'local',
    executionHost:
      options.binding.workspaceOwner?.executionHostId ??
      getPtyExecutionHost(options.ptyId) ??
      'local',
    runtimeId: null,
    ptyId: options.ptyId,
    incarnationId: options.incarnationId ?? null
  }
  const resident = sameExecution
    ? existing
    : residentRegistry.admit(identity, (captured) =>
        createTerminalResidentPolicy(
          options.binding,
          captured.identity,
          () => captured.isLive,
          options.services
        )
      )
  residentsByPtyId.set(options.ptyId, resident)
  if (!sameExecution) {
    resident.policy.legacySource.byteSource = options.byteSource
  }
  drainHandoffFactBuffer(options.ptyId, resident)
  let legacy = legacySourcesByPtyId.get(options.ptyId)
  if (!legacy || legacy.resident !== resident) {
    disposeLegacySource(options.ptyId)
    legacy = { resident, source: resident.policy.legacySource }
    legacySourcesByPtyId.set(options.ptyId, legacy)
  }
  if (options.byteSource && !legacy.unsubscribe) {
    legacy.unsubscribe = paired
      ? undefined
      : subscribeToPtyData(options.ptyId, (data, meta) => {
          resident.policy.observeLegacyData(data, meta)
        })
  }
  for (const entry of consumersByPtyId.get(options.ptyId) ?? []) {
    attachResidentConsumer(entry, resident)
  }
  return resident
}

export function admitRemoteTerminalSemanticResident(
  options: Parameters<typeof admitLegacyTerminalSemanticResident>[0]
): void {
  if (residentsByPtyId.has(options.ptyId) || sourceSubscriptionsByPtyId.has(options.ptyId)) {
    return
  }
  const source: { close?: () => void } = {}
  sourceSubscriptionsByPtyId.set(options.ptyId, source)
  // The named stream's actual acknowledgement admits E before its first live callback.
  source.close = subscribeResidentRemoteSource(options.ptyId, (result) =>
    admitLegacyTerminalSemanticResident({
      ...options,
      incarnationId: result?.incarnationId,
      byteSource: false
    })
  )
}

onRuntimeEnvironmentsRetired((environmentIds) => {
  for (const resident of residentsByPtyId.values()) {
    if (environmentIds.includes(resident.identity.endpoint)) {
      retireCapturedResident(resident)
    }
  }
})

export function observeTerminalSemanticResidentExit(
  ptyId: string,
  code: number,
  incarnationId?: string
): void {
  const resident = residentsByPtyId.get(ptyId)
  if (
    !resident ||
    !isProvenProcessExit(code) ||
    (incarnationId !== undefined && resident.identity.incarnationId !== incarnationId)
  ) {
    return
  }
  if (useAppStore.getState().isPtyShutdownPending(ptyId)) {
    deferPtyShutdownExit(ptyId, (settlement) => {
      if (settlement === 'committed') {
        retireCapturedResident(resident)
      }
    })
    return
  }
  retireCapturedResident(resident)
}

import type { TerminalSideEffectBatch } from '../../../../shared/terminal-side-effect-facts'

const consumersByPtyId = new Map<string, Set<ConsumerEntry>>()
let channelUnsubscribe: (() => void) | null = null

export function dispatchTerminalSideEffectBatch(batch: TerminalSideEffectBatch): void {
  const entries = consumersByPtyId.get(batch.ptyId)
  const entry = entries?.values().next().value
  if (!batch.terminalState && legacySourcesByPtyId.get(batch.ptyId)?.source.byteSource) {
    return
  }
  if (batch.terminalState && batch.paneKey && batch.tabId && batch.worktreeId) {
    const { paneKey, tabId, worktreeId } = batch
    const paired = parseRemoteRuntimePtyId(batch.ptyId)
    const identity = {
      endpoint: paired?.environmentId ?? 'local',
      executionHost: batch.connectionId
        ? toSshExecutionHostId(batch.connectionId)
        : (getPtyExecutionHost(batch.ptyId) ?? 'local'),
      ptyId: batch.ptyId,
      runtimeId: batch.terminalState.runtimeId,
      incarnationId: batch.terminalState.incarnationId
    }
    const resident = residentRegistry.admit(identity, (captured) =>
      createTerminalResidentPolicy(
        resolveTerminalResidentBinding({
          ...batch,
          paneKey,
          tabId,
          worktreeId,
          binding: entry?.binding
        }),
        captured.identity,
        () => captured.isLive,
        entry?.services
      )
    )
    if (!resident.admitIdentity(identity)) {
      return
    }
    resident.policy.bindPty(identity.ptyId, identity.incarnationId, identity.runtimeId)
    drainHandoffFactBuffer(batch.ptyId, resident)
    disposeLegacySource(batch.ptyId)
    residentsByPtyId.set(batch.ptyId, resident)
    for (const consumer of entries ?? []) {
      attachResidentConsumer(consumer, resident)
    }
    resident.consume(batch)
    return
  }
  const resident = residentsByPtyId.get(batch.ptyId)
  if (resident) {
    if (batch.terminalState) {
      if (
        resident.admitIdentity({
          ...resident.identity,
          runtimeId: batch.terminalState.runtimeId,
          incarnationId: batch.terminalState.incarnationId
        })
      ) {
        resident.consume(batch)
      }
    } else {
      resident.policy.legacySource.observeFacts(batch)
    }
    return
  }
  bufferHandoffFactBatch(batch)
}

function ensureSideEffectChannelSubscription(): void {
  if (channelUnsubscribe !== null) {
    return
  }
  // Why: optional-chained from globalThis so unit tests (and any non-preload
  // surface) without window.api degrade to "no channel" instead of throwing.
  const onSideEffect = (globalThis as { window?: Window }).window?.api?.pty?.onSideEffect
  if (typeof onSideEffect !== 'function') {
    return
  }
  channelUnsubscribe = onSideEffect(dispatchTerminalSideEffectBatch)
}

/** Presentation registrations attach to the source-selected execution; they never construct policy. */
export function registerTerminalSideEffectFactConsumer(
  options: TerminalSideEffectFactConsumerOptions
): () => void {
  ensureSideEffectChannelSubscription()
  const entry: ConsumerEntry = {
    binding: options.binding,
    services: options.services,
    onResident: options.onResident
  }
  let entries = consumersByPtyId.get(options.ptyId)
  if (!entries) {
    entries = new Set()
    consumersByPtyId.set(options.ptyId, entries)
  }
  entries.add(entry)
  const resident = residentsByPtyId.get(options.ptyId)
  if (resident) {
    attachResidentConsumer(entry, resident)
  } else {
    openHandoffFactBuffer(options.ptyId, entry.binding, true)
  }
  if (options.restoreTitleOnRegister) {
    const getSnapshot = globalThis.window?.api?.pty?.getSideEffectSnapshot
    if (typeof getSnapshot === 'function') {
      // Only this captured execution may receive the eventual baseline.
      void getSnapshot(options.ptyId)
        .then((batch) => {
          if (batch && resident?.isLive && entries.has(entry) && entry.resident === resident) {
            if (batch.terminalState) {
              resident.consume({ ...batch, replay: true })
            } else {
              resident.policy.legacySource.observeFacts({ ...batch, replay: true })
            }
          }
        })
        .catch(() => {})
    }
  }
  return () => {
    if (!entries.delete(entry)) {
      return
    }
    entry.detachPresentation?.()
    if (entries.size === 0 && consumersByPtyId.get(options.ptyId) === entries) {
      consumersByPtyId.delete(options.ptyId)
      if (!residentsByPtyId.has(options.ptyId)) {
        openHandoffFactBuffer(options.ptyId, entry.binding)
      }
    }
  }
}

/** Test seam: deliver a batch as if it arrived on the channel. */
export function _dispatchTerminalSideEffectBatchForTest(batch: TerminalSideEffectBatch): void {
  dispatchTerminalSideEffectBatch(batch)
}

/** Test seam: reset module state between tests. */
export function _resetTerminalSideEffectFactConsumersForTest(): void {
  for (const entries of consumersByPtyId.values()) {
    for (const entry of entries) {
      entry.detachPresentation?.()
    }
  }
  consumersByPtyId.clear()
  resetHandoffFacts()
  residentRegistry.dispose()
  for (const source of sourceSubscriptionsByPtyId.values()) {
    source.close?.()
  }
  sourceSubscriptionsByPtyId.clear()
  residentsByPtyId.clear()
  for (const ptyId of legacySourcesByPtyId.keys()) {
    disposeLegacySource(ptyId)
  }
  channelUnsubscribe?.()
  channelUnsubscribe = null
  resetTerminalSideEffectAuthorityForTest()
}
