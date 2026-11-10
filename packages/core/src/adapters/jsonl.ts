import type { EngineProcess } from '../shared.ts'

// Engines write one JSON message a line on stdout. Lines split on \n only, never with readline: JSON strings can hold
// U+2028 and U+2029, which readline takes as line ends. A \r before the \n is dropped, blank lines are skipped, and a
// line that isn't JSON goes to onOther (an engine's own logs); handle gets each message and its line. Call the returned
// flush when the process exits, so a last line without its \n is still read.
export function onJsonLines(
  proc: EngineProcess,
  handle: (msg: any, line: string) => void,
  onOther?: (line: string) => void,
) {
  let buffer = ''
  const read = (raw: string) => {
    const line = raw.replace(/\r$/, '')
    if (!line.trim()) return
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      onOther?.(line)
      return
    }
    handle(msg, line)
  }
  proc.onStdout((chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      read(line)
    }
  })
  return {
    flush() {
      const rest = buffer
      buffer = ''
      read(rest)
    },
  }
}
