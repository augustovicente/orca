import { resetTerminalSideEffectAuthorityForTest } from './terminal-side-effect-authority'
export { isMainTerminalSideEffectAuthorityForPty } from './terminal-side-effect-authority'
import {
  applyBatchToConsumer,
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
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { getPtyExecutionHost } from '../../../../shared/terminal-execution-host'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import {
  remoteTerminalNeedsLegacySource,
  subscribeResidentRemoteSource
} from './terminal-resident-remote-source'
import { onRuntimeEnvironmentsRetired } from '@/runtime/runtime-environment-revision'
import type { TerminalResidentBinding, TerminalResidentServices } from './terminal-resident-policy'

import {
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
  policy?: ReturnType<typeof createTerminalResidentPolicy>
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
        options.policy?.bindPty(captured.identity.ptyId, captured.identity.incarnationId)
          ? options.policy
          : createTerminalResidentPolicy(
              options.binding,
              captured.identity,
              () => captured.isLive,
              options.services
            )
      )
  residentsByPtyId.set(options.ptyId, resident)
  if (!sameExecution && !paired) {
    resident.policy.legacySource.byteSource = options.byteSource
  }
  let legacy = legacySourcesByPtyId.get(options.ptyId)
  if (!legacy || legacy.resident !== resident) {
    disposeLegacySource(options.ptyId)
    legacy = { resident, source: resident.policy.legacySource }
    legacySourcesByPtyId.set(options.ptyId, legacy)
  }
  if (options.byteSource && !legacy.unsubscribe) {
    legacy.unsubscribe = paired
      ? subscribeResidentRemoteSource(resident)
      : subscribeToPtyData(options.ptyId, (data, meta) => {
          resident.policy.observeLegacyData(data, meta)
        })
  }
  const entry = consumersByPtyId.get(options.ptyId)
  if (entry) {
    attachResidentConsumer(entry, resident)
  }
  return resident
}

export async function admitRemoteTerminalSemanticResident(
  options: Parameters<typeof admitLegacyTerminalSemanticResident>[0]
): Promise<void> {
  const resident = admitLegacyTerminalSemanticResident({ ...options, byteSource: false })
  try {
    if (!(await remoteTerminalNeedsLegacySource(options.ptyId))) {
      return
    }
    if (
      !resident.isLive ||
      residentsByPtyId.get(options.ptyId) !== resident ||
      resident.identity.runtimeId
    ) {
      return
    }
    admitLegacyTerminalSemanticResident({ ...options, byteSource: true })
  } catch (error) {
    console.warn('[terminal-status] Could not observe remote terminal:', error)
  }
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

const consumersByPtyId = new Map<string, ConsumerEntry>()
let channelUnsubscribe: (() => void) | null = null

export function dispatchTerminalSideEffectBatch(batch: TerminalSideEffectBatch): void {
  const entry = consumersByPtyId.get(batch.ptyId)
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
      entry?.policy?.bindPty(captured.identity.ptyId, captured.identity.incarnationId)
        ? entry.policy
        : createTerminalResidentPolicy(
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
    resident.policy.bindPty(identity.ptyId, identity.incarnationId, identity.runtimeId)
    disposeLegacySource(batch.ptyId)
    residentsByPtyId.set(batch.ptyId, resident)
    if (entry) {
      attachResidentConsumer(entry, resident)
    }
    resident.consume(batch)
    return
  }
  let resident = residentsByPtyId.get(batch.ptyId)
  const binding =
    batch.paneKey && batch.worktreeId && batch.tabId
      ? resolveTerminalResidentBinding({
          ...batch,
          paneKey: batch.paneKey,
          worktreeId: batch.worktreeId,
          tabId: batch.tabId,
          binding: entry?.binding
        })
      : entry?.binding
  if (!resident && binding) {
    resident = admitLegacyTerminalSemanticResident({
      ptyId: batch.ptyId,
      binding,
      byteSource: false,
      policy: entry?.policy,
      services: entry?.services
    })
  }
  const legacy = legacySourcesByPtyId.get(batch.ptyId)
  if (resident && legacy) {
    if (entry) {
      attachResidentConsumer(entry, resident)
    }
    legacy.source.observeFacts(batch)
    return
  }
  if (entry) {
    applyBatchToConsumer(entry, batch)
  }
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

/**
 * Register the single fact consumer for a PTY. A new registration replaces a
 * stale one for the same PTY (same semantics as the parked watcher registry):
 * two consumers would double-fire bell/completion policy for the same bytes.
 */
export function registerTerminalSideEffectFactConsumer(
  options: TerminalSideEffectFactConsumerOptions
): () => void {
  ensureSideEffectChannelSubscription()
  const entry: ConsumerEntry = {
    binding: options.binding,
    services: options.services,
    policy: options.policy,
    callbacks: options.callbacks,
    onResident: options.onResident,
    lastLiveTitleSeq: null
  }
  consumersByPtyId.get(options.ptyId)?.detachPresentation?.()
  consumersByPtyId.set(options.ptyId, entry)
  const resident = residentsByPtyId.get(options.ptyId)
  if (resident && entry.onResident) {
    entry.resident = resident
    entry.detachPresentation = entry.onResident(resident)
    entry.callbacks = {
      ...resident.policy.callbacks,
      onPrLink: (link) => resident.policy.observePrLink(link.url)
    }
  }

  if (options.restoreTitleOnRegister) {
    const getSnapshot = (globalThis as { window?: Window }).window?.api?.pty?.getSideEffectSnapshot
    if (typeof getSnapshot === 'function') {
      void getSnapshot(options.ptyId)
        .then((batch) => {
          // Why: apply only while this registration is still the live
          // consumer; a slow snapshot must not fire into a replaced one.
          if (batch && consumersByPtyId.get(options.ptyId) === entry) {
            dispatchTerminalSideEffectBatch({ ...batch, replay: true })
          }
        })
        .catch(() => {})
    }
  }

  return () => {
    if (consumersByPtyId.get(options.ptyId) === entry) {
      consumersByPtyId.delete(options.ptyId)
      entry.detachPresentation?.()
    }
  }
}

/** Test seam: deliver a batch as if it arrived on the channel. */
export function _dispatchTerminalSideEffectBatchForTest(batch: TerminalSideEffectBatch): void {
  dispatchTerminalSideEffectBatch(batch)
}

/** Test seam: reset module state between tests. */
export function _resetTerminalSideEffectFactConsumersForTest(): void {
  for (const entry of consumersByPtyId.values()) {
    entry.detachPresentation?.()
  }
  consumersByPtyId.clear()
  residentRegistry.dispose()
  residentsByPtyId.clear()
  for (const ptyId of legacySourcesByPtyId.keys()) {
    disposeLegacySource(ptyId)
  }
  channelUnsubscribe?.()
  channelUnsubscribe = null
  resetTerminalSideEffectAuthorityForTest()
}
