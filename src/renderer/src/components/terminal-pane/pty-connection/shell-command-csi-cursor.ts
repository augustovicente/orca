export function createShellCommandCsiCursor(actions: {
  move: (delta: number) => void
  set: (position: number) => void
  length: () => number
  deleteCharacter: () => void
  reset: () => void
}) {
  return (data: string, index: number): number | null => {
    if (data.charCodeAt(index) !== 0x1b || data[index + 1] !== '[') {
      return null
    }
    let cursor = index + 2
    while (cursor < data.length && /[0-9;?]/.test(data[cursor]!)) {
      cursor += 1
    }
    const final = data[cursor]
    if (!final || !/[~A-Za-z]/.test(final)) {
      return null
    }
    const params = data.slice(index + 2, cursor)
    // Why: only emulate a bare one-column move. Parameterized/modified cursor keys
    // (e.g. Ctrl+Left `\x1b[1;5D` = word-jump) move the real cursor by more than
    // one, so tracking them as ±1 would desync the shadow line — fall through to
    // reset instead of silently corrupting the sampled command.
    if (final === 'D' && params === '') {
      actions.move(-1)
    } else if (final === 'C' && params === '') {
      actions.move(1)
    } else if (final === 'H' || (final === '~' && params === '1')) {
      actions.set(0)
    } else if (final === 'F' || (final === '~' && params === '4')) {
      actions.set(actions.length())
    } else if (final === '~' && params === '3') {
      actions.deleteCharacter()
    } else if (final === '~' && (params === '200' || params === '201')) {
      // Bracketed paste wrappers are terminal framing, not shell command text.
    } else {
      actions.reset()
    }
    return cursor + 1
  }
}
