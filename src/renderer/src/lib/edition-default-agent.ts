import type { TuiAgent } from '../../../shared/tui-agent'

/** Single-assistant edition: resolve the configured agent, preserving an explicit blank. */
export function resolveEditionDefaultAgent(
  defaultTuiAgent: TuiAgent | 'blank' | null | undefined
): TuiAgent | 'blank' {
  if (defaultTuiAgent === 'blank') {
    return 'blank'
  }
  if (defaultTuiAgent && defaultTuiAgent !== null) {
    return defaultTuiAgent
  }
  return 'opencode'
}
