import { describe, expect, it, vi } from 'vitest'
import { inspectRuntimePtyProcess } from './runtime-terminal-process-inspection'
import type { PtyProcessInspection } from '../../providers/pty-process-inspection'

describe('runtime handle foreground observation contract', () => {
  it('forwards the existing operation and projects the host leaf identity to the requested handle', async () => {
    const answer: PtyProcessInspection = {
      foregroundProcess: 'claude',
      hasChildProcesses: true,
      childProcessEvidence: 'unverifiable',
      foregroundObservation: {
        ptyId: 'leaf',
        ptyIncarnationId: 'inc',
        authorityGeneration: 'host',
        observationEpoch: 1,
        capturedAgeMs: 0,
        verdict: 'observed',
        source: 'pty-master',
        foregroundKind: 'non-shell',
        processName: 'claude'
      }
    }
    const inspectProcess = vi.fn(async () => answer)
    const result = await inspectRuntimePtyProcess(
      { inspectProcess, getForegroundProcess: vi.fn() },
      () => 'leaf',
      'term_1',
      { expectedIncarnationId: 'inc', foregroundOnly: true }
    )
    expect(inspectProcess).toHaveBeenCalledExactlyOnceWith('leaf', {
      expectedIncarnationId: 'inc',
      foregroundOnly: true
    })
    expect(result.foregroundObservation).toMatchObject({ ptyId: 'term_1', ptyIncarnationId: 'inc' })
    expect(result.childProcessEvidence).toBe('unverifiable')
    expect(answer.foregroundObservation?.ptyId).toBe('leaf')
  })
  it('discards a delayed result for a replaced leaf and retains a bare old-host response shape', async () => {
    let leaf = 'first'
    const answer = { foregroundProcess: 'claude', hasChildProcesses: true }
    const inspectProcess = vi.fn(async () => {
      leaf = 'replacement'
      return answer
    })
    await expect(
      inspectRuntimePtyProcess(
        { inspectProcess, getForegroundProcess: vi.fn() },
        () => leaf,
        'term_1'
      )
    ).rejects.toThrow('terminal_handle_stale')
    inspectProcess.mockImplementation(async () => answer)
    expect(
      await inspectRuntimePtyProcess(
        { inspectProcess, getForegroundProcess: vi.fn() },
        () => leaf,
        'term_1'
      )
    ).toBeDefined()
    expect(inspectProcess).toHaveBeenLastCalledWith('replacement')
  })
})
