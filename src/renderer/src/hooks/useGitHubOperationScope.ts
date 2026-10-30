import { isWebClientLocation } from '@/lib/web-client-location'
import { webRuntimeState } from '@/web/preload-api/web-runtime-session'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status-connection-generation'

export function useGitHubOperationScope(
  target: RuntimeClientTarget,
  repoId?: string | null,
  repoPath?: string | null
): string {
  return useAppStore((state) => {
    const repo = state.repos.find((candidate) =>
      repoId ? candidate.id === repoId : candidate.path === repoPath
    )
    const environmentId =
      target.kind === 'environment'
        ? target.environmentId
        : isWebClientLocation()
          ? webRuntimeState.activeEnvironment?.id
          : null
    return JSON.stringify([
      repoId,
      repoPath,
      repo?.ghAccount,
      repo?.executionHostId,
      environmentId,
      environmentId ? getRuntimeEnvironmentRevision(environmentId) : null,
      environmentId ? getRuntimeEnvironmentConnectionGeneration(environmentId) : null
    ])
  })
}
