// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  activeLines,
  codeTokens,
  continueList,
  EDITOR_SAVE_MS,
  linkQuery,
  linkTarget,
  MarkdownEditor,
  MAX_PASTE_BYTES,
  pastedName,
  picturePath,
  previewDecorations,
  rankCompletions,
  tableDecorations,
  tableRows,
  wikiLinksIn,
} from './markdown-editor.tsx'

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

test('following a link sends what is unsent first, so it lands in the note it was typed in', () => {
  vi.useFakeTimers()
  const order: string[] = []
  mount({ text: 'See [[Deploy]]', onChange: (t) => order.push(`change:${t}`), onLink: (t) => order.push(`link:${t}`) })
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement)!
  act(() => view.dispatch({ changes: { from: 0, insert: 'Now ' } }))
  const link = host.querySelector('[data-link]') as HTMLElement
  act(() => link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })))
  expect(order).toEqual(['change:Now See [[Deploy]]', 'link:Deploy'])
})

// Puts the cursor at pos and presses Enter as the editor's keymap would.
let enters = 0
function enterAt(text: string, pos = text.length) {
  const { view } = mount({ text, docKey: `enter-${enters++}` })
  const v = view()
  act(() => v.dispatch({ selection: { anchor: pos } }))
  ensureSyntaxTree(v.state, v.state.doc.length, 5000)
  const handled = continueList(v)
  return { handled, text: v.state.doc.toString(), cursor: v.state.selection.main.head }
}

test('Enter carries a list on: the same bullet, the next number, an unticked box, a quote', () => {
  expect(enterAt('- milk')).toMatchObject({ handled: true, text: '- milk\n- ', cursor: 9 })
  expect(enterAt('  * nested')).toMatchObject({ text: '  * nested\n  * ' })
  expect(enterAt('9. nine')).toMatchObject({ text: '9. nine\n10. ' })
  expect(enterAt('- [x] done')).toMatchObject({ text: '- [x] done\n- [ ] ' })
  expect(enterAt('> said')).toMatchObject({ text: '> said\n> ' })
  // An empty item ends the list, or steps out a level when indented.
  expect(enterAt('- one\n- ')).toMatchObject({ handled: true, text: '- one\n' })
  expect(enterAt('- one\n  - ')).toMatchObject({ text: '- one\n- ' })
  // Plain text, the middle of a mark and code are left to Enter itself.
  expect(enterAt('plain').handled).toBe(false)
  expect(enterAt('- milk', 1).handled).toBe(false)
  expect(enterAt('```\n- not a list').handled).toBe(false)
})

test('a task reads as a checkbox off the cursor line, and clicking it ticks the task in the text', () => {
  const found = preview('- [ ] milk\n- [x] eggs')
  expect(found.filter(([kind]) => kind === 'widget')).toHaveLength(2)
  expect(found).toContainEqual(['cm-md-done', ' eggs'])
  const { view } = mount({ text: '- [ ] milk\n- [x] eggs' })
  const boxes = [...host.querySelectorAll<HTMLInputElement>('input.cm-md-task')]
  expect(boxes.map((b) => b.checked)).toEqual([false, true])
  act(() => boxes[0]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })))
  expect(view().state.doc.toString()).toBe('- [x] milk\n- [x] eggs')
})

test('web links open in the browser: [text](url) and a bare URL; other links stay text', () => {
  const found = preview('A [site](https://a.test) and https://b.test and [file](./x.md)')
  expect(found).toContainEqual(['cm-md-link', '[site](https://a.test)', { 'data-url': 'https://a.test' }])
  expect(found).toContainEqual(['cm-md-link', 'https://b.test', { 'data-url': 'https://b.test' }])
  expect(found).toContainEqual(['cm-md-link', '[file](./x.md)'])
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  act(() => root.unmount())
  root = createRoot(host)
  mount({ text: 'See https://b.test' })
  const link = host.querySelector('[data-url]') as HTMLElement
  act(() => link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })))
  expect(open).toHaveBeenCalledWith('https://b.test', '_blank', 'noopener,noreferrer')
})

test('a picture from the web shows in place of its Markdown; a file path stays text', () => {
  const found = preview('![cat](https://x.test/cat.png) and ![local](cat.png)')
  expect(found.filter(([kind]) => kind === 'widget')).toHaveLength(1)
})

test('pasting a URL over selected text makes a link', () => {
  const { view } = mount({ text: 'the docs' })
  act(() => view().dispatch({ selection: { anchor: 4, head: 8 } }))
  const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(paste, 'clipboardData', { value: { getData: () => 'https://docs.test' } })
  act(() => view().contentDOM.dispatchEvent(paste))
  expect(view().state.doc.toString()).toBe('the [docs](https://docs.test)')
})

