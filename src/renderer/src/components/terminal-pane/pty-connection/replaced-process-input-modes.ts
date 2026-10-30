import { PROCESS_BOUNDARY_GROUND } from '../../../../../shared/terminal-mode-reset-profiles'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { useAppStore } from '@/store'

/** A replaced process must not inherit the old one's input modes (#35559). */
export function bindReplacedProcessInputModes(session: ConnectPanePtySession): void {
  // The process whose input modes this xterm may still hold; null once grounded or never stamped.
  session.inputModeOwnerIncarnationId = null

  session.groundInputModesForNewProcess = (): void => {
    session.inputModeOwnerIncarnationId = null
    session.writeInputModeGround(PROCESS_BOUNDARY_GROUND)
  }

  // Call before the process's replay is written, so its own bytes re-arm only what it set.
  session.noteBoundProcessIncarnation = (incarnationId: string | null | undefined): void => {
    if (
      session.disposed ||
      !incarnationId ||
      incarnationId === session.inputModeOwnerIncarnationId
    ) {
      return
    }
    if (session.inputModeOwnerIncarnationId !== null) {
      session.groundInputModesForNewProcess()
      const state = useAppStore.getState()
      state.removeAgentStatus(session.cacheKey)
      state.clearPaneForegroundAgent(session.cacheKey)
      session.deps.clearRuntimePaneTitle(session.deps.tabId, session.pane.id)
      session.paneForegroundAgentTracker.onCommandStarted(true)
    }
    session.inputModeOwnerIncarnationId = incarnationId
  }
}
