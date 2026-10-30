import type { ChildProcessHandle } from '@orca/process-host/process-spec'
import { runCliFsReadsAsync } from '../../shared/cli-fs-reads'
import { installedCliRuntimeDirectory } from '../../shared/cli-runtime-pairing-inputs'
import { installedCliCandidates } from '../../shared/node-cli-command-resolution'
import {
  INSTALLED_LOOKUP_REQUEST,
  INSTALLED_PLAN_REPLY,
  type InstalledProviderPlan
} from '../provider-process/provider-process-supervisor'

type InstalledLookupContext = {
  command: string
  homePath: string
  platform: NodeJS.Platform
  runtimePathBase: string | null
  acceptPath: (path: string) => boolean
}

/** One ephemeral inventory; late filesystem completions cannot revive a closed launch. */
export function attachSourceControlInstallFallback(
  child: ChildProcessHandle,
  context: InstalledLookupContext
): void {
  let active = true
  let requested = false
  const detach = (): void => {
    active = false
    child.off('message', onMessage)
    child.off('disconnect', detach)
    child.off('exit', detach)
    child.off('close', detach)
    child.off('error', detach)
  }
  const acceptPath = (path: string): boolean => active && context.acceptPath(path)
  const prepare = async (): Promise<InstalledProviderPlan> => {
    const commands = await runCliFsReadsAsync(
      installedCliCandidates(context.command, context.platform, context.homePath, acceptPath)
    )
    const candidates: InstalledProviderPlan['candidates'] = []
    for (const command of commands) {
      if (!active) {
        break
      }
      candidates.push({
        command,
        runtimeDirectory: await installedCliRuntimeDirectory(command, acceptPath)
      })
    }
    return { runtimePathBase: context.runtimePathBase, candidates }
  }
  const channelFailed = (): void => {
    detach()
    if (child.connected) {
      try {
        child.disconnect()
      } catch {}
    }
  }
  const reply = (plan: InstalledProviderPlan | { error: true }): void => {
    if (!active || !child.connected) {
      return
    }
    try {
      child.send({ type: INSTALLED_PLAN_REPLY, ...plan }, (error) => {
        if (error) {
          channelFailed()
        }
      })
    } catch {
      channelFailed()
    }
  }
  const onMessage = (message: unknown): void => {
    if (
      !active ||
      requested ||
      typeof message !== 'object' ||
      message === null ||
      !('type' in message) ||
      message.type !== INSTALLED_LOOKUP_REQUEST
    ) {
      return
    }
    requested = true
    void prepare().then(reply, () => reply({ error: true }))
  }
  child.on('message', onMessage)
  child.once('disconnect', detach)
  child.once('exit', detach)
  child.once('close', detach)
  child.once('error', detach)
}
