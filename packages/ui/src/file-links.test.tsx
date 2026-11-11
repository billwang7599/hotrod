// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ClientMessage } from '@kothar/core/shared'
import { editorLabel, FileLinks, fileLinksChecked, forgetFileLinks, NoFileLinks } from './file-links.tsx'
import { codeRef, fileRefsIn, looksLikePath } from './file-refs.ts'
import { UserText } from './lists.tsx'
import { Markdown } from './markdown.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('finding paths', () => {
  const paths = (text: string) => fileRefsIn(text).map(({ path, line, col }) => [path, line, col].filter((x) => x !== undefined).join(':'))

  test('finds relative, absolute and ~ paths, with a line and column', () => {
    expect(paths('See packages/core/src/core.ts:52 and src/app.tsx, then /Users/me/a b.md or ~/notes/todo.md:3:7.')).toEqual([
      'packages/core/src/core.ts:52',
      'src/app.tsx',
      '/Users/me/a',
      'b.md',
      '~/notes/todo.md:3:7',
    ])
    expect(paths('Edit README.md. Then ./run.sh and ../x/y.')).toEqual(['README.md', './run.sh', '../x/y'])
  })

  test('never matches URLs, versions or plain words', () => {
    expect(paths('Go to https://example.com/a/b.ts or http://x.io/y.md')).toEqual([])
    expect(paths('Version 1.5 and v2.0.1 shipped. Done: ok')).toEqual([])
    expect(looksLikePath('/')).toBe(false)
    expect(looksLikePath('file://a/b')).toBe(false)
  })

  test('takes a whole code span as one path, but not a command', () => {
    expect(codeRef('packages/core/src/core.ts:52')).toEqual({ path: 'packages/core/src/core.ts', line: 52 })
    expect(codeRef('/Users/me/My Notes/a.md')).toEqual({ path: '/Users/me/My Notes/a.md' })
    expect(codeRef('cat src/a.ts')).toBeNull()
    expect(codeRef('npm run lint')).toBeNull()
    expect(codeRef('a.b()')).toBeNull()
  })

  test('names what a click opens with', () => {
    expect(editorLabel({})).toBe('Open with the default app')
    expect(editorLabel({ editor: 'zed', editors: [{ id: 'zed', name: 'Zed' }] })).toBe('Open in Zed')
    expect(editorLabel({ editor: 'custom' })).toBe('Open with your command')
  })
})

describe('links', () => {
  let root: Root
  let host: HTMLDivElement
  let sent: ClientMessage[]

  beforeEach(() => {
    vi.useFakeTimers()
    forgetFileLinks()
    sent = []
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  function render(children: ReactNode, connected = true) {
    act(() =>
      root.render(
        <LazyMotion features={domAnimation} strict>
          <MotionConfig transition={{ duration: 0 }}>
            <Tooltip.Provider delayDuration={0}>
              <FileLinks.Provider value={{ chatId: 'c1', send: (m) => sent.push(m), connected, editor: 'Open in Zed' }}>
                {children}
              </FileLinks.Provider>
            </Tooltip.Provider>
          </MotionConfig>
        </LazyMotion>,
      ),
    )
    act(() => vi.advanceTimersByTime(50))
  }
  const answer = (paths: Record<string, string | null>) => act(() => fileLinksChecked({ type: 'files.checked', chatId: 'c1', paths }))
  const links = () => [...host.querySelectorAll('[data-file-link]')] as HTMLElement[]

  test('asks the core once, in one batch, and links only the paths it finds', () => {
    render(<Markdown className="a" text={'Changed `src/a.ts:12` and src/gone.ts, see [b.md](https://x.dev/b.md).\n\n```\nsrc/a.ts\n```'} />)
    expect(sent).toEqual([{ type: 'files.check', chatId: 'c1', paths: ['src/a.ts', 'src/gone.ts'] }])
    expect(links()).toEqual([])
    answer({ 'src/a.ts': '/w/app/src/a.ts', 'src/gone.ts': null })
    expect(links().map((l) => [l.dataset.fileLink, l.textContent])).toEqual([['/w/app/src/a.ts', 'src/a.ts:12']])
    expect(host.querySelector('[data-file-link] code')).not.toBeNull()
    expect(host.querySelector('pre [data-file-link]')).toBeNull()
    // Rendering again asks nothing new.
    render(<Markdown className="a" text="src/a.ts again" />)
    expect(sent).toHaveLength(1)
  })

  test('a click opens the file at its line in the editor; Enter does too', () => {
    render(<Markdown className="a" text="Look at `src/a.ts:12:4`." />)
    answer({ 'src/a.ts': '/w/app/src/a.ts' })
    act(() => links()[0]!.click())
    act(() => links()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    const open = { type: 'file.open', chatId: 'c1', path: '/w/app/src/a.ts', line: 12, col: 4, in: 'editor' }
    expect(sent.slice(1)).toEqual([open, open])
  })

  test('right-click offers a terminal at its folder, Finder and copying the path', () => {
    render(<Markdown className="a" text="Look at src/a.ts" />)
    answer({ 'src/a.ts': '/w/app/src/a.ts' })
    act(() => links()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 })))
    const items = [...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[]
    expect(items.map((i) => i.textContent)).toEqual(['Open in Zed', 'Open folder in Terminal', expect.stringMatching(/^Show in /), 'Copy path'])
    act(() => items[1]!.click())
    expect(sent.at(-1)).toEqual({ type: 'file.open', chatId: 'c1', path: '/w/app/src/a.ts', in: 'terminal' })
  })

  test("links paths in the user's own messages, lists included", () => {
    render(<UserText text={'Fix src/a.ts\n- and src/b.ts:3'} />)
    expect(sent[0]).toEqual({ type: 'files.check', chatId: 'c1', paths: ['src/a.ts', 'src/b.ts'] })
    answer({ 'src/a.ts': '/w/src/a.ts', 'src/b.ts': '/w/src/b.ts' })
    expect(links().map((l) => l.textContent)).toEqual(['src/a.ts', 'src/b.ts:3'])
  })

  test('text still typing out asks nothing and links nothing', () => {
    render(
      <NoFileLinks>
        <Markdown className="a" text="Editing src/a.t" />
      </NoFileLinks>,
    )
    expect(sent).toEqual([])
  })

  test('while disconnected a link does nothing', () => {
    render(<Markdown className="a" text="src/a.ts" />, false)
    answer({ 'src/a.ts': '/w/src/a.ts' })
    act(() => links()[0]!.click())
    expect(sent.filter((m) => m.type === 'file.open')).toEqual([])
  })
})
