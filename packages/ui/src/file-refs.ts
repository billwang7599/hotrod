// Finding file paths in chat text, for file links. Only finds what could be a path; the core says which ones really
// exist for the chat (files.check), and only those become links. URLs never match.

/** A path in a text: where it is, the path as written, and the line and column after it (`a.ts:52:3`). */
export type FileRef = { start: number; end: number; path: string; line?: number; col?: number }

// One path segment: starts with a word character or @, + or -, then may hold dots (`a.test.ts`, `.env` mid-path).
const SEG = String.raw`[\w@+-][\w.@+-]*`
// A path: optional ~/, ./, ../ or / in front, segments joined by /, an optional trailing /, then :line and :col. It
// can't follow a character that would make it part of something longer: a word, a path, or a URL's `://`.
const PATH = new RegExp(
  String.raw`(?<![\w./~@+:\\-])((?:~/|\.{1,2}/|/)?(?:${SEG}/)*${SEG}/?)(?::(\d+)(?::(\d+))?)?(?![\w/])`,
  'g',
)
// A file name's extension, which must start with a letter, so `1.5` and `v2.0` aren't files.
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/
const LINE_SUFFIX = /^(.*?)(?::(\d+)(?::(\d+))?)?$/s
// More than this many characters of text, or paths in it, isn't searched further (a huge tool output).
export const MAX_TEXT = 20_000
const MAX_REFS = 100

/** Whether text looks like a path: it has a folder in it, or ends in a file extension. */
export const looksLikePath = (text: string) =>
  text.length > 1 && text.length <= 1024 && !/[\n<>|*?"`]/.test(text) && !/^\w+:\/\//.test(text) &&
  (text.includes('/') ? /[\w.]/.test(text.replace(/^~/, '')) : EXTENSION.test(text))

const positive = (digits?: string) => {
  const n = digits === undefined ? undefined : Number(digits)
  return n && n > 0 && Number.isSafeInteger(n) ? n : undefined
}

/** Every path-like run in plain text, in order. */
export function fileRefsIn(text: string): FileRef[] {
  if (text.length > MAX_TEXT) return []
  const refs: FileRef[] = []
  for (const match of text.matchAll(PATH)) {
    // A sentence's full stop isn't part of the path.
    const path = match[1]!.replace(/\.+$/, '')
    if (!looksLikePath(path)) continue
    const line = path === match[1] ? positive(match[2]) : undefined
    const col = line === undefined ? undefined : positive(match[3])
    const start = match.index
    const end = line === undefined ? start + path.length : start + match[0].length
    refs.push({ start, end, path, ...(line !== undefined && { line }), ...(col !== undefined && { col }) })
    if (refs.length >= MAX_REFS) break
  }
  return refs
}

/** A whole code span as a path (`packages/core/src/core.ts:52`), which may hold spaces; null if it doesn't look like one. */
export function codeRef(text: string): Omit<FileRef, 'start' | 'end'> | null {
  const [, raw = '', lineText, colText] = LINE_SUFFIX.exec(text.trim()) ?? []
  if (!looksLikePath(raw) || /^\s|\s$/.test(raw)) return null
  // A command (`cat src/a.ts`) is a code span with a space before its first slash: not a path.
  if (/\s/.test(raw) && !/^[~./]/.test(raw)) return null
  const line = positive(lineText)
  const col = line === undefined ? undefined : positive(colText)
  return { path: raw, ...(line !== undefined && { line }), ...(col !== undefined && { col }) }
}

/** Text split into plain runs and the paths in it. */
export function splitByRefs(text: string): (string | FileRef)[] {
  const parts: (string | FileRef)[] = []
  let at = 0
  for (const ref of fileRefsIn(text)) {
    if (ref.start > at) parts.push(text.slice(at, ref.start))
    parts.push(ref)
    at = ref.end
  }
  if (at < text.length) parts.push(text.slice(at))
  return parts
}
