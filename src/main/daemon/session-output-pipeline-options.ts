import type { SessionOptions } from './session-options'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { createSessionOutputPipeline } from './session-output-pipeline'

export function sessionOutputPipelineOptions(
  opts: SessionOptions,
  incarnationId: string,
  subprocess: SubprocessHandle,
  isAlive: () => boolean
): Parameters<typeof createSessionOutputPipeline>[0] {
  return {
    incarnationId,
    startupCommand: opts.startupCommand,
    cols: opts.cols,
    rows: opts.rows,
    scrollback: opts.scrollback,
    wslDistro: opts.wslDistro,
    historySeedChunks: opts.historySeedChunks,
    subprocess,
    isAlive
  }
}
