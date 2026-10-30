import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { realHomeCodexResumeEnvDeletion } from '../../../shared/ai-vault-resume-command'
import { managedDataAccountResumeEnv } from '../../../shared/managed-data-account-resume'
import { getExecutionHostIdForWorktree } from './worktree-runtime-owner'
import { resolveTerminalHostOwnership } from './terminal-worktree-route'
import {
  agentResumeCurrentInputs,
  type AgentTerminalResume
} from '../../../shared/agent-terminal-resume'
import { isResumableTuiAgent } from '../../../shared/agent-session-resume'
import {
  assertAntigravityReferenceTarget,
  buildAntigravityReferenceStartup
} from './ai-vault-antigravity-reference-startup'
import { isAntigravityReferenceSession } from '../../../shared/antigravity-session-origin'
import { normalizeAiVaultResumeFilePath } from '../../../shared/ai-vault-resume-path'
import type { AiVaultSessionDragPayload } from '@/lib/ai-vault-session-drag'
import { resolveAiVaultResumeStartupShell } from '@/lib/ai-vault-resume-shell'
import {
  getAiVaultResumePlatform,
  type AiVaultResumePlatformState
} from '@/lib/ai-vault-resume-platform'
import {
  buildAiVaultLocalResumeStartup,
  buildAiVaultLocalResumeFallback,
  getAiVaultAgentProviderSession,
  type AiVaultResumeCommandSession,
  type AiVaultResumeHostShell,
  type AiVaultResumeLaunchSettings,
  type AiVaultResumeStartup as PreparedAiVaultResumeStartup
} from '../../../shared/ai-vault-resume-startup'
import {
  buildAiVaultRemoteResumeStartup,
  resolveAiVaultResumeHostShell
} from '../../../shared/ai-vault-resume-host-startup'

export type { AiVaultResumeCommandSession } from '../../../shared/ai-vault-resume-startup'
export { getAiVaultAgentProviderSession }
export type AiVaultResumeStartup = PreparedAiVaultResumeStartup & { resume?: AgentTerminalResume }

export type AiVaultResumeWorktreeArgs = {
  state: AiVaultResumePlatformState
  worktreeId?: string | null
  session: AiVaultResumeCommandSession
  commandOverride?: string | null
  agentArgs?: string
}

export function buildAiVaultResumeCopyCommandForWorktree(args: AiVaultResumeWorktreeArgs): string {
  // Copied lines run in unknown shells; env -u avoids fish_pid probing that aborts under set -u before agent launch (#14863).
  const clearEnvNames =
    args.session.agent === 'codex' && args.session.codexHome === null
      ? (['CODEX_HOME', 'ORCA_CODEX_HOME'] as const)
      : undefined
  return buildAiVaultResumeForWorktree(args, true, clearEnvNames).command
}

export function buildAiVaultResumeStartupForWorktree(
  args: AiVaultResumeWorktreeArgs
): AiVaultResumeStartup {
  if (
    getExecutionHostIdForWorktree(args.state, args.worktreeId) !== LOCAL_EXECUTION_HOST_ID ||
    resolveTerminalHostOwnership(args.state, args.worktreeId, 'spawn').kind !== 'local-or-ssh'
  ) {
    return buildAiVaultResumeForWorktree(args, false)
  }
  const providerSession = getAiVaultAgentProviderSession(args.session)
  const opaque =
    args.session.executionHostId &&
    args.session.executionHostId !== LOCAL_EXECUTION_HOST_ID &&
    args.session.resumeCommand &&
    args.session.agent !== 'omp' &&
    !(args.session.agent === 'codex' && args.session.codexHome === null) &&
    !args.commandOverride?.trim()
  if (
    providerSession &&
    isResumableTuiAgent(args.session.agent) &&
    !opaque &&
    !isAntigravityReferenceSession(args.session)
  ) {
    const settings = agentResumeCurrentInputs(args.session.agent, args.state.settings)
    const accountEnv = managedDataAccountResumeEnv(args.session)
    if (Object.keys(accountEnv).length > 0) {
      settings.agentDefaultEnv = {
        ...settings.agentDefaultEnv,
        [args.session.agent]: { ...settings.agentDefaultEnv?.[args.session.agent], ...accountEnv }
      }
    }
    return {
      ...buildAiVaultLocalResumeFallback({
        session: args.session,
        settings: args.state.settings,
        host: resolveAiVaultResumeHost(args),
        commandOverride: args.commandOverride,
        embedCwd: false
      }),
      resume: {
        providerSession,
        recipe: {
          source: 'current-inputs',
          settings,
          ...(args.commandOverride !== undefined ? { commandOverride: args.commandOverride } : {}),
          ...(args.agentArgs !== undefined ? { agentArgs: args.agentArgs } : {})
        },
        ...(args.session.agent === 'omp' && args.session.filePath
          ? { ompResumeFilePath: args.session.filePath }
          : {}),
        resumeInLaunchCwd: true,
        ...(args.session.agent === 'codex' ? { codexHome: args.session.codexHome } : {})
      },
      ...(args.session.cwd ? { cwd: args.session.cwd } : {}),
      ...realHomeCodexResumeEnvDeletion(args.session)
    }
  }
  return buildAiVaultResumeForWorktree(args, false)
}

