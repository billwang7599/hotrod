// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { ModView } from '@hotrod/mod-api'
import type { ClientMessage } from '@hotrod/core/shared'
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
const modUi: State['modUi'] = {
  chatId: 'space',
  panels: [{ mod: 'git', id: 'changes', title: 'Changes' }],
  commands: [{ mod: 'git', id: 'refresh', label: 'Refresh', hint: 'Looks again' }],
}
const view: ModView = {
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
              modUi={modUi}
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

test("a mod's panel is a tab beside Hotrod's own, and asks the core for its view when opened", () => {
  render()
  expect([...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual([
    'General',
    'Context',
    'Permissions',
    'Changes',
  ])
  expect(sent).toEqual([])
  act(() => tab('Changes').click())
  expect(tab('Changes').getAttribute('aria-selected')).toBe('true')
  expect(sent).toEqual([{ type: 'mod.panel.get', chatId: 'space', mod: 'git', panel: 'changes' }])
  expect(host.querySelector('[role="tabpanel"]')!.textContent).toContain('Loading…')
})

test('the view is drawn with Hotrod controls, and its actions go back to the mod', () => {
  localStorage.setItem('hotrod.panelTab', 'mod:git/changes')
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
    { type: 'mod.panel.action', chatId: 'space', mod: 'git', panel: 'changes', action: { name: 'open', value: 'a.ts' } },
    { type: 'mod.panel.action', chatId: 'space', mod: 'git', panel: 'changes', action: { name: 'again' } },
  ])
})

test("a render error shows in the panel; a tab the chat doesn't have falls back to Context", () => {
  localStorage.setItem('hotrod.panelTab', 'mod:git/changes')
  render({ [panelKey('space', 'git', 'changes')]: { error: 'git is missing' } })
  expect(host.querySelector('[role="tabpanel"]')!.textContent).toBe('git is missing')
  localStorage.setItem('hotrod.panelTab', 'mod:gone/panel')
  render()
  expect(tab('Context').getAttribute('aria-selected')).toBe('true')
})

test("mods' commands are listed in General and run on click", () => {
  localStorage.setItem('hotrod.panelTab', 'general')
  render()
  act(() => button('Refresh').click())
  expect(sent).toContainEqual({ type: 'mod.command', chatId: 'space', mod: 'git', command: 'refresh' })
})

test("the state keeps the selected chat's mod tabs and panel views, and drops them on a switch", () => {
  let state = reduce({ ...initialState, chats: [space], selectedId: 'space' }, { type: 'chat.mods', ...modUi! })
  state = reduce(state, { type: 'mod.panel', chatId: 'space', mod: 'git', panel: 'changes', view })
  state = reduce(state, { type: 'chat.mods', chatId: 'other', panels: [], commands: [] })
  expect(state.modUi).toEqual(modUi)
  expect(state.panelViews).toEqual({ [panelKey('space', 'git', 'changes')]: { view } })
  state = reduce(state, { type: 'select', chatId: 'other' })
  expect(state.modUi).toBeUndefined()
  expect(state.panelViews).toEqual({})
})

test("a mod's note keeps the panel it opens", () => {
  const at = '2026-01-01T00:00:00.000Z'
  let state = reduce({ ...initialState, chats: [space], selectedId: 'space' }, { type: 'select', chatId: 'space' })
  state = reduce(state, {
    type: 'chat.entry',
    chatId: 'space',
    entry: { at, type: 'mod.note', text: '3 files changed', mod: 'git', panel: 'changes' },
  })
  expect(state.chats[0]!.items).toEqual([{ kind: 'note', text: '3 files changed', mod: 'git', panel: 'changes' }])
})
