import { PROVIDER_SPAWN_FAILURE_MARKER } from './provider-spawn-failure-report'

/** Time the provider gets to exit on its own after its stdin ends, before SIGTERM. */
export const PROVIDER_STDIN_END_GRACE_MS = 1_000
/** Time the provider group gets to flush and exit after SIGTERM, before SIGKILL. */
export const PROVIDER_SIGTERM_GRACE_MS = 3_000
/** Bound kernel kill completion; a process stuck on a hung drive must not hang close/recovery forever. */
export const PROVIDER_GROUP_REAP_TIMEOUT_MS = 1_500
/** Longest a supervisor waits, after its provider exits, to relay output still in the pipes. */
export const PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS = 1_000
/** Wrapper stop budget; killing it before both graces and reap finish can orphan the group. */
export const PROVIDER_SUPERVISOR_MAX_STOP_MS =
  PROVIDER_STDIN_END_GRACE_MS + PROVIDER_SIGTERM_GRACE_MS + PROVIDER_GROUP_REAP_TIMEOUT_MS

export const INSTALLED_LOOKUP_REQUEST = 'orca-installed-lookup'
export const INSTALLED_PLAN_REPLY = 'orca-installed-plan'
export type InstalledProviderPlan = {
  runtimePathBase: string | null
  candidates: { command: string; runtimeDirectory: string | null }[]
}

