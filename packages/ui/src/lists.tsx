import { memo, type ReactNode } from 'react'

/*
 * Lists in what the user types. The user's own messages aren't Markdown: they show as typed, with every newline kept,
 * and a casual `#`, `*` or `_` stays a character. Only list lines (`- a`, `* a`, `+ a`, `1. a`, `1) a`, `- [ ] a`)
 * become real lists, nested by indentation. Lines inside a ``` or ~~~ fence stay text.
 */

const LIST_LINE = /^([ \t]*)([-*+]|\d{1,3}[.)])([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/
const FENCE = /^[ \t]*(```|~~~)/

/** A list line's parts: `  1. [ ] rest` is indent, marker, gap, box and rest; prefix is all but the rest. */
type ListLine = { indent: string; marker: string; gap: string; box: string; rest: string; prefix: string }
function listLine(line: string): ListLine | null {
  const match = LIST_LINE.exec(line)
  if (!match) return null
  const [, indent = '', marker = '', gap = '', box = '', rest = ''] = match
  return { indent, marker, gap, box, rest, prefix: indent + marker + gap + box }
}
const numbered = (marker: string) => /\d/.test(marker)

type ListItem = { text: string; checked?: boolean; lists: List[] }
type List = { ordered: boolean; start: number; items: ListItem[] }
type Block = { kind: 'text'; text: string } | { kind: 'list'; list: List }

/** Columns of leading whitespace, a tab counting as 4. */
const width = (indent: string) => [...indent].reduce((n, c) => n + (c === '\t' ? 4 : 1), 0)

/** Splits a message into runs of plain text and lists. */
export function blocksOf(text: string): Block[] {
  const blocks: Block[] = []
  let lines: string[] = []
  // The open lists, outermost first, each with the indent of its items and its latest item.
  let stack: { indent: number; list: List; last: ListItem }[] = []
  let fenced = false
  const flushText = () => {
    // A blank line beside a list is the list's own spacing.
    while (lines.length && !lines[0]?.trim()) lines.shift()
    while (lines.length && !lines.at(-1)?.trim()) lines.pop()
    if (lines.length) blocks.push({ kind: 'text', text: lines.join('\n') })
    lines = []
  }
  for (const line of text.split('\n')) {
    const fence = FENCE.test(line)
    if (fence) fenced = !fenced
    const parsed = fenced || fence ? null : listLine(line)
    const top = stack.at(-1)
    if (!parsed) {
      // An indented line right after an item continues it.
      if (top && !fenced && /^[ \t]+\S/.test(line)) {
        top.last.text += '\n' + line.trim()
        continue
      }
      stack = []
      lines.push(line)
      continue
    }
    const at = width(parsed.indent)
    const ordered = numbered(parsed.marker)
    const item: ListItem = { text: parsed.rest, lists: [] }
    if (parsed.box) item.checked = parsed.box[1] !== ' '
    while ((stack.at(-1)?.indent ?? -1) > at) stack.pop()
    const open = stack.at(-1)
    if (open && open.indent === at && open.list.ordered === ordered) {
      open.list.items.push(item)
      open.last = item
      continue
    }
    const list: List = { ordered, start: ordered ? parseInt(parsed.marker, 10) : 1, items: [item] }
    // Same indent, other kind of list: a new list beside it.
    if (open && open.indent === at) stack.pop()
    const parent = stack.at(-1)
    if (parent) parent.last.lists.push(list)
    else {
      flushText()
      blocks.push({ kind: 'list', list })
    }
    stack.push({ indent: at, list, last: item })
  }
  flushText()
  return blocks
}

const LIST_CLASS = 'my-2 pl-20 [&_li+li]:mt-2'

function ListView({ list, depth }: { list: List; depth: number }): ReactNode {
  const items = list.items.map((item, i) => (
    <li key={i} className={item.checked === undefined ? undefined : 'list-none'}>
      {item.checked !== undefined && (
        <input
          type="checkbox"
          checked={item.checked}
          disabled
          readOnly
          className="mr-6 -ml-18 align-[-1px]"
          aria-label={item.checked ? 'Done' : 'Not done'}
        />
      )}
      {item.text}
      {item.lists.map((sub, j) => (
        <ListView key={j} list={sub} depth={depth + 1} />
      ))}
    </li>
  ))
  if (list.ordered)
    return (
      <ol className={`${LIST_CLASS} list-decimal`} start={list.start === 1 ? undefined : list.start}>
        {items}
      </ol>
    )
  const bullet = ['list-disc', 'list-[circle]', 'list-[square]'][Math.min(depth, 2)]
  return <ul className={`${LIST_CLASS} ${bullet}`}>{items}</ul>
}

/** A user's message as typed, with its lists rendered. Text without a list renders as the plain string. */
export const UserText = memo(function UserText({ text }: { text: string }) {
  if (!/^[ \t]*([-*+]|\d{1,3}[.)])[ \t]/m.test(text)) return <>{text}</>
  return (
    <>
      {blocksOf(text).map((b, i) =>
        b.kind === 'text' ? <div key={i}>{b.text}</div> : <ListView key={i} list={b.list} depth={0} />,
      )}
    </>
  )
})

/* Editing lists in the message box. Each returns the edit to make, or null to leave the key alone. */

/** Replace `[from, to)` of the text with `insert`, then select `[selStart, selEnd]`. */
export type ListEdit = { from: number; to: number; insert: string; selStart: number; selEnd: number }

const lineStart = (text: string, at: number) => text.lastIndexOf('\n', at - 1) + 1
const lineEnd = (text: string, at: number) => {
  const end = text.indexOf('\n', at)
  return end === -1 ? text.length : end
}

/**
 * A new line from inside a list item continues the list: the same indent and bullet, the next number, an empty
 * checkbox. On an item with nothing after its marker, it ends the list instead by removing the marker.
 */
export function continueList(text: string, start: number, end: number): ListEdit | null {
  if (start !== end) return null
  const from = lineStart(text, start)
  const line = text.slice(from, lineEnd(text, start))
  const item = listLine(line)
  // Only from the end of the marker onwards: a caret inside the indent or marker is a plain new line.
  if (!item || start - from < item.prefix.length) return null
  const { indent, marker, gap, box, rest } = item
  if (!rest.trim()) return { from, to: from + line.length, insert: '', selStart: from, selEnd: from }
  const next = numbered(marker) ? `${parseInt(marker, 10) + 1}${marker.slice(-1)}` : marker
  const insert = `\n${indent}${next}${gap}${box ? '[ ] ' : ''}`
  return { from: start, to: start, insert, selStart: start + insert.length, selEnd: start + insert.length }
}

const INDENT = '  '

/**
 * Tab indents, and Shift+Tab outdents, every list line the selection touches, when the caret's line is one. A
 * numbered item takes the next number at its new level, or 1 when it starts one.
 */
export function indentList(text: string, start: number, end: number, outdent: boolean): ListEdit | null {
  const from = lineStart(text, start)
  const to = lineEnd(text, Math.max(start, end - (end > start && text[end - 1] === '\n' ? 1 : 0)))
  const lines = text.slice(from, to).split('\n')
  if (!listLine(lines[0] ?? '')) return null
  const before = text.slice(0, from).split('\n')
  before.pop()
  // Each changed line: where its old prefix (indent and marker) was, and how long the old and new prefixes are.
  const changes: { at: number; old: number; now: number }[] = []
  let offset = from
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const item = listLine(line)
    if (item) {
      const { indent, marker } = item
      const moved = !outdent ? INDENT + indent : indent.startsWith('\t') ? indent.slice(1) : indent.replace(/^ {1,2}/, '')
      if (moved !== indent) {
        const mark = numbered(marker)
          ? `${numberAt([...before, ...lines.slice(0, i)], width(moved))}${marker.slice(-1)}`
          : marker
        lines[i] = moved + mark + line.slice(indent.length + marker.length)
        changes.push({ at: offset, old: indent.length + marker.length, now: moved.length + mark.length })
      }
    }
    offset += line.length + 1
  }
  const insert = lines.join('\n')
  // A position after a changed prefix moves with it; one inside it stays inside the new one.
  const map = (p: number) => {
    let shift = 0
    for (const c of changes) {
      if (p >= c.at + c.old) shift += c.now - c.old
      else if (p > c.at) shift += Math.min(p - c.at, c.now) - (p - c.at)
    }
    return p + shift
  }
  // With nothing to outdent this still takes the key, so Shift+Tab doesn't leave the box from a list line.
  return { from, to, insert, selStart: map(start), selEnd: map(end) }
}

/** The number a numbered item at this indent takes after the given lines: one past the item above at its level. */
function numberAt(above: string[], at: number): number {
  for (let i = above.length - 1; i >= 0; i--) {
    const item = listLine(above[i] ?? '')
    if (!item) return 1
    const indent = width(item.indent)
    if (indent < at) return 1
    if (indent === at) return numbered(item.marker) ? parseInt(item.marker, 10) + 1 : 1
  }
  return 1
}

/**
 * Makes an edit in a textarea the way typing would: through the browser's own insert, so Undo takes it back and React
 * sees an input event. Where that isn't available (jsdom), it sets the value and fires the input event itself.
 */
export function applyEdit(box: HTMLTextAreaElement, edit: ListEdit) {
  if (box.value.slice(edit.from, edit.to) === edit.insert) return box.setSelectionRange(edit.selStart, edit.selEnd)
  box.setSelectionRange(edit.from, edit.to)
  const inserted =
    typeof document.execCommand === 'function' &&
    (edit.insert ? document.execCommand('insertText', false, edit.insert) : document.execCommand('delete'))
  if (!inserted) {
    const value = box.value.slice(0, edit.from) + edit.insert + box.value.slice(edit.to)
    if (box.value !== value) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, value)
      box.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }
  box.setSelectionRange(edit.selStart, edit.selEnd)
}
