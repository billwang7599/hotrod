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
import { ConfirmDialog } from './controls.tsx'
import { ExtensionPopup, launcherEntries, panelDefaultKeys, usePanelShortcuts } from './extension-popups.tsx'
import { currentPopup, openPopup, usePanelTab } from './panel-tab.ts'
import { reloadPopupSizes } from './popup-size.ts'
import { reloadShortcuts, setBinding, shortcutActions } from './shortcuts.ts'
import { panelKey, type ChatView, type State } from './state.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const notes: PanelTab = { extension: 'notes', id: 'notes', title: 'Notes', placement: 'popup', shortcut: 'Mod+Shift+N', launcher: true }
const changes: PanelTab = { extension: 'git', id: 'changes', title: 'Changes' }

let root: Root
let host: HTMLDivElement
let sent: ClientMessage[]

beforeEach(() => {
  localStorage.clear()
  reloadShortcuts()
  reloadPopupSizes()
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

test('panels that ask for a launcher get one, with their keys', () => {
  const entries = launcherEntries([notes, changes], { 'extension:notes/notes': 'Mod+Shift+N' }, () => {})
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

test("a popup button's confirm opens above the popup, so its own buttons take the click", async () => {
  const view: ExtensionView = {
    type: 'button',
    label: 'Delete',
    action: { name: 'delete' },
    confirm: { text: 'Delete it?', ok: 'Delete', danger: true },
  }
  act(() =>
    root.render(
      wrap(
        <>
          <ExtensionPopup chatId="space" panels={[notes]} panelViews={{ [panelKey('space', 'notes', 'notes')]: { view } }} connected send={(m) => sent.push(m)} />
          <ConfirmDialog />
        </>,
      ),
    ),
  )
  act(() => openPopup('extension:notes/notes'))
  await act(async () => [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Delete')!.click())
  const layer = (el: Element | null) => Number(/(?:^|\s)z-(\d+)/.exec(el?.className ?? '')?.[1] ?? 0)
  const alert = document.querySelector('[role="alertdialog"]')!
  // Fixed layers: the popup's backdrop and window, then the confirm's backdrop and window.
  const popupLayers = [...document.querySelectorAll('.fixed')].filter((el) => !alert.contains(el) && el !== alert && !el.className.includes('z-30'))
  expect(Math.max(...popupLayers.map(layer))).toBe(20)
  expect(layer(alert)).toBeGreaterThan(20)
  expect(layer(alert.previousElementSibling)).toBeGreaterThan(20)
  await act(async () => [...alert.querySelectorAll('button')].find((b) => b.textContent === 'Delete')!.click())
  expect(sent).toContainEqual(expect.objectContaining({ type: 'extension.panel.action', action: { name: 'delete' } }))
})

const notesView = (view: ExtensionView): State['panelViews'] => ({ [panelKey('space', 'notes', 'notes')]: { view } })
const button = (label: string) => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
const escape = () =>
  act(() => {
    ;(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })

test("opening a popup focuses its view's autofocus search box, never its Close button, and closing goes back", async () => {
  const opener = document.createElement('button')
  document.body.append(opener)
  opener.focus()
  renderPopup()
  act(() => openPopup('extension:notes/notes'))
  // Before the view arrives, the popup itself has focus.
  expect(document.activeElement).toBe(dialog())
  renderPopup(notesView({ type: 'stack', children: [{ type: 'button', label: 'New', action: { name: 'new' } }, { type: 'search', action: 'search', placeholder: 'Find', autofocus: true }] }))
  expect(document.activeElement).toBe(dialog()!.querySelector('input[type="search"]'))
  // Drawn again, it doesn't take focus back from where the user moved it.
  act(() => button('Maximise Notes').focus())
  renderPopup(notesView({ type: 'stack', children: [{ type: 'search', action: 'search', placeholder: 'Find again', autofocus: true }] }))
  expect(document.activeElement).toBe(button('Maximise Notes'))
  // Once its exit animation is done.
  await act(async () => {
    openPopup(null)
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  expect(document.activeElement).toBe(opener)
  opener.remove()
})

test('without an autofocus field, an open popup keeps focus on itself, not on Close', () => {
  renderPopup(notesView({ type: 'button', label: 'New', action: { name: 'new' } }))
  act(() => openPopup('extension:notes/notes'))
  expect(document.activeElement).toBe(dialog())
})

test('a popup maximises and restores, Esc restores before it closes, and it opens as it was left', () => {
  renderPopup(notesView({ type: 'text', text: 'Hi' }))
  act(() => openPopup('extension:notes/notes'))
  act(() => button('Maximise Notes').click())
  expect(dialog()!.dataset.maximised).toBe('true')
  expect(button('Restore Notes').getAttribute('aria-pressed')).toBe('true')
  // No resize corner while it fills the window.
  expect(document.querySelector('[aria-label="Resize Notes"]')).toBeNull()
  act(() => openPopup(null))
  act(() => openPopup('extension:notes/notes'))
  expect(dialog()!.dataset.maximised).toBe('true')
  escape()
  expect(currentPopup()).toBe('extension:notes/notes')
  expect(dialog()!.dataset.maximised).toBeUndefined()
  escape()
  expect(currentPopup()).toBeNull()
})

test("a popup's corner resizes it with the arrows, kept per extension, and double-click goes back to the default", () => {
  Object.assign(window, { innerWidth: 1400, innerHeight: 900 })
  renderPopup(notesView({ type: 'text', text: 'Hi' }))
  act(() => openPopup('extension:notes/notes'))
  const corner = document.querySelector<HTMLElement>('[aria-label="Resize Notes"]')!
  // jsdom lays nothing out: the corner starts from the default width and the smallest height.
  const key = (k: string) => act(() => corner.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))
  key('ArrowRight')
  key('ArrowDown')
  expect(JSON.parse(localStorage.getItem('kothar.popupSizes')!)).toEqual({ 'extension:notes/notes': { width: 1112, height: 352 } })
  expect(dialog()!.style.width).toMatch(/^min\(1112px,/)
  expect(dialog()!.style.height).toMatch(/^min\(352px,/)
  // Never wider than the window allows.
  for (let i = 0; i < 20; i++) key('ArrowRight')
  expect(JSON.parse(localStorage.getItem('kothar.popupSizes')!)['extension:notes/notes'].width).toBe(1400 - 32)
  act(() => corner.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
  expect(dialog()!.style.width).toBe('')
})
