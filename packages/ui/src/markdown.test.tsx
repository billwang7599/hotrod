import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Markdown } from './markdown.tsx'

const render = (text: string) => renderToStaticMarkup(<Markdown className="assistant" text={text} />)

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
