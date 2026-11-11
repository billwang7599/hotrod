import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { EditorSelection, EditorState, type Extension, Prec, type Range, StateField } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  placeholder as placeholderText,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands'
import { defineLanguageFacet, Language, syntaxTree } from '@codemirror/language'
import { GFM, type MarkdownConfig, parser as baseParser } from '@lezer/markdown'
import { Button } from './controls.tsx'
import { highlightRanges } from './highlight.ts'

/**
 * A Markdown editor with live preview, as Obsidian's: the text stays plain Markdown, but on lines the cursor isn't on,
 * the marks (#, **, `, [[ ]], link URLs) are hidden and the text is drawn as it reads: tasks as checkboxes you can
 * tick, tables as tables, pictures from the web as pictures, code coloured. Built on CodeMirror 6 with only its core
 * packages and the Lezer Markdown parser (no language bundles), so it adds little to the window.
 *
 * [[wikilinks]] and #tags are parsed too; clicking one calls onLink or onTag, and a web link opens in the browser. On
 * the line being edited, ⌘-click (Ctrl elsewhere) follows it, so a plain click can still place the cursor. Enter carries
 * a list on, Tab and Shift-Tab indent, pasting a URL over selected text makes a link, and typing [[ offers the names
 * in completions.
 */

const OPEN = 91 // [
const HASH = 35 // #

// A tag: #, then letters, digits, _, - or /, with at least one that isn't a digit (so #1 stays text).
const TAG_BODY = /^[\p{L}\p{N}_\-/]+/u

const WikiLinks: MarkdownConfig = {
  defineNodes: ['WikiLink', 'WikiLinkMark', 'WikiLinkTarget'],
  parseInline: [
    {
      name: 'WikiLink',
      before: 'Link',
      parse(cx, next, pos) {
        if (next !== OPEN || cx.char(pos + 1) !== OPEN) return -1
        const rest = cx.slice(pos + 2, cx.end)
        const close = rest.indexOf(']]')
        const inner = close > 0 ? rest.slice(0, close) : ''
        if (!inner.trim() || /[[\]\n]/.test(inner)) return -1
        const end = pos + 2 + close + 2
        const bar = inner.indexOf('|')
        // With an alias ([[target|shown]]), the target and its bar are marks too: only the alias reads.
        const target = bar >= 0 ? [cx.elt('WikiLinkTarget', pos + 2, pos + 2 + bar + 1)] : []
        return cx.addElement(
          cx.elt('WikiLink', pos, end, [cx.elt('WikiLinkMark', pos, pos + 2), ...target, cx.elt('WikiLinkMark', end - 2, end)]),
        )
      },
    },
  ],
}

const Tags: MarkdownConfig = {
  defineNodes: ['Tag'],
  parseInline: [
    {
      name: 'Tag',
      parse(cx, next, pos) {
        if (next !== HASH) return -1
        const before = pos > cx.offset ? cx.char(pos - 1) : 32
        if (before !== 32 && before !== 9 && before !== 10 && before !== 40) return -1
        const body = TAG_BODY.exec(cx.slice(pos + 1, cx.end))?.[0]
        if (!body || /^\d+$/.test(body)) return -1
        return cx.addElement(cx.elt('Tag', pos, pos + 1 + body.length))
      },
    },
  ],
}

// Only Lezer's Markdown parser, with GFM, links and tags; no nested languages in code blocks.
const markdown = new Language(defineLanguageFacet(), baseParser.configure([GFM, WikiLinks, Tags]), [], 'markdown')

/** A wikilink's target: what's before any | (alias) or # (heading), trimmed. */
export const linkTarget = (inner: string) => inner.split('|')[0]!.split('#')[0]!.trim()

/** Every [[wikilink]] target in a text, in order, without repeats. */
export function wikiLinksIn(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
    const target = linkTarget(match[1]!)
    if (target && !found.includes(target)) found.push(target)
  }
  return found
}

// A link the editor opens in the browser: the web and mail only.
const openable = (url: string) => /^(https?:|mailto:)/i.test(url)

