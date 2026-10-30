import type { AgentPaneChange } from '../../agent-hooks/agent-transition-detector'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { resolveStructuredWorkerIdentityForSession } from '../structured-worker-authority'
import type { OrchestrationDb } from './db'

/** A finished worker's countdown runs only while its agent rests: working suspends it, the next rest restarts it. */
export class WorkerAutoReleaseActivity {
  private readonly chatWorking = new Map<string, boolean>()

  constructor(private readonly getDb: () => OrchestrationDb | null) {}

  observePane(change: AgentPaneChange): void {
    // Every hook event is 'observed'; only phase moves (and seeds) change whether the agent works.
    if (change.kind !== 'observed') {
      this.apply(change.paneKey, (change.kind === 'moved' ? change.to : change.phase) === 'working')
    }
  }

  observeChat(summary: Pick<AgentSessionStatusSummary, 'sessionId' | 'status'>): void {
    const working = summary.status === 'working'
    if (this.chatWorking.get(summary.sessionId) === working) {
      return
    }
    this.chatWorking.set(summary.sessionId, working)
    const db = this.getDb()
    const paneKey = db && resolveStructuredWorkerIdentityForSession(summary.sessionId, db)?.paneKey
    if (paneKey) {
      this.apply(paneKey, working)
    }
  }

  private apply(paneKey: string, working: boolean): void {
    try {
      const db = this.getDb()
      if (working) {
        db?.suspendWorkerTerminalAutoRelease(paneKey)
      } else {
        db?.restartWorkerTerminalAutoRelease(paneKey)
      }
    } catch (error) {
      console.warn('[orchestration] worker auto-release activity update failed', error)
    }
  }
}
