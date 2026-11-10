// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ExtensionView } from '@kothar/extension-api'
import type { ClientMessage, PanelTab } from '@kothar/core/shared'
import { ContextPanel } from './context-panel.tsx'
import { ExtensionViewer, SEARCH_VIEW_MS } from './extension-view.tsx'
import { ExtensionPopup, panelDefaultKeys, sidebarEntries, usePanelShortcuts } from './extension-popups.tsx'
import { currentPopup, openPopup, usePanelTab } from './panel-tab.ts'
import { reloadShortcuts, setBinding, shortcutActions } from './shortcuts.ts'
import { panelKey, type ChatView, type State } from './state.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const notes: PanelTab = { extension: 'notes', id: 'notes', title: 'Notes', placement: 'popup', shortcut: 'Mod+Shift+N', sidebar: true }
const changes: PanelTab = { extension: 'git', id: 'changes', title: 'Changes' }

let root: Root
let host: HTMLDivElement
let sent: ClientMessage[]

beforeEach(() => {
  localStorage.clear()
  reloadShortcuts()
  sent = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => openPopup(null))
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const wrap = (node: React.ReactNode) => (
  <LazyMotion features={domAnimation} strict>
    <MotionConfig transition={{ duration: 0 }}>
      <Tooltip.Provider delayDuration={0}>{node}</Tooltip.Provider>
    </MotionConfig>
  </LazyMotion>
)

function renderPopup(panelViews: State['panelViews'] = {}, panels: PanelTab[] = [notes, changes]) {
  act(() =>
    root.render(wrap(<ExtensionPopup chatId="space" panels={panels} panelViews={panelViews} connected send={(m) => sent.push(m)} />)),
  )
}

const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement | null

test('a popup panel opens over the chat on request, asks for its view, and sends its actions', () => {
  renderPopup()
  expect(dialog()).toBeNull()
  act(() => openPopup('extension:notes/notes'))
  expect(dialog()!.textContent).toContain('Notes')
  expect(sent).toEqual([{ type: 'extension.panel.get', chatId: 'space', extension: 'notes', panel: 'notes' }])
  const view: ExtensionView = { type: 'button', label: 'New note', action: { name: 'new' } }
  renderPopup({ [panelKey('space', 'notes', 'notes')]: { view } })
  const button = [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'New note')!
  act(() => button.click())
  expect(sent.at(-1)).toEqual({ type: 'extension.panel.action', chatId: 'space', extension: 'notes', panel: 'notes', action: { name: 'new' } })
})

test('Esc closes the popup', () => {
  renderPopup()
  act(() => openPopup('extension:notes/notes'))
  expect(dialog()).not.toBeNull()
  act(() => {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(currentPopup()).toBeNull()
})

test("a chat without the panel shows no popup, and a tab panel never opens as one", () => {
  renderPopup({}, [changes])
  act(() => openPopup('extension:notes/notes'))
  expect(dialog()).toBeNull()
  act(() => openPopup('extension:git/changes'))
  expect(dialog()).toBeNull()
})

test("a popup panel isn't a tab in the right sidebar", () => {
  const space = { id: 'space', name: 'Space', folders: [], files: [], engine: 'fake', archived: false, createdAt: '2026-01-01T00:00:00.000Z', status: 'idle', items: [], draft: '', queue: [] } as ChatView
  act(() =>
    root.render(
      wrap(
        <ContextPanel
          chatId="space"
          items={[]}
          chats={[space]}
          workFolder={{ defaultPath: '/w', canSandbox: true }}
          readOnly={false}
          connected
          send={(m) => sent.push(m)}
          extensionUi={{ chatId: 'space', panels: [notes, changes], commands: [] }}
          extensions={[]}
          panelViews={{}}
        />,
      ),
    ),
  )
  expect([...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(['General', 'Context', 'Changes'])
})

function Shortcuts({ panels, show }: { panels: PanelTab[]; show: () => void }) {
  const handlers = usePanelShortcuts(panels, show)
  const tab = usePanelTab()
  return (
    <div data-tab={tab}>
      {Object.entries(handlers).map(([id, run]) => (
        <button key={id} data-run={id} onClick={run} />
      ))}
    </div>
  )
}

test("a panel's keys join the shortcut registry, and run it: a popup toggles, a tab shows", () => {
  const show = vi.fn()
  act(() => root.render(<Shortcuts panels={[notes, { ...changes, shortcut: 'Mod+Alt+G' }]} show={show} />))
  expect(shortcutActions().find((a) => a.id === 'extension:notes/notes')).toMatchObject({ label: 'Open Notes', defaultKeys: 'Mod+Shift+N' })
  const run = (id: string) => act(() => (host.querySelector(`[data-run="${id}"]`) as HTMLButtonElement).click())
  run('extension:notes/notes')
  expect(currentPopup()).toBe('extension:notes/notes')
  run('extension:notes/notes')
  expect(currentPopup()).toBeNull()
  run('extension:git/changes')
  expect(host.querySelector('[data-tab]')!.getAttribute('data-tab')).toBe('extension:git/changes')
  expect(show).toHaveBeenCalledOnce()
})

test("a panel never takes keys another shortcut has, or keys that aren't a shortcut", () => {
  expect(panelDefaultKeys('extension:x/a', 'Mod+O')).toBeNull()
  expect(panelDefaultKeys('extension:x/a', 'N')).toBeNull()
  expect(panelDefaultKeys('extension:x/a', 'Mod+Q')).toBeNull()
  expect(panelDefaultKeys('extension:x/a', 'Shift+Mod+J')).toBe('Mod+Shift+J')
  setBinding('marketplace', 'Mod+Shift+J')
  expect(panelDefaultKeys('extension:x/a', 'Mod+Shift+J')).toBeNull()
})

test('panels that ask for a sidebar entry get one, with their keys', () => {
  const entries = sidebarEntries([notes, changes], { 'extension:notes/notes': 'Mod+Shift+N' }, () => {})
  expect(entries.map(({ label, keys }) => [label, keys])).toEqual([['Notes', 'Mod+Shift+N']])
  act(() => entries[0]!.open())
  expect(currentPopup()).toBe('extension:notes/notes')
})

test('a split draws both columns, and a search box sends what is typed after a pause', () => {
  vi.useFakeTimers()
  const acted: unknown[] = []
  const view: ExtensionView = {
    type: 'split',
    side: { type: 'search', placeholder: 'Search notes', action: 'search' },
    main: { type: 'text', text: 'Main column' },
  }
  act(() => root.render(wrap(<ExtensionViewer view={view} act={(a) => acted.push(a)} />)))
  expect(host.querySelector('[data-split]')!.textContent).toContain('Main column')
  const input = host.querySelector('input[type="search"]') as HTMLInputElement
  const type = (text: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  type('te')
  type('tes')
  expect(acted).toEqual([])
  act(() => vi.advanceTimersByTime(SEARCH_VIEW_MS))
  expect(acted).toEqual([{ name: 'search', value: 'tes' }])
  // Drawn again with the same key, it keeps what's typed.
  act(() => root.render(wrap(<ExtensionViewer view={{ ...view }} act={(a) => acted.push(a)} />)))
  expect(input.value).toBe('tes')
})

test("an editor view sends its text as the extension's change action, and links and tags as theirs", () => {
  vi.useFakeTimers()
  const acted: unknown[] = []
  const view: ExtensionView = { type: 'editor', key: 'n1', text: 'See [[Plan]] #idea', change: 'save', links: 'open', tags: 'tag' }
  act(() => root.render(wrap(<ExtensionViewer view={view} act={(a) => acted.push(a)} />)))
  const mousedown = (el: Element) => act(() => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })))
  mousedown(host.querySelector('[data-link]')!)
  mousedown(host.querySelector('[data-tag]')!)
  expect(acted).toEqual([
    { name: 'open', value: 'Plan' },
    { name: 'tag', value: 'idea' },
  ])
})
