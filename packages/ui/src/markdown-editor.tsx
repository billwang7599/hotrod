import { useEffect, useLayoutEffect, useRef } from 'react'
import { EditorState, type Range } from '@codemirror/state'
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
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { defineLanguageFacet, Language, syntaxTree } from '@codemirror/language'
import { GFM, type MarkdownConfig, parser as baseParser } from '@lezer/markdown'

/**
 * A Markdown editor with live preview, as Obsidian's: the text stays plain Markdown, but on lines the cursor isn't on,
 * the marks (#, **, `, [[ ]], link URLs) are hidden and the text is drawn as it reads. Built on CodeMirror 6 with only
 * its core packages and the Lezer Markdown parser (no language bundles), so it adds little to the window.
 *
 * [[wikilinks]] and #tags are parsed too; clicking one calls onLink or onTag. On the line being edited, ⌘-click (Ctrl
 * elsewhere) follows it, so a plain click can still place the cursor.
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
  Link: 'cm-md-link',
}
// Marks hidden off the line being edited; on it they show, faint.
const MARKS = new Set(['EmphasisMark', 'CodeMark', 'StrikethroughMark', 'LinkMark', 'URL', 'WikiLinkMark', 'WikiLinkTarget'])

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
        // A bare URL (<https://…> or autolinked) is the link itself; only a [text](url)'s URL is a mark.
        if (name === 'URL' && node.node.parent?.name !== 'Link') return
        if (node.to <= node.from) return
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
        return
      }
      if (name === 'CodeInfo') {
        found.push(mark('cm-md-mark').range(node.from, node.to))
        return
      }
      if (name === 'ListMark') {
        const text = doc.sliceString(node.from, node.to)
        // A task's checkbox follows its mark; leave those, and numbered lists, as written.
        const task = node.node.parent?.getChild('Task')
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

type EditorProps = {
  /** A new key starts over at text. */
  docKey: string
  text: string
  label?: string
  placeholder?: string
  autofocus?: boolean
  /** The whole text, a moment after typing stops, and on blur or unmount if anything is unsent. */
  onChange: (text: string) => void
  onLink?: (target: string) => void
  onTag?: (tag: string) => void
}

export const EDITOR_SAVE_MS = 400

export function MarkdownEditor({ docKey, text, label, placeholder, autofocus, onChange, onLink, onTag }: EditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  // What the extension and the editor last agreed the text is: the last text sent or taken in.
  const agreed = useRef(text)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const handlers = useRef({ onChange, onLink, onTag })
  useLayoutEffect(() => {
    handlers.current = { onChange, onLink, onTag }
  })

  const flush = () => {
    clearTimeout(timer.current)
    timer.current = undefined
    const current = view.current?.state.doc.toString()
    if (current === undefined || current === agreed.current) return
    agreed.current = current
    handlers.current.onChange(current)
  }
  const flushRef = useRef(flush)
  useLayoutEffect(() => {
    flushRef.current = flush
  })

  // One editor per key: a new key flushes the old text and starts over.
  useEffect(() => {
    const parent = host.current
    if (!parent) return
    agreed.current = text
    const follow = (e: MouseEvent, editing: boolean) => {
      const target = e.target instanceof Element ? e.target : null
      const link = target?.closest<HTMLElement>('[data-link]')
      const tag = target?.closest<HTMLElement>('[data-tag]')
      if (!link && !tag) return false
      // On the line being edited, a plain click places the cursor; ⌘ or Ctrl follows.
      if (editing && !e.metaKey && !e.ctrlKey) return false
      // What's typed is sent first, so the extension saves it to this text's note before opening another.
      flushRef.current()
      if (link && handlers.current.onLink) handlers.current.onLink(link.dataset.link!)
      else if (tag && handlers.current.onTag) handlers.current.onTag(tag.dataset.tag!)
      else return false
      e.preventDefault()
      return true
    }
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: text,
        extensions: [
          markdown,
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': label ?? 'Editor', spellcheck: 'true' }),
          ...(placeholder ? [placeholderText(placeholder)] : []),
          preview,
          EditorView.domEventHandlers({
            mousedown(e, v) {
              const pos = v.posAtCoords({ x: e.clientX, y: e.clientY })
              const editing = v.hasFocus && pos !== null && activeLines(v.state).has(v.state.doc.lineAt(pos).number)
              return follow(e, editing)
            },
            blur() {
              flushRef.current()
            },
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            clearTimeout(timer.current)
            timer.current = setTimeout(() => flushRef.current(), EDITOR_SAVE_MS)
          }),
        ],
      }),
    })
    view.current = editor
    if (autofocus) editor.focus()
    return () => {
      flushRef.current()
      editor.destroy()
      view.current = null
    }
    // Only the key starts a new editor; text arriving later is taken in below.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- a new editor per key only; later text is taken in below
  }, [docKey])

  // A new text for the same key (the file changed elsewhere) replaces the editor's only while nothing is unsent.
  useEffect(() => {
    const editor = view.current
    if (!editor || text === agreed.current) return
    const current = editor.state.doc.toString()
    if (current !== agreed.current) return
    agreed.current = text
    if (current !== text) editor.dispatch({ changes: { from: 0, to: current.length, insert: text } })
  }, [text])

  return <div ref={host} className="markdown-editor min-h-0 min-w-0 flex-1" />
}
