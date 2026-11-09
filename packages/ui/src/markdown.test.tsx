// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { domAnimation, LazyMotion } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { COPIED_MS } from './controls.tsx'
import { Markdown } from './markdown.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const markdown = (text: string) => (
  <LazyMotion features={domAnimation} strict>
    <Tooltip.Provider delayDuration={0}>
      <Markdown className="assistant" text={text} />
    </Tooltip.Provider>
  </LazyMotion>
)
const render = (text: string) => renderToStaticMarkup(markdown(text))

test('renders emphasis, fenced code and GFM tables', () => {
  const html = render('Some **bold** text.\n\n```ts\nconst x = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |')
  expect(html).toContain('<strong>bold</strong>')
  expect(html).toMatch(/<pre><code[^>]*>const x = 1\n<\/code><\/pre>/)
  expect(html).toContain('<table>')
})

test('opens links outside the app', () => {
  expect(render('[docs](https://example.com)')).toContain(
    '<a href="https://example.com" target="_blank" rel="noreferrer">docs</a>',
  )
})

test('never renders raw HTML', () => {
  const html = render('hi <script>alert(1)</script> there')
  expect(html).not.toContain('<script>')
  expect(html).toContain('&lt;script&gt;')
})

test('<br> in a table cell or paragraph is a line break', () => {
  const html = render('| grid |\n|---|\n| `1 2 3`<br>`4 5 6`<br/>`7 8 9` |\n\none<BR />two')
  expect(html).toContain('<td><code>1 2 3</code><br/>\n<code>4 5 6</code><br/>\n<code>7 8 9</code></td>')
  expect(html).toContain('one<br/>\ntwo')
  expect(html).not.toContain('&lt;br')
})

test('<br> inside code stays literal', () => {
  const html = render('`a<br>b`\n\n```\nx<br>y\n```')
  expect(html).toContain('<code>a&lt;br&gt;b</code>')
  expect(html).toContain('x&lt;br&gt;y')
})

test('other HTML tags still render as text, next to a <br>', () => {
  const html = render('<b>bold</b><br><img src=x onerror=alert(1)>')
  expect(html).not.toContain('<b>')
  expect(html).not.toContain('<img')
  expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;<br/>\n&lt;img')
})

test('entities, strikethrough and task lists', () => {
  const html = render('a&nbsp;b &lt;tag&gt; ~~gone~~\n\n- [x] done\n- [ ] todo')
  expect(html).toContain('a\u00a0b &lt;tag&gt; <del>gone</del>')
  expect(html).toContain('<li class="task-list-item"><input type="checkbox" disabled="" checked=""/> done</li>')
})

let root: Root
let container: HTMLElement
const setClipboard = (clipboard?: Partial<Clipboard>) =>
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
const copyButton = () => container.querySelector<HTMLButtonElement>('pre')!.parentElement!.querySelector('button')!
const label = () => copyButton().getAttribute('aria-label')

beforeEach(() => {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (navigator as unknown as Record<string, unknown>).clipboard
  vi.useRealTimers()
})

test('only code blocks get a copy button, not inline code', () => {
  act(() => root.render(markdown('Use `npm ci` first.')))
  expect(container.querySelector('button')).toBeNull()
  act(() => root.render(markdown('Run:\n\n```sh\nnpm ci\n```\n\nThen:\n\n    npm test')))
  expect([...container.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual([
    'Copy code',
    'Copy code',
  ])
})

test('a code block copies its raw code without the fence, then shows Copied for a moment', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const writeText = vi.fn().mockResolvedValue(undefined)
  setClipboard({ writeText })
  act(() => root.render(markdown('Run:\n\n```sh\nnpm ci\nnpm test\n```')))
  expect(label()).toBe('Copy code')
  await act(async () => copyButton().click())
  expect(writeText).toHaveBeenCalledWith('npm ci\nnpm test')
  expect(label()).toBe('Copied')
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Copied')
  act(() => vi.advanceTimersByTime(COPIED_MS - 1))
  expect(label()).toBe('Copied')
  act(() => vi.advanceTimersByTime(1))
  expect(label()).toBe('Copy code')
})

test('a copy that fails says so on the button instead of throwing', async () => {
  for (const clipboard of [{ writeText: vi.fn().mockRejectedValue(new Error('denied')) }, undefined]) {
    setClipboard(clipboard)
    act(() => root.render(<></>))
    act(() => root.render(markdown('```\nx\n```')))
    await act(async () => copyButton().click())
    expect(label()).toBe("Couldn't copy")
  }
})
