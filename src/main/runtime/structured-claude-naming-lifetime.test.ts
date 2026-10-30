import { appendFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import * as transcriptNaming from '../claude/claude-provider-session-rename'
import { StructuredAgentSessionAdapterRouter } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router'
import { HOST_TEST_SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { stopStructuredAgentSessionRuntime } from './structured-agent-session-runtime'
import {
  createClaudeNamingRuntime,
  nativeNamingTitle,
  writeNativeNamingConversation
} from './structured-claude-naming-test-support'

vi.mock('./structured-agent-model-catalog-wiring', () => ({
  modelCatalogHostDeps: async () => ({})
}))

it('settles fresh input while the actual outside append is held, then corrects only the overlapping chat', async ({
  onTestFinished
}) => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const fixture = await createClaudeNamingRuntime()
  const append = transcriptNaming.renameClaudeTranscript
  const naming = vi
    .spyOn(transcriptNaming, 'renameClaudeTranscript')
    .mockImplementation(async (...args) => {
      entered.resolve()
      await release.promise
      await append(...args)
    })
  onTestFinished(async () => {
    release.resolve()
    await fixture.dispose()
    vi.restoreAllMocks()
  })
  await writeNativeNamingConversation(fixture.file, fixture.nativeId, fixture.root)
  const host = await fixture.install()
  expect(await fixture.create()).toMatchObject({
    ok: true,
    value: {
      page: {
        items: expect.arrayContaining([
          expect.objectContaining({ body: expect.objectContaining({ role: 'user' }) })
        ])
      }
    }
  })
  expect(
    host.deps.store.requireWritableRecord(HOST_TEST_SESSION).providerHandleChain
  ).toMatchObject([{ origin: 'adopted', handle: { nativeId: fixture.nativeId } }])
  expect(fixture.launches).toHaveLength(0)
  await expect(
    host.setUserConversationName(HOST_TEST_SESSION, 'New name', 'rename')
  ).resolves.toEqual({
    name: 'New name',
    applied: true
  })
  await entered.promise
  const sent = await fixture.send()
  expect(sent).toMatchObject({ ok: true })
  if (!sent.ok) {
    throw new Error('the fresh input was refused')
  }
  await vi.waitFor(async () => {
    const journal = await host.journalSnapshot(HOST_TEST_SESSION)
    expect(
      journal.submissions.find((entry) => entry.clientMessageId === sent.value.clientMessageId)
    ).toMatchObject({
      dispatchState: 'accepted'
    })
    expect(journal.items).toContainEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          role: 'assistant',
          blocks: [{ type: 'text', text: 'NAMING_OK' }]
        })
      })
    )
  })
  expect(fixture.launches).toHaveLength(1)
  expect(fixture.launches[0]?.options).toMatchObject({ resume: fixture.nativeId })
  expect(await nativeNamingTitle(fixture.file)).toBe('Old')
  expect(fixture.controls).toEqual([])
  release.resolve()
  await vi.waitFor(() =>
    expect(fixture.controls).toEqual([{ name: 'New name', nativeId: fixture.nativeId }])
  )
  await stopStructuredAgentSessionRuntime()
  expect(await nativeNamingTitle(fixture.file)).toBe('New name')
  expect(naming).toHaveBeenCalledOnce()

  // A later independent native rename survives an unrelated true resume, even to an older spelling.
  for (const later of ['Independent CLI', 'Old']) {
    await appendFile(
      fixture.file,
      `${JSON.stringify({ type: 'custom-title', sessionId: fixture.nativeId, customTitle: later })}\n`
    )
    await fixture.install()
    expect(await fixture.send('Unrelated continuation')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(fixture.native.connections.at(-1)?.sent).toHaveLength(1))
    await stopStructuredAgentSessionRuntime()
    expect(await nativeNamingTitle(fixture.file)).toBe(later)
    expect(fixture.controls).toHaveLength(1)
    expect(naming).toHaveBeenCalledOnce()
  }
})

