import type { MessageType, OrchestrationDb, RunRow } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { checkWorkerMailbox } from './check-worker'
import { acknowledgedOnlyReceipt, handsOverBatch } from './mailbox-message-receipt'
import { currentDispatchAssigneeRun } from './recipient-routing'
import { callerHoldsDispatchPane, dispatchFenced } from './dispatch-mailbox-fence'
import { orchestrationCallerIdentity } from '../runs/run-scope'
import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import type { CheckParams } from '../schemas'
import type { z } from 'zod'

export async function checkRunPendingMail(args: {
  params: z.infer<typeof CheckParams>
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  run: RunRow
  handle: string
  paneKey: string | undefined
  callerSession: OrchestrationSessionCaller | undefined
  typeFilter: MessageType[] | undefined
  signal: AbortSignal | undefined
  revalidateConsumer: () => void
  recordMutationReceipt: ((receipt: unknown) => void) | undefined
}): Promise<unknown> {
  const {
    params,
    runtime,
    db,
    run,
    handle,
    paneKey,
    typeFilter,
    signal,
    revalidateConsumer,
    recordMutationReceipt
  } = args
  const address = `run:${run.id}`
  // Drain pre-bind mail through its original Dispatch owner, never by changing its Run.
  const residual = !params.run ? db.getActiveDispatchForIdentity(handle, paneKey) : undefined
  const caller = orchestrationCallerIdentity(runtime, {
    handle,
    paneKey,
    session: args.callerSession
  })
  const drainsResidual =
    residual &&
    residual.run_id !== run.id &&
    (residual.assignee_orca_session_id === null ||
      residual.assignee_orca_session_id === caller.orcaSessionId) &&
    callerHoldsDispatchPane(residual, paneKey) &&
    currentDispatchAssigneeRun(runtime, db, residual)?.id === run.id
      ? residual
      : undefined
  if (
    params.ack &&
    (!drainsResidual ||
      db.getDeliveryRaw(params.ack)?.mailbox_handle !== `dispatch:${drainsResidual.id}`)
  ) {
    const acknowledged = db.acknowledgeRunDelivery({
      runId: run.id,
      consumerGeneration: run.consumer_generation,
      deliveryId: params.ack
    })
    const receipt = acknowledgedOnlyReceipt({ runId: run.id }, acknowledged.delivery.id)
    recordMutationReceipt?.(receipt)
    return receipt
  }
  if (!drainsResidual || (!params.ack && db.hasOutstandingMailboxDelivery(address))) {
    return undefined
  }
  const result = await checkWorkerMailbox({
    params: { ...params, wait: false },
    runtime,
    db,
    handle,
    paneKey,
    typeFilter,
    signal,
    activeDispatch: drainsResidual,
    remoteAttachment: undefined,
    wakeTypes: params.wait ? typeFilter : undefined,
    // Never create a batch ahead of Run replay.
    deferDelivery: () => db.hasOutstandingMailboxDelivery(address),
    revalidateConsumer: () => {
      revalidateConsumer()
      const current = db.getActiveDispatchForIdentity(handle, paneKey)
      if (
        !current ||
        current.id !== drainsResidual.id ||
        currentDispatchAssigneeRun(runtime, db, current)?.id !== run.id
      ) {
        throw dispatchFenced()
      }
    },
    recordMutationReceipt
  })
  if (params.ack || handsOverBatch(result)) {
    return result
  }
  revalidateConsumer()
  const inspectingHistory = params.all === true || (params.unread === false && params.peek !== true)
  return result &&
    result.count > 0 &&
    (!inspectingHistory || db.getUnreadMessages(`dispatch:${drainsResidual.id}`).length > 0)
    ? result
    : undefined
}
