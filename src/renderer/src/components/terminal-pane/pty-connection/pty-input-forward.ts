import { installPtyResizeForward } from './pty-resize-forward'

import { subscribeToTerminalInputData } from '../terminal-user-input-signal'
import { installTerminalImeCompositionRoute } from '../terminal-ime-composition-route'
import { useAppStore } from '@/store'
import { isTerminalQueryReply } from '../../../../../shared/terminal-query-reply'

import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'

import { isPaneReplaying } from '../replay-guard'
import { isXtermMouseReport, isXtermWheelCursorKey } from '../terminal-pointer-input-sequences'
import { shouldDropQuarantinedTerminalInput } from '../terminal-input-quarantine'

import { TERMINAL_FOCUS_IN_SEQUENCE, TERMINAL_FOCUS_OUT_SEQUENCE } from './foreground-output-scan'
import { isCodexPaneStale } from './codex-pane-stale'
import { installTerminalSelectionFitGuard } from '../terminal-selection-fit-guard'
import { initializePaneGeometry, readPaneSize } from './read-pane-size'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installPtyInputForward(session: ConnectPanePtySession): void {
  session.forwardPtyInput = (data: string, wasUserInput = false): void => {
    // Why: replaying recorded PTY bytes makes xterm auto-reply to embedded
    // queries (DA1/DECRQM/OSC 10-11/CPR) via onData; those must not leak into
    // the shell, but keystrokes typed mid-restore must survive. Pointer input
    // stays dropped even though xterm flags it as user input: replayed bytes can
    // leave mouse tracking armed until the guarded mode reset lands (a click
    // would print SGR fragments on the fresh prompt), and a wheel over a
    // replayed alt-screen frame becomes cursor keys that would recall history
    // at that prompt once ?1049l lands. See replay-guard.ts.
    if (
      isPaneReplaying(session.deps.replayingPanesRef, session.pane.id) &&
      (!wasUserInput ||
        isXtermMouseReport(data) ||
        (isXtermWheelCursorKey(data) && session.pane.terminal.buffer.active.type === 'alternate'))
    ) {
      return
    }
    const currentPtyId = session.transport.getPtyId()
    // Protocol replies keep the TUI responsive while an account notice blocks typing.
    if (isTerminalQueryReply(data)) {
      session.sendDesktopQueryReplyImmediate(data)
      return
    }
    // Why: after a Codex account switch, the runtime auth has already moved to
    // the newly selected account. Stale panes must not keep sending input until
    // they restart, or work can execute under the wrong account while the UI
    // still says the pane is stale. Fall back to the tab's persisted PTY ID so
    // the block still holds during reconnect races before the live transport has
    // updated its local PTY binding.
    if (
      isCodexPaneStale({
        tabId: session.deps.tabId,
        worktreeId: session.deps.worktreeId,
        panePtyId: currentPtyId
      })
    ) {
      session.clearPendingTerminalInputIntent()
      return
    }
    // Why: presence-lock input drop. While mobile is the driver for this
    // PTY, desktop keystrokes must not reach the shell; the visible overlay's
    // explicit Take back action owns restoring desktop input and dimensions.
    if (currentPtyId && isPtyLocked(currentPtyId)) {
      session.clearPendingTerminalInputIntent()
      return
    }
    if (
      session.isNativeWindowsConpty &&
      session.suppressNativeWindowsIdleCodexFocusReports &&
      (data === TERMINAL_FOCUS_IN_SEQUENCE || data === TERMINAL_FOCUS_OUT_SEQUENCE)
    ) {
      // Why: Codex can leave focus reporting armed after a Windows turn, but
      // disabling the mode would permanently silence focus events on resume.
      return
    }
    // Why after the query-reply branch: device replies are not user input and
    // must always reach the shell, or a program querying during reattach hangs.
    // Why at all: a replaced endpoint reattaches to a fresh shell, so the tail
    // of the interrupted line would be submitted by the user's own Enter and a
    // compound command could run its surviving half (#10065 follow-up).
    if (shouldDropQuarantinedTerminalInput(session.deps.tabId, data)) {
      session.clearPendingTerminalInputIntent()
      return
    }
    // Why xterm's provenance: its own focus reports reach onData too, and no person typed them.
    const inputKind = wasUserInput ? 'driving' : 'query-reply'
    const intent = session.pendingTerminalInputIntentFor(data)
    // Why: real xterm can deliver the terminal byte even when our DOM keydown
    // listener missed the press. Exact Ctrl+C/Escape bytes are still safe to
    // infer for local/remote acknowledged writes; SSH fire-and-forget remains
    // excluded because those transports do not expose sendInputAccepted.
    const acknowledgedIntent = intent ?? session.inferIntentFromExactTerminalInput(data)
    if (acknowledgedIntent && session.transport.sendInputAccepted) {
      const interruptStatusBaseline =
        useAppStore.getState().agentStatusByPaneKey[session.cacheKey] ?? null
      // Why: equal snapshots retain double-Escape semantics while older snapshots lose ack races.
      if (session.sequencedInterruptStatusBaseline !== interruptStatusBaseline) {
        session.sequencedInterruptStatusBaseline = interruptStatusBaseline
        session.interruptStatusBaselineSequence += 1
      }
      const capturedBaselineSequence = session.interruptStatusBaselineSequence
      session.claimViewportForUserActivity(data)
      if (acknowledgedIntent === 'ctrl-c') {
        // Why: the accepted-write callback is async; let the next command be
        // inferred if the user cancelled an oversized line and immediately typed.
        session.cancelSuspendedShellCommandInference()
      }
      session.clearPendingTerminalInputIntent()
      const capturedPolicy = session.semanticPolicy
      const capturedTransport = session.transport
      const capturedPtyId = capturedTransport.getPtyId()
      const view = new WeakRef(session)
      const writePromise = capturedTransport
        .sendInputAccepted(data, inputKind)
        .then((accepted): boolean | Promise<boolean> | null => {
          if (accepted) {
            const writtenPtyId = capturedPtyId ?? capturedTransport.getPtyId()
            if (
              !capturedPolicy.isLive() ||
              (writtenPtyId && capturedPolicy.getPtyId() !== writtenPtyId)
            ) {
              return null
            }
            capturedPolicy.acceptInput(data, acknowledgedIntent)
            const immediateResult = capturedPolicy.input.interruptInference.observeInputIntent(
              acknowledgedIntent,
              interruptStatusBaseline,
              capturedBaselineSequence
            )
            capturedPolicy.shellInput.observeTitleOnlyInterrupt()
            const mounted = view.deref()
            if (mounted && !mounted.disposed && mounted.semanticPolicy === capturedPolicy) {
              mounted.markAcceptedTerminalInputSent()
            }
            return immediateResult ?? null
          }
          // Why: Esc/Ctrl+C are the first keys users press on a frozen pane;
          // an unbound-transport reject here must arm recovery too.
          view.deref()?.requestRecoveryForUndeliverableInput()
          return null
        })
        .catch((err) => {
          console.warn('[agent-interrupt] acknowledged terminal input failed:', err)
          return null
        })
      session.setPendingTerminalInputWrite(writePromise)
      return
    }
    if (intent) {
      session.claimViewportForUserActivity(data)
      if (session.transport.sendInput(data, inputKind)) {
        session.markAcceptedTerminalInputSent()
        session.semanticPolicy.acceptInput(data, intent)
      } else {
        session.requestRecoveryForUndeliverableInput()
      }
      session.clearPendingTerminalInputIntent()
      return
    }
    session.claimViewportForUserActivity(data)
    if (session.transport.sendInput(data, inputKind)) {
      session.markAcceptedTerminalInputSent()
      session.semanticPolicy.acceptInput(data)
      session.observeSentTerminalInputIntent(data)
    } else {
      session.clearPendingTerminalInputIntent()
      session.requestRecoveryForUndeliverableInput()
    }
  }
  // Why bind once: provenance must survive deferPtyInput's later callback, and
  // this is the per-keystroke hot path, so no closure allocation per onData event.
  const forwardUserInput = (data: string): void => session.forwardPtyInput(data, true)
  const forwardUnclassifiedInput = (data: string): void => session.forwardPtyInput(data, false)
  session.onDataDisposable = subscribeToTerminalInputData(
    session.pane.terminal,
    (data, wasUserInput) => {
      const forward = wasUserInput ? forwardUserInput : forwardUnclassifiedInput
      if (session.deps.deferPtyInput) {
        session.deps.deferPtyInput(session.pane.id, data, forward)
        return
      }
      forward(data)
    }
  )
  session.imeCompositionRouteDisposable = installTerminalImeCompositionRoute({
    terminalElement: session.pane.terminal.element,
    terminal: session.pane.terminal,
    capturedTransport: session.transport,
    getCurrentTransport: () => session.deps.paneTransportsRef.current.get(session.pane.id)
  })
  session.terminalSelectionFitGuard = installTerminalSelectionFitGuard(session.pane.terminal, () =>
    session.scheduleForegroundGridDriftCheck(true)
  )

  installPtyResizeForward(session)

  session.readPaneSize = () => readPaneSize(session)
  initializePaneGeometry(session)
}
