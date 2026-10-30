import { isTerminalQueryReply } from './terminal-query-reply'

// Why: xterm answers focus changes (CSI I / CSI O) through input that carries no provenance.
// oxlint-disable-next-line no-control-regex -- focus reports are ESC-framed sequences by definition.
const TERMINAL_FOCUS_REPORTS_ONLY_RE = new RegExp('^(?:\\u001b\\[[IO])+$')

export function isTerminalFocusReportOnly(payload: string): boolean {
  return TERMINAL_FOCUS_REPORTS_ONLY_RE.test(payload)
}

/** Input with no provenance that no person typed: a whole terminal reply or only focus reports. */
export function isUntypedTerminalInput(payload: string): boolean {
  return isTerminalQueryReply(payload) || isTerminalFocusReportOnly(payload)
}

const TERMINAL_POINTER_REPORTS_ONLY_RE = new RegExp(
  // oxlint-disable-next-line no-control-regex -- mouse reports are ESC-framed sequences by definition.
  '^(?:\\u001b\\[<\\d+;\\d+;\\d+[Mm]|\\u001b\\[M[\\s\\S]{3})+$'
)

/** Mouse reports only (hover, click, wheel): a person pointing at or reading a terminal, never typing into it. */
export function isTerminalPointerReportOnly(payload: string): boolean {
  return TERMINAL_POINTER_REPORTS_ONLY_RE.test(payload)
}
