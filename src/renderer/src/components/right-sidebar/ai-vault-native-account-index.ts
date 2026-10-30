import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type {
  ClaudeManagedAccountSummary,
  CodexManagedAccountSummary
} from '../../../../shared/managed-account-types'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import {
  getCodexAccountDisplayLabel,
  normalizeCodexAccountEmail
} from '@/lib/codex-account-display-label'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import { accountRuntimeScope, type NativeAccountBinding } from './ai-vault-account-binding'

export type SessionAccountSettings = Pick<
  GlobalSettings,
  'claudeManagedAccounts' | 'codexManagedAccounts'
>
type Saved = {
  id: string
  email: string
  workspaceLabel?: string | null
  scope: string
  paths: string[]
  proof: string
  updatedAt: number
}
const address = (scope: string, path: string): string => JSON.stringify([scope, path])
const emailGroup = (scope: string, email: string): string =>
  address(scope, normalizeCodexAccountEmail(email))
function first<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (!map.has(key)) {
    map.set(key, value)
  }
}
function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const entries = map.get(key)
  if (entries) {
    entries.push(value)
  } else {
    map.set(key, [value])
  }
}

class SavedIndex {
  readonly paths = new Map<string, Saved>()
  readonly ids = new Map<string, Saved[]>()
  readonly groups = new Map<string, Saved[]>()
  readonly topology = new Map<string, string>()
  constructor(settings: SessionAccountSettings | null, kind: 'claude' | 'codex') {
    const topology = new Map<string, unknown[]>()
    for (const account of (kind === 'claude'
      ? settings?.claudeManagedAccounts
      : settings?.codexManagedAccounts) ?? []) {
      const claude = 'managedAuthPath' in account
      const scope = accountRuntimeScope(
        claude ? account.managedAuthRuntime : account.managedHomeRuntime,
        account.wslDistro
      )
      const paths = [
        claude ? account.managedAuthPath : account.managedHomePath,
        claude ? account.wslLinuxAuthPath : account.wslLinuxHomePath
      ]
        .filter((path): path is string => !!path)
        .map(normalizeRuntimePathForComparison)
      const workspaceLabel = 'workspaceLabel' in account ? account.workspaceLabel : undefined
      const saved: Saved = {
        id: account.id,
        email: account.email,
        workspaceLabel,
        scope,
        paths,
        updatedAt: account.updatedAt,
        proof: JSON.stringify([
          account.id,
          scope,
          paths,
          account.email,
          workspaceLabel,
          account.lastAuthenticatedAt,
          claude ? account.authMethod : account.providerAccountId,
          claude ? account.organizationUuid : account.workspaceAccountId
        ])
      }
      for (const path of paths) {
        first(this.paths, address(scope, path), saved)
      }
      append(this.ids, account.id, saved)
      append(this.groups, emailGroup(scope, account.email), saved)
      append(topology, scope, [account.id, paths])
    }
    for (const [scope, entries] of topology) {
      this.topology.set(scope, JSON.stringify(entries.map((entry) => JSON.stringify(entry)).sort()))
    }
  }
}

export class NativeAccountInputs {
  readonly claude: SavedIndex
  readonly codex: SavedIndex
  constructor(
    readonly settings: SessionAccountSettings | null,
    previous?: NativeAccountInputs
  ) {
    this.claude =
      previous?.settings?.claudeManagedAccounts === settings?.claudeManagedAccounts && previous
        ? previous.claude
        : new SavedIndex(settings, 'claude')
    this.codex =
      previous?.settings?.codexManagedAccounts === settings?.codexManagedAccounts && previous
        ? previous.codex
        : new SavedIndex(settings, 'codex')
  }
}

export class NativeAccountEvidence {
  readonly claudeHomes = new Map<string, ClaudeManagedAccountSummary>()
  readonly claudeCollisions = new Map<string, ClaudeManagedAccountSummary[]>()
  readonly claudeIdCollisions = new Map<string, ClaudeManagedAccountSummary[]>()
  readonly claudeIds = new Map<string, ClaudeManagedAccountSummary>()
  readonly codexCollisions = new Map<string, CodexManagedAccountSummary[]>()
  readonly codexIds = new Map<string, CodexManagedAccountSummary>()
  readonly codexGroups = new Map<string, CodexManagedAccountSummary[]>()
  constructor(
    readonly inputs: NativeAccountInputs,
    readonly snapshot: Partial<ProviderAccountsSnapshot>
  ) {
    if (!snapshot.failedProviders?.includes('claude')) {
      for (const account of snapshot.claude?.accounts ?? []) {
        first(this.claudeIds, account.id, account)
        append(this.claudeIdCollisions, account.id, account)
        if (account.home) {
          const key = address(
            accountRuntimeScope(account.managedAuthRuntime, account.wslDistro),
            normalizeRuntimePathForComparison(account.home)
          )
          first(this.claudeHomes, key, account)
          append(this.claudeCollisions, key, account)
        }
      }
    }
    if (!snapshot.failedProviders?.includes('codex')) {
      for (const account of snapshot.codex?.accounts ?? []) {
        const scope = accountRuntimeScope(account.managedHomeRuntime, account.wslDistro)
        first(this.codexIds, address(scope, account.id), account)
        append(this.codexCollisions, address(scope, account.id), account)
        append(this.codexGroups, emailGroup(scope, account.email), account)
      }
    }
  }
}