test('a table reads as a table while the cursor is outside it', () => {
  expect(tableRows('| a | b \\| c |\n|---|:--:|\n| 1 | 2 |')).toEqual([
    ['a', 'b | c'],
    ['1', '2'],
  ])
  const text = 'Top\n\n| a | b |\n|---|---|\n| **1** | 2 |\n\nEnd'
  const { view } = mount({ text, docKey: 'table' })
  const v = view()
  ensureSyntaxTree(v.state, v.state.doc.length, 5000)
  expect(tableDecorations(v.state).size).toBe(1)
  act(() => v.dispatch({ selection: { anchor: text.indexOf('**1**') } }))
  expect(tableDecorations(v.state).size).toBe(0)
})

test('code is coloured: languages Kothar parses as code views colour them, others by a few rules', () => {
  const kinds = (code: string, language: string) =>
    codeTokens(code, language).map((r) => [(r.value.spec as { class: string }).class, code.slice(r.from, r.to)])
  // Parsed (highlight.ts): the code views' tok-* classes.
  expect(kinds('const a = "x" // note', 'js')).toEqual(
    expect.arrayContaining([
      ['tok-keyword', 'const'],
      ['tok-string', '"x"'],
      ['tok-comment', '// note'],
    ]),
  )
  expect(kinds('x = 42 # why', 'python')).toContainEqual(['tok-comment', '# why'])
  // Not parsed: the simple rules.
  expect(kinds('func main() { return 1 } // go', 'go')).toEqual([
    ['cm-tok-keyword', 'func'],
    ['cm-tok-keyword', 'return'],
    ['cm-tok-number', '1'],
    ['cm-tok-comment', '// go'],
  ])
  expect(kinds('x = 1 # why', 'ruby')).toContainEqual(['cm-tok-comment', '# why'])
  expect(kinds('color #fff', 'scss')).toEqual([])
})

test('a code block is coloured as one run, so a parsed string or comment can span lines', () => {
  const { view } = mount({ text: '```ts\n/* one\ntwo */ let x = 1\n```' })
  const state = view().state
  ensureSyntaxTree(state, state.doc.length, 5000)
  const comment = previewDecorations(state, new Set())
    .filter((r) => (r.value.spec as { class?: string }).class === 'tok-comment')
    .map((r) => state.doc.sliceString(r.from, r.to))
  expect(comment).toEqual(['/* one\ntwo */'])
})

test('a change from elsewhere over unsent typing asks which to keep, and saves nothing until then', () => {
  vi.useFakeTimers()
  const { view, render, changes } = mount({ text: 'one' })
  act(() => view().dispatch({ changes: { from: 3, insert: ' mine' } }))
  render({ text: 'one theirs' })
  expect(host.querySelector('[role=alert]')?.textContent).toContain('changed somewhere else')
  act(() => vi.advanceTimersByTime(EDITOR_SAVE_MS * 2))
  expect(changes).toEqual([])
  const keep = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Keep mine')!
  act(() => keep.click())
  expect(changes).toEqual(['one mine'])
  // Without onKeep, the other text is dropped.
  expect(host.querySelector('[role=alert]')).toBeNull()

  act(() => view().dispatch({ changes: { from: 0, insert: '>' } }))
  render({ text: 'agent version' })
  const theirs = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Use the other version')!
  act(() => theirs.click())
  expect(view().state.doc.toString()).toBe('agent version')
  act(() => vi.advanceTimersByTime(EDITOR_SAVE_MS * 2))
  expect(changes).toEqual(['one mine'])
})

