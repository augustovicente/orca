import { runProcess } from '@orca/process-host'
import { resolveCliCommand, withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { RuntimeClientError } from '../runtime-client'

export async function resolveOpenCodeLoginCommand(env: NodeJS.ProcessEnv): Promise<string> {
  for (const command of ['opencode2', 'opencode']) {
    try {
      const resolvedCommand = resolveCliCommand(command)
      const result = await runProcess({
        program: resolvedCommand,
        args: ['auth', 'login', '--help'],
        env: withCliRuntimeOnPath(resolvedCommand, env),
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024
      })
      if (
        result.code === 0 &&
        !result.timedOut &&
        /--standalone\b/.test(`${result.stdout}\n${result.stderr}`)
      ) {
        return command
      }
    } catch {
      // A missing or unusable candidate does not rule out the other installed binary.
    }
  }
  throw new RuntimeClientError(
    'invalid_environment',
    'Could not find an OpenCode 2 login. Managed OpenCode accounts require OpenCode 2. Install @opencode/cli (npm install -g @opencode/cli), then run this command again.'
  )
}
