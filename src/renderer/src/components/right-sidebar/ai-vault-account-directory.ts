import { useAppStore } from '../../store'
import { subscribeRuntimeRpc } from '@/runtime/runtime-rpc-subscribe'
import {
  watchProviderAccounts,
  type ProviderAccountsWatcher,
  type ProviderAccountsSnapshot
} from '@/runtime/runtime-provider-accounts-client'
import type { AccountBinding, NativeAccountBinding } from './ai-vault-account-binding'
import {
  NativeAccountInputs,
  NativeAccountEvidence,
  nativeAccountDependency,
  nativeAccountLabel,
  nativeEvidenceCovers
} from './ai-vault-native-account-index'

type Entry = { binding: AccountBinding; value: string | null; listeners: Set<() => void> }
type NativeAttempt = { inputs: NativeAccountInputs; watcher?: ProviderAccountsWatcher }
type DataAttempt = { close?: () => void }
type Directory = {
  entries: Map<string, Entry>
  inputs: NativeAccountInputs
  desired: NativeAccountInputs
  evidence: NativeAccountEvidence | null
  native: NativeAttempt | null
  unwatchSettings?: () => void
  data: DataAttempt | null
  profiles: Map<string, string>
}
let directory: Directory | undefined

const nativeEntries = (owner: Directory): (Entry & { binding: NativeAccountBinding })[] =>
  [...owner.entries.values()].filter(
    (entry): entry is Entry & { binding: NativeAccountBinding } =>
      entry.binding.kind !== 'opencode' && entry.listeners.size > 0
  )
const hasData = (owner: Directory): boolean =>
  [...owner.entries.values()].some(
    (entry) => entry.binding.kind === 'opencode' && entry.listeners.size > 0
  )

function publish(owner: Directory, domain: 'native' | 'data'): void {
  const changed: Entry[] = []
  for (const entry of owner.entries.values()) {
    const binding = entry.binding
    if ((binding.kind === 'opencode') !== (domain === 'data')) {
      continue
    }
    const proof =
      binding.kind !== 'opencode' &&
      owner.evidence &&
      nativeEvidenceCovers(binding, owner.inputs, owner.evidence)
        ? owner.evidence
        : null
    const value =
      binding.kind === 'opencode'
        ? (owner.profiles.get(binding.id) ?? null)
        : nativeAccountLabel(binding, owner.inputs, proof)
    if (value !== entry.value) {
      entry.value = value
      changed.push(entry)
    }
  }
  // Establish every scalar before callbacks can synchronously acquire or mutate inputs.
  for (const entry of changed) {
    entry.listeners.forEach((notify) => notify())
  }
}

function drainNative(owner: Directory): void {
  if (directory !== owner || owner.native || nativeEntries(owner).length === 0) {
    return
  }
  const attempt: NativeAttempt = { inputs: owner.desired }
  owner.native = attempt
  const settle = (snapshot?: ProviderAccountsSnapshot): void => {
    if (directory !== owner || owner.native !== attempt) {
      return
    }
    attempt.watcher?.close()
    owner.native = null
    const evidence = snapshot ? new NativeAccountEvidence(attempt.inputs, snapshot) : null
    // A routed-home candidate first discovered by this result also needs current saved-input coverage.
    if (
      evidence &&
      nativeEntries(owner).some(
        ({ binding }) => !nativeEvidenceCovers(binding, owner.inputs, evidence)
      )
    ) {
      owner.desired = owner.inputs
    }
    if (attempt.inputs !== owner.desired) {
      drainNative(owner)
      return
    }
    owner.evidence = evidence
    publish(owner, 'native')
  }
  try {
    const watcher = watchProviderAccounts(
      { kind: 'local' },
      { onSnapshot: settle, onError: () => settle() }
    )
    if (owner.native === attempt) {
      attempt.watcher = watcher
    } else {
      watcher.close()
    }
  } catch {
    settle()
  }
}