class Bullet extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-md-bullet'
    span.textContent = '•'
    return span
  }
}

class Rule extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-md-hr'
    return span
  }
}

// A task's [ ] or [x], as a checkbox; clicking it ticks the task in the text (see the mousedown handler).
class Checkbox extends WidgetType {
  readonly checked: boolean
  constructor(checked: boolean) {
    super()
    this.checked = checked
  }
  eq(other: Checkbox) {
    return other.checked === this.checked
  }
  toDOM() {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-md-task'
    box.checked = this.checked
    box.setAttribute('aria-label', this.checked ? 'Done' : 'To do')
    return box
  }
  ignoreEvent() {
    return false
  }
}

// A picture from the web or a data: URL, in place of its ![alt](url).
class Picture extends WidgetType {
  readonly url: string
  readonly alt: string
  constructor(url: string, alt: string) {
    super()
    this.url = url
    this.alt = alt
  }
  eq(other: Picture) {
    return other.url === this.url && other.alt === this.alt
  }
  toDOM() {
    const img = document.createElement('img')
    img.className = 'cm-md-image'
    img.src = this.url
    img.alt = this.alt
    img.loading = 'lazy'
    return img
  }
}

const hide = Decoration.replace({})
const bullet = Decoration.replace({ widget: new Bullet() })
const rule = Decoration.replace({ widget: new Rule() })
const mark = (cls: string, attributes?: Record<string, string>) => Decoration.mark({ class: cls, ...(attributes && { attributes }) })
const line = (cls: string) => Decoration.line({ class: cls })

const INLINE: Record<string, string> = {
  Emphasis: 'cm-md-em',
  StrongEmphasis: 'cm-md-strong',
  Strikethrough: 'cm-md-strike',
  InlineCode: 'cm-md-code',
}
// Marks hidden off the line being edited; on it they show, faint.
const MARKS = new Set(['EmphasisMark', 'CodeMark', 'StrikethroughMark', 'LinkMark', 'URL', 'WikiLinkMark', 'WikiLinkTarget'])

// Code is coloured by a few rules that suit most languages, without a parser per language: comments, strings,
// numbers and common keywords.
const CODE_TOKENS =
  /(\/\/[^\n]*|#(?![{[(])[^\n]*|\/\*[\s\S]*?\*\/|--[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d[\d_]*(?:\.\d+)?)\b|\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|extends|new|import|export|from|as|default|async|await|try|catch|finally|throw|type|interface|enum|public|private|protected|static|def|lambda|pass|elif|in|is|not|and|or|None|True|False|true|false|null|undefined|nil|fn|pub|impl|struct|mut|use|match|package|func|go|defer|select|then|fi|end|echo|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|JOIN|ORDER|GROUP|BY)\b/g
// Languages where # starts a comment; elsewhere it's left alone (CSS colours, C's #include reads fine either way).
const HASH_COMMENTS = /^(py|python|sh|bash|zsh|shell|rb|ruby|yaml|yml|toml|r|perl|pl|makefile|dockerfile|conf|ini)$/i
const DASH_COMMENTS = /^(sql|lua|haskell|hs|elm)$/i

/**
 * The colour marks for a code block's text, from its language (the fence's info, maybe empty): the languages Kothar
 * parses (highlight.ts, as code views colour them) get the same tok-* colours; others a few rules that suit most.
 */
export function codeTokens(text: string, language: string, offset = 0): Range<Decoration>[] {
  const parsed = highlightRanges(text, language)
  if (parsed) return parsed.map(({ from, to, className }) => mark(className).range(offset + from, offset + to))
  const found: Range<Decoration>[] = []
  for (const match of text.matchAll(CODE_TOKENS)) {
    const [whole, comment, string, number, keyword] = match
    let cls: string | undefined
    if (comment) {
      if (comment.startsWith('#') && !HASH_COMMENTS.test(language)) continue
      if (comment.startsWith('--') && !DASH_COMMENTS.test(language)) continue
      cls = 'cm-tok-comment'
    } else if (string) cls = 'cm-tok-string'
    else if (number) cls = 'cm-tok-number'
    else if (keyword) cls = 'cm-tok-keyword'
    if (cls && whole.length) found.push(mark(cls).range(offset + match.index, offset + match.index + whole.length))
  }
  return found
}

/** The lines (by number) a selection touches: they show their Markdown as typed. */
export function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>()
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(range.to).number
    for (let n = first; n <= last; n++) lines.add(n)
  }
  return lines
}

