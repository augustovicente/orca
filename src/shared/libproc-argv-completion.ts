import type { LibprocProcessRow } from './libproc-addon'
import { DEADLINE_PASSED, beforeDeadline, monotonicNow } from './deadline-settle-notifier'
import { NODEV, P_WEXIT, SIDL, SZOMB } from './libproc-ps-format'
import { runArgvRecoveryPs } from './libproc-ps-fallback'

const MAX_ANCESTOR_DEPTH = 64

/** KERN_PROCARGS2 refuses only another euid's argv; our own fails just mid-exec or exiting, where setuid ps fails too. */
function isOwnProcess(row: LibprocProcessRow): boolean {
  const ownUid = process.geteuid?.()
  return row.uid !== undefined && ownUid !== undefined ? row.uid === ownUid : !row.commandIncomplete
}

/** A pane descendant: the foreign chain above it starts on the terminal of one of the user's own processes, e.g.
 * `sudo` under the pane shell, and the root shell and agent `sudo -i` puts on its own pty (use_pty).
 * Root daemons descend only from launchd, and a pane's root `login` opens its own pty under the terminal host, so
 * neither costs a ps. */
function descendsFromUsersTerminal(
  row: LibprocProcessRow,
  byPid: ReadonlyMap<number, LibprocProcessRow>
): boolean {
  let top = row
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    const parent = top.pid === top.ppid ? undefined : byPid.get(top.ppid)
    if (!parent) {
      return false
    }
    if (isOwnProcess(parent)) {
      return parent.tdev !== NODEV && parent.tdev === top.tdev
    }
    top = parent
  }
  return false
}

/** Which rows the caller asked ps for: `-p` pids, one `-t` terminal, or the whole table. */
export type CommandSelection = 'pids' | 'tty' | 'all'

function needsRecovery(
  row: LibprocProcessRow,
  selection: CommandSelection,
  byPid: ReadonlyMap<number, LibprocProcessRow>
): boolean {
  return (
    row.commandIncomplete === true &&
    row.status !== SZOMB &&
    row.status !== SIDL &&
    (row.flags & P_WEXIT) === 0 &&
    !isOwnProcess(row) &&
    (selection === 'pids' ||
      // After `exec su` no process of ours is left on the terminal; its foreground group is what callers judge.
      (selection === 'tty' && row.pgid === row.tpgid) ||
      descendsFromUsersTerminal(row, byPid))
  )
}

/** A positive answer ages from when ps started reading; a failure from when it ended, however long ps took. */
type Recovered = { startedAtMs: number; settledAtMs: number; command: string | undefined }

// exec can keep pid, start time and comm (node → node with another script) and no cheap field shows it, so recovered
// argv is reused for at most 2s, and every row carries when ps read it so evidence reports its oldest input's age.
const recovered = new Map<string, Recovered>()
// One ps run's answer per process; undefined when ps omitted it, failed or the budget withheld it.
const recovering = new Map<string, { startedAtMs: number; command: Promise<string | undefined> }>()
const RECOVERED_LIMIT = 512
const RECOVERED_TTL_MS = 2_000
// A row ps could not answer (exited, or unreadable to it too) waits this long before costing another ps.
const UNRECOVERED_TTL_MS = 5_000

/** exec keeps pid and start time; comm usually changes, and microseconds split same-second pid reuse. */
function commandKey(ctype: string, row: LibprocProcessRow): string {
  return [ctype, row.pid, row.startSec, row.startUsec ?? '', row.comm].join('\0')
}

function remember(key: string, entry: Recovered): void {
  // A recovery begun past an older one's window can finish first; the older answer must not replace it.
  if ((recovered.get(key)?.startedAtMs ?? Number.NEGATIVE_INFINITY) > entry.startedAtMs) {
    return
  }
  recovered.delete(key)
  for (const oldest of recovered.keys()) {
    if (recovered.size < RECOVERED_LIMIT) {
      break
    }
    recovered.delete(oldest)
  }
  recovered.set(key, entry)
}

async function readCommands(
  pids: readonly number[],
  env: NodeJS.ProcessEnv,
  deadline: number,
  background: boolean
): Promise<ReadonlyMap<number, string> | null> {
  try {
    const result = await runArgvRecoveryPs(
      ['-ww', '-o', 'pid=,command=', '-p', pids.join(',')],
      { env, maxOutputBytes: 1024 * 1024 },
      deadline,
      background
    )
    if (result.timedOut || result.outputTruncated || (result.code !== 0 && result.code !== 1)) {
      return null
    }
    const commands = new Map<number, string>()
    for (const line of result.stdout.split('\n')) {
      const match = /^\s*(\d+) (.*)$/.exec(line)
      if (match) {
        commands.set(Number(match[1]), match[2])
      }
    }
    return commands
  } catch {
    return null
  }
}

/** Fill argv only setuid ps can read, for the rows this caller selected or that descend from a user's terminal.
 * Concurrent callers share one ps per process; `background` polls yield the recovery budget to interactive reads. */
export async function completeCommands(
  rows: LibprocProcessRow[],
  selection: CommandSelection,
  ctype: string,
  env: NodeJS.ProcessEnv,
  deadline: number,
  background: boolean
): Promise<void> {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const now = monotonicNow()
  const pending: {
    row: LibprocProcessRow
    readAtMs: number
    command: Promise<string | undefined>
  }[] = []
  const missing: { row: LibprocProcessRow; key: string }[] = []
  for (const row of rows) {
    if (!needsRecovery(row, selection, byPid)) {
      continue
    }
    const key = commandKey(ctype, row)
    const known = recovered.get(key)
    // A failure only withholds argv (the row reads unverifiable), never serves stale argv.
    if (known && known.command === undefined && now - known.settledAtMs < UNRECOVERED_TTL_MS) {
      continue
    }
    if (known?.command !== undefined && now - known.startedAtMs < RECOVERED_TTL_MS) {
      row.command = known.command
      row.commandReadAtMs = known.startedAtMs
      continue
    }
    // A run begun too long ago reads argv older than this caller may reuse.
    const inFlight = recovering.get(key)
    if (inFlight && now - inFlight.startedAtMs < RECOVERED_TTL_MS) {
      pending.push({ row, readAtMs: inFlight.startedAtMs, command: inFlight.command })
    } else {
      missing.push({ row, key })
    }
  }
  if (deadline <= monotonicNow()) {
    return
  }
  if (missing.length > 0) {
    const startedAtMs = monotonicNow()
    const read = readCommands(
      missing.map(({ row }) => row.pid),
      env,
      deadline,
      background
    )
    for (const { row, key } of missing) {
      const recovery = { startedAtMs, command: read.then((commands) => commands?.get(row.pid)) }
      recovering.set(key, recovery)
      void recovery.command.then((command) => {
        remember(key, { startedAtMs, settledAtMs: monotonicNow(), command })
        if (recovering.get(key) === recovery) {
          recovering.delete(key)
        }
      })
      pending.push({ row, readAtMs: startedAtMs, command: recovery.command })
    }
  }
  if (pending.length === 0) {
    return
  }
  const commands = await beforeDeadline(
    Promise.all(pending.map(({ command }) => command)),
    deadline
  )
  if (commands === DEADLINE_PASSED) {
    return
  }
  pending.forEach(({ row, readAtMs }, index) => {
    const command = commands[index]
    if (command !== undefined) {
      row.command = command
      row.commandReadAtMs = readAtMs
    }
  })
}
