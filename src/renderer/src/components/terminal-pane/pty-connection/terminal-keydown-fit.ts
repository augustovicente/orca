import { attachTerminalResidentPresentation } from './terminal-resident-presentation'
import { captureNotificationTransportOwner } from '@/attention/notification-subject-owner'
import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime-pty-id'
import { makePaneKey } from '../../../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'
import { bindPanePtyId, getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'
import { isCtrlCKeyEvent, isPlainEscapeKeyEvent } from '../agent-interrupt-inference'
import {
  admitRemoteTerminalSemanticResident,
  admitLegacyTerminalSemanticResident,
  registerTerminalSideEffectFactConsumer
} from '../terminal-side-effect-facts-handler'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Keydown intent, PTY fit binding, side-effect fact consumption, and the agent completion coordinator. */
export function installTerminalKeydownFit(session: ConnectPanePtySession): void {
  session.onTerminalKeyDown = (event: KeyboardEvent): void => {
    if (isPlainEscapeKeyEvent(event)) {
      session.setPendingTerminalInputIntent('plain-escape')
      return
    }
    if (isCtrlCKeyEvent(event)) {
      if (!navigator.userAgent.includes('Mac') && session.pane.terminal.hasSelection()) {
        return
      }
      session.setPendingTerminalInputIntent('ctrl-c')
    }
    // Why: only keydowns that will produce real terminal input reach the sample
    // below; modifier-only presses, autorepeat, and copy chords do not.
    if (
      event.repeat ||
      event.key === 'Alt' ||
      event.key === 'AltGraph' ||
      event.key === 'Control' ||
      event.key === 'Meta' ||
      event.key === 'Shift'
    ) {
      return
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === 'c' &&
      session.pane.terminal.hasSelection()
    ) {
      return
    }
    // Why: user shell frameworks (bash-preexec/iTerm2) can replace Orca's
    // OSC 133;C hook, so a manually launched agent produces no command-start
    // signal at all. Enter at a shell-foreground prompt is the user-side
    // equivalent; the sample is gated to panes with no live agent identity
    // and publishes nothing for an idle shell.
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      session.sampleVisiblePaneForegroundAgent()
    }
  }
  // Why: infer only from focused xterm key events. Raw PTY bytes cannot
  // distinguish plain Escape from Alt/meta sequences, and programmatic writes
  // should not clear agent status.
  session.terminalKeyTarget = session.pane.terminal.element ?? session.pane.container
  session.terminalKeyTargetSupportsEvents =
    typeof session.terminalKeyTarget?.addEventListener === 'function' &&
    typeof session.terminalKeyTarget?.removeEventListener === 'function'
  if (session.terminalKeyTargetSupportsEvents) {
    session.terminalKeyTarget.addEventListener('keydown', session.onTerminalKeyDown, {
      capture: true
    })
  }

  session.visibleRemoteViewportClaimPtyId = null
  session.pendingVisibleRemoteViewportClaim = false
  session.setPanePtyFitBinding = (ptyId: string): void => {
    bindPanePtyId(session.pane.id, ptyId, session.deps.tabId)
    session.pane.container.dataset.ptyId = ptyId
    if (
      session.deps.isVisibleRef.current &&
      isRemoteRuntimePtyId(ptyId) &&
      session.visibleRemoteViewportClaimPtyId !== ptyId
    ) {
      // Why: the initial fit event consumes this activation arm before later peer ownership changes.
      session.visibleRemoteViewportClaimPtyId = ptyId
      session.pendingVisibleRemoteViewportClaim = true
    }
    // Why: override hydration can arrive before this pane knows its PTY. Once
    // data-pty-id is bound, safeFit can park xterm at the authoritative grid.
    if (getFitOverrideForPty(ptyId)) {
      safeFit(session.pane)
    }
    session.claimPendingVisibleRemoteViewport()
  }
  session.activePanePtyBinding = null
  // Why: bind time lets async liveness reconcile ignore a request started
  // before this PTY bound (newborn race). Null disables the guard (fail-safe).
  session.activePanePtyBindingBoundAt = null

  // Why: with main side-effect authority on, the pane's title/bell/agent
  // policy callbacks consume pty:sideEffect facts instead of transport byte
  // parsers (which stay unregistered) — same policy code, single consumer.
  // restoreTitleOnRegister replaces the eager-replay title restore: main's
  // title-only snapshot carries the no-attention-replay rule.
  session.unregisterSideEffectFactConsumer = null
  session.registerSideEffectFactConsumerForPty = (
    ptyId: string,
    remoteOutputPaused = false
  ): void => {
    if (session.disposed) {
      return
    }
    session.semanticPolicy.bindPty(ptyId, session.remotePtyIncarnationId ?? null)
    const binding = {
      paneKey: session.cacheKey,
      tabId: session.deps.tabId,
      worktreeId: session.deps.worktreeId,
      cwd: session.deps.cwd,
      startup: session.paneStartup,
      initialTitle: session.getCurrentTerminalTitle() ?? undefined,
      launchToken: session.launchToken,
      runtimeEnvironmentId: session.runtimeEnvironmentId,
      workspaceOwner: captureNotificationTransportOwner(session.transport)
    }
    const services = {
      setCacheTimerStartedAt: session.deps.setCacheTimerStartedAt,
      markTerminalBell: session.deps.markTerminalBell,
      dispatchNotification: session.deps.dispatchNotification
    }
    if (
      !session.mainSideEffectAuthority &&
      session.runtimeEnvironmentId === null &&
      !isRemoteRuntimePtyId(ptyId)
    ) {
      admitLegacyTerminalSemanticResident({
        ptyId,
        incarnationId: session.remotePtyIncarnationId,
        binding,
        byteSource: true,
        services,
        policy: session.semanticPolicy
      })
    }
    if (isRemoteRuntimePtyId(ptyId)) {
      void admitRemoteTerminalSemanticResident({
        ptyId,
        binding,
        byteSource: true,
        services,
        policy: session.semanticPolicy
      })
    }
    session.unregisterSideEffectFactConsumer?.()
    session.unregisterSideEffectFactConsumer = registerTerminalSideEffectFactConsumer({
      ptyId,
      binding,
      services,
      policy: session.semanticPolicy,
      callbacks: {
        onTitleChange: session.onTitleChange,
        onBell: session.onBell,
        onAgentBecameIdle: session.onAgentBecameIdle,
        onAgentBecameWorking: session.onAgentBecameWorking,
        onAgentExited: session.onAgentExited,
        onCommandStarted: session.handleCommandStarted,
        onCommandFinished: session.handleCommandFinished,
        onPrLink: (link) =>
          useAppStore
            .getState()
            .observeTerminalGitHubPullRequestLink(session.deps.worktreeId, link, {
              tabId: session.deps.tabId,
              paneKey: makePaneKey(session.deps.tabId, session.pane.leafId),
              ptyId: session.transport.getPtyId(),
              executionHostId: session.transport.getExecutionHostId?.() ?? undefined
            }),
        // Why: the Command Code settle policy stays here — the done settle
        // timer must consult the live store row (which hook events and
        // renderer seeds also write), so main only emits scrape facts.
        onCommandCodeWorking: session.seedCommandCodeOutputWorkingStatus,
        onCommandCodeDone: session.scheduleCommandCodeOutputDoneStatus,
        ...(session.shouldOwnAgentStatusInRenderer
          ? { onAgentStatus: (payload) => session.handleRendererOwnedAgentStatus(payload) }
          : {}),
        // Why: gated hidden panes never see the subscribe bytes; the fact
        // replaces the byte scan (and the old post-latch subscribe drop).
        ...(session.hiddenDeliveryGateActive || remoteOutputPaused
          ? {
              onMode2031Subscribe: session.handleHiddenMode2031SubscribeFact,
              onMode2031Unsubscribe: session.handleHiddenMode2031UnsubscribeFact
            }
          : {})
      },
      onResident: (resident) => attachTerminalResidentPresentation(session, resident),
      restoreTitleOnRegister: true
    })
  }
  session.dropSideEffectFactConsumer = (): void => {
    session.unregisterSideEffectFactConsumer?.()
    session.unregisterSideEffectFactConsumer = null
    session.remoteOutputFactConsumerPtyId = null
  }
  session.clearPanePtyFitBinding = (): void => {
    // Why: fit bindings live in a module-level map, so pane teardown must
    // clear them explicitly instead of relying on DOM removal.
    bindPanePtyId(session.pane.id, null, session.deps.tabId)
    session.visibleRemoteViewportClaimPtyId = null
    session.pendingVisibleRemoteViewportClaim = false
    session.activePanePtyBinding = null
    session.activePanePtyBindingBoundAt = null
    delete session.pane.container.dataset.ptyId
    delete session.pane.container.dataset.ptyRecoveryState
  }
}
