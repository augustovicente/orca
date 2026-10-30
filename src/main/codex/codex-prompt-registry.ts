import { randomUUID } from 'node:crypto'
import {
  MAX_CODEX_PROMPT_JOURNAL_BINDINGS,
  MAX_CODEX_PROMPT_REGISTRY_BYTES,
  MAX_CODEX_PROMPT_REGISTRY_ENTRIES,
  codexPromptMatchesTurn,
  codexPromptRegistryEntryBytes,
  codexPromptTurnIdentity
} from './codex-prompt-registry-bounds'
import {
  CODEX_COMMAND_APPROVAL_METHOD,
  CODEX_USER_INPUT_METHOD,
  readCodexPendingPrompt,
  type CodexPendingPrompt
} from './codex-prompt-request'
export {
  CODEX_COMMAND_APPROVAL_METHOD,
  CODEX_FILE_CHANGE_APPROVAL_METHOD,
  CODEX_USER_INPUT_METHOD,
  CODEX_MCP_ELICITATION_METHOD,
  isCodexPromptMethod,
  type CodexPendingPrompt
} from './codex-prompt-request'

export type CodexAbandonedCommand = { threadId: string; itemId: string }
const NO_ABANDONED_COMMANDS: readonly CodexAbandonedCommand[] = []

export type CodexPromptClaim = {
  readonly itemId: string
  readonly prompt: CodexPendingPrompt
  answer?: string
}

// Callback ownership is session-local and cannot be reconstructed from the journal.
export class CodexPromptRegistry {
  private readonly registryId = randomUUID()
  private readonly byAddress = new Map<string, CodexPendingPrompt>()
  private readonly journalItemIds = new Map<string, string>()
  private readonly boundPrompts = new Map<string, CodexPendingPrompt>()
  private readonly claims = new Map<CodexPendingPrompt, CodexPromptClaim>()
  private abandonedCommands: CodexAbandonedCommand[] = []

  get sizes(): { prompts: number; journalBindings: number } {
    return { prompts: this.byAddress.size, journalBindings: this.journalItemIds.size }
  }

  get bytes(): number {
    return this.retainedPromptBytes()
  }

  register(request: {
    id: number | string
    method: string
    params: unknown
  }): CodexPendingPrompt | null {
    const prompt = readCodexPendingPrompt(request, this.registryId)
    if (!prompt) {
      return null
    }
    const promptBytes = codexPromptRegistryEntryBytes(prompt)
    if (promptBytes > MAX_CODEX_PROMPT_REGISTRY_BYTES) {
      return null
    }
    while (
      this.retainedPromptBytes() + promptBytes > MAX_CODEX_PROMPT_REGISTRY_BYTES &&
      this.byAddress.size > 0
    ) {
      const oldest = this.byAddress.values().next().value
      if (!oldest) {
        break
      }
      this.byAddress.delete(this.address(oldest.threadId, oldest.promptKey))
    }
    if (this.retainedPromptBytes() + promptBytes > MAX_CODEX_PROMPT_REGISTRY_BYTES) {
      return null
    }
    const address = this.address(prompt.threadId, prompt.promptKey)
    this.byAddress.delete(address)
    this.byAddress.set(address, prompt)
    this.trim()
    return prompt
  }

  bindJournalItemId(
    journalItemId: string,
    threadId: string,
    promptKey: string,
    turnId?: string | null
  ): void {
    if (this.journalItemIds.has(journalItemId)) {
      this.boundPrompts.delete(journalItemId)
    }
    this.journalItemIds.delete(journalItemId)
    const address = this.address(threadId, promptKey)
    const prompt = this.byAddress.get(address)
    if (!prompt) {
      return
    }
    if (prompt.turnId === null && prompt.turnIdDigest === undefined && turnId) {
      Object.assign(prompt, codexPromptTurnIdentity(turnId))
    }
    this.journalItemIds.set(journalItemId, address)
    this.boundPrompts.set(journalItemId, prompt)
    this.trim()
  }

  find(journalItemId: string): CodexPendingPrompt | null {
    const address = this.journalItemIds.get(journalItemId)
    if (address) {
      return this.boundPrompts.get(journalItemId) ?? this.byAddress.get(address) ?? null
    }
    const matches = [...this.byAddress.values()].filter(
      (prompt) => prompt.promptKey === journalItemId
    )
    return matches.length === 1 ? (matches[0] ?? null) : null
  }