it('joins an issued control after stopDelivery before closing adapters and the database', async ({
  onTestFinished
}) => {
  const control = Promise.withResolvers<void>()
  const controlEntered = Promise.withResolvers<void>()
  const fixture = await createClaudeNamingRuntime({
    beforeControl: async () => {
      controlEntered.resolve()
      await control.promise
    }
  })
  onTestFinished(async () => {
    control.resolve()
    await fixture.dispose()
    vi.restoreAllMocks()
  })
  await writeNativeNamingConversation(fixture.file, fixture.nativeId, fixture.root)
  const host = await fixture.install()
  expect(await fixture.create()).toMatchObject({ ok: true })
  expect(await fixture.send()).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(fixture.native.connections[0]?.sent).toHaveLength(1))
  await host.setUserConversationName(HOST_TEST_SESSION, 'Accepted before quit', 'rename')
  await controlEntered.promise
  const adapter = host.deps.adapter
  if (!(adapter instanceof StructuredAgentSessionAdapterRouter)) {
    throw new Error('expected the installed runtime router')
  }
  const stopDelivery = vi.spyOn(host, 'stopDelivery')
  const closeAdapters = vi.spyOn(adapter, 'closeAll')
  const closeDatabase = vi.spyOn(host.deps.journalDatabase, 'close')
  const stopping = stopStructuredAgentSessionRuntime()
  await vi.waitFor(() => expect(stopDelivery).toHaveBeenCalledOnce())
  host.deps.nameProviderConversation?.({
    ...host.deps.store.requireWritableRecord(HOST_TEST_SESSION),
    conversationName: 'Late push'
  })
  expect(fixture.controls).toEqual([{ name: 'Accepted before quit', nativeId: fixture.nativeId }])
  expect(closeAdapters).not.toHaveBeenCalled()
  expect(closeDatabase).not.toHaveBeenCalled()
  control.resolve()
  await stopping
  expect(fixture.controls).toEqual([{ name: 'Accepted before quit', nativeId: fixture.nativeId }])
  expect(await nativeNamingTitle(fixture.file)).toBe('Accepted before quit')
  expect(fixture.native.connections).toHaveLength(1)
  expect(fixture.native.connections[0]?.exitVerdict).toEqual({ root: 'exited', tree: 'exited' })
  expect(closeAdapters).toHaveBeenCalledOnce()
  expect(closeDatabase).toHaveBeenCalledOnce()
})

it('joins already-issued root cleanup after startup expiry even when delivery and unissued follow-up stop', async ({
  onTestFinished
}) => {
  vi.useFakeTimers()
  const initialize = Promise.withResolvers<void>()
  const appendEntered = Promise.withResolvers<void>()
  const releaseAppend = Promise.withResolvers<void>()
  const appendFinished = Promise.withResolvers<void>()
  const warn = vi.fn()
  const closeEntered = Promise.withResolvers<void>()
  const rootExit = Promise.withResolvers<boolean>()
  const fixture = await createClaudeNamingRuntime({
    initialize: initialize.promise,
    deps: { startupLimits: { ceilingMs: 5000 }, logger: { warn, error: vi.fn() } },
    beforeClose: () => {
      closeEntered.resolve()
      return rootExit.promise
    }
  })
  const append = transcriptNaming.renameClaudeTranscript
  vi.spyOn(transcriptNaming, 'renameClaudeTranscript').mockImplementation(async (...args) => {
    appendEntered.resolve()
    await releaseAppend.promise
    await append(...args)
    appendFinished.resolve()
  })
  onTestFinished(async () => {
    releaseAppend.resolve()
    initialize.resolve()
    rootExit.resolve(true)
    await fixture.dispose()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })
  await writeNativeNamingConversation(fixture.file, fixture.nativeId, fixture.root)
  const host = await fixture.install()
  expect(await fixture.create()).toMatchObject({ ok: true })
  expect(await fixture.send()).toMatchObject({ ok: true })
  await vi.waitFor(() =>
    expect(host.readStatusSummary(HOST_TEST_SESSION)?.hostExecutionPhase).toBe('starting')
  )
  await host.setUserConversationName(HOST_TEST_SESSION, 'Name after expiry', 'rename')
  await appendEntered.promise
  const stopDelivery = vi.spyOn(host, 'stopDelivery')
  const adapter = host.deps.adapter
  if (!(adapter instanceof StructuredAgentSessionAdapterRouter)) {
    throw new Error('expected the installed runtime router')
  }
  const closeAdapters = vi.spyOn(adapter, 'closeAll')
  const closeDatabase = vi.spyOn(host.deps.journalDatabase, 'close')
  const stopping = stopStructuredAgentSessionRuntime()
  expect(stopDelivery).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(5000)
  await closeEntered.promise
  expect(closeAdapters).not.toHaveBeenCalled()
  expect(closeDatabase).not.toHaveBeenCalled()
  expect(fixture.native.connections[0]?.exitVerdict.root).toBe('live')
  releaseAppend.resolve()
  await appendFinished.promise
  await vi.advanceTimersByTimeAsync(0)
  expect(closeAdapters).not.toHaveBeenCalled()
  expect(closeDatabase).not.toHaveBeenCalled()
  rootExit.resolve(true)
  await stopping
  expect(fixture.controls).toEqual([])
  // A failed-before-ready writer may finish its old title; the unissued correction is terminal.
  expect(await nativeNamingTitle(fixture.file)).toBe('Old')
  expect(warn).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ scope: 'provider-session-rename' })
  )
  expect(fixture.native.connections[0]?.exitVerdict).toEqual({ root: 'exited', tree: 'exited' })
  expect(fixture.native.connections[0]?.closeCount).toBe(1)
  expect(closeAdapters).toHaveBeenCalledOnce()
  expect(closeDatabase).toHaveBeenCalledOnce()
})

