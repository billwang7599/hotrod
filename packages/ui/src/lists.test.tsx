// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { continueList, indentList, UserText } from './lists.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root
let container: HTMLElement
beforeEach(() => {
  container = document.body.appendChild(document.createElement('div'))
  container.style.whiteSpace = 'pre-wrap'
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
const show = (text: string) => act(() => root.render(<UserText text={text} />))
const items = (list: Element | null | undefined) => [...(list?.children ?? [])].filter((c) => c.tagName === 'LI')

describe('a sent message', () => {
  test('renders - lines as a list', () => {
    show('- a\n- b')
    const ul = container.querySelector('ul')!
    expect(items(ul).map((li) => li.textContent)).toEqual(['a', 'b'])
  })

  test('renders numbered lists from their first number', () => {
    show('Steps:\n3. one\n4) two')
    const ol = container.querySelector('ol')!
    expect(ol.getAttribute('start')).toBe('3')
    expect(items(ol)).toHaveLength(2)
    expect(container.firstElementChild!.textContent).toBe('Steps:')
  })

  test('nests lists by indent, a numbered list inside a bulleted one', () => {
    show('- a\n  1. a1\n  2. a2\n    * deep\n- b')
    const top = container.querySelector(':scope > ul')!
    expect(items(top)).toHaveLength(2)
    const inner = items(top)[0]!.querySelector(':scope > ol')!
    expect(items(inner).map((li) => li.firstChild!.textContent)).toEqual(['a1', 'a2'])
    expect(items(inner)[1]!.querySelector('ul li')!.textContent).toBe('deep')
  })

  test('shows task boxes', () => {
    show('- [ ] todo\n- [x] done')
    const boxes = [...container.querySelectorAll('input[type=checkbox]')] as HTMLInputElement[]
    expect(boxes.map((b) => b.checked)).toEqual([false, true])
    expect(container.querySelector('ul')!.textContent).toBe('tododone')
  })

  test('keeps plain text exactly as typed, single newlines and markdown-looking characters included', () => {
    show('hi\nthere\n# not a heading **not bold** _x_\n\nbye')
    expect(container.querySelector('ul, ol, h1, strong, em')).toBeNull()
    expect(container.textContent).toBe('hi\nthere\n# not a heading **not bold** _x_\n\nbye')
  })

  test('keeps text around a list, and indented lines continue an item', () => {
    show('before\nline two\n- a\n  more of a\nafter')
    const blocks = [...container.children]
    expect(blocks.map((b) => b.tagName)).toEqual(['DIV', 'UL', 'DIV'])
    expect(blocks[0]!.textContent).toBe('before\nline two')
    expect(items(blocks[1])[0]!.textContent).toBe('a\nmore of a')
    expect(blocks[2]!.textContent).toBe('after')
  })

  test('leaves list lines inside a code fence alone', () => {
    show('```\n- not a list\n```')
    expect(container.querySelector('ul')).toBeNull()
    expect(container.textContent).toBe('```\n- not a list\n```')
  })

  test('needs a space after the marker: -x, *bold* and 2020.10 stay text', () => {
    show('-x\n*bold*\n2020.10 was fine\n---')
    expect(container.querySelector('ul, ol')).toBeNull()
  })
})

const at = (text: string) => {
  const i = text.indexOf('|')
  return [text.replace('|', ''), i, i] as const
}
const run = (edit: ReturnType<typeof continueList>, text: string) =>
  edit && { text: text.slice(0, edit.from) + edit.insert + text.slice(edit.to), caret: [edit.selStart, edit.selEnd] }

describe('continuing a list', () => {
  test('repeats the bullet at the same indent', () => {
    const [text, s, e] = at('  - foo|')
    const out = run(continueList(text, s, e), text)!
    expect(out.text).toBe('  - foo\n  - ')
    expect(out.caret).toEqual([out.text.length, out.text.length])
  })

  test('takes the next number, and an empty box after a task', () => {
    const [a, s, e] = at('9. foo|')
    expect(run(continueList(a, s, e), a)!.text).toBe('9. foo\n10. ')
    const [b, s2, e2] = at('* [x] done|')
    expect(run(continueList(b, s2, e2), b)!.text).toBe('* [x] done\n* [ ] ')
  })

  test('splits an item at the caret', () => {
    const [text, s, e] = at('- foo|bar')
    expect(run(continueList(text, s, e), text)!.text).toBe('- foo\n- bar')
  })

  test('ends the list on an empty item', () => {
    const [text, s, e] = at('- a\n- |')
    const out = run(continueList(text, s, e), text)!
    expect(out.text).toBe('- a\n')
    expect(out.caret).toEqual([4, 4])
  })

  test('leaves other lines, and a caret before the marker, to the textarea', () => {
    expect(continueList(...at('plain|'))).toBeNull()
    expect(continueList(...at('|- a'))).toBeNull()
  })
})

describe('indenting a list line', () => {
  test('Tab indents a list line, keeping the caret after the text', () => {
    const [text, s, e] = at('- a\n- b|')
    const out = run(indentList(text, s, e, false), text)!
    expect(out.text).toBe('- a\n  - b')
    expect(out.caret).toEqual([9, 9])
  })

  test('renumbers: a nested numbered item starts at 1, an outdented one continues its level', () => {
    const [text, s, e] = at('1. a\n2. b|')
    expect(run(indentList(text, s, e, false), text)!.text).toBe('1. a\n  1. b')
    const [back, s2, e2] = at('1. a\n  1. b|')
    expect(run(indentList(back, s2, e2, true), back)!.text).toBe('1. a\n2. b')
  })

  test('indents every list line in a selection', () => {
    const text = '- a\nnote\n- b'
    expect(run(indentList(text, 0, text.length, false), text)!.text).toBe('  - a\nnote\n  - b')
  })

  test('only in a list line', () => {
    expect(indentList(...at('plain|'), false)).toBeNull()
  })

  test('Shift+Tab at the left edge still keeps the key, changing nothing', () => {
    const [text, s, e] = at('- a|')
    expect(run(indentList(text, s, e, true), text)!.text).toBe('- a')
  })
})
