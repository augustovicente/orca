import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { runProcess, spawnProcess } from '@orca/process-host'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { DATA_ACCOUNT_RUNTIME_CAPABILITY } from '../shared/account-runtime-capabilities'

const eventSchema = z.object({
  name: z.string(),
  args: z.array(z.string()),
  dataHome: z.string(),
  configHome: z.string(),
  database: z.string(),
  kind: z.enum(['probe', 'login', 'stopped', 'survived']),
  dataHomeExists: z.boolean()
})

async function accountFixture() {
  const manifest = createRequire(resolve('package.json')).resolve('bun/package.json')
  const { bin } = z
    .object({ bin: z.object({ bun: z.string() }) })
    .parse(JSON.parse(readFileSync(manifest, 'utf8')))
  const program = join(dirname(manifest), bin.bun)
  const root = mkdtempSync(join(tmpdir(), 'orca-account-process-'))
  const tools = join(root, 'bin')
  mkdirSync(tools)
  const eventsPath = join(root, 'events.jsonl')
  const modePath = join(root, 'mode.json')
  const endpoint =
    process.platform === 'win32' ? `\\\\.\\pipe\\account-${randomUUID()}` : join(root, 'rpc')
  const requests: { method: string; params: Record<string, unknown> }[] = []
  const events = () =>
    existsSync(eventsPath)
      ? readFileSync(eventsPath, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => eventSchema.parse(JSON.parse(line)))
      : []
  const server = createServer((socket) => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (!buffer.includes('\n')) {
        return
      }
      const request = z
        .object({
          id: z.string(),
          method: z.string(),
          params: z.record(z.string(), z.unknown()).default({})
        })
        .parse(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))))
      requests.push(request)
      if (request.method === 'accounts.addDataFromHome') {
        const source = z.string().parse(request.params.sourceDataHome)
        expect(readFileSync(join(source, 'fixture-login'), 'utf8')).toBe('completed')
      }
      socket.end(
        `${JSON.stringify({
          id: request.id,
          ok: true,
          result:
            request.method === 'status.get'
              ? { capabilities: [DATA_ACCOUNT_RUNTIME_CAPABILITY] }
              : { accounts: [], activeAccountId: null },
          _meta: { runtimeId: 'fixture-host' }
        })}\n`
      )
    })
  })
  await new Promise<void>((ready) => server.listen(endpoint, ready))
  writeFileSync(
    join(root, 'orca-runtime.json'),
    JSON.stringify({
      runtimeId: 'fixture-host',
      pid: process.pid,
      startedAt: 1,
      authToken: 'fixture-token',
      transports: [{ kind: process.platform === 'win32' ? 'named-pipe' : 'unix', endpoint }]
    })
  )
  for (const name of ['opencode2', 'opencode']) {
    const script = join(tools, `${name}.cjs`)
    writeFileSync(
      script,
      `const fs = require('node:fs');
const mode = JSON.parse(fs.readFileSync(${JSON.stringify(modePath)}, 'utf8'));
const name = ${JSON.stringify(name)};
const args = process.argv.slice(2);
const probe = args.includes('--help');
fs.mkdirSync(process.env.XDG_DATA_HOME, {recursive:true});
const record = kind => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({
  name, args, kind, dataHome:process.env.XDG_DATA_HOME,
  configHome:process.env.XDG_CONFIG_HOME, database:process.env.OPENCODE_DB,
  dataHomeExists:fs.existsSync(process.env.XDG_DATA_HOME)
}) + '\\n');
record(probe ? 'probe' : 'login');
if (probe && mode.hold) {
  process.on('SIGTERM', () => {record('stopped'); process.exit(0)});
  setTimeout(() => {record('survived'); process.exit(0)}, 3000);
} else if (probe) {
  console.log(mode.supported === name || mode.nonzero === name ? '--standalone' : '--pure');
  process.exit(mode.nonzero === name ? 1 : 0);
} else {
  console.log('interactive login output');
  if (!mode.loginExit) fs.writeFileSync(require('node:path').join(process.env.XDG_DATA_HOME, 'fixture-login'), 'completed');
  process.exit(mode.loginExit || 0);
}
`
    )
    writeFileSync(
      join(tools, process.platform === 'win32' ? `${name}.cmd` : name),
      process.platform === 'win32'
        ? `@"${process.execPath}" "%~dp0\\${name}.cjs" %*\r\n`
        : `#!${process.execPath}\nrequire(${JSON.stringify(script)})\n`,
      { mode: 0o700 }
    )
  }
  const env = {
    ...Object.fromEntries(
      'HOME USERPROFILE APPDATA LOCALAPPDATA XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME ORCA_E2E_HOME_DIR ORCA_E2E_USER_DATA_DIR ORCA_USER_DATA_PATH TEMP TMP TMPDIR'
        .split(' ')
        .map((key) => [key, root])
    ),
    CODEX_HOME: join(root, 'codex'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_DISABLE_MACOS_LOGIN_SHELL: '1',
    PATH: tools + delimiter + dirname(process.execPath),
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec
  }
  const spec = {
    program,
    args: [
      resolve('src/cli/index.ts'),
      'account',
      'add',
      '--agent',
      'opencode',
      '--integration',
      'opencode-go',
      '--label',
      'CLI fixture',
      '--json'
    ],
    cwd: root,
    env,
    timeoutMs: 15_000
  }
  return {
    spec,
    events,
    requests,
    mode(value: Record<string, unknown>) {
      writeFileSync(modePath, JSON.stringify(value))
      writeFileSync(eventsPath, '')
      requests.length = 0
    },
    async close() {
      await new Promise<void>((done) => server.close(() => done()))
      rmSync(root, { recursive: true, force: true })
    }
  }
}