/** Inline supervisor source kept dependency-free for the spawned Node child. */
export const POSIX_PROVIDER_SUPERVISOR_SCRIPT = `
const { spawn } = require('node:child_process')
const spec = JSON.parse(Buffer.from(process.env.ORCA_PROVIDER_SUPERVISOR_SPEC, 'base64').toString())
// The provider's own argv, after this script's '--'.
const [providerCommand, ...providerArgs] = process.argv.slice(1)
// A detached supervisor is reparented when its owner exits. The new parent may
// be PID 1 or a platform subreaper, so any other parent means no live owner.
const ownerGone = () => process.ppid !== spec.ownerPid
const childEnv = { ...process.env, ...spec.nodeEnv }
delete childEnv.ORCA_PROVIDER_SUPERVISOR_SPEC
delete childEnv.ELECTRON_RUN_AS_NODE
// The owner sees only this pid's exit; this marked last stderr line says the provider never started.
const exitWithSpawnFailure = (error, thrown) => {
  const report = { thrown, code: (error && error.code) || 'UNKNOWN', message: String(error && error.message) }
  try { require('node:fs').writeSync(2, ${JSON.stringify(PROVIDER_SPAWN_FAILURE_MARKER)} + JSON.stringify(report) + '\\n') } catch {}
  process.exit(127)
}
// Orca opens the report channel only when it will keep the group's identity. Linux children
// inherit its fd, so /dev/null takes that slot and only this pid holds the channel.
const reports = typeof process.send === 'function'
const reportShield = reports ? require('node:fs').openSync('/dev/null', 'r') : null
let child
let committed = false
let awaitingPlan = false
let originalFailure
let deniedFailure
let installedPlan
let candidateIndex = 0
const closeReportShield = () => {
  if (reportShield !== null) { try { require('node:fs').closeSync(reportShield) } catch {} }
}
const protocolFailure = (error) => exitWithSpawnFailure(error || new Error('Installed lookup channel failed'), true)
const failAttempt = (error, thrown, installed) => {
  if (settling) return
  if (!installed) {
    if (!spec.installedFallback || !reports || error.code !== 'ENOENT') return exitWithSpawnFailure(error, thrown)
    originalFailure = { error, thrown }
    awaitingPlan = true
    try {
      process.send({ type: ${JSON.stringify(INSTALLED_LOOKUP_REQUEST)} }, (failure) => {
        if (failure && awaitingPlan && !settling) protocolFailure(failure)
      })
    } catch (failure) { protocolFailure(failure) }
    return
  }
  if (error.code === 'EACCES') deniedFailure ||= { error, thrown }
  else if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return exitWithSpawnFailure(error, thrown)
  setImmediate(nextInstalledAttempt)
}
const nextInstalledAttempt = () => {
  if (settling || committed) return
  if (ownerGone()) return stopProviderGroup(null)
  const candidate = installedPlan.candidates[candidateIndex++]
  if (!candidate) {
    const failure = deniedFailure || originalFailure
    return exitWithSpawnFailure(failure.error, failure.thrown)
  }
  let env = childEnv
  if (candidate.runtimeDirectory !== null) {
    const parts = installedPlan.runtimePathBase === null ? [] : installedPlan.runtimePathBase.split(':')
    env = { ...childEnv, PATH: [candidate.runtimeDirectory, ...parts.filter((part) => part !== candidate.runtimeDirectory)].join(':') }
  }
  attempt(candidate.command, env, true)
}
const attempt = (command, env, installed) => {
  if (settling || ownerGone()) return stopProviderGroup(null)
  let pending
  try {
    pending = spawn(command, providerArgs, {
      cwd: spec.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe', ...(reportShield === null ? [] : [reportShield])],
      detached: true
    })
  } catch (error) {
    return failAttempt(error, true, installed)
  }
  child = pending
  let failure
  pending.once('error', (error) => {
    if (committed) {
      clearInterval(timer)
      return exitWithSpawnFailure(error, false)
    }
    failure = error
    // Terminal failures need no next attempt or failed-pipe handoff.
    if ((!installed && (!spec.installedFallback || error.code !== 'ENOENT')) ||
        (installed && !['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code))) {
      exitWithSpawnFailure(error, false)
    }
  })
  pending.once('close', () => {
    if (!committed && failure) {
      child = undefined
      failAttempt(failure, false, installed)
    }
  })
  if (pending.pid) commitProvider()
  else pending.once('spawn', commitProvider)
}
const acceptPlan = (message) => {
  if (settling || committed || !awaitingPlan || message?.type !== ${JSON.stringify(INSTALLED_PLAN_REPLY)}) return
  awaitingPlan = false
  const valid = message.error === undefined &&
    (message.runtimePathBase === null || typeof message.runtimePathBase === 'string') &&
    Array.isArray(message.candidates) && message.candidates.every((entry) =>
      entry && typeof entry.command === 'string' && entry.command.startsWith('/') &&
      (entry.runtimeDirectory === null || typeof entry.runtimeDirectory === 'string'))
  if (!valid) return protocolFailure(new Error('Invalid installed lookup plan'))
  installedPlan = message
  nextInstalledAttempt()
}
let timer
let ownerShutdownTimer
let settling = false
let providerExited = false
const providerGroupExists = () => {
  if (!child?.pid) return false
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code !== 'ESRCH')
  }
}
const waitForProviderGroupExit = async (timeoutMs, untilProviderExits = false) => {
  const deadline = Date.now() + timeoutMs
  while (providerGroupExists()) {
    if (Date.now() >= deadline || (untilProviderExits && providerExited)) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}
const reapOwnedProviderGroup = async () => {
  if (!child?.pid) return false
  try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
    if (error && error.code !== 'ESRCH') return false
  }
  return waitForProviderGroupExit(${PROVIDER_GROUP_REAP_TIMEOUT_MS})
}
const finishWithProviderOutcome = (code, signal) => {
  if (!signal) return process.exit(code ?? 1)
  // Re-raise with the default action; this supervisor's own handler would swallow it.
  process.removeAllListeners(signal)
  process.kill(process.pid, signal)
}
// Every stop is the same: SIGTERM the group, SIGKILL it after its grace, and exit only once it is
// gone. Whoever stops this pid judges the provider by it, so a dead supervisor means a dead group.
const stopProviderGroup = (receivedSignal) => {
  if (settling) return
  settling = true
  clearInterval(timer)
  if (ownerShutdownTimer) clearTimeout(ownerShutdownTimer)
  if (!child?.pid) {
    closeReportShield()
    return finishWithProviderOutcome(137, receivedSignal)
  }
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
  // A one-shot's helpers die with it once it has exited; a session's keep the grace to clean up.
  void waitForProviderGroupExit(spec.sigtermGraceMs, spec.lifetime === 'one-shot')
    .then((exited) => exited || reapOwnedProviderGroup())
    .then((reaped) => {
      if (!reaped) return process.exit(1)
      finishWithProviderOutcome(137, receivedSignal)
    })
}
const scheduleOwnerShutdown = () => {
  if (settling || ownerShutdownTimer) return
  // A normal close ends the provider's stdin first; allow it to flush and
  // exit before forcing the group, while still bounding an orphaned child.
  ownerShutdownTimer = setTimeout(() => stopProviderGroup(null), spec.stdinEndGraceMs)
  ownerShutdownTimer.unref()
}
// A one-shot's stdin end is the end of its request, not a stop; only its owner's death stops it.
if (spec.lifetime !== 'one-shot') {
  process.stdin.once('end', scheduleOwnerShutdown)
  process.stdin.once('close', scheduleOwnerShutdown)
}
// A successful exec commits once; failed attempts never consume prompt bytes or report a group.
const commitProvider = () => {
  if (committed) return
  committed = true
  if (reports) {
    closeReportShield()
    const disconnect = () => { try { process.disconnect() } catch {} }
    try { process.send({ pgid: child.pid }, disconnect) } catch { disconnect() }
  }
  process.stdin.pipe(child.stdin)
  child.stdout.pipe(process.stdout)
  child.stderr.pipe(process.stderr)
  for (const stream of [process.stdin, process.stdout, process.stderr, child.stdin, child.stdout, child.stderr]) {
    stream.on('error', () => {})
  }
  child.once('exit', (code, signal) => {
    providerExited = true
    void reapProviderExit(code, signal)
  })
}
// Exit can land before the provider's last output is relayed; a one-shot's answer is that output.
const drainProviderOutput = () => {
  const ended = (stream) => stream.readableEnded || stream.destroyed ? null : new Promise((resolve) => {
    stream.once('end', resolve)
    stream.once('close', resolve)
  })
  const flushed = (stream) => new Promise((resolve) => stream.write('', resolve))
  const drained = Promise.all([child.stdout, child.stderr].map(ended))
    .then(() => Promise.all([process.stdout, process.stderr].map(flushed)))
  return Promise.race([drained, new Promise((resolve) => setTimeout(resolve, ${PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS}))])
}
const reapProviderExit = async (code, signal) => {
  if (settling) return
  settling = true
  clearInterval(timer)
  if (ownerShutdownTimer) clearTimeout(ownerShutdownTimer)
  if (!(await reapOwnedProviderGroup())) return process.exit(1)
  await drainProviderOutput()
  finishWithProviderOutcome(code, signal)
}
// An owner that is gone gets the close its owner would have asked for, made here on its behalf.
timer = setInterval(() => {
  if (!ownerGone()) return
  clearInterval(timer)
  if (!child?.pid) return stopProviderGroup(null)
  process.stdin.unpipe(child.stdin)
  try { child.stdin.end() } catch {}
  // A one-shot's stdin end was its request, so only a stop is left to ask for.
  if (spec.lifetime === 'one-shot' || spec.closeRequest !== 'stdin-end') return stopProviderGroup(null)
  scheduleOwnerShutdown()
}, 100)
timer.unref()
// Stop/owner/control listeners exist before the first attempt or any inventory wait.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => stopProviderGroup(signal))
if (reports) {
  process.on('message', acceptPlan)
  process.on('disconnect', () => { if (awaitingPlan && !settling) protocolFailure() })
}
if (ownerGone()) process.exit(1)
attempt(providerCommand, childEnv, false)
`
