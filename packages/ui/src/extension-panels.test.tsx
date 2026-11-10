// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { ExtensionView } from '@kothar/extension-api'
import type { ClientMessage } from '@kothar/core/shared'
import { ContextPanel } from './context-panel.tsx'
import { initialState, panelKey, reduce, type ChatView, type State } from './state.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const space: ChatView = {
  id: 'space',
  name: 'Space',
  folders: [],
  files: [],
  engine: 'fake',
  archived: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  status: 'idle',
  items: [],
  draft: '',
  queue: [],
}
const extensionUi: State['extensionUi'] = {
  chatId: 'space',
  panels: [{ extension: 'git', id: 'changes', title: 'Changes' }],
  commands: [{ extension: 'git', id: 'refresh', label: 'Refresh', hint: 'Looks again' }],
}
const view: ExtensionView = {
  type: 'stack',
  children: [
    { type: 'heading', text: 'feat/x' },
    { type: 'badge', text: '2 ahead', tone: 'success' },
    {
      type: 'list',
      label: 'Files',
      items: [{ key: 'a', label: 'a.ts', detail: '+3 −1', action: { name: 'open', value: 'a.ts' } }],
    },
    { type: 'code', language: 'diff', text: '@@ -1 +1 @@\n-old\n+new' },
    { type: 'button', label: 'Again', action: { name: 'again' } },
  ],
}

let root: Root
let host: HTMLDivElement
let sent: ClientMessage[]