/**
 * The live preview's decorations for a range of the document, from its syntax tree. active: lines that show their
 * Markdown as typed (only styled, nothing hidden); the editor passes none while it doesn't have focus, so every line
 * reads as rendered.
 */
export function previewDecorations(state: EditorState, active: Set<number>, from = 0, to = state.doc.length) {
  const found: Range<Decoration>[] = []
  const doc = state.doc
  const isActive = (pos: number) => active.has(doc.lineAt(pos).number)
  const eachLine = (start: number, end: number, cls: string) => {
    for (let pos = start; pos <= end; ) {
      const l = doc.lineAt(pos)
      found.push(line(cls).range(l.from))
      pos = l.to + 1
    }
  }
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      const name = node.name
      const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name)
      if (heading) {
        found.push(line(`cm-md-h cm-md-h${heading[1]}`).range(doc.lineAt(node.from).from))
        return
      }
      if (name === 'HeaderMark') {
        if (isActive(node.from)) found.push(mark('cm-md-mark').range(node.from, node.to))
        else {
          // The # marks and the space after them; a Setext underline's line too.
          const after = doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
          if (after > node.from) found.push(hide.range(node.from, after))
        }
        return
      }
      if (INLINE[name]) {
        if (node.to > node.from) found.push(mark(INLINE[name]).range(node.from, node.to))
        return
      }
      if (name === 'Link') {
        const url = node.node.getChild('URL')
        const href = url ? doc.sliceString(url.from, url.to) : ''
        if (node.to > node.from) found.push(mark('cm-md-link', openable(href) ? { 'data-url': href } : undefined).range(node.from, node.to))
        return
      }
      if (name === 'Image') {
        const url = node.node.getChild('URL')
        const href = url ? doc.sliceString(url.from, url.to) : ''
        const alt = /^!\[([^\]]*)\]/.exec(doc.sliceString(node.from, node.to))?.[1] ?? ''
        // Only pictures the window can load by themselves; a file path stays as text.
        if (!isActive(node.from) && /^(https:|data:image\/)/i.test(href)) {
          found.push(Decoration.replace({ widget: new Picture(href, alt) }).range(node.from, node.to))
          return false
        }
        return
      }
      if (name === 'WikiLink') {
        const inner = doc.sliceString(node.from + 2, node.to - 2)
        found.push(mark('cm-md-wikilink', { 'data-link': linkTarget(inner) }).range(node.from, node.to))
        return
      }
      if (name === 'Tag') {
        found.push(mark('cm-md-tag', { 'data-tag': doc.sliceString(node.from + 1, node.to) }).range(node.from, node.to))
        return
      }
      if (MARKS.has(name)) {
        if (node.to <= node.from) return
        // A bare URL (autolinked, or <https://…>) is the link itself; only a [text](url)'s URL is a mark.
        if (name === 'URL' && node.node.parent?.name !== 'Link') {
          const href = doc.sliceString(node.from, node.to)
          found.push(mark('cm-md-link', openable(href) ? { 'data-url': href } : undefined).range(node.from, node.to))
          return
        }
        found.push((isActive(node.from) ? mark('cm-md-mark') : hide).range(node.from, node.to))
        return
      }
      if (name === 'Blockquote') {
        eachLine(node.from, node.to, 'cm-md-quote')
        return
      }
      if (name === 'QuoteMark') {
        if (!isActive(node.from)) {
          const after = doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
          found.push(hide.range(node.from, after))
        } else found.push(mark('cm-md-mark').range(node.from, node.to))
        return
      }
      if (name === 'FencedCode' || name === 'CodeBlock') {
        eachLine(node.from, node.to, 'cm-md-codeblock')
        const info = node.node.getChild('CodeInfo')
        const language = info ? doc.sliceString(info.from, info.to).trim() : ''
        // One run over the block's text, so a parser sees it whole (a string or comment can span lines).
        const texts = node.node.getChildren('CodeText')
        if (texts.length) {
          const from = texts[0]!.from
          found.push(...codeTokens(doc.sliceString(from, texts.at(-1)!.to), language, from))
        }
        return
      }
      if (name === 'CodeInfo') {
        found.push(mark('cm-md-mark').range(node.from, node.to))
        return
      }
      if (name === 'ListMark') {
        const text = doc.sliceString(node.from, node.to)
        const task = node.node.parent?.getChild('Task')
        const marker = task?.getChild('TaskMarker')
        if (task && marker && !isActive(node.from)) {
          // A task reads as a checkbox: its - and the space after it go, its [ ] becomes the box, and a done task's
          // text is struck through.
          const checked = /x/i.test(doc.sliceString(marker.from, marker.to))
          found.push(hide.range(node.from, marker.from))
          found.push(Decoration.replace({ widget: new Checkbox(checked) }).range(marker.from, marker.to))
          if (checked && task.to > marker.to) found.push(mark('cm-md-done').range(marker.to, task.to))
          return
        }
        // Numbered lists, and a task's mark on the line being edited, stay as written.
        if (/^[-*+]$/.test(text) && !task && !isActive(node.from)) found.push(bullet.range(node.from, node.to))
        else found.push(mark('cm-md-listmark').range(node.from, node.to))
        return
      }
      if (name === 'HorizontalRule') {
        if (!isActive(node.from)) found.push(rule.range(node.from, node.to))
        return
      }
    },
  })
  return found
}

