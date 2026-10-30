import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateConversationNameFromContext } from './commit-message-text-generation'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-naming-cli-'))
  vi.stubEnv('HOME', root)
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('installed one-shot naming CLI', () => {
  it.each(['codex', 'claude'] as const)(
    'names a chat with %s installed only under nvm, using its sibling Node',
    async (agentId) => {
      const bin = join(root, '.nvm', 'versions', 'node', 'v20.1.0', 'bin')
      mkdirSync(bin, { recursive: true })
      symlinkSync(process.execPath, join(bin, 'node'))
      const program = join(bin, agentId)
      writeFileSync(
        program,
        `#!/usr/bin/env node
const { realpathSync } = require('node:fs')
if (realpathSync(process.env.PATH.split(':')[0]) !== realpathSync(__dirname)) process.exit(2)
process.stdin.resume()
process.stdin.on('end', () => console.log('Fix login flow'))
`
      )
      chmodSync(program, 0o755)
      const result = await generateConversationNameFromContext(
        { firstPrompt: 'Fix login' },
        { agentId, model: agentId === 'codex' ? 'gpt-5.5' : 'sonnet' },
        {
          kind: 'local',
          cwd: root,
          env: {
            ...process.env,
            PATH: '/usr/bin:/bin',
            CODEX_HOME: join(root, '.codex'),
            CLAUDE_CONFIG_DIR: join(root, '.claude')
          }
        }
      )
      expect(result).toEqual({
        success: true,
        name: 'Fix login flow',
        agentLabel: agentId === 'codex' ? 'Codex' : 'Claude'
      })
    }
  )
})