function observeNative(owner: Directory): void {
  if (!owner.unwatchSettings) {
    owner.inputs = new NativeAccountInputs(useAppStore.getState().settings)
    owner.desired = owner.inputs
    owner.unwatchSettings = useAppStore.subscribe((state) => {
      const previous = owner.inputs
      if (
        directory !== owner ||
        (previous.settings?.claudeManagedAccounts === state.settings?.claudeManagedAccounts &&
          previous.settings?.codexManagedAccounts === state.settings?.codexManagedAccounts)
      ) {
        return
      }
      owner.inputs = new NativeAccountInputs(state.settings, previous)
      const relevant = nativeEntries(owner).some(
        ({ binding }) =>
          nativeAccountDependency(binding, previous, owner.evidence) !==
          nativeAccountDependency(binding, owner.inputs, owner.evidence)
      )
      if (relevant) {
        owner.desired = owner.inputs
        publish(owner, 'native')
        drainNative(owner)
      }
    })
  }
  const uncovered = nativeEntries(owner).some(
    ({ binding }) =>
      !owner.evidence ||
      !nativeEvidenceCovers(binding, owner.inputs, owner.evidence) ||
      (binding.kind === 'claude'
        ? owner.evidence.snapshot.failedProviders?.includes('claude')
        : owner.evidence.snapshot.failedProviders?.includes('codex'))
  )
  if (uncovered) {
    if (
      !owner.native ||
      nativeEntries(owner).some(
        ({ binding }) =>
          nativeAccountDependency(
            binding,
            owner.native?.inputs ?? owner.desired,
            owner.evidence
          ) !== nativeAccountDependency(binding, owner.inputs, owner.evidence)
      )
    ) {
      owner.desired = owner.inputs
    }
    drainNative(owner)
  }
  publish(owner, 'native')
}

function profileDirectory(frame: unknown): Map<string, string> {
  const profiles = new Map<string, string>()
  if (typeof frame !== 'object' || frame === null || !('snapshot' in frame)) {
    return profiles
  }
  const snapshot = frame.snapshot
  if (typeof snapshot !== 'object' || snapshot === null || !('opencode' in snapshot)) {
    return profiles
  }
  const data = snapshot.opencode
  if (
    typeof data !== 'object' ||
    data === null ||
    !('accounts' in data) ||
    !Array.isArray(data.accounts)
  ) {
    return profiles
  }
  for (const account of data.accounts) {
    if (
      typeof account !== 'object' ||
      account === null ||
      typeof account.id !== 'string' ||
      typeof account.label !== 'string' ||
      !account.id ||
      !account.label
    ) {
      return new Map()
    }
    if (!profiles.has(account.id)) {
      profiles.set(account.id, account.label)
    }
  }
  return profiles
}

function observeData(owner: Directory): void {
  if (owner.data) {
    return
  }
  const attempt: DataAttempt = {}
  owner.data = attempt
  const live = () => directory === owner && owner.data === attempt
  const lose = (): void => {
    if (!live()) {
      return
    }
    owner.data = null
    owner.profiles = new Map()
    attempt.close?.()
    publish(owner, 'data')
  }
  void subscribeRuntimeRpc({ kind: 'local' }, 'accounts.subscribe', null, {
    onEvent: (frame) => {
      if (!live() || typeof frame !== 'object' || frame === null || !('type' in frame)) {
        return
      }
      if (frame.type === 'end') {
        lose()
      } else if (frame.type === 'ready' || frame.type === 'snapshot') {
        owner.profiles = profileDirectory(frame)
        publish(owner, 'data')
      }
    },
    onError: lose,
    onClose: lose
  }).then((handle) => {
    if (live()) {
      attempt.close = handle.unsubscribe
    } else {
      handle.unsubscribe()
    }
  }, lose)
}

export function readSessionAccount(key: string): string | null {
  return directory?.entries.get(key)?.value ?? null
}

export function subscribeSessionAccount(
  key: string,
  binding: AccountBinding,
  listener: () => void
): () => void {
  const owner = (directory ??= {
    entries: new Map(),
    inputs: new NativeAccountInputs(null),
    desired: new NativeAccountInputs(null),
    evidence: null,
    native: null,
    data: null,
    profiles: new Map()
  })
  let entry = owner.entries.get(key)
  const newBinding = !entry
  if (!entry) {
    entry = { binding, value: null, listeners: new Set() }
    owner.entries.set(key, entry)
  }
  const held = entry
  held.listeners.add(listener)
  if (binding.kind === 'opencode') {
    observeData(owner)
    if (newBinding) {
      publish(owner, 'data')
    }
  } else if (
    newBinding ||
    (!owner.native && (!owner.evidence || owner.evidence.snapshot.failedProviders?.length))
  ) {
    observeNative(owner)
  }
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    held.listeners.delete(listener)
    queueMicrotask(() => {
      if (directory !== owner || owner.entries.get(key) !== held || held.listeners.size > 0) {
        return
      }
      owner.entries.delete(key)
      if (!hasData(owner)) {
        const attempt = owner.data
        owner.data = null
        owner.profiles.clear()
        attempt?.close?.()
      }
      if (nativeEntries(owner).length === 0) {
        const attempt = owner.native
        owner.native = null
        attempt?.watcher?.close()
        owner.unwatchSettings?.()
        owner.unwatchSettings = undefined
        owner.evidence = null
        owner.inputs = owner.desired = new NativeAccountInputs(null)
      }
      if (owner.entries.size === 0) {
        directory = undefined
      }
    })
  }
}
