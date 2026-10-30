import type { IPty } from 'node-pty'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import { shouldInspectOuterWrapperForegroundProcess } from '../../shared/foreground-wrapper-agent'
import { ptyShellProcessId } from '../windows/windows-pty-job'
import { createPtyForegroundResolver } from '../daemon/pty-subprocess/spawn-file-foreground-process'
import {
  resolveAgentForegroundProcessWithAvailability,
  type AgentForegroundResolutionOptions,
  type AgentForegroundProcessResolution
} from './agent-foreground-process'
import {
  judgeCachedAgentJobEvidence,
  reconcileWindowsAgentDecision,
  type WindowsCachedAgentJobVerdict
} from './windows-cached-agent-revalidation'
import { readWindowsConsoleAttachedProcessIds } from './windows-console-attached-processes'
import { isWindowsPtyJobReadable, readWindowsPtyJobProcessIds } from './windows-pty-job-membership'

/** Execute fresh confirmation; owners retain cache publication and lifetime fences. */
export async function confirmFreshPtyForeground(args: {
  process: IPty
  fallbackProcess: string | null
  contextPaths: AgentForegroundResolutionOptions['contextPaths']
  decision: boolean
  anchor: { processName: string; pid: number | null } | null
  anchorAt?: number
}): Promise<{ resolution: AgentForegroundProcessResolution; processName: string | null }> {
  const proc = args.process
  const shellPid = ptyShellProcessId(proc) ?? proc.pid
  let verdict: WindowsCachedAgentJobVerdict = 'unavailable'
  if (args.decision) {
    try {
      verdict = judgeCachedAgentJobEvidence({
        jobProcessIds: readWindowsPtyJobProcessIds(proc),
        jobSupported: isWindowsPtyJobReadable(),
        shellPid,
        anchorProcessId: args.anchor?.pid ?? null,
        identityAgeMs: Date.now() - (args.anchorAt ?? 0)
      })
    } catch {
      /* A failed job read cannot release a known anchor. */
    }
  }
  let resolution: AgentForegroundProcessResolution
  try {
    const resolve = args.decision
      ? resolveAgentForegroundProcessWithAvailability
      : createPtyForegroundResolver(proc)
    resolution = await resolve(proc.pid, args.fallbackProcess, {
      contextPaths: args.contextPaths,
      fresh: true,
      ...(args.decision && args.anchor?.pid != null
        ? { anchorProcessId: args.anchor.pid, anchorProcessName: args.anchor.processName }
        : {}),
      ...(process.platform === 'win32'
        ? {
            forceProcessScan: true,
            readWindowsConsoleAttachedProcessIds: () =>
              readWindowsConsoleAttachedProcessIds(proc.pid)
          }
        : {})
    })
  } catch {
    resolution = { available: false, processName: null }
  }
  return {
    resolution,
    processName: args.decision
      ? reconcileWindowsAgentDecision(resolution, verdict, args.anchor, shellPid)
      : resolution.available
        ? resolution.processName
        : null
  }
}

/** POSIX confirmations read the physical terminal even when its display name already names an agent. */
export function shouldConfirmPtyForeground(fallback: string | null, decision: boolean): boolean {
  if (process.platform !== 'win32') {
    return true
  }
  if (!fallback) {
    return decision
  }
  const recognized = recognizeAgentProcess(fallback)
  return (
    process.platform === 'win32' ||
    recognized === null ||
    shouldInspectOuterWrapperForegroundProcess(recognized)
  )
}
