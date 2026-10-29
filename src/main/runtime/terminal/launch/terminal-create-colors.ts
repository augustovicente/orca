import * as dependencies from '../../orca-runtime-create-terminal-dependencies'

export function rememberTerminalCreateColors(opts: dependencies.TerminalCreateOptions): void {
  const callerColors = dependencies.normalizeColorQueryReplyColors(opts.terminalColorQueryReplies)
  // Older paired clients report their theme only at creation.
  if (callerColors) {
    dependencies.setPairedViewerColors(callerColors)
  }
}