// Compare saved-input coverage before IO; summaries identify routed-home and email-group dependencies.
export function nativeAccountDependency(
  binding: NativeAccountBinding,
  inputs: NativeAccountInputs,
  evidence: NativeAccountEvidence | null
): string {
  const index = inputs[binding.kind]
  const key = address(binding.scope, binding.path)
  const saved = index.paths.get(key)
  if (binding.kind === 'claude') {
    const current = evidence?.claudeHomes.get(key)
    const collisions = evidence?.claudeCollisions.get(key) ?? []
    const candidates = current
      ? index.ids.get(current.id)
      : saved
        ? index.ids.get(saved.id)
        : undefined
    const idCollisions = saved ? (evidence?.claudeIdCollisions.get(saved.id) ?? []) : []
    return JSON.stringify([
      index.topology.get(binding.scope),
      saved?.proof,
      candidates?.map((entry) => entry.proof),
      !current && idCollisions.length > 1
        ? index.ids.get(saved!.id)?.map((entry) => entry.updatedAt)
        : null,
      collisions.length > 1
        ? collisions.map((entry) => index.ids.get(entry.id)?.map((saved) => saved.updatedAt))
        : null
    ])
  }
  if (!saved) {
    return JSON.stringify([index.topology.get(binding.scope)])
  }
  const current = evidence?.codexIds.get(address(binding.scope, saved.id))
  const emails = new Set([saved.email, current?.email].map(normalizeCodexAccountEmail))
  const collisions = evidence?.codexCollisions.get(address(binding.scope, saved.id)) ?? []
  const livePeers =
    evidence?.codexGroups.get(emailGroup(binding.scope, current?.email ?? saved.email)) ?? []
  return JSON.stringify([
    saved.proof,
    livePeers
      .map((peer) =>
        index.ids
          .get(peer.id)
          ?.filter((entry) => entry.scope === binding.scope)
          .map((entry) => entry.proof)
      )
      .sort(),
    collisions.length > 1 ? index.ids.get(saved.id)?.map((entry) => entry.updatedAt) : null,
    [...emails].map((email) =>
      index.groups
        .get(emailGroup(binding.scope, email))
        ?.map((entry) => entry.proof)
        .sort()
    )
  ])
}

export function nativeEvidenceCovers(
  binding: NativeAccountBinding,
  inputs: NativeAccountInputs,
  evidence: NativeAccountEvidence
): boolean {
  return (
    nativeAccountDependency(binding, inputs, evidence) ===
    nativeAccountDependency(binding, evidence.inputs, evidence)
  )
}

export function nativeAccountLabel(
  binding: NativeAccountBinding,
  inputs: NativeAccountInputs,
  evidence: NativeAccountEvidence | null
): string | null {
  const key = address(binding.scope, binding.path)
  const saved = inputs[binding.kind].paths.get(key)
  if (binding.kind === 'claude') {
    if (!evidence?.snapshot.claude || evidence.snapshot.failedProviders?.includes('claude')) {
      return null
    }
    const current = evidence.claudeHomes.get(key)
    if (current) {
      return current.email
    }
    const summary = saved ? evidence.claudeIds.get(saved.id) : undefined
    return !summary ||
      (summary.home && normalizeRuntimePathForComparison(summary.home) !== binding.path)
      ? null
      : summary.email
  }
  if (!saved) {
    return null
  }
  const current = evidence?.codexIds.get(address(binding.scope, saved.id)) ?? saved
  const group = evidence?.snapshot.codex
    ? (evidence.codexGroups.get(emailGroup(binding.scope, current.email)) ?? [])
    : (inputs.codex.groups.get(emailGroup(binding.scope, current.email)) ?? [])
  return getCodexAccountDisplayLabel(current, group)
}
