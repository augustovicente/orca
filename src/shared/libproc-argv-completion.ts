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

function needsRecovery(
  row: LibprocProcessRow,
  selectedByPid: boolean,
  byPid: ReadonlyMap<number, LibprocProcessRow>
): boolean {
  return (
    row.commandIncomplete === true &&
    row.status !== SZOMB &&
    row.status !== SIDL &&
    (row.flags & P_WEXIT) === 0 &&
    !isOwnProcess(row) &&
    (selectedByPid || descendsFromUsersTerminal(row, byPid))
  )
}

/** One ps run's answer for a process; undefined when ps omitted it or failed. */
type Recovery = { startedAtMs: number; command: Promise<string | undefined> }
/** A positive answer ages from when ps started reading; a failure from when it ended, however long ps took. */
type Recovered = { startedAtMs: number; settledAtMs: number; command: string | undefined }

// exec can keep pid, start time and comm (node → node with another script) and no cheap field shows it, so display
// reads trust recovered argv for 30s; fresh readers take only argv ps read after their request.
const recovered = new Map<string, Recovered>()
const recovering = new Map<string, Recovery>()
const RECOVERED_LIMIT = 512
const RECOVERED_TTL_MS = 30_000
// A row ps could not answer (exited, or unreadable to it too) waits this long before costing another ps.
const UNRECOVERED_TTL_MS = 5_000

/** exec keeps pid and start time; comm usually changes, and microseconds split same-second pid reuse. */
function commandKey(ctype: string, row: LibprocProcessRow): string {
  return [ctype, row.pid, row.startSec, row.startUsec ?? '', row.comm].join('\0')
}

function remember(key: string, entry: Recovered): void {
  // A fresh reader's recovery can overtake an older one still running; the older answer must not replace it.
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
  deadline: number
): Promise<ReadonlyMap<number, string> | null> {
  try {
    const result = await runArgvRecoveryPs(
      ['-ww', '-o', 'pid=,command=', '-p', pids.join(',')],
      { env, maxOutputBytes: 1024 * 1024 },
      deadline
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
 * Concurrent callers share one ps per process; `notBeforeMs` refuses argv ps read before that instant. */
export async function completeCommands(
  rows: LibprocProcessRow[],
  selectedByPid: boolean,
  ctype: string,
  env: NodeJS.ProcessEnv,
  deadline: number,
  notBeforeMs?: number
): Promise<void> {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const now = monotonicNow()
  const pending: { row: LibprocProcessRow; command: Promise<string | undefined> }[] = []
  const missing: { row: LibprocProcessRow; key: string }[] = []
  for (const row of rows) {
    if (!needsRecovery(row, selectedByPid, byPid)) {
      continue
    }
    const key = commandKey(ctype, row)
    const known = recovered.get(key)
    // A failure only withholds argv, never serves stale argv, so fresh readers honour it too.
    if (known && known.command === undefined && now - known.settledAtMs < UNRECOVERED_TTL_MS) {
      continue
    }
    if (
      known?.command !== undefined &&
      now - known.startedAtMs < RECOVERED_TTL_MS &&
      (notBeforeMs === undefined || known.startedAtMs >= notBeforeMs)
    ) {
      row.command = known.command
      continue
    }
    const inFlight = recovering.get(key)
    if (inFlight && (notBeforeMs === undefined || inFlight.startedAtMs >= notBeforeMs)) {
      pending.push({ row, command: inFlight.command })
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
      deadline
    )
    for (const { row, key } of missing) {
      const recovery: Recovery = {
        startedAtMs,
        command: read.then((commands) => commands?.get(row.pid))
      }
      recovering.set(key, recovery)
      void recovery.command.then((command) => {
        remember(key, { startedAtMs, settledAtMs: monotonicNow(), command })
        if (recovering.get(key) === recovery) {
          recovering.delete(key)
        }
      })
      pending.push({ row, command: recovery.command })
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
  pending.forEach(({ row }, index) => {
    const command = commands[index]
    if (command !== undefined) {
      row.command = command
    }
  })
}
