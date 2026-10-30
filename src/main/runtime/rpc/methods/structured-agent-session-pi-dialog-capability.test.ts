import { RuntimeSubscriptionRegistry } from '../../runtime-subscription-registry'
import { RuntimeClientCapabilities } from '../runtime-client-capabilities'
import { foldAgentSessionStatusEvent } from '../../../../shared/agent-session-status-snapshot-fold'
import type { AgentSessionStatusEvent } from '../../../../shared/agent-session-wire'
import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY,
  AGENT_SESSION_TURN_ITEM_CAPABILITY,
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY,
  SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import { remoteRuntimeClientCapabilities } from '../../../../shared/remote-runtime/remote-runtime-client-capabilities'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import { STRUCTURED_AGENT_RUNTIME_REGISTRATIONS } from '../../structured-agent-runtime-registrations'
import { STRUCTURED_AGENT_SESSION_AGENTS_METHODS } from './structured-agent-session-agents'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../ipc/desktop-renderer-runtime-capabilities'
import type {
  AgentSessionStatusSummary,
  AgentSessionTurnCompletion
} from '../../../../shared/agent-session-wire'
import type { AgentSessionPromptAttention } from '../../../../shared/agent-session-turn-completion-wire'
import type { StructuredAgentSessionStatusSubscriber } from '../../../native-chat/agent-session-wire/structured-agent-session-status-feed'
import type { StructuredAgentSessionTurnCompletionSubscriber } from '../../../native-chat/agent-session-wire/structured-agent-session-turn-completion-feed'
import {
  call,
  clearStructuredHostStub,
  dispatcher,
  envelope,
  hostCalls,
  installStructuredHostStub,
  runtimeCalls,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'
import {
  CLEANUP_METHODS,
  WORK_METHODS
} from './structured-agent-session-gate-classification.test-fixture'

const OLD_CLIENT = {
  ...STRUCTURED_CLIENT,
  clientCapabilities: [
    ...STRUCTURED_CLIENT.clientCapabilities,
    STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
  ]
}
const PI_CLIENT = {
  ...OLD_CLIENT,
  clientCapabilities: [...OLD_CLIENT.clientCapabilities, PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY]
}
const MOBILE_CLIENT = {
  clientKind: 'mobile' as const,
  // Mirrors the mobile transport list without importing its Expo project into this Node suite.
  clientCapabilities: remoteRuntimeClientCapabilities([
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY,
    STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY,
    CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY,
    AGENT_SESSION_TURN_ITEM_CAPABILITY,
    AGENT_LAUNCH_RUNTIME_CAPABILITY
  ])
}
const DESKTOP_CLIENT = {
  clientKind: 'runtime' as const,
  clientCapabilities: [...DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES]
}
const UNSUPPORTED = { message: expect.stringContaining('structured_agent_session_unsupported') }

beforeEach(installStructuredHostStub)
afterEach(clearStructuredHostStub)

describe('Pi dialog-shape client capability', () => {
  it('filters only Pi from the registered agent list of an older client', async () => {
    const registered = STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.map(
      ({ definition }) => definition.agent
    )
    const listing = (agents: string[]) => ({
      ok: true,
      result: { agents: agents.map((agent) => ({ agent })) }
    })
    expect(registered).toContain('pi')

    expect(
      await call('agentSession.agents', {}, OLD_CLIENT, {}, STRUCTURED_AGENT_SESSION_AGENTS_METHODS)
    ).toMatchObject(listing(registered.filter((agent) => agent !== 'pi')))
    expect(
      await call('agentSession.agents', {}, PI_CLIENT, {}, STRUCTURED_AGENT_SESSION_AGENTS_METHODS)
    ).toMatchObject(listing(registered))
  })

  it('refuses Pi create support before asking the runtime, while other agents keep their path', async () => {
    expect(
      await call(
        'agentSession.createSupport',
        { worktree: 'id:workspace-1', agent: 'pi' },
        OLD_CLIENT
      )
    ).toMatchObject({ ok: false, error: UNSUPPORTED })
    expect(runtimeCalls.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()

    expect(
      await call(
        'agentSession.createSupport',
        { worktree: 'id:workspace-1', agent: 'grok' },
        OLD_CLIENT
      )
    ).toMatchObject({ ok: true })
    expect(
      await call(
        'agentSession.createSupport',
        { worktree: 'id:workspace-1', agent: 'pi' },
        PI_CLIENT
      )
    ).toMatchObject({ ok: true })
  })

  it('refuses Pi create before resolution or attachment', async () => {
    const params = {
      envelope: envelope({
        expectedRuntimeFence: null,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.create',
          sessionId: SESSION,
          fields: { worktree: 'id:workspace-1', agent: 'pi' }
        })
      }),
      worktree: 'id:workspace-1',
      agent: 'pi'
    }
    expect(await call('agentSession.create', params, OLD_CLIENT)).toMatchObject({
      ok: false,
      error: UNSUPPORTED
    })
    expect(runtimeCalls.resolveStructuredAgentSessionCreateIntent).not.toHaveBeenCalled()
    expect(hostCalls.attach).not.toHaveBeenCalled()
    expect(await call('agentSession.create', params, PI_CLIENT)).toMatchObject({ ok: true })
  })

  it('withholds Pi journal history from a client that cannot show its dialogs', async () => {
    hostCalls.sessionAgent.mockReturnValue('pi')
    expect(
      await call('agentSession.history', { sessionId: SESSION, direction: 'tail' }, OLD_CLIENT)
    ).toMatchObject({ ok: false, error: UNSUPPORTED })
    expect(hostCalls.history).not.toHaveBeenCalled()
    expect(
      await call('agentSession.history', { sessionId: SESSION, direction: 'tail' }, PI_CLIENT)
    ).toMatchObject({ ok: true })
  })

  it.each([
    ['old D3 desktop', OLD_CLIENT],
    ['current mobile', MOBILE_CLIENT]
  ] as const)(
    'refuses Pi session reads and mutations by ID for %s before host work',
    async (_label, client) => {
      hostCalls.sessionAgent.mockReturnValue('pi')
      for (const { method, params } of WORK_METHODS) {
        if (
          method === 'agentSession.createSupport' ||
          method === 'agentSession.create' ||
          method === 'agentSession.ensure' ||
          method === 'agentSession.subscribeStatus' ||
          method === 'agentSession.reveal'
        ) {
          continue
        }
        expect(await call(method, params, client), method).toMatchObject({
          ok: false,
          error: UNSUPPORTED
        })
      }
      expect(hostCalls.send).not.toHaveBeenCalled()
      expect(hostCalls.readOptions).not.toHaveBeenCalled()
      expect(hostCalls.rewind).not.toHaveBeenCalled()
      expect(hostCalls.respondToPrompt).not.toHaveBeenCalled()
      expect(hostCalls.setOption).not.toHaveBeenCalled()
      expect(hostCalls.history).not.toHaveBeenCalled()
      expect(hostCalls.revealSession).not.toHaveBeenCalled()
      expect(await call('agentSession.modelCatalog', { agent: 'pi' }, client)).toMatchObject({
        ok: false,
        error: UNSUPPORTED
      })
      hostCalls.sessionAgent.mockReturnValue('codex')
      expect(
        await call('agentSession.modelCatalog', { agent: 'pi', sessionId: SESSION }, client)
      ).toMatchObject({ ok: false, error: UNSUPPORTED })
      hostCalls.sessionAgent.mockReturnValue('pi')
      expect(await call('agentSession.reveal', { sessionId: SESSION }, client)).toMatchObject({
        ok: true,
        result: { ok: false, refusal: { code: 'structured_agent_session_unsupported' } }
      })
      for (const [method, params] of [
        ['agentSession.commands', { sessionId: SESSION }],
        ['agentSession.conversationCommand', { envelope: envelope(), command: 'compact' }],
        ['agentSession.modelCatalog', { agent: 'codex', sessionId: SESSION }]
      ] as const) {
        expect(await call(method, params, client), method).toMatchObject({
          ok: false,
          error: UNSUPPORTED
        })
      }
      expect(hostCalls.revealSession).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['old D3 desktop', OLD_CLIENT],
    ['current mobile', MOBILE_CLIENT]
  ] as const)('keeps Pi cleanup callable for %s', async (_label, client) => {
    hostCalls.sessionAgent.mockReturnValue('pi')
    for (const { method, params } of CLEANUP_METHODS) {
      expect(await call(method, params, client), method).toMatchObject({ ok: true })
    }
    expect(hostCalls.cancel).toHaveBeenCalledOnce()
    expect(hostCalls.close).toHaveBeenCalledOnce()
  })

  it('admits current desktop Pi send, options and commands, and preserves other agents', async () => {
    hostCalls.sessionAgent.mockReturnValue('pi')
    hostCalls.readCommands = vi.fn(async () => [])
    for (const method of [
      'agentSession.send',
      'agentSession.options',
      'agentSession.commands'
    ] as const) {
      const params =
        method === 'agentSession.send'
          ? WORK_METHODS.find((entry) => entry.method === method)?.params
          : { sessionId: SESSION }
      expect(await call(method, params, DESKTOP_CLIENT), method).toMatchObject({ ok: true })
    }
    expect(hostCalls.send).toHaveBeenCalledOnce()
    expect(hostCalls.readOptions).toHaveBeenCalledOnce()
    expect(hostCalls.readCommands).toHaveBeenCalledOnce()

    hostCalls.sessionAgent.mockReturnValue('codex')
    expect(
      await call(
        'agentSession.send',
        WORK_METHODS.find((entry) => entry.method === 'agentSession.send')?.params,
        OLD_CLIENT
      )
    ).toMatchObject({ ok: true })
    expect(await call('agentSession.options', { sessionId: SESSION }, MOBILE_CLIENT)).toMatchObject(
      { ok: true }
    )
  })

  it('filters Pi status from the opening snapshot and live updates', async () => {
    const codex: AgentSessionStatusSummary = {
      sessionId: 'codex-session',
      workspaceId: 'workspace-1',
      agent: 'codex',
      status: 'idle',
      latestPrompt: 'hello',
      updatedAt: 1
    }
    const pi: AgentSessionStatusSummary = { ...codex, sessionId: SESSION, agent: 'pi' }
    hostCalls.subscribeStatus.mockImplementation(
      (subscriber: StructuredAgentSessionStatusSubscriber) => {
        subscriber.emit({ type: 'snapshot', sessions: [codex, pi] })
        subscriber.emit({ type: 'status', session: pi })
        subscriber.emit({ type: 'status', session: codex })
        subscriber.emit({ type: 'end' })
        return () => undefined
      }
    )
    for (const [client, seesPi] of [
      [OLD_CLIENT, false],
      [MOBILE_CLIENT, false],
      [DESKTOP_CLIENT, true]
    ] as const) {
      const replies: unknown[] = []
      await dispatcher().dispatchStreaming(
        {
          id: 'status-test',
          authToken: 'token',
          method: 'agentSession.subscribeStatus',
          params: null
        },
        (raw) => replies.push(JSON.parse(raw)),
        client
      )
      const serialized = JSON.stringify(replies)
      expect(serialized).toContain('codex-session')
      expect(serialized.includes(SESSION)).toBe(seesPi)
      expect(replies).toHaveLength(seesPi ? 4 : 3)
    }
  })

  it('filters Pi turn completions from the global live stream', async () => {
    hostCalls.sessionAgent.mockImplementation((sessionId: string) =>
      sessionId === SESSION ? 'pi' : 'codex'
    )
    hostCalls.subscribeTurnCompletions = vi.fn(
      (subscriber: StructuredAgentSessionTurnCompletionSubscriber) => {
        const completion: AgentSessionTurnCompletion = {
          scope: {
            executionHostId: 'local',
            wslDistro: null,
            workspaceId: 'workspace-1',
            workspaceKind: 'git-worktree' as const
          },
          sessionId: SESSION,
          turnId: 'turn-1',
          outcome: 'success' as const,
          completedAt: 1
        }
        subscriber.emit({ type: 'completion', completion })
        subscriber.emit({
          type: 'completion',
          completion: { ...completion, sessionId: 'codex-session' }
        })
        subscriber.emit({ type: 'end' })
        return () => undefined
      }
    )
    for (const [client, seesPi] of [
      [OLD_CLIENT, false],
      [DESKTOP_CLIENT, true]
    ] as const) {
      const replies: unknown[] = []
      await dispatcher().dispatchStreaming(
        {
          id: 'completion-test',
          authToken: 'token',
          method: 'agentSession.subscribeTurnCompletions',
          params: null
        },
        (raw) => replies.push(JSON.parse(raw)),
        client
      )
      const serialized = JSON.stringify(replies)
      expect(serialized).toContain('codex-session')
      expect(serialized.includes(SESSION)).toBe(seesPi)
      expect(replies).toHaveLength(seesPi ? 3 : 2)
    }
  })

  it('filters Pi prompt alerts from a client that asked for prompts', async () => {
    hostCalls.sessionAgent.mockImplementation((sessionId: string) =>
      sessionId === SESSION ? 'pi' : 'codex'
    )
    hostCalls.subscribeTurnCompletions = vi.fn(
      (subscriber: StructuredAgentSessionTurnCompletionSubscriber) => {
        const prompt: AgentSessionPromptAttention = {
          scope: {
            executionHostId: 'local',
            wslDistro: null,
            workspaceId: 'workspace-1',
            workspaceKind: 'git-worktree' as const
          },
          sessionId: SESSION,
          promptId: 'prompt-1',
          raisedAt: 1
        }
        subscriber.emit({ type: 'prompt', prompt })
        subscriber.emit({ type: 'prompt', prompt: { ...prompt, sessionId: 'codex-session' } })
        subscriber.emit({ type: 'end' })
        return () => undefined
      }
    )
    for (const [client, seesPi] of [
      [OLD_CLIENT, false],
      [DESKTOP_CLIENT, true]
    ] as const) {
      const replies: unknown[] = []
      await dispatcher().dispatchStreaming(
        {
          id: 'prompt-test',
          authToken: 'token',
          method: 'agentSession.subscribeTurnCompletions',
          params: { includePrompts: true }
        },
        (raw) => replies.push(JSON.parse(raw)),
        client
      )
      const serialized = JSON.stringify(replies)
      expect(serialized).toContain('codex-session')
      expect(serialized.includes(SESSION)).toBe(seesPi)
      expect(replies).toHaveLength(seesPi ? 3 : 2)
    }
  })
})

