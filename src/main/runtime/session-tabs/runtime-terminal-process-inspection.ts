import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import type { RuntimePtyController } from '../runtime-pty-controller-contract'
import type {
  PtyProcessInspection,
  PtyProcessInspectionOptions
} from '../../providers/pty-process-inspection'

/** Project the owner's PTY identity into the caller's terminal handle without borrowing a replacement leaf. */
export async function inspectRuntimePtyProcess(
  controller: Pick<
    RuntimePtyController,
    'inspectProcess' | 'getForegroundProcess' | 'hasChildProcesses'
  > | null,
  currentPtyId: () => string | undefined,
  terminalSelector: string,
  options?: PtyProcessInspectionOptions
): Promise<PtyProcessInspection> {
  const ptyId = currentPtyId()
  if (!ptyId || !controller) {
    throw new Error('terminal_gone')
  }
  if (controller.inspectProcess) {
    const inspection =
      options === undefined
        ? await controller.inspectProcess(ptyId)
        : await controller.inspectProcess(ptyId, options)
    if (currentPtyId() !== ptyId) {
      throw new Error('terminal_handle_stale')
    }
    const evidence = inspection.foregroundProcessEvidence
    const observation = inspection.foregroundObservation
    const relayPtyId = parseAppSshPtyId(ptyId)?.relayPtyId
    const belongs = (id: string): boolean => id === ptyId || id === relayPtyId
    return {
      ...inspection,
      ...(evidence && belongs(evidence.ptyId)
        ? { foregroundProcessEvidence: { ...evidence, ptyId: terminalSelector } }
        : {}),
      ...(observation && belongs(observation.ptyId)
        ? { foregroundObservation: { ...observation, ptyId: terminalSelector } }
        : {})
    }
  }
  const foregroundProcess = await controller.getForegroundProcess(ptyId)
  const hasChildProcesses = (await controller.hasChildProcesses?.(ptyId)) ?? false
  if (currentPtyId() !== ptyId) {
    throw new Error('terminal_handle_stale')
  }
  return { foregroundProcess, hasChildProcesses }
}
