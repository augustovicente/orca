import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveCliCommandAsync } from '../../shared/node-cli-command-async-resolution'
import { resolveCliCommand, resolveCliCommands } from '../../shared/node-cli-command-resolution'
import { createProviderSpawnSpec } from '../provider-process/provider-process-supervisor'
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
  it.each(['absolute PATH', 'relative PATH', 'symlink cwd'])(
    'preserves the original supervisor executable with %s containing symlink/..',
    async (input) => {
      mkdirSync(join(root, 'actual', 'nested'), { recursive: true })
      mkdirSync(join(root, 'actual', 'bin'))
      mkdirSync(join(root, 'bin'))
      symlinkSync(join(root, 'actual', 'nested'), join(root, 'link'))
      writeFileSync(join(root, 'actual', 'bin', 'cx'), '#!/bin/sh\necho Fix login flow\n', {
        mode: 0o755
      })
      writeFileSync(join(root, 'bin', 'cx'), '#!/bin/sh\necho Different executable\n', {
        mode: 0o755
      })
      const cwd = input === 'symlink cwd' ? join(root, 'link') : root
      // Keep the traversal literal: lexical normalization changes which executable runs.
      const pathEnv =
        input === 'absolute PATH'
          ? `${root}/link/../bin`
          : input === 'relative PATH'
            ? 'link/../bin'
            : '../bin'
      const env = { PATH: pathEnv }
      const original = await runProcess({
        ...createProviderSpawnSpec({ command: 'cx', args: [], cwd }, env, process.platform, {
          lifetime: 'one-shot'
        }),
        timeoutMs: 5000
      })
      expect(original).toMatchObject({ code: 0, stdout: 'Fix login flow\n', timedOut: false })
      await expect(
        generateConversationNameFromContext(
          { firstPrompt: 'Fix login' },
          { agentId: 'custom', model: '', customAgentCommand: 'cx' },
          { kind: 'local', cwd, env }
        )
      ).resolves.toMatchObject({ success: true, name: original.stdout.trim() })
      const options = { pathEnv, cwd, homePath: root }
      const expected = input === 'absolute PATH' ? `${pathEnv}/cx` : `${cwd}/${pathEnv}/cx`
      expect([
        resolveCliCommand('cx', options),
        await resolveCliCommandAsync('cx', options),
        resolveCliCommands(['cx'], options).get('cx')
      ]).toEqual([expected, expected, expected])
    }
  )

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
