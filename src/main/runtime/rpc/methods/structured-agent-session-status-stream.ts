// `agentSession.subscribeStatus` — every structured session's projected status on one stream.
//
// Session lists read turn state from here instead of replaying transcripts: one stream per client
// covers every session, and unlike a transcript subscription it retains none of them.

import type { AgentSessionStatusEvent } from '../../../../shared/agent-session-wire'
import { prepareStructuredTabsIfSupported } from './structured-session-tab-restore'
import { defineStreamingMethod, type RpcContext } from '../core'
import { requireStructuredHost as requireHost } from './structured-agent-session-gate'
import { structuredAgentSessionStatusSubscriptionId } from './structured-agent-session-subscription-id'
import { clientReadsStructuredSessionAgent } from './structured-agent-session-policy'

/** Ties a stream to both ends that can close it — the runtime's subscription registry and the
 *  transport abort — so either one runs `onClose` exactly once. */
export function bindStructuredAgentSessionStream(
  ctx: RpcContext,
  subscriptionId: string,
  onClose: () => void
): { isClosed: () => boolean } {
  let closed = false
  let releaseTransportSubscription = (): void => {}
  const onTransportAbort = (): void => releaseTransportSubscription()
  const cleanup = (): void => {
    closed = true
    ctx.signal?.removeEventListener('abort', onTransportAbort)
    onClose()
  }
  let registration: { releaseIfCurrent: () => void }
  if (typeof ctx.runtime.registerOwnedSubscriptionCleanup === 'function') {
    registration = ctx.runtime.registerOwnedSubscriptionCleanup(
      subscriptionId,
      cleanup,
      ctx.connectionId
    )
  } else {
    ctx.runtime.registerSubscriptionCleanup(subscriptionId, cleanup, ctx.connectionId)
    registration = { releaseIfCurrent: () => ctx.runtime.cleanupSubscription(subscriptionId) }
  }
  releaseTransportSubscription = registration.releaseIfCurrent
  ctx.signal?.addEventListener('abort', onTransportAbort, { once: true })
  if (ctx.signal?.aborted) {
    onTransportAbort()
  }
  return { isClosed: () => closed }
}

export const STRUCTURED_AGENT_SESSION_STATUS_METHODS = [
  defineStreamingMethod({
    name: 'agentSession.subscribeStatus',
    permission: 'workspace',
    params: null,
    handler: async (_params, ctx, emit) => {
      const restoration = prepareStructuredTabsIfSupported(ctx)
      if (restoration) {
        await restoration
      }
      const host = requireHost(ctx)
      const subscriptionId = structuredAgentSessionStatusSubscriptionId(ctx)
      let dispose = (): void => {}
      let stopCapabilities = (): void => {}
      const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => {
        stopCapabilities()
        dispose()
      })
      if (stream.isClosed()) {
        return
      }
      const audience = () => ({
        ...ctx,
        clientCapabilities: ctx.capabilitySource?.current ?? ctx.clientCapabilities
      })
      const publish = (event: AgentSessionStatusEvent): void => {
        if (event.type === 'snapshot') {
          emit({
            ...event,
            ...(event.conversationNames
              ? {
                  conversationNames: event.conversationNames.filter((note) => {
                    const record = host.deps.store.getConversation(note.sessionId)
                    return record && clientReadsStructuredSessionAgent(audience(), record.provider)
                  })
                }
              : {}),
            ...(event.namingActiveSessionIds
              ? {
                  namingActiveSessionIds: event.namingActiveSessionIds.filter((sessionId) => {
                    const record = host.deps.store.getConversation(sessionId)
                    return record && clientReadsStructuredSessionAgent(audience(), record.provider)
                  })
                }
              : {}),
            sessions: event.sessions.filter((session) =>
              clientReadsStructuredSessionAgent(audience(), session.agent)
            )
          })
        } else if (
          event.type !== 'status' ||
          clientReadsStructuredSessionAgent(audience(), event.session.agent)
        ) {
          emit(event)
        }
      }
      dispose = host.subscribeStatus({ id: subscriptionId, emit: publish })
      if (!stream.isClosed()) {
        stopCapabilities =
          ctx.capabilitySource?.observe((previous) => {
            if (
              clientReadsStructuredSessionAgent({ ...ctx, clientCapabilities: previous }, 'pi') !==
              clientReadsStructuredSessionAgent(audience(), 'pi')
            ) {
              publish(host.readStatusSnapshot())
            }
          }) ?? (() => {})
      }
      if (stream.isClosed()) {
        dispose()
      }
    }
  })
]
