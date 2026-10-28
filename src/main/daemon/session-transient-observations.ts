import { TerminalSnapshotObserver } from '../../shared/terminal-snapshot-observer'
import type { TerminalTransientObservation } from '../../shared/terminal-transient-observation'
import { OpenCodeRunLifetimeStatus } from '../runtime/opencode-run-lifetime-status'
import type { SubprocessHandle } from './session-subprocess-handle'
import { resolveAgentForegroundCommandLine } from '../providers/agent-foreground-process'
import { resolveWindowsAgentForegroundCommandLine } from '../providers/windows-agent-foreground-command-line'

/** The Session owns genuine-byte interpretation and local live-process recognition. */
export class SessionTransientObservations {
  private readonly observer: TerminalSnapshotObserver
  private readonly openCode: OpenCodeRunLifetimeStatus

  constructor(
    publish: (observation: TerminalTransientObservation) => void,
    adopted = false,
    subprocess?: SubprocessHandle,
    wslDistro?: string,
    startupCommand?: string
  ) {
    this.openCode = new OpenCodeRunLifetimeStatus({
      isObservablePty: () => Boolean(subprocess) && !wslDistro,
      isStatusEnabled: () => true,
      readForegroundProcessName: async () => subprocess?.getForegroundProcess() ?? null,
      readForegroundCommandLine: async (_id, name) =>
        !subprocess
          ? null
          : process.platform === 'win32'
            ? resolveWindowsAgentForegroundCommandLine(subprocess.pid, name)
            : resolveAgentForegroundCommandLine(subprocess.pid),
      publish: (_id, payload, startedAt) =>
        this.observer.record({ kind: 'opencode-status', payload, startedAt }),
      now: Date.now
    })
    this.observer = new TerminalSnapshotObserver(publish, {
      adopted,
      startupCommand,
      beforeCommandStarted: () => this.openCode.onCommandFinished('session', null),
      onCommandStarted: () => this.openCode.onCommandStarted('session'),
      onCommandFinished: (exitCode) => this.openCode.onCommandFinished('session', exitCode)
    })
  }

  observe(data: string, rawEndSeq: number): void {
    this.observer.observe(data, rawEndSeq)
  }
  snapshot(): TerminalTransientObservation {
    return this.observer.snapshot()
  }
  dispose(): void {
    this.openCode.forgetPty('session')
    this.observer.dispose()
  }
}