describe('live Pi delivery audience', () => {
  it('publishes idle status and naming on support gain without erasing merged history on loss', async () => {
    const source = new RuntimeClientCapabilities()
    source.replace(OLD_CLIENT.clientCapabilities)
    const codex: AgentSessionStatusSummary = {
      sessionId: 'codex',
      workspaceId: 'workspace-1',
      agent: 'codex',
      status: 'idle',
      latestPrompt: 'hello',
      updatedAt: 1
    }
    const pi: AgentSessionStatusSummary = { ...codex, sessionId: SESSION, agent: 'pi' }
    const snapshot: AgentSessionStatusEvent = {
      type: 'snapshot',
      sessions: [codex, pi],
      conversationNames: [{ sessionId: SESSION, conversationName: 'Saved Pi' }],
      namingActiveSessionIds: [SESSION]
    }
    let subscriber!: StructuredAgentSessionStatusSubscriber
    const dispose = vi.fn()
    hostCalls.subscribeStatus.mockImplementation((next: StructuredAgentSessionStatusSubscriber) => {
      subscriber = next
      next.emit(snapshot)
      return dispose
    })
    hostCalls.readStatusSnapshot = vi.fn(() => snapshot)
    // SAFETY: the installed host fixture owns this deps/store object; only its conversation lookup is replaced.
    const deps = Reflect.get(hostCalls, 'deps') as {
      store: { getConversation: ReturnType<typeof vi.fn> }
    }
    deps.store.getConversation.mockImplementation(() => ({ provider: 'pi' }))
    const frames: AgentSessionStatusEvent[] = []
    const abort = new AbortController()
    const registry = new RuntimeSubscriptionRegistry()
    const rpc = dispatcher({
      registerSubscriptionCleanup: registry.register.bind(registry),
      cleanupSubscription: registry.cleanup.bind(registry)
    })
    let merged = new Map<string, AgentSessionStatusSummary>()
    await rpc.dispatchStreaming(
      {
        id: 'live-status',
        authToken: 'token',
        method: 'agentSession.subscribeStatus',
        params: null
      },
      (raw) => {
        const event = JSON.parse(raw).result
        frames.push(event)
        merged = new Map(foldAgentSessionStatusEvent(merged, event))
      },
      { ...OLD_CLIENT, capabilitySource: source, signal: abort.signal }
    )
    expect(merged.has(SESSION)).toBe(false)
    source.replace(PI_CLIENT.clientCapabilities)
    expect(merged.get(SESSION)).toEqual(pi)
    expect(frames.at(-1)).toMatchObject({
      conversationNames: [{ conversationName: 'Saved Pi' }],
      namingActiveSessionIds: [SESSION]
    })
    source.replace(OLD_CLIENT.clientCapabilities)
    expect(merged.has(SESSION)).toBe(true)
    const count = frames.length
    subscriber.emit({ type: 'status', session: pi })
    expect(frames).toHaveLength(count)
    subscriber.emit({ type: 'status', session: codex })
    expect(frames).toHaveLength(count + 1)
    abort.abort()
    const reads = hostCalls.readStatusSnapshot.mock.calls.length
    source.replace(PI_CLIENT.clientCapabilities)
    expect(hostCalls.readStatusSnapshot).toHaveBeenCalledTimes(reads)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('changes only future Pi completion/prompt delivery, retaining the opening prompt contract', async () => {
    const source = new RuntimeClientCapabilities()
    source.replace(OLD_CLIENT.clientCapabilities)
    hostCalls.sessionAgent.mockImplementation((id: string) => (id === SESSION ? 'pi' : 'codex'))
    let subscriber!: StructuredAgentSessionTurnCompletionSubscriber
    hostCalls.subscribeTurnCompletions = vi.fn(
      (next: StructuredAgentSessionTurnCompletionSubscriber) => {
        subscriber = next
        return () => {}
      }
    )
    const frames: unknown[] = []
    await dispatcher().dispatchStreaming(
      {
        id: 'live-edges',
        authToken: 'token',
        method: 'agentSession.subscribeTurnCompletions',
        params: { includePrompts: true }
      },
      (raw) => frames.push(JSON.parse(raw).result),
      { ...OLD_CLIENT, capabilitySource: source }
    )
    const scope = {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree' as const
    }
    const emitEdges = (sessionId: string) => {
      subscriber.emit({
        type: 'completion',
        completion: { scope, sessionId, turnId: 'turn', outcome: 'success', completedAt: 1 }
      })
      subscriber.emit({
        type: 'prompt',
        prompt: { scope, sessionId, promptId: 'prompt', raisedAt: 1 }
      })
    }
    emitEdges(SESSION)
    expect(frames).toHaveLength(0)
    source.replace(PI_CLIENT.clientCapabilities)
    expect(frames).toHaveLength(0)
    emitEdges(SESSION)
    expect(frames).toHaveLength(2)
    source.replace(OLD_CLIENT.clientCapabilities)
    emitEdges(SESSION)
    expect(frames).toHaveLength(2)
    emitEdges('codex')
    expect(frames).toHaveLength(4)
    expect(subscriber.includePrompts).toBe(true)
  })
})
