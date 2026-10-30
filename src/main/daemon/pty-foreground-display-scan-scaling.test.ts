import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as pty from 'node-pty'
import type * as ProcessTablePsCapture from '../../shared/process-table-ps-capture'
import type * as ProcessHost from '@orca/process-host'

const { captureProcessTableMock, runProcessMock } = vi.hoisted(() => ({
  captureProcessTableMock: vi.fn(),
  runProcessMock: vi.fn()
}))

vi.mock('../../shared/process-table-ps-capture', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessTablePsCapture>()),
  captureProcessTable: captureProcessTableMock
}))

vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessHost>()),
  runProcess: runProcessMock
}))

import { createPtyForegroundProcessTracker } from './pty-subprocess/foreground-process-tracker'
import { resetProcessTableSnapshotForTests } from '../../shared/process-table-snapshot-reader'

const CODEX = 'node /usr/lib/node_modules/@openai/codex/bin/codex.js'

function shellPid(pane: number): number {
  return 10_000 + pane * 10
}

/** Linux PS_ARGS rows: every pane runs npm Codex, whose node-pty leader name (`node`) refreshes every second. */
function table(panes: number): string {
  return Array.from({ length: panes }, (_, pane) => {
    const shell = shellPid(pane)
    const agent = shell + 1
    return [
      `${shell} 1 ${shell} ${agent} Ss pts/${pane} 9 -zsh`,
      `${agent} ${shell} ${agent} ${agent} S+ pts/${pane} 5 ${CODEX}`
    ].join('\n')
  }).join('\n')
}

function trackers(panes: number) {
  return Array.from({ length: panes }, (_, pane) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tracker and resolver read only these members.
    const proc = {
      pid: shellPid(pane),
      process: 'node',
      ptsName: `/dev/pts/${pane}`,
      getForegroundProcessGroup: () => shellPid(pane) + 1
    } as unknown as pty.IPty
    return createPtyForegroundProcessTracker({
      process: proc,
      shellPath: '/bin/zsh',
      sessionId: `pane-${pane}`,
      startupAgentRecognition: null,
      isDead: () => false
    })
  })
}

async function refreshRound(panes: number): Promise<{ captures: number; names: string[] }> {
  resetProcessTableSnapshotForTests()
  captureProcessTableMock.mockReset()
  captureProcessTableMock.mockResolvedValue(table(panes))
  const all = trackers(panes)
  for (const tracker of all) {
    tracker.getForegroundProcess()
  }
  await vi.waitFor(() =>
    expect(all.every((tracker) => tracker.getForegroundProcess() === 'codex')).toBe(true)
  )
  return {
    captures: captureProcessTableMock.mock.calls.length,
    names: all.map((tracker) => tracker.getForegroundProcess() ?? '')
  }
}

describe('display foreground refresh from the PTY master group', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resetProcessTableSnapshotForTests()
  })

  it('shares one process-table capture however many panes refresh', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const small = await refreshRound(4)
    const large = await refreshRound(40)

    expect(small.names).toEqual(Array(4).fill('codex'))
    expect(large.names).toEqual(Array(40).fill('codex'))
    expect(small.captures).toBe(1)
    expect(large.captures).toBe(small.captures)
    // No pane spawns its own terminal-scoped ps for display.
    expect(runProcessMock).not.toHaveBeenCalled()
  })
})