/** Rebuild with the substituted account home; the prebuilt command pins the wrong account. null cwd means no cd; absent cwd is an older payload whose original directory cannot be recovered. */
export function buildAiVaultDropRepinStartup(args: {
  state: AiVaultResumeWorktreeArgs['state']
  payload: Pick<
    AiVaultSessionDragPayload,
    'agent' | 'sessionId' | 'sessionCwd' | 'sessionExecutionHostId' | 'sessionFilePath'
  >
  substituteCodexHome: string
  worktreeId: string
}): AiVaultResumeStartup | null {
  if (args.payload.sessionCwd === undefined || !args.payload.sessionFilePath) {
    return null
  }
  return buildAiVaultResumeStartupForWorktree({
    state: args.state,
    worktreeId: args.worktreeId,
    session: {
      agent: args.payload.agent,
      sessionId: args.payload.sessionId,
      cwd: args.payload.sessionCwd,
      codexHome: args.substituteCodexHome,
      executionHostId: args.payload.sessionExecutionHostId,
      filePath: args.payload.sessionFilePath
    },
    commandOverride: args.state.settings?.agentCmdOverrides?.[args.payload.agent]
  })
}

export function buildAiVaultResumeForWorktree(
  args: AiVaultResumeWorktreeArgs,
  embedCwd: boolean,
  /** Copied lines strip env from the agent command; spawned startups use envToDelete. */
  clearEnvNames?: readonly string[],
  settings: AiVaultResumeLaunchSettings | null | undefined = args.state.settings
): PreparedAiVaultResumeStartup {
  assertAntigravityReferenceTarget(args)
  const remote = buildAiVaultRemoteResumeStartup(args.session, args.commandOverride)
  if (remote) {
    return remote
  }
  const host = resolveAiVaultResumeHost(args)
  if (isAntigravityReferenceSession(args.session)) {
    const reference = buildAntigravityReferenceStartup({
      session: {
        ...args.session,
        filePath: normalizeAiVaultResumeFilePath(args.session.filePath, host.platform)
      },
      cwd: embedCwd ? args.session.cwd : null,
      platform: host.platform,
      shell: host.liveShell,
      commandOverride: args.commandOverride,
      settings
    })
    if (reference) {
      return { ...reference, ...(!embedCwd && args.session.cwd ? { cwd: args.session.cwd } : {}) }
    }
  }
  return buildAiVaultLocalResumeStartup({
    session: args.session,
    host,
    settings,
    commandOverride: args.commandOverride,
    agentArgs: args.agentArgs,
    embedCwd,
    clearEnvNames
  })
}

export function resolveAiVaultResumeHost(args: AiVaultResumeWorktreeArgs): AiVaultResumeHostShell {
  return resolveAiVaultResumeHostShell({
    session: args.session,
    workspacePlatform: getAiVaultResumePlatform(args.state, args.worktreeId),
    localLiveShell: (platform) =>
      resolveAiVaultResumeStartupShell({
        state: args.state,
        worktreeId: args.worktreeId,
        platform
      })
  })
}