test('[[ offers note names as they are typed, and Enter takes one', () => {
  expect(rankCompletions(['Deploys', 'Style guide', 'Groceries', 'My style'], 'sty')).toEqual(['Style guide', 'My style'])
  expect(rankCompletions(['Groceries'], 'grcs')).toEqual(['Groceries'])
  expect(linkQuery(EditorState.create({ doc: 'See [[Dep', selection: { anchor: 9 } }))).toEqual({ from: 6, query: 'Dep' })
  expect(linkQuery(EditorState.create({ doc: 'See [[Dep]] x', selection: { anchor: 13 } }))).toBeNull()
  const { view } = mount({ text: 'See ', completions: ['Deploys', 'Style'] })
  const v = view()
  act(() => {
    v.focus()
    v.dispatch({ selection: { anchor: 4 } })
  })
  act(() => v.dispatch({ changes: { from: 4, insert: '[[De' }, selection: { anchor: 8 } }))
  const options = [...host.querySelectorAll('[role=option]')].map((o) => o.textContent)
  // jsdom has no layout, so the list may not place itself; where it shows, it offers the matching name.
  if (options.length) {
    expect(options).toEqual(['Deploys'])
    act(() => v.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(v.state.doc.toString()).toBe('See [[Deploys]]')
  }
})

test('a note opens again where its cursor was', () => {
  const { view, render } = mount({ docKey: 'kept', text: 'hello world' })
  act(() => view().dispatch({ selection: { anchor: 5 } }))
  render({ docKey: 'other', text: 'x' })
  render({ docKey: 'kept', text: 'hello world' })
  expect(view().state.selection.main.head).toBe(5)
})

test('"Keep mine" hands the other text to onKeep first, then sends the editor\'s', () => {
  vi.useFakeTimers()
  const order: string[] = []
  const { view, render } = mount({ text: 'one', onKeep: (t) => order.push(`keep:${t}`), onChange: (t) => order.push(`save:${t}`) })
  act(() => view().dispatch({ changes: { from: 3, insert: ' mine' } }))
  render({ text: 'one theirs' })
  act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Keep mine')!.click())
  expect(order).toEqual(['keep:one theirs', 'save:one mine'])
})

test('a jump puts the cursor at the start of its line and takes focus, once per key', () => {
  const text = '# A\n\ntext\n\n## B\n\nmore'
  const { view, render } = mount({ text, jump: { key: 'j1', line: 5 } })
  expect(view().state.selection.main.head).toBe(text.indexOf('## B'))
  expect(view().hasFocus).toBe(true)
  // The same key again doesn't move the cursor back.
  act(() => view().dispatch({ selection: { anchor: 0 } }))
  render({ text, jump: { key: 'j1', line: 5 } })
  expect(view().state.selection.main.head).toBe(0)
  // A line past the end goes to the last.
  render({ text, jump: { key: 'j2', line: 99 } })
  expect(view().state.selection.main.head).toBe(text.indexOf('more'))
})

test('a picture path is read against the files folder; a URL, a scheme or a bad escape is not', () => {
  expect(picturePath('/g/notes', 'attachments/a%20b.png')).toBe('/g/notes/attachments/a b.png')
  expect(picturePath('/g/notes/', './a.png')).toBe('/g/notes/a.png')
  expect(picturePath('/g/notes', '/abs/a.png')).toBe('/abs/a.png')
  for (const src of ['https://x/a.png', 'file:///etc/a.png', 'javascript:alert(1)', '//host/a.png', '%E0%A4%A', '']) {
    expect(picturePath('/g', src), src).toBeUndefined()
  }
})

test('a pasted picture is named by its time, and never takes a name already used', () => {
  const at = new Date(2026, 10, 10, 9, 5, 7)
  expect(pastedName('image/png', at)).toBe('pasted-20261110-090507.png')
  expect(pastedName('image/jpeg', at, (n) => n === 'pasted-20261110-090507.jpg')).toBe('pasted-20261110-090507-2.jpg')
})

test('with files, a relative picture shows from the files URL; without, it stays text', () => {
  const text = 'x\n\n![cat](attachments/cat.png)\n'
  const { view } = mount({ text, files: { folder: '/g/notes', url: (p) => `http://core/f?path=${p}` } })
  expect(host.querySelector<HTMLImageElement>('img.cm-md-image')?.src).toBe('http://core/f?path=/g/notes/attachments/cat.png')
  expect(view().state.doc.toString()).toBe(text)
  act(() => root.unmount())
  root = createRoot(host)
  mount({ text })
  expect(host.querySelector('img.cm-md-image')).toBeNull()
})

test('pasting a picture writes its link into the text, shows it at once, and sends its bytes to save', async () => {
  const blobUrls: string[] = []
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    blobUrls.push(`blob:${blobUrls.length}`)
    return blobUrls.at(-1)!
  })
  const saved: { path: string; mimeType: string; data: string }[] = []
  const { view } = mount({ text: 'Before ', files: { folder: '/g/n1', url: (p) => `http://core/f?path=${p}` }, onPaste: (p) => saved.push(p) })
  act(() => view().dispatch({ selection: { anchor: 7 } }))
  const picture = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })
  const tooBig = new File([new Uint8Array(1)], 'big.png', { type: 'image/png' })
  Object.defineProperty(tooBig, 'size', { value: MAX_PASTE_BYTES + 1 })
  const notPicture = new File(['hi'], 'a.txt', { type: 'text/plain' })
  const paste = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(paste, 'clipboardData', { value: { files: [picture, tooBig, notPicture], getData: () => '' } })
  await act(async () => {
    view().contentDOM.dispatchEvent(paste)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(paste.defaultPrevented).toBe(true)
  expect(saved).toEqual([{ path: expect.stringMatching(/^attachments\/pasted-\d{8}-\d{6}\.png$/), mimeType: 'image/png', data: 'iVBORw==' }])
  expect(view().state.doc.toString()).toBe(`Before ![](${saved[0]!.path})`)
  // Off the line being edited, it draws from the editor's own copy until the extension has saved it.
  act(() => view().contentDOM.blur())
  expect(host.querySelector<HTMLImageElement>('img.cm-md-image')?.getAttribute('src')).toBe('blob:0')
})

test('without files or a paste action, a pasted picture adds nothing', () => {
  const saved: unknown[] = []
  const { view } = mount({ text: 'x', onPaste: (p) => saved.push(p) })
  const paste = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(paste, 'clipboardData', { value: { files: [new File(['p'], 'a.png', { type: 'image/png' })], getData: () => '' } })
  act(() => view().contentDOM.dispatchEvent(paste))
  expect(view().state.doc.toString()).toBe('x')
  expect(saved).toEqual([])
})