it('joins a retiring writer but refuses an unproven root before issuing outside metadata', async ({
  onTestFinished
}) => {
  const entered = Promise.withResolvers<void>()
  const rootExit = Promise.withResolvers<boolean>()
  let retry = false
  const warn = vi.fn()
  const fixture = await createClaudeNamingRuntime({
    deps: { logger: { warn, error: vi.fn() } },
    beforeClose: () => {
      entered.resolve()
      return retry ? Promise.resolve(true) : rootExit.promise
    }
  })
  const append = vi.spyOn(transcriptNaming, 'renameClaudeTranscript')
  onTestFinished(async () => {
    retry = true
    rootExit.resolve(true)
    await fixture.dispose()
    vi.restoreAllMocks()
  })
  await writeNativeNamingConversation(fixture.file, fixture.nativeId, fixture.root)
  const host = await fixture.install()
  expect(await fixture.create()).toMatchObject({ ok: true })
  expect(await fixture.send()).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(fixture.native.connections[0]?.sent).toHaveLength(1))
  const adapter = host.deps.adapter
  if (!adapter.closeSession) {
    throw new Error('expected the runtime close boundary')
  }
  const closing = adapter.closeSession(HOST_TEST_SESSION)
  await entered.promise
  await host.setUserConversationName(HOST_TEST_SESSION, 'Refused until proven', 'rename')
  expect(append).not.toHaveBeenCalled()
  rootExit.resolve(false)
  expect(await closing).toBe(false)
  await vi.waitFor(() =>
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ scope: 'provider-session-rename' })
    )
  )
  expect(fixture.native.connections[0]?.exitVerdict.root).toBe('live')
  expect(await nativeNamingTitle(fixture.file)).toBe('Old')
  expect(append).not.toHaveBeenCalled()
  retry = true
  expect(await adapter.closeSession(HOST_TEST_SESSION)).toBe(true)
  await host.setUserConversationName(HOST_TEST_SESSION, 'After proven exit', 'rename')
  await vi.waitFor(async () =>
    expect(await nativeNamingTitle(fixture.file)).toBe('After proven exit')
  )
})

it('detaches a quit-before-ready follow-up without waiting for post-join closeAll', async ({
  onTestFinished
}) => {
  const initialize = Promise.withResolvers<void>()
  const fixture = await createClaudeNamingRuntime({ initialize: initialize.promise })
  onTestFinished(async () => {
    initialize.resolve()
    await fixture.dispose()
    vi.restoreAllMocks()
  })
  await writeNativeNamingConversation(fixture.file, fixture.nativeId, fixture.root)
  const host = await fixture.install()
  expect(await fixture.create()).toMatchObject({ ok: true })
  expect(await fixture.send()).toMatchObject({ ok: true })
  await vi.waitFor(() =>
    expect(host.readStatusSummary(HOST_TEST_SESSION)?.hostExecutionPhase).toBe('starting')
  )
  await host.setUserConversationName(HOST_TEST_SESSION, 'Before quit', 'rename')
  await vi.waitFor(async () => expect(await nativeNamingTitle(fixture.file)).toBe('Before quit'))
  await stopStructuredAgentSessionRuntime()
  expect(fixture.controls).toEqual([])
  expect(fixture.native.connections[0]?.exitVerdict.root).toBe('exited')
})
