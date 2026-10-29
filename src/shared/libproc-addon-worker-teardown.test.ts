import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'

// Terminating a worker_thread with libproc reads still on the pool used to abort the whole process
// (uncaught Napi::Error from AsyncWorker::OnWorkComplete during env cleanup), so run it in a child.
const SCRIPT = String.raw`
const { Worker } = require('node:worker_threads')
const ptyDir = process.argv[1]
function once() {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      'const m = require(' + JSON.stringify(ptyDir + '/lib/utils') + ').loadNativeModule("pty").module;' +
        'for (let i = 0; i < 25; i++) { m.readProcessCwd(process.pid); m.readProcessPath(process.pid); m.readProcessTable({ command: true }) }' +
        'require("node:worker_threads").parentPort.postMessage(0)',
      { eval: true }
    )
    worker.on('message', () => worker.terminate().then(resolve, reject))
    worker.on('error', reject)
  })
}
;(async () => {
  for (let run = 0; run < 30; run += 1) await once()
  console.log('survived')
})()
`

describe.runIf(process.platform === 'darwin')('libproc addon worker teardown', () => {
  it(
    'survives terminating a worker thread with native reads in flight',
    { timeout: 60_000 },
    () => {
      const ptyDir = dirname(createRequire(__filename).resolve('node-pty/package.json'))
      const child = spawnSync(process.execPath, ['-e', SCRIPT, ptyDir], {
        encoding: 'utf8',
        timeout: 50_000
      })
      expect(child.stderr).not.toContain('terminating due to uncaught exception')
      expect(child.stdout.trim()).toBe('survived')
      expect(child.status).toBe(0)
    }
  )
})
