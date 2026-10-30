import type { Socket } from 'node:net'
import type { DaemonEndpointLifecycle } from './daemon-endpoint-lifecycle'
import type { DaemonRequestRouter } from './daemon-request-router'
import type { DaemonServerLifecycle } from './daemon-server-lifecycle'
import type { DaemonAutomaticWorkGuard } from './daemon-automatic-work-guard'
import { answerAutomaticWorkRequest } from './daemon-automatic-work-protocol'
import type { DaemonRequest } from './types'
import type { HostTerminalPolicy } from './host-terminal-policy'
import { answerTerminalLimitRequest } from './daemon-terminal-limit-protocol'
import { answerDaemonControlRequest } from './daemon-control-request'
export async function handleDaemonRequest(
  options: {
    automaticWork: DaemonAutomaticWorkGuard
    endpoint: DaemonEndpointLifecycle
    requestRouter: DaemonRequestRouter
    terminalPolicy: HostTerminalPolicy
    terminalPolicyNonce: string
    lifecycle: DaemonServerLifecycle
  },
  socket: Socket,
  clientId: string,
  request: DaemonRequest
): Promise<void> {
  return answerDaemonControlRequest(
    socket,
    request,
    async () =>
      answerTerminalLimitRequest(
        request,
        options.terminalPolicy,
        options.terminalPolicyNonce,
        () => options.lifecycle.isAcceptingWork() && !options.endpoint.hasLostOwnership()
      ) ??
      answerAutomaticWorkRequest(request, options.automaticWork, options.endpoint) ??
      options.requestRouter.route(clientId, request),
    () => options.lifecycle.startPendingShutdownReply(clientId, request.id)
  )
}
