import { expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  seam,
  current,
  file,
  read,
  write,
  install,
  remove,
  erase,
  storage,
  documentPath,
  document,
  slot,
  pausedEdit
} from './claude-system-statusline.test-fixture'

const userValues = {
  model: 'opus',
  permissions: { allow: ['Read'] },
  statusLine: { type: 'command', command: '/user/owned-statusline' }
}

async function editCurrent(name: string, missing = false) {
  const prior = missing ? {} : await read(file(name))
  const edited = {
    ...prior,
    ...userValues,
    hooks: {
      ...prior.hooks,
      Notification: [{ hooks: [{ type: 'command', command: '/user/notifier' }] }]
    }
  }
  await write(file(name), edited)
}

function checkUserValues(actual: Record<string, unknown>) {
  expect(actual).toMatchObject(userValues)
  expect(actual.hooks).toMatchObject({
    Notification: [{ hooks: [{ type: 'command', command: '/user/notifier' }] }]
  })
}

it('control: fresh reread preserves a user edit during the initial optional metadata lookup', async () => {
  await install('seed')
  await write(file('X'), { model: 'sonnet' })
  const meta = await documentPath()
  const result = await pausedEdit(
    (method, path) => method === 'readFile' && path === meta,
    () => install('X'),
    () => editCurrent('X')
  )
  const actual = await read(file('X'))
  expect(result.state).toBe('installed')
  expect(actual.hooks.SessionStart).toHaveLength(1)
  checkUserValues(actual)
  expect((await install('X')).state).toBe('installed')
  checkUserValues(await read(file('X')))
})

it('preserves a user edit while the own-retirement journal is being saved', async () => {
  await install('X')
  const before = await read(file('X'))
  await write(file('X'), { ...before, model: 'sonnet' })
  const meta = await documentPath()
  const result = await pausedEdit(
    (method, path) => method === 'rename' && path === meta,
    () => install('X', { claudeVersion: '1.0.0' }),
    () => editCurrent('X')
  )
  const actual = await read(file('X'))
  expect(result.state).toBe('installed')
  expect((await install('X')).state).toBe('installed')
  checkUserValues(actual)
  checkUserValues(await read(file('X')))
})

it('preserves a user-created config while a missing-file publication waits for optional metadata', async () => {
  await install('seed')
  const meta = await documentPath()
  const result = await pausedEdit(
    (method, path) => method === 'readFile' && path === meta,
    () => install('X'),
    () => editCurrent('X', true)
  )
  const actual = await read(file('X'))
  expect(result.state).toBe('installed')
  expect(actual.hooks.SessionStart).toHaveLength(1)
  checkUserValues(actual)
  expect((await install('X')).state).toBe('installed')
  checkUserValues(await read(file('X')))
})

it('preserves a completed user save during reset identity preparation', async () => {
  await install('X')
  const meta = await documentPath()
  let reset = false
  seam.after = async (method, path) => {
    if (method === 'rename' && path === meta) {
      reset = true
    }
  }
  const result = await pausedEdit(
    (method, path) => reset && method === 'stat' && path === dirname(file('X')),
    () => remove('X'),
    () => editCurrent('X')
  )
  expect(result.state).toBe('not_installed')
  checkUserValues(await read(file('X')))
  expect(
    (await document()).destinations.some((entry: { path: string }) => entry.path === file('X'))
  ).toBe(false)
  expect((await install('X')).state).toBe('installed')
  checkUserValues(await read(file('X')))
})

it('honors a deletion completed during its own retirement journal, then retries without replay', async () => {
  await install('X')
  const meta = await documentPath()
  const result = await pausedEdit(
    (method, path) => method === 'rename' && path === meta,
    () => install('X', { claudeVersion: '1.0.0' }),
    () => erase('X')
  )
  expect(result.state).toBe('installed')
  expect((await document()).destinations[0].phase).toBe('managed')
  expect((await install('X')).state).toBe('installed')
  expect((await read(file('X'))).statusLine).toBeUndefined()
})

