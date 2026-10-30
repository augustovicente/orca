import { spawnProcess } from '@orca/process-host'
import { createOutputSink } from '@orca/process-host/bounded-output-sink'
import { resolveCliCommand, withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { getSpawnArgsForWindows } from '../../shared/windows-batch-spawn'
import { RuntimeClientError } from '../runtime-client'
import {
  type InteractiveLoginSession,
  terminateInteractiveLoginProcess
} from './interactive-login-interruption'

export async function resolveOpenCodeLoginCommand(
  env: NodeJS.ProcessEnv,
  session: InteractiveLoginSession
): Promise<string> {
  for (const command of ['opencode2', 'opencode']) {
    try {
      const resolvedCommand = resolveCliCommand(command)
      const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(resolvedCommand, [
        'auth',
        'login',
        '--help'
      ])
      const child = spawnProcess({
        program: spawnCmd,
        args: spawnArgs,
        env: withCliRuntimeOnPath(resolvedCommand, env)
      })
      session.child = child
      const output = createOutputSink(64 * 1024)
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        void terminateInteractiveLoginProcess(child, 'SIGTERM')
      }, 10_000)
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.stdout?.on('data', output.write)
          child.stderr?.on('data', output.write)
          for (const stream of [child.stdin, child.stdout, child.stderr]) {
            stream?.on('error', () => {})
          }
          child.once('error', reject)
          child.once('close', resolve)
          child.stdin?.end()
        })
        if (session.terminationPromise) {
          throw new RuntimeClientError('internal', 'OpenCode sign-in was interrupted.')
        }
        if (code === 0 && !timedOut && /--standalone\b/.test(output.text())) {
          return command
        }
      } finally {
        clearTimeout(timer)
        session.child = null
      }
    } catch (error) {
      if (session.terminationPromise) {
        throw error
      }
      // A missing or unusable candidate does not rule out the other installed binary.
    }
  }
  throw new RuntimeClientError(
    'invalid_environment',
    'Could not find an OpenCode 2 login. Managed OpenCode accounts require OpenCode 2. Install alongside your existing CLI with `npm install --prefix ./orca-opencode2 @opencode/cli`. Append the absolute path of orca-opencode2/node_modules/.bin to PATH after existing entries, then run this command again.'
  )
}
