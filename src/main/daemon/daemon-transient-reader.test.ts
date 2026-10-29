import { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { DaemonTransientReader } from './daemon-transient-reader'
import { attachStreamEventReader } from './daemon-client-ndjson-readers'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import { TerminalSnapshotState } from '../../shared/terminal-snapshot-state'
import { TerminalSnapshotConsumption } from '../../shared/terminal-snapshot-consumption'
import { SessionTransientObservations } from './session-transient-observations'
import { SessionOutputPlane } from './session-output-plane'
import type { DaemonEvent } from './daemon-stream-events'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('complete terminal state delivery', () => {
  it.each(['ndjson', 'binary-v1'] as const)(
    'recovers advancing effects once after a held %s gap without a FIFO',
    async (streamFraming) => {
      const socket = new Socket()
      const destination = new Socket()
      let deep = 0
      Object.defineProperty(socket, 'writableLength', { get: () => deep })
      const events: DaemonEvent[] = []
      const admission = new DaemonTransientReader((event) => events.push(event))
      const reader = attachStreamEventReader(
        destination,
        { streamFraming, remainder: Buffer.alloc(0) },
        (event) => admission.accept(event)
      )
      vi.spyOn(socket, 'write').mockImplementation((...args: unknown[]) => {
        const line = args[0]
        destination.push(Buffer.isBuffer(line) ? line : Buffer.from(String(line)))
        return deep === 0
      })
      const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: socket, streamFraming }), {
        isSessionDroppable: () => true
      })
      const state = new TerminalSnapshotState()
      const sink = batcher.bindTransients('client', 'canonical')!
      const consumption = new TerminalSnapshotConsumption()
      try {
        sink.install(state.snapshot(), 'incarnation', () => state.snapshot())
        batcher.flush('client')
        await tick()
        const first = events.find((event) => event.event === 'terminalObservation')
        expect(first?.sessionId).toBe('canonical')
        if (first?.event !== 'terminalObservation') {
          throw new Error('Missing initial state')
        }
        expect(consumption.consume(first.payload)?.effects).toEqual([])
        events.length = 0
        deep = 256 * 1024
        for (let ordinal = 1; ordinal <= 3; ordinal++) {
          state.record({ kind: 'command-started' })
          state.record({ kind: 'bell' })
          state.record({ kind: 'command-finished', exitCode: ordinal })
          state.state.rawEndSeq += 600_000
          batcher.enqueue('client', 'canonical', 'x'.repeat(600_000))
          sink.stage(state.snapshot())
          sink.commit()
          batcher.flush('client')
        }
        await tick()
        expect(events.filter((event) => event.event === 'terminalObservation')).toEqual([])
        deep = 0
        batcher.flush('client')
        await vi.waitFor(() =>
          expect(events.filter((event) => event.event === 'terminalObservation')).toHaveLength(1)
        )
        expect(events.some((event) => event.event === 'dataGap')).toBe(true)
        const states = events.filter((event) => event.event === 'terminalObservation')
        expect(states).toHaveLength(1)
        const last = states[0]
        if (last.event !== 'terminalObservation') {
          throw new Error('Missing final state')
        }
        expect(events.at(-1)).toEqual(last)
        const consumed = consumption.consume(last.payload)
        expect(consumed?.effects.map((effect) => effect.fact.kind)).toEqual([
          'command-started',
          'bell',
          'command-finished'
        ])
        expect(last.payload.effects['command-started']?.count).toBe(3)
        expect(last.payload.effects['command-finished']?.fact).toEqual({
          kind: 'command-finished',
          exitCode: 3
        })
        expect(last.payload.current.commandOrdinal).toBe(3)
        expect(consumption.consume(last.payload)?.effects).toEqual([])
        expect(consumption.consume(first.payload)).toBeNull()
      } finally {
        batcher.clear()
        reader.detach()
        socket.destroy()
        destination.destroy()
      }
    }
  )

  it.each(['ndjson', 'binary-v1'] as const)(
    'keeps the physical installation before first live effect under %s backpressure',
    async (streamFraming) => {
      const socket = new Socket()
      const destination = new Socket()
      let deep = 256 * 1024
      Object.defineProperty(socket, 'writableLength', { get: () => deep })
      const events: DaemonEvent[] = []
      const admission = new DaemonTransientReader((event) => events.push(event))
      const reader = attachStreamEventReader(
        destination,
        { streamFraming, remainder: Buffer.alloc(0) },
        (event) => admission.accept(event)
      )
      vi.spyOn(socket, 'write').mockImplementation((...args: unknown[]) => {
        const line = args[0]
        destination.push(Buffer.isBuffer(line) ? line : Buffer.from(String(line)))
        return deep === 0
      })
      const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: socket, streamFraming }))
      const plane = new SessionOutputPlane({ cols: 80, rows: 24, incarnationId: 'physical' })
      const emission = (data: string, start: number) => ({
        data,
        rawStartSeq: start,
        rawEndSeq: start + data.length
      })
      try {
        plane.emit(emission('\x07', 0))
        batcher.enqueue('client', 'canonical', 'x'.repeat(64 * 1024))
        plane.attachClient({
          transients: batcher.bindTransients('client', 'canonical'),
          onData: (data) => batcher.enqueue('client', 'canonical', data),
          onExit: () => {}
        })
        plane.emit(emission('\x07', 1))
        batcher.flush('client')
        await tick()
        expect(events.filter((event) => event.event === 'terminalObservation')).toHaveLength(0)
        deep = 0
        batcher.flush('client')
        await tick()
        await vi.waitFor(() =>
          expect(events.filter((event) => event.event === 'terminalObservation')).toHaveLength(2)
        )
        const observations = events.filter((event) => event.event === 'terminalObservation')
        expect(observations).toHaveLength(2)
        expect(
          observations.map(
            (event) => event.event === 'terminalObservation' && event.payload.effects.bell?.count
          )
        ).toEqual([1, 2])
        const cursor = new TerminalSnapshotConsumption()
        const applied = observations.flatMap((event) =>
          event.event === 'terminalObservation'
            ? (cursor.consume(event.payload)?.effects ?? [])
            : []
        )
        expect(applied.map((effect) => effect.fact.kind)).toEqual(['bell'])
      } finally {
        plane.markDisposed()
        plane.disposeEmulator()
        batcher.clear()
        reader.detach()
        socket.destroy()
        destination.destroy()
      }
    }
  )

  it('holds state without DATA and captured old cleanup cannot erase its replacement', () => {
    const socket = new Socket()
    let deep = 256 * 1024
    Object.defineProperty(socket, 'writableLength', { get: () => deep })
    const events: DaemonEvent[] = []
    vi.spyOn(socket, 'write').mockImplementation((...args: unknown[]) => {
      events.push(JSON.parse(String(args[0])))
      return deep === 0
    })
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: socket }))
    const state = new TerminalSnapshotState()
    const old = batcher.bindTransients('client', 'canonical')!
    const successor = batcher.bindTransients('client', 'canonical')!
    try {
      old.install(state.snapshot(), 'incarnation', () => state.snapshot())
      state.record({ kind: 'bell' })
      successor.install(state.snapshot(), 'incarnation', () => state.snapshot())
      old.dispose?.()
      batcher.flush('client')
      expect(events.filter((event) => event.event === 'terminalObservation')).toEqual([])
      deep = 0
      batcher.flush('client')
      expect(events.filter((event) => event.event === 'terminalObservation')).toMatchObject([
        { payload: { effects: { bell: { count: 1 } } } }
      ])
    } finally {
      batcher.clear()
      socket.destroy()
    }
  })

  it('retains independent finishes and current command plus split title, status and Command Code evidence', () => {
    const source = new SessionTransientObservations(() => {}, false, 'command-code')
    try {
      source.observe('\x1b]133;C\x07output\x1b]133;D;0\x07\x1b]133;C\x07', 30)
      source.observe('\x1b]2;Working', 42)
      source.observe(' title\x07\n❯ implement fix\nThinking…\n', 80)
      const active = source.snapshot()
      expect(active.current.command).toBe('running')
      expect(active.current.commandOrdinal).toBe(2)
      expect(active.effects['command-finished']?.commandOrdinal).toBe(1)
      expect(active.current.title?.rawTitle).toBe('Working title')
      expect(active.current.commandCode).toMatchObject({
        armed: true,
        prompt: 'implement fix',
        phase: 'working'
      })
      source.observe('\n❯ Ask your question...\n', 110)
      expect(source.snapshot().effects['command-code-done']?.fact).toMatchObject({
        prompt: 'implement fix'
      })
    } finally {
      source.dispose()
    }
  })
})
