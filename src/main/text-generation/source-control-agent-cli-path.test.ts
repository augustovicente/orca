import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import * as fs from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { setSpawnObserver } from '@orca/process-host/spawn-observer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveCliCommandAsync } from '../../shared/node-cli-command-async-resolution'
import { resolveCliCommand, resolveCliCommands } from '../../shared/node-cli-command-resolution'
import {
  createProviderSpawnSpec,
  POSIX_PROVIDER_SUPERVISOR_SCRIPT
} from '../provider-process/provider-process-supervisor'
import { generateConversationNameFromContext } from './commit-message-text-generation'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    statSync: vi.fn(actual.statSync),
    readdirSync: vi.fn(actual.readdirSync)
  }
})

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-naming-cli-'))
  vi.stubEnv('HOME', root)
})
afterEach(() => {
  setSpawnObserver(null)
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

  it.each([
    { agentId: 'codex', versions: 10 },
    { agentId: 'codex', versions: 100 },
    { agentId: 'claude', versions: 10 },
    { agentId: 'claude', versions: 100 }
  ] as const)(
    'names a chat with $agentId at the last of $versions nvm versions in linear probes',
    async ({ agentId, versions }) => {
      const inventory = join(root, '.nvm', 'versions', 'node')
      for (let version = 1; version <= versions; version++) {
        mkdirSync(join(inventory, `v20.${version}.0`, 'bin'), { recursive: true })
      }
      const bin = join(inventory, 'v20.1.0', 'bin')
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
      const request = async (pathEnv = '/usr/bin:/bin', literal?: string) => {
        const stats = vi.mocked(fs.statSync).mockClear()
        const directories = vi.mocked(fs.readdirSync).mockClear()
        // Snapshot real resolver operations at the supervisor admission, before its CLI answers.
        const spawn = vi.fn((command: string, args: readonly string[]) => ({
          command,
          args,
          enumerations: directories.mock.calls.filter(([path]) => String(path) === inventory)
            .length,
          entries: directories.mock.results.reduce(
            (count, result, index) =>
              count +
              (String(directories.mock.calls[index][0]) === inventory && result.type === 'return'
                ? result.value.length
                : 0),
            0
          ),
          candidates: stats.mock.calls.filter(([path]) => String(path).endsWith(`/${agentId}`))
            .length,
          nvmCandidates: stats.mock.calls.filter(
            ([path]) =>
              String(path).startsWith(`${inventory}/`) && String(path).endsWith(`/${agentId}`)
          ).length,
          aliasReads: stats.mock.calls.filter(([path]) =>
            String(path).startsWith(`${join(root, '.nvm', 'alias')}/`)
          ).length
        }))
        setSpawnObserver((command, args) => {
          if (args[1] === POSIX_PROVIDER_SUPERVISOR_SCRIPT) {
            spawn(command, args)
          }
        })
        const result = await generateConversationNameFromContext(
          { firstPrompt: 'Fix login' },
          literal
            ? { agentId: 'custom', model: '', customAgentCommand: `"${literal}"` }
            : { agentId, model: agentId === 'codex' ? 'gpt-5.5' : 'sonnet' },
          {
            kind: 'local',
            cwd: root,
            env: {
              ...process.env,
              PATH: pathEnv,
              CODEX_HOME: join(root, '.codex'),
              CLAUDE_CONFIG_DIR: join(root, '.claude')
            }
          }
        )
        expect(result).toMatchObject({ success: true, name: 'Fix login flow' })
        expect(spawn).toHaveBeenCalledTimes(1)
        const admission = spawn.mock.results[0].value
        expect(admission.command).toBe(process.execPath)
        return admission
      }
      const scan = await request()
      expect(scan.args).toContain(program)
      expect(scan.enumerations).toBe(1)
      expect(scan.entries).toBe(versions)
      expect(scan.nvmCandidates).toBe(versions)
      expect(scan.candidates).toBeLessThanOrEqual(2 + versions + 16)
      expect(scan.aliasReads).toBeLessThanOrEqual(11)

      if (agentId === 'codex' && versions === 10) {
        expect(await request(`${bin}:/usr/bin:/bin`)).toMatchObject({ enumerations: 0, entries: 0 })
        expect(await request('/usr/bin:/bin', program)).toMatchObject({
          enumerations: 0,
          entries: 0,
          candidates: 0,
          aliasReads: 0
        })
        const newer = join(inventory, 'v20.10.0', 'bin', agentId)
        copyFileSync(program, newer)
        symlinkSync(process.execPath, join(inventory, 'v20.10.0', 'bin', 'node'))
        expect((await request()).args).toContain(newer)
        unlinkSync(newer)
        expect((await request()).args).toContain(program)
      }
    }
  )
})