beforeEach(() => {
  localStorage.clear()
  sent = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function render(panelViews: State['panelViews'] = {}) {
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider delayDuration={0}>
            <ContextPanel
              chatId="space"
              items={[]}
              chats={[space]}
              workFolder={{ defaultPath: '/w', canSandbox: true }}
              readOnly={false}
              connected
              send={(m) => sent.push(m)}
              extensionUi={extensionUi}
              panelViews={panelViews}
            />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
}

const tab = (name: string) => [...host.querySelectorAll('[role="tab"]')].find((t) => t.textContent === name) as HTMLElement
const button = (name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(name)) as HTMLButtonElement

test("an extension's panel is a tab beside Kothar's own, and asks the core for its view when opened", () => {
  render()
  expect([...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual([
    'General',
    'Context',
    'Changes',
  ])
  expect(sent).toEqual([])
  act(() => tab('Changes').click())
  expect(tab('Changes').getAttribute('aria-selected')).toBe('true')
  expect(sent).toEqual([{ type: 'extension.panel.get', chatId: 'space', extension: 'git', panel: 'changes' }])
  expect(host.querySelector('[role="tabpanel"]')!.textContent).toContain('Loading…')
})

test('the view is drawn with Kothar controls, and its actions go back to the extension', () => {
  localStorage.setItem('kothar.panelTab', 'extension:git/changes')
  render({ [panelKey('space', 'git', 'changes')]: { view } })
  const panel = host.querySelector('[role="tabpanel"]')!
  expect(panel.querySelector('h3')!.textContent).toBe('feat/x')
  expect(panel.textContent).toContain('2 ahead')
  const lines = [...panel.querySelectorAll('pre div')]
  expect(lines.map((l) => l.textContent)).toEqual(['@@ -1 +1 @@', '-old', '+new'])
  expect(lines[2]!.className).toContain('text-green')
  expect(lines[1]!.className).toContain('text-red')
  sent = []
  act(() => button('a.ts').click())
  act(() => button('Again').click())
  expect(sent).toEqual([
    { type: 'extension.panel.action', chatId: 'space', extension: 'git', panel: 'changes', action: { name: 'open', value: 'a.ts' } },
    { type: 'extension.panel.action', chatId: 'space', extension: 'git', panel: 'changes', action: { name: 'again' } },
  ])
})

test("a render error shows in the panel; a tab the chat doesn't have falls back to Context", () => {
  localStorage.setItem('kothar.panelTab', 'extension:git/changes')
  render({ [panelKey('space', 'git', 'changes')]: { error: 'git is missing' } })
  expect(host.querySelector('[role="tabpanel"]')!.textContent).toBe('git is missing')
  localStorage.setItem('kothar.panelTab', 'extension:gone/panel')
  render()
  expect(tab('Context').getAttribute('aria-selected')).toBe('true')
})

test("extensions' commands are listed in General and run on click", () => {
  localStorage.setItem('kothar.panelTab', 'general')
  render()
  act(() => button('Refresh').click())
  expect(sent).toContainEqual({ type: 'extension.command', chatId: 'space', extension: 'git', command: 'refresh' })
})

test("the state keeps the selected chat's extension tabs and panel views, and drops them on a switch", () => {
  let state = reduce({ ...initialState, chats: [space], selectedId: 'space' }, { type: 'chat.extensions', ...extensionUi! })
  state = reduce(state, { type: 'extension.panel', chatId: 'space', extension: 'git', panel: 'changes', view })
  state = reduce(state, { type: 'chat.extensions', chatId: 'other', panels: [], commands: [] })
  expect(state.extensionUi).toEqual(extensionUi)
  expect(state.panelViews).toEqual({ [panelKey('space', 'git', 'changes')]: { view } })
  state = reduce(state, { type: 'select', chatId: 'other' })
  expect(state.extensionUi).toBeUndefined()
  expect(state.panelViews).toEqual({})
})

test("an extension's note keeps the panel it opens", () => {
  const at = '2026-01-01T00:00:00.000Z'
  let state = reduce({ ...initialState, chats: [space], selectedId: 'space' }, { type: 'select', chatId: 'space' })
  state = reduce(state, {
    type: 'chat.entry',
    chatId: 'space',
    entry: { at, type: 'extension.note', text: '3 files changed', extension: 'git', panel: 'changes' },
  })
  expect(state.chats[0]!.items).toEqual([{ kind: 'note', text: '3 files changed', extension: 'git', panel: 'changes' }])
})

test('a row can have a status dot and a link of its own, apart from its action', () => {
  localStorage.setItem('kothar.panelTab', 'extension:git/changes')
  const rows: ExtensionView = {
    type: 'list',
    items: [
      {
        key: 'web',
        label: 'web',
        dot: 'success',
        link: { text: 'localhost:5173', url: 'http://localhost:5173/' },
        action: { name: 'open', value: 'web' },
      },
      { key: 'plain', label: 'plain' },
    ],
  }
  render({ [panelKey('space', 'git', 'changes')]: { view: rows } })
  const [web, plain] = [...host.querySelectorAll('[role="tabpanel"] li')]
  expect(web!.querySelector('[data-tone]')!.getAttribute('data-tone')).toBe('success')
  expect(web!.querySelector('[data-tone]')!.className).toContain('bg-green')
  const link = web!.querySelector('a')!
  expect([link.textContent, link.getAttribute('href'), link.getAttribute('target')]).toEqual([
    'localhost:5173',
    'http://localhost:5173/',
    '_blank',
  ])
  expect(link.closest('button')).toBeNull()
  expect(plain!.querySelector('[data-tone]')).toBeNull()
  expect(plain!.querySelector('a')).toBeNull()
})

test('followed output shows its last lines and stays at the end as it grows, unless scrolled up', () => {
  localStorage.setItem('kothar.panelTab', 'extension:git/changes')
  const log = (lines: number): ExtensionView => ({
    type: 'code',
    text: Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n'),
    maxLines: 3,
    follow: true,
  })
  const key = panelKey('space', 'git', 'changes')
  // jsdom lays nothing out, so the log says how tall it is.
  const scrolls: number[] = []
  const pre = () => host.querySelector('[role="tabpanel"] pre') as HTMLPreElement
  const sized = (el: HTMLPreElement) => {
    let top = 0
    Object.defineProperties(el, {
      scrollHeight: { configurable: true, get: () => 1000 },
      clientHeight: { configurable: true, get: () => 200 },
      scrollTop: { configurable: true, get: () => top, set: (value: number) => (scrolls.push(value), (top = value)) },
    })
  }
  render({ [key]: { view: log(5) } })
  expect([...pre().querySelectorAll('div')].map((d) => d.textContent)).toEqual([
    '2 earlier lines',
    'line 3',
    'line 4',
    'line 5',
  ])
  sized(pre())
  render({ [key]: { view: log(6) } })
  expect(scrolls).toEqual([1000])
  // Scrolled up to read: new lines don't pull it back down.
  act(() => {
    pre().scrollTop = 100
    pre().dispatchEvent(new Event('scroll'))
  })
  render({ [key]: { view: log(7) } })
  expect(scrolls).toEqual([1000, 100])
  // Back at the end, it follows again.
  act(() => {
    pre().scrollTop = 800
    pre().dispatchEvent(new Event('scroll'))
  })
  render({ [key]: { view: log(8) } })
  expect(scrolls).toEqual([1000, 100, 800, 1000])
})
