import '../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import 'node:child_process'
import 'node:fs'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import 'node:os'
import { join } from 'node:path'
import 'node:util'
import { expect, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import '../../shared/constants'
import '../../shared/project-host-setup-lookup'
import '../ipc/worktrees/listing/ssh-worktree-fallback'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import '../host-tree-removal'
import * as nativeFs from '../asar-transparent-fs'
import 'node:fs/promises'
import '../git/windows-worktree-removal'
import '../git/worktree-list-reader'
import '../local-orphaned-worktree-cleanup'
import '../ipc/worktrees/removal/worktree-removal-ownership'
import '../ipc/worktrees/removal/execute-worktree-removal'
import './runtime-preserved-branch-cleanup'
import './runtime-store-partial-fixture'
import './runtime-worktree-removal-in-flight'
import './workspaces/workspace-removal-target'
import { loadWorktreeRemovalRecords } from '../worktree-background-removal'
import '../git/worktree'
import '../ipc/worktree-remote'
import '../project-runtime-git-options'
import '../worktree-removal-table'
import '../git/worktree'
import '../git/worktree-path-comparison'
import '../ipc/watcher-removal-gate'
import '../worktree-background-removal'
import '../worktree-removal-listing'
import { writeWorktreeRemovalRecords } from '../worktree-removal-records'
import './runtime-interrupted-local-worktree-removal'

export function isolateRemovalGitEnvironment(home: string): void {
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase().startsWith('GIT_')) {
      vi.stubEnv(key, undefined)
    }
  }
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME']) {
    vi.stubEnv(key, home)
  }
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_CONFIG_GLOBAL', join(home, 'empty'))
}

export const deletionOperations = () =>
  (['rm', 'unlink', 'rmdir'] as const).map((operation) => vi.spyOn(nativeFs, operation))

export function expectNoTeardownOrDeletion(
  ...callbacks: (ReturnType<typeof vi.fn> | ReturnType<typeof deletionOperations>[number])[]
): void {
  callbacks.forEach((callback) => expect(callback).not.toHaveBeenCalled())
}

export async function orphanAdmin(worktreePath: string): Promise<void> {
  const admin = (await readFile(join(worktreePath, '.git'), 'utf8')).trim().replace(/^gitdir: /, '')
  await removeTree(admin)
  await unlink(join(worktreePath, '.git'))
  await writeFile(join(worktreePath, '.git'), `  gitdir: ${admin}\nignored second line\n`)
}

export async function recordFailedRemoval(
  recordsDir: string,
  worktreePath: string,
  repo: Repo,
  repoPath: string,
  force: boolean
): Promise<void> {
  await writeWorktreeRemovalRecords(recordsDir, () => [
    {
      worktreeId: `repo-1::${worktreePath}`,
      repoId: repo.id,
      repoPath,
      worktreePath,
      branch: 'feature',
      head: '',
      deleteBranch: true,
      force,
      requestedAt: 1,
      failure: { message: 'held file', failedAt: 2 }
    }
  ])
  await loadWorktreeRemovalRecords(recordsDir)
}