  claim(journalItemId: string, kind?: 'approval' | 'question'): CodexPromptClaim | null {
    const prompt = this.find(journalItemId)
    if (!prompt || this.claims.has(prompt) || (kind && this.kind(prompt) !== kind)) {
      return null
    }
    const claim = { itemId: journalItemId, prompt }
    this.claims.set(prompt, claim)
    return claim
  }

  claimBound(journalItemId: string): CodexPromptClaim | null {
    const prompt = this.boundPrompts.get(journalItemId)
    if (!prompt || this.claims.has(prompt)) {
      return null
    }
    const claim = { itemId: journalItemId, prompt }
    this.claims.set(prompt, claim)
    return claim
  }

  ownsClaim(claim: CodexPromptClaim): boolean {
    return this.claims.get(claim.prompt) === claim && this.find(claim.itemId) === claim.prompt
  }

  releaseClaim(claim: CodexPromptClaim): void {
    if (this.claims.get(claim.prompt) === claim) {
      this.claims.delete(claim.prompt)
    }
  }

  forget(prompt: CodexPendingPrompt): void {
    this.claims.delete(prompt)
    const address = this.address(prompt.threadId, prompt.promptKey)
    if (this.byAddress.get(address) === prompt) {
      this.byAddress.delete(address)
    }
    for (const [journalItemId, boundPrompt] of this.boundPrompts) {
      if (boundPrompt === prompt) {
        this.journalItemIds.delete(journalItemId)
        this.boundPrompts.delete(journalItemId)
      }
    }
  }

  clearTurn(threadId: string, turnId: string): void {
    const prompts = new Set(
      [...this.byAddress.values(), ...this.boundPrompts.values(), ...this.claims.keys()].filter(
        (prompt) => prompt.threadId === threadId && codexPromptMatchesTurn(prompt, turnId)
      )
    )
    for (const prompt of prompts) {
      this.forget(prompt)
      // Only whole-command approvals imply no execution; approvalId targets a subcommand.
      if (
        prompt.method === CODEX_COMMAND_APPROVAL_METHOD &&
        prompt.promptKey === prompt.codexItemId
      ) {
        this.abandonedCommands.push({ threadId: prompt.threadId, itemId: prompt.codexItemId })
      }
    }
  }

  takeAbandonedCommands(): readonly CodexAbandonedCommand[] {
    if (this.abandonedCommands.length === 0) {
      return NO_ABANDONED_COMMANDS
    }
    const taken = this.abandonedCommands
    this.abandonedCommands = []
    return taken
  }

  clear(): void {
    this.byAddress.clear()
    this.journalItemIds.clear()
    this.boundPrompts.clear()
    this.claims.clear()
    this.abandonedCommands = []
  }

  private address(threadId: string, promptKey: string): string {
    return `${encodeURIComponent(threadId)}:${encodeURIComponent(promptKey)}`
  }

  private kind(prompt: CodexPendingPrompt): 'approval' | 'question' {
    return prompt.method === CODEX_USER_INPUT_METHOD ||
      (prompt.elicitation?.kind === 'form' && prompt.questionIds.length > 0)
      ? 'question'
      : 'approval'
  }

  reserveAnswer(claim: CodexPromptClaim, answer: string): boolean {
    if (
      !this.ownsClaim(claim) ||
      this.retainedPromptBytes() + Buffer.byteLength(answer, 'utf8') >
        MAX_CODEX_PROMPT_REGISTRY_BYTES
    ) {
      return false
    }
    // Count answers held across the asynchronous commit, including other requests' claims.
    claim.answer = answer
    return true
  }

  private retainedPromptBytes(): number {
    const prompts = new Set([
      ...this.byAddress.values(),
      ...this.boundPrompts.values(),
      ...this.claims.keys()
    ])
    const claimedBytes = [...this.claims.values()].reduce(
      (total, claim) => total + Buffer.byteLength(claim.answer ?? '', 'utf8'),
      0
    )
    return (
      claimedBytes +
      [...prompts].reduce((total, prompt) => total + codexPromptRegistryEntryBytes(prompt), 0)
    )
  }

  private trim(): void {
    while (this.byAddress.size > MAX_CODEX_PROMPT_REGISTRY_ENTRIES) {
      const oldest = this.byAddress.values().next().value
      if (!oldest) {
        break
      }
      this.byAddress.delete(this.address(oldest.threadId, oldest.promptKey))
    }
    while (this.journalItemIds.size > MAX_CODEX_PROMPT_JOURNAL_BINDINGS) {
      const oldest = this.journalItemIds.keys().next().value
      if (!oldest) {
        break
      }
      this.journalItemIds.delete(oldest)
      this.boundPrompts.delete(oldest)
    }
  }
}