const preview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = this.build(update.view)
      }
    }
    build(view: EditorView) {
      const active = view.hasFocus ? activeLines(view.state) : new Set<number>()
      const ranges = view.visibleRanges.flatMap(({ from, to }) => previewDecorations(view.state, active, from, to))
      return Decoration.set(ranges, true)
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

/** A GFM table's rows of cells, the header first, the --- row left out. */
export function tableRows(text: string): string[][] {
  const rows = text.split('\n').filter((row) => row.trim() && !/^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(row))
  return rows.map((row) =>
    row
      .trim()
      .replace(/^\||\|$/g, '')
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim().replace(/\\\|/g, '|')),
  )
}

// Inline Markdown in a table cell, drawn plainly: its marks dropped.
const plainCell = (cell: string) =>
  cell
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|~~|`)(.+?)\1/g, '$2')

class Table extends WidgetType {
  readonly text: string
  readonly from: number
  constructor(text: string, from: number) {
    super()
    this.text = text
    this.from = from
  }
  eq(other: Table) {
    return other.text === this.text && other.from === this.from
  }
  toDOM() {
    const wrap = document.createElement('div')
    wrap.className = 'cm-md-table'
    wrap.dataset.tableFrom = String(this.from)
    const table = document.createElement('table')
    const [head, ...body] = tableRows(this.text)
    const row = (cells: string[], tag: 'th' | 'td') => {
      const tr = document.createElement('tr')
      for (const cell of cells) {
        const td = document.createElement(tag)
        td.textContent = plainCell(cell)
        tr.append(td)
      }
      return tr
    }
    if (head) table.createTHead().append(row(head, 'th'))
    const tbody = table.createTBody()
    for (const cells of body) tbody.append(row(cells, 'td'))
    wrap.append(table)
    return wrap
  }
  ignoreEvent() {
    return false
  }
}

/** The tables the cursor isn't in, as tables; each spans whole lines, so it's a block of its own. */
export function tableDecorations(state: EditorState): DecorationSet {
  const found: Range<Decoration>[] = []
  const lines = activeLines(state)
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'Table') return
      const first = state.doc.lineAt(node.from)
      const last = state.doc.lineAt(node.to)
      for (let n = first.number; n <= last.number; n++) if (lines.has(n)) return false
      const text = state.doc.sliceString(first.from, last.to)
      found.push(Decoration.replace({ widget: new Table(text, first.from), block: true }).range(first.from, last.to))
      return false
    },
  })
  return Decoration.set(found, true)
}

const tables = StateField.define<DecorationSet>({
  create: (state) => tableDecorations(state),
  update(value, tr) {
    if (tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state)) return tableDecorations(tr.state)
    return value
  },
  provide: (field) => EditorView.decorations.from(field),
})

/**
 * Enter in a list carries it on: the next line starts with the same bullet, the next number, or an unticked box; in a
 * quote, with >. Enter on an empty item ends the list (or steps it out a level). Elsewhere Enter is Enter.
 */
export function continueList(view: EditorView): boolean {
  const { state } = view
  const range = state.selection.main
  if (!range.empty) return false
  const at = state.doc.lineAt(range.head)
  // Not in code.
  for (let node: TreeNode | null = syntaxTree(state).resolveInner(range.head, -1); node; node = node.parent) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return false
  }
  const item = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\]\s+)?/.exec(at.text)
  const quote = item ? null : /^(\s*(?:>\s?)+)/.exec(at.text)
  const lead = item?.[0] ?? quote?.[0]
  if (!lead || range.head - at.from < lead.length) return false
  const rest = at.text.slice(lead.length)
  if (!rest.trim() && range.head === at.to) {
    // An empty item: out a level if it's indented, else the mark goes and the list ends.
    const indent = item?.[1] ?? ''
    const out = indent.length ? indent.slice(Math.min(indent.length, indent.startsWith('\t') ? 1 : 2)) + at.text.slice(indent.length) : ''
    view.dispatch(state.update({ changes: { from: at.from, to: at.to, insert: out }, selection: { anchor: at.from + out.length }, userEvent: 'delete' }))
    return true
  }
  let next = lead
  if (item) {
    const [, indent, marker, gap, task] = item
    const number = /^(\d+)([.)])$/.exec(marker!)
    next = `${indent}${number ? `${Number(number[1]) + 1}${number[2]}` : marker}${gap}${task ? '[ ] ' : ''}`
  }
  const insert = `\n${next}`
  view.dispatch(
    state.update({
      changes: { from: range.head, insert },
      selection: { anchor: range.head + insert.length },
      scrollIntoView: true,
      userEvent: 'input',
    }),
  )
  return true
}

type TreeNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>

/** Ticks or unticks the task whose [ ] starts at pos. */
export function toggleTask(view: EditorView, pos: number) {
  const marker = view.state.doc.sliceString(pos, pos + 3)
  if (!/^\[[ xX]\]$/.test(marker)) return false
  view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: marker[1] === ' ' ? 'x' : ' ' }, userEvent: 'input' })
  return true
}

/** The [[ link being typed before the cursor: where its name starts and what's typed of it, or null. */
export function linkQuery(state: EditorState): { from: number; query: string } | null {
  const range = state.selection.main
  if (!range.empty) return null
  const at = state.doc.lineAt(range.head)
  const before = state.doc.sliceString(at.from, range.head)
  const match = /\[\[([^[\]|#\n]{0,80})$/.exec(before)
  if (!match) return null
  return { from: range.head - match[1]!.length, query: match[1]! }
}

/** The names to offer for what's typed: ones starting with it first, then ones containing it, then letters in order. */
export function rankCompletions(names: string[], query: string, max = 8): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return names.slice(0, max)
  const starts: string[] = []
  const contains: string[] = []
  const loose: string[] = []
  for (const name of names) {
    const n = name.toLowerCase()
    if (n.startsWith(q)) starts.push(name)
    else if (n.includes(q)) contains.push(name)
    else {
      let at = 0
      const ok = [...q.replace(/\s+/g, '')].every((ch) => (at = n.indexOf(ch, at) + 1) > 0)
      if (ok) loose.push(name)
    }
  }
  return [...starts, ...contains, ...loose].slice(0, max)
}

// Where each note's cursor and scroll were when its editor closed, by key, so coming back to it carries on there.
const places = new Map<string, { anchor: number; head: number; top: number }>()

type EditorProps = {
  /** A new key starts over at text. */
  docKey: string
  text: string
  label?: string
  placeholder?: string
  autofocus?: boolean
  /** Names [[ offers as it's typed. */
  completions?: string[]
  /** The whole text, a moment after typing stops, and on blur or unmount if anything is unsent. */
  onChange: (text: string) => void
  onLink?: (target: string) => void
  onTag?: (tag: string) => void
  /** "Keep mine" over a text that changed elsewhere: called with that other text, before the editor's is sent. */
  onKeep?: (theirs: string) => void
  /** Puts the cursor at the start of this line (from 1) and scrolls it to the top, once per key. */
  jump?: { key: string; line: number }
}

export const EDITOR_SAVE_MS = 400

type Suggest = { from: number; items: string[]; index: number; left: number; top: number }

export function MarkdownEditor({ docKey, text, label, placeholder, autofocus, completions, onChange, onLink, onTag, onKeep, jump }: EditorProps) {
  const wrap = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  // What the extension and the editor last agreed the text is: the last text sent or taken in.
  const agreed = useRef(text)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const handlers = useRef({ onChange, onLink, onTag, onKeep, completions })
  useLayoutEffect(() => {
    handlers.current = { onChange, onLink, onTag, onKeep, completions }
  })
  // A text that came from the extension (changed on disk) while the user had unsent typing: until they pick one, the
  // editor keeps theirs and saves nothing but on close.
  const [conflict, setConflict] = useState<string>()
  const conflictRef = useRef<string | undefined>(undefined)
  const [suggest, setSuggest] = useState<Suggest | null>(null)
  const suggestRef = useRef<Suggest | null>(null)
  useLayoutEffect(() => {
    conflictRef.current = conflict
    suggestRef.current = suggest
  })

  const flush = (force = false) => {
    clearTimeout(timer.current)
    timer.current = undefined
    if (conflictRef.current !== undefined && !force) return
    const current = view.current?.state.doc.toString()
    if (current === undefined || current === agreed.current) return
    agreed.current = current
    handlers.current.onChange(current)
  }
  const flushRef = useRef(flush)
  useLayoutEffect(() => {
    flushRef.current = flush
  })

  // What [[ offers for the text before the cursor, placed under it.
  const refreshSuggest = (editor: EditorView) => {
    const names = handlers.current.completions
    const typed = names?.length && editor.hasFocus ? linkQuery(editor.state) : null
    const items = typed ? rankCompletions(names!, typed.query) : []
    const coords = typed && items.length ? editor.coordsAtPos(editor.state.selection.main.head) : null
    const box = wrap.current?.getBoundingClientRect()
    if (!typed || !coords || !box) return setSuggest(null)
    const previous = suggestRef.current
    setSuggest({
      from: typed.from,
      items,
      index: previous && previous.from === typed.from ? Math.min(previous.index, items.length - 1) : 0,
      left: coords.left - box.left,
      top: coords.bottom - box.top + 4,
    })
  }
  const refreshRef = useRef(refreshSuggest)
  useLayoutEffect(() => {
    refreshRef.current = refreshSuggest
  })

  const complete = (name: string) => {
    const editor = view.current
    const typed = editor && linkQuery(editor.state)
    if (!editor || !typed) return
    const head = editor.state.selection.main.head
    const closed = editor.state.doc.sliceString(head, head + 2) === ']]'
    const insert = closed ? name : `${name}]]`
    editor.dispatch({
      changes: { from: typed.from, to: head, insert },
      selection: { anchor: typed.from + name.length + 2 },
      userEvent: 'input.complete',
    })
    setSuggest(null)
  }
  const completeRef = useRef(complete)
  useLayoutEffect(() => {
    completeRef.current = complete
  })

  // One editor per key: a new key flushes the old text and starts over.
  useEffect(() => {
    const parent = host.current
    if (!parent) return
    agreed.current = text
    setConflict(undefined)
    const follow = (e: MouseEvent, editing: boolean) => {
      const target = e.target instanceof Element ? e.target : null
      const link = target?.closest<HTMLElement>('[data-link]')
      const tag = target?.closest<HTMLElement>('[data-tag]')
      const url = target?.closest<HTMLElement>('[data-url]')
      if (!link && !tag && !url) return false
      // On the line being edited, a plain click places the cursor; ⌘ or Ctrl follows.
      if (editing && !e.metaKey && !e.ctrlKey) return false
      if (url) {
        window.open(url.dataset.url, '_blank', 'noopener,noreferrer')
        e.preventDefault()
        return true
      }
      // What's typed is sent first, so the extension saves it to this text's note before opening another.
      flushRef.current()
      if (link && handlers.current.onLink) handlers.current.onLink(link.dataset.link!)
      else if (tag && handlers.current.onTag) handlers.current.onTag(tag.dataset.tag!)
      else return false
      e.preventDefault()
      return true
    }
    // While [[ is offering names, the arrows pick one, Enter or Tab takes it and Esc closes the list.
    const suggestKeys: Extension = Prec.highest(
      keymap.of([
        ...(['ArrowDown', 'ArrowUp'] as const).map((key) => ({
          key,
          run: () => {
            const open = suggestRef.current
            if (!open) return false
            const step = key === 'ArrowDown' ? 1 : -1
            setSuggest({ ...open, index: (open.index + step + open.items.length) % open.items.length })
            return true
          },
        })),
        ...['Enter', 'Tab'].map((key) => ({
          key,
          run: () => {
            const open = suggestRef.current
            if (!open) return false
            completeRef.current(open.items[open.index]!)
            return true
          },
        })),
        {
          key: 'Escape',
          run: () => {
            if (!suggestRef.current) return false
            setSuggest(null)
            return true
          },
        },
      ]),
    )
    const place = places.get(docKey)
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: text,
        ...(place && place.head <= text.length && place.anchor <= text.length && { selection: EditorSelection.single(place.anchor, place.head) }),
        extensions: [
          markdown,
          history(),
          suggestKeys,
          keymap.of([
            { key: 'Enter', run: continueList },
            { key: 'Tab', run: indentMore, shift: indentLess },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': label ?? 'Editor', spellcheck: 'true' }),
          ...(placeholder ? [placeholderText(placeholder)] : []),
          preview,
          tables,
          EditorView.domEventHandlers({
            mousedown(e, v) {
              const target = e.target instanceof Element ? e.target : null
              // A checkbox ticks its task; a table opens for editing where it starts.
              if (target?.classList.contains('cm-md-task')) {
                const pos = v.posAtDOM(target)
                e.preventDefault()
                return toggleTask(v, pos)
              }
              const table = target?.closest<HTMLElement>('[data-table-from]')
              if (table) {
                e.preventDefault()
                v.dispatch({ selection: { anchor: Number(table.dataset.tableFrom) } })
                v.focus()
                return true
              }
              const pos = v.posAtCoords({ x: e.clientX, y: e.clientY })
              const editing = v.hasFocus && pos !== null && activeLines(v.state).has(v.state.doc.lineAt(pos).number)
              return follow(e, editing)
            },
            // A URL pasted over selected text makes it a link to the URL.
            paste(e, v) {
              const pasted = e.clipboardData?.getData('text/plain')?.trim() ?? ''
              const range = v.state.selection.main
              if (range.empty || !/^https?:\/\/\S+$/.test(pasted)) return false
              const selected = v.state.sliceDoc(range.from, range.to)
              if (selected.includes('\n')) return false
              e.preventDefault()
              const insert = `[${selected}](${pasted})`
              v.dispatch({ changes: { from: range.from, to: range.to, insert }, selection: { anchor: range.from + insert.length }, userEvent: 'input.paste' })
              return true
            },
            blur() {
              flushRef.current()
              setSuggest(null)
            },
            scroll() {
              if (suggestRef.current) setSuggest(null)
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged || update.selectionSet) refreshRef.current(update.view)
            if (!update.docChanged) return
            clearTimeout(timer.current)
            timer.current = setTimeout(() => flushRef.current(), EDITOR_SAVE_MS)
          }),
        ],
      }),
    })
    view.current = editor
    if (place) editor.scrollDOM.scrollTop = place.top
    if (autofocus) {
      editor.focus()
      // Where it was left, or else the end, as a notes app carries on.
      if (!place) editor.dispatch({ selection: { anchor: editor.state.doc.length } })
    }
    return () => {
      const selection = editor.state.selection.main
      places.set(docKey, { anchor: selection.anchor, head: selection.head, top: editor.scrollDOM.scrollTop })
      // Closing keeps what was typed, even over a version that changed elsewhere meanwhile.
      flushRef.current(true)
      editor.destroy()
      view.current = null
      setSuggest(null)
    }
    // Only the key starts a new editor; text arriving later is taken in below.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- a new editor per key only; later text is taken in below
  }, [docKey])

  // A new text for the same key (the file changed elsewhere) replaces the editor's while nothing is unsent. With
  // something unsent, the user picks which to keep.
  useEffect(() => {
    const editor = view.current
    if (!editor || text === agreed.current) return
    const current = editor.state.doc.toString()
    if (current === text) {
      agreed.current = text
      setConflict(undefined)
      return
    }
    if (current !== agreed.current) {
      setConflict(text)
      return
    }
    agreed.current = text
    editor.dispatch({ changes: { from: 0, to: current.length, insert: text } })
  }, [text])

  // A jump: once per key, to the start of the line, scrolled to the top.
  const jumped = useRef<string | undefined>(undefined)
  const jumpKey = jump?.key
  const jumpLine = jump?.line
  useEffect(() => {
    const editor = view.current
    if (!editor || jumpKey === undefined || jumpLine === undefined || jumped.current === jumpKey) return
    jumped.current = jumpKey
    const line = editor.state.doc.line(Math.min(Math.max(1, Math.floor(jumpLine) || 1), editor.state.doc.lines))
    editor.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 8 }) })
    editor.focus()
  }, [jumpKey, jumpLine, docKey])

  const useTheirs = () => {
    const editor = view.current
    const theirs = conflictRef.current
    if (!editor || theirs === undefined) return
    agreed.current = theirs
    conflictRef.current = undefined
    setConflict(undefined)
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: theirs } })
  }
  const keepMine = () => {
    const theirs = conflictRef.current
    // The other text goes to the extension first, so it can keep it before the editor's replaces it.
    if (theirs !== undefined) handlers.current.onKeep?.(theirs)
    agreed.current = theirs ?? agreed.current
    conflictRef.current = undefined
    setConflict(undefined)
    flushRef.current(true)
  }

  return (
    <div ref={wrap} className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-8">
      {conflict !== undefined && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-8 rounded border border-amber/40 bg-amber/10 px-10 py-6 text-sm">
          <span>This note changed somewhere else while you were typing. Nothing is saved until you pick.</span>
          <span className="flex gap-6">
            <Button size="small" variant="ghost" onClick={useTheirs}>
              Use the other version
            </Button>
            <Button size="small" variant="primary" onClick={keepMine}>
              Keep mine
            </Button>
          </span>
        </div>
      )}
      <div ref={host} className="markdown-editor min-h-0 min-w-0 flex-1" />
      {suggest && (
        <ul
          role="listbox"
          aria-label="Link to a note"
          className="absolute z-10 max-h-240 min-w-200 overflow-y-auto rounded-lg border bg-panel py-4 text-sm shadow-floating"
          style={{ left: suggest.left, top: suggest.top }}
        >
          {suggest.items.map((item, i) => (
            <li
              key={item}
              role="option"
              aria-selected={i === suggest.index}
              className="cursor-pointer truncate px-10 py-4 aria-selected:bg-hover"
              // Before the editor's blur, so the click lands.
              onMouseDown={(e) => {
                e.preventDefault()
                complete(item)
              }}
            >
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