it.each(['empty', 'invalid'] as const)(
  'reclassifies fresh %s settings after missing-file evidence',
  async (kind) => {
    await install('seed')
    const meta = await documentPath()
    const bytes = kind === 'empty' ? '{"model":"opus"}' : '["not a settings object"]'
    const result = await pausedEdit(
      (method, path) => method === 'readFile' && path === meta,
      () => install('X'),
      async () => {
        await fs.mkdir(dirname(file('X')), { recursive: true })
        await fs.writeFile(file('X'), bytes)
      }
    )
    if (kind === 'invalid') {
      expect(result.state).toBe('error')
      expect(await fs.readFile(file('X'), 'utf8')).toBe(bytes)
      await write(file('X'), { model: 'opus' })
      expect((await install('X')).state).toBe('installed')
    } else {
      expect(result.state).toBe('installed')
    }
    expect(await read(file('X'))).toMatchObject({ model: 'opus' })
    expect((await read(file('X'))).statusLine).toBeDefined()
  }
)

async function selectedParentEdit(
  nth: number,
  operation: () => ReturnType<typeof install>,
  retarget: boolean
) {
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  let count = 0
  let held = false
  let expired = false
  const emergency = setTimeout(() => {
    expired = true
    released.resolve()
    entered.resolve()
  }, 3000)
  seam.after = async (method, path) => {
    if (method === 'stat' && path === dirname(file('A')) && ++count === nth) {
      held = true
      entered.resolve()
      await released.promise
    }
  }
  const pending = operation()
  try {
    await entered.promise
    expect(held).toBe(true)
    expect(expired).toBe(false)
    if (retarget) {
      await fs.unlink(dirname(file('alias')))
      await fs.symlink(dirname(file('B')), dirname(file('alias')), 'junction')
    }
    released.resolve()
    const result = await pending
    expect(expired).toBe(false)
    return result
  } finally {
    released.resolve()
    await pending
    clearTimeout(emergency)
    seam.after = null
    expect(await fs.readdir(join(storage(), 'lock'))).toEqual([])
    for (const name of ['A', 'B']) {
      expect(
        (await fs.readdir(dirname(file(name)))).filter((entry) => entry.endsWith('.tmp'))
      ).toEqual([])
    }
  }
}

it.each(['control', 'install', 'retire', 'off'] as const)(
  'retains selected physical A through directory retarget: %s',
  async (mode) => {
    await write(file('A'), { model: 'sonnet' })
    expect((await install('A')).state).toBe('installed')
    const deleted = mode === 'control' || mode === 'install'
    if (deleted) {
      await erase('A')
    }
    await write(file('B'), {
      model: 'opus',
      permissions: { allow: ['Read'] },
      hooks: { Notification: [{ hooks: [{ type: 'command', command: '/user/notify' }] }] }
    })
    if (!deleted) {
      expect((await install('B')).state).toBe('installed')
    }
    await fs.symlink(dirname(file('A')), dirname(file('alias')), 'junction')
    const bBytes = await fs.readFile(file('B'), 'utf8')
    const bBackup = await fs.readFile(`${file('B')}.bak`, 'utf8').catch(() => null)
    const bRecord = (await document()).destinations.find(
      (entry: { path: string }) => entry.path === file('B')
    )
    const result = await selectedParentEdit(
      deleted ? 1 : 2,
      () =>
        mode === 'off'
          ? remove('alias')
          : install('alias', mode === 'retire' ? { claudeVersion: '1.0.0' } : current),
      mode !== 'control'
    )
    expect(result.state).toBe(deleted && mode !== 'control' ? 'not_installed' : 'installed')
    expect(result.managedHooksPresent).toBe(mode === 'control' || mode === 'off')
    expect(slot(await read(file('A')))).toBe('empty')
    expect(await fs.readFile(file('B'), 'utf8')).toBe(bBytes)
    expect(await fs.readFile(`${file('B')}.bak`, 'utf8').catch(() => null)).toBe(bBackup)
    const owners = (await document()).destinations
    expect(owners.find((entry: { path: string }) => entry.path === file('B'))).toEqual(bRecord)
    expect(owners.some((entry: { path: string }) => entry.path === file('A'))).toBe(deleted)
    if (mode !== 'control') {
      expect((await install('B')).state).toBe('installed')
      expect(slot(await read(file('B')))).toBe('managed')
      expect(await read(file('B'))).toMatchObject({
        model: 'opus',
        permissions: { allow: ['Read'] },
        hooks: { Notification: [{ hooks: [{ command: '/user/notify' }] }] }
      })
    }
  }
)
