// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { activeLines, EDITOR_SAVE_MS, linkTarget, MarkdownEditor, previewDecorations, wikiLinksIn } from './markdown-editor.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// The editor's language, from a mounted editor's state, so the tests parse exactly as it does.
let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

function mount(props: Partial<Parameters<typeof MarkdownEditor>[0]> = {}) {
  const changes: string[] = []
  const links: string[] = []
  const tags: string[] = []
  const render = (more: Partial<Parameters<typeof MarkdownEditor>[0]> = {}) =>
    act(() =>
      root.render(
        <MarkdownEditor
          docKey="a"
          text="# Title"
          onChange={(t) => changes.push(t)}
          onLink={(t) => links.push(t)}
          onTag={(t) => tags.push(t)}
          {...props}
          {...more}
        />,
      ),
    )
  render()
  const view = () => EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement)!
  return { changes, links, tags, view, render }
}

// What the preview does to a text with no line active: [kind, text] in document order.
function preview(text: string, active: number[] = []) {
  const { view } = mount({ text })
  const state = view().state
  ensureSyntaxTree(state, state.doc.length, 5000)
  return previewDecorations(state, new Set(active))
    .sort((a, b) => a.from - b.from)
    .map((r) => {
      const spec = r.value.spec as { class?: string; widget?: unknown; attributes?: Record<string, string> }
      const kind = spec.class ?? (spec.widget ? 'widget' : 'hide')
      return [kind, state.doc.sliceString(r.from, r.to), ...(spec.attributes ? [spec.attributes] : [])]
    })
}

test('wikilink targets drop an alias and a heading', () => {
  expect(linkTarget('Tests|how we test')).toBe('Tests')
  expect(linkTarget(' Tests#Setup ')).toBe('Tests')
  expect(wikiLinksIn('See [[Tests]], [[Tests|again]] and [[Deploy#Steps]]. Not [[ ]] or [[a\nb]].')).toEqual(['Tests', 'Deploy'])
})

test('off the cursor line, marks are hidden and the text is drawn as it reads', () => {
  const found = preview('# Plan\n\nSome **bold**, *soft* and `code`, a [[Deploy|deploy note]] and #todo.')
  expect(found).toContainEqual(['cm-md-h cm-md-h1', ''])
  expect(found).toContainEqual(['hide', '# '])
  expect(found).toContainEqual(['cm-md-strong', '**bold**'])
  expect(found).toContainEqual(['cm-md-em', '*soft*'])
  expect(found).toContainEqual(['cm-md-code', '`code`'])
  expect(found.filter(([kind, text]) => kind === 'hide' && (text === '**' || text === '*' || text === '`'))).toHaveLength(6)
  // The link reads as its alias: [[, the target and its bar, and ]] are hidden.
  expect(found).toContainEqual(['cm-md-wikilink', '[[Deploy|deploy note]]', { 'data-link': 'Deploy' }])
  expect(found).toContainEqual(['hide', 'Deploy|'])
  expect(found.filter(([kind, text]) => kind === 'hide' && (text === '[[' || text === ']]'))).toHaveLength(2)
  expect(found).toContainEqual(['cm-md-tag', '#todo', { 'data-tag': 'todo' }])
})

test('on the line being edited, marks show (faint) and nothing is hidden', () => {
  const found = preview('Some **bold** and [[Deploy]]', [1])
  expect(found.some(([kind]) => kind === 'hide')).toBe(false)
  expect(found).toContainEqual(['cm-md-mark', '**'])
  expect(found).toContainEqual(['cm-md-mark', '[['])
})

test('a heading is not a tag, nor is #1, and a tag needs a space or line start before it', () => {
  const found = preview('# Heading\n\nIssue #12, a#b and #real/tag')
  const tags = found.filter(([kind]) => kind === 'cm-md-tag').map(([, text]) => text)
  expect(tags).toEqual(['#real/tag'])
})

test('bullets become dots, quotes and code blocks are styled per line', () => {
  const found = preview('- one\n- two\n\n> quoted\n\n```\ncode\n```')
  expect(found.filter(([kind]) => kind === 'widget')).toHaveLength(2)
  expect(found.filter(([kind]) => kind === 'cm-md-quote')).toHaveLength(1)
  expect(found.filter(([kind]) => kind === 'cm-md-codeblock')).toHaveLength(3)
})

test('active lines are the ones a selection touches', () => {
  const state = EditorState.create({ doc: 'a\nb\nc', selection: { anchor: 0, head: 3 } })
  expect([...activeLines(state)]).toEqual([1, 2])
})

test('typing sends the whole text after a pause, once', () => {
  vi.useFakeTimers()
  const { changes, view } = mount()
  act(() => view().dispatch({ changes: { from: 7, insert: '!' } }))
  act(() => view().dispatch({ changes: { from: 8, insert: '!' } }))
  expect(changes).toEqual([])
  act(() => vi.advanceTimersByTime(EDITOR_SAVE_MS))
  expect(changes).toEqual(['# Title!!'])
})

test('closing sends what is unsent', () => {
  const { changes, view } = mount()
  act(() => view().dispatch({ changes: { from: 7, insert: ' 2' } }))
  act(() => root.render(<></>))
  expect(changes).toEqual(['# Title 2'])
})

test('a new text for the same key replaces the editor only while nothing is unsent', () => {
  vi.useFakeTimers()
  const { view, render } = mount()
  render({ text: '# Changed on disk' })
  expect(view().state.doc.toString()).toBe('# Changed on disk')
  act(() => view().dispatch({ changes: { from: 0, insert: 'x' } }))
  render({ text: '# Another change' })
  expect(view().state.doc.toString()).toBe('x# Changed on disk')
  // Its own text coming back after a save changes nothing.
  act(() => vi.advanceTimersByTime(EDITOR_SAVE_MS))
  render({ text: 'x# Changed on disk' })
  expect(view().state.doc.toString()).toBe('x# Changed on disk')
})

test('a new key starts over at its text', () => {
  const { view, render } = mount()
  render({ docKey: 'b', text: 'Other note' })
  expect(view().state.doc.toString()).toBe('Other note')
})

test('clicking a rendered link or tag follows it', () => {
  const { links, tags } = mount({ text: 'See [[Deploy]] and #todo' })
  const link = host.querySelector('[data-link]') as HTMLElement
  const tag = host.querySelector('[data-tag]') as HTMLElement
  expect(link.textContent).toBe('Deploy')
  act(() => {
    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    tag.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  })
  expect(links).toEqual(['Deploy'])
  expect(tags).toEqual(['todo'])
})