it('real account-add CLI probes, selects, logs in, hands off capture and cleans up; failures never enroll', async () => {
  const fixture = await accountFixture()
  try {
    for (const mode of [
      { supported: 'opencode2' },
      { supported: 'opencode', nonzero: 'opencode2' },
      { supported: 'neither' },
      { supported: 'opencode2', loginExit: 7 }
    ]) {
      fixture.mode(mode)
      const result = await runProcess(fixture.spec)
      const success = mode.supported !== 'neither' && !mode.loginExit
      expect(result.code, result.stdout + result.stderr).toBe(success ? 0 : 1)
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: success })
      const events = fixture.events()
      expect(events[0]).toMatchObject({ name: 'opencode2', args: ['auth', 'login', '--help'] })
      const login = events.find(({ kind }) => kind === 'login')
      if (mode.supported === 'neither') {
        expect(login).toBeUndefined()
        expect(result.stdout).toContain('npm install --prefix ./orca-opencode2 @opencode/cli')
      } else {
        expect(login).toMatchObject({
          name: mode.supported,
          args: ['auth', 'login', 'opencode-go', '--standalone'],
          database: 'opencode.db'
        })
        expect(result.stderr).toContain('interactive login output')
      }
      expect(events.every(({ dataHome, configHome }) => dataHome !== configHome)).toBe(true)
      expect(events.every(({ dataHome }) => !existsSync(dirname(dataHome)))).toBe(true)
      expect(fixture.requests.map(({ method }) => method)).toEqual(
        success ? ['status.get', 'accounts.addDataFromHome'] : ['status.get']
      )
      if (success) {
        expect(fixture.requests.at(-1)?.params).toEqual({
          provider: 'opencode',
          sourceDataHome: login?.dataHome,
          label: 'CLI fixture'
        })
        expect(events.every(({ dataHome }) => dataHome === login?.dataHome)).toBe(true)
      }
    }
  } finally {
    await fixture.close()
  }
}, 60_000)

it.skipIf(process.platform === 'win32')(
  'SIGTERM during the real CLI help probe stops it before cleanup without fallback or capture',
  async () => {
    const fixture = await accountFixture()
    fixture.mode({ hold: true })
    const child = spawnProcess(fixture.spec)
    const exited = once(child, 'close')
    child.stdout?.resume()
    child.stderr?.resume()
    try {
      await expect.poll(() => fixture.events().length, { timeout: 10_000 }).toBe(1)
      child.kill('SIGTERM')
      expect(await exited).toEqual([143, null])
      expect(fixture.events().map(({ kind, dataHomeExists }) => [kind, dataHomeExists])).toEqual([
        ['probe', true],
        ['stopped', true]
      ])
      expect(fixture.requests.map(({ method }) => method)).toEqual(['status.get'])
      expect(fixture.events().every(({ dataHome }) => !existsSync(dirname(dataHome)))).toBe(true)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await exited
      }
      await fixture.close()
    }
  },
  20_000
)
