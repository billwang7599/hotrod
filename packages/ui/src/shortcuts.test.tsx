// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { useState } from 'react'
import { PanelToggle } from './controls.tsx'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { nthSpace, spaceOrder, stepSpace } from './nav.ts'
import { ShortcutsPage } from './shortcuts-page.tsx'
import {
  acceleratorOf,
  actionFor,
  bindingOf,
  bindings,
  conflictsOf,
  formatBinding,
  matches,
  panelShortcuts,
  refusal,
  reloadShortcuts,
  resetAllBindings,
  resetBinding,
  setBinding,
  useShortcuts,
} from './shortcuts.ts'
import type { ChatView } from './state.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const key = (k: string, code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
  key: k,
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

beforeEach(() => {
  localStorage.clear()
  reloadShortcuts()
})

describe('bindings', () => {
  test('a key press names its physical key, with Mod for ⌘ on macOS and Ctrl elsewhere', () => {
    expect(bindingOf(key('o', 'KeyO', { metaKey: true }), true)).toBe('Mod+O')
    expect(bindingOf(key('o', 'KeyO', { ctrlKey: true }), false)).toBe('Mod+O')
    expect(bindingOf(key('o', 'KeyO', { ctrlKey: true }), true)).toBe('Ctrl+O')
    // ⌥ changes the typed character but not the binding.
    expect(bindingOf(key('ø', 'KeyO', { metaKey: true, altKey: true }), true)).toBe('Mod+Alt+O')
    expect(bindingOf(key('<', 'Comma', { metaKey: true, shiftKey: true }), true)).toBe('Mod+Shift+,')
    expect(bindingOf(key('ArrowUp', 'ArrowUp', { metaKey: true }), true)).toBe('Mod+ArrowUp')
    expect(bindingOf(key('Meta', 'MetaLeft', { metaKey: true }), true)).toBeNull()
  })

  test('matching needs exactly the same modifiers', () => {
    expect(matches(key('o', 'KeyO', { metaKey: true }), 'Mod+O', true)).toBe(true)
    expect(matches(key('o', 'KeyO', { metaKey: true, shiftKey: true }), 'Mod+O', true)).toBe(false)
    expect(matches(key('o', 'KeyO', { ctrlKey: true }), 'Mod+O', false)).toBe(true)
    expect(matches(key('o', 'KeyO', { ctrlKey: true, metaKey: true }), 'Mod+O', false)).toBe(false)
    expect(matches(key('1', 'Digit1', { metaKey: true }), 'Mod+1', true)).toBe(true)
    expect(matches(key('o', 'KeyO'), null, true)).toBe(false)
  })

  test('bindings read as symbols on macOS and words elsewhere', () => {
    expect(formatBinding('Mod+Shift+O', true)).toBe('⇧⌘O')
    expect(formatBinding('Mod+ArrowUp', true)).toBe('⌘↑')
    expect(formatBinding('Mod+,', true)).toBe('⌘,')
    expect(formatBinding('Ctrl+Alt+K', true)).toBe('⌃⌥K')
    expect(formatBinding('Mod+Shift+O', false)).toBe('Ctrl+Shift+O')
    expect(formatBinding('Mod+ArrowDown', false)).toBe('Ctrl+Down')
    expect(formatBinding(null, true)).toBe('')
  })

  test('menu accelerators use Electron names', () => {
    expect(acceleratorOf('Mod+Shift+O')).toBe('CmdOrCtrl+Shift+O')
    expect(acceleratorOf('Mod+ArrowUp')).toBe('CmdOrCtrl+Up')
    expect(acceleratorOf('Mod+,')).toBe('CmdOrCtrl+,')
    expect(acceleratorOf(null)).toBeNull()
  })

  test('bare keys and system keys are refused', () => {
    expect(refusal('O')).toMatch(/Add/)
    expect(refusal('Shift+O')).toMatch(/Add/)
    expect(refusal('Alt+O')).toBeUndefined()
    expect(refusal('F5')).toBeUndefined()
    expect(refusal('Mod+Q')).toMatch(/system/)
    expect(refusal('Mod+K')).toBeUndefined()
  })

  test('conflicts name the other actions on the same keys', () => {
    expect(conflictsOf('newSpace', 'Mod+,').map((a) => a.id)).toEqual(['settings'])
    expect(conflictsOf('settings', 'Mod+,')).toEqual([])
    expect(conflictsOf('newSpace', 'Mod+K')).toEqual([])
  })

  test('changes persist in localStorage, and setting the default drops the change', () => {
    setBinding('newSpace', 'Mod+Shift+N')
    expect(JSON.parse(localStorage.getItem('kothar.shortcuts')!)).toEqual({ newSpace: 'Mod+Shift+N' })
    reloadShortcuts()
    expect(bindings().newSpace).toBe('Mod+Shift+N')
    setBinding('settings', null)
    expect(bindings().settings).toBeNull()
    setBinding('newSpace', 'Mod+N')
    expect(JSON.parse(localStorage.getItem('kothar.shortcuts')!)).toEqual({ settings: null })
    resetBinding('settings')
    expect(bindings().settings).toBe('Mod+,')
    setBinding('jump1', 'Alt+1')
    resetAllBindings()
    expect(localStorage.getItem('kothar.shortcuts')).toBe('{}')
    expect(bindings().jump1).toBe('Mod+1')
  })

  test('saved junk is ignored', () => {
    localStorage.setItem('kothar.shortcuts', JSON.stringify({ newSpace: 'Mod+Bogus+N', settings: 4 }))
    reloadShortcuts()
    expect(bindings().newSpace).toBe('Mod+N')
    expect(bindings().settings).toBe('Mod+,')
    localStorage.setItem('kothar.shortcuts', 'not json')
    reloadShortcuts()
    expect(bindings().newSpace).toBe('Mod+N')
  })

  test('a key press finds its action only when it has a handler', () => {
    const press = key('ArrowDown', 'ArrowDown', { metaKey: true })
    expect(actionFor(press, { nextSpace: () => {} }, bindings(), true)).toBe('nextSpace')
    expect(actionFor(press, {}, bindings(), true)).toBeUndefined()
  })
})

const chat = (change: Partial<ChatView>): ChatView => ({
  id: 'c1',
  name: 'demo',
  folders: [],
  files: [],
  engine: 'fake',
  archived: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  status: 'idle',
  items: [],
  draft: '',
  queue: [],
  ...change,
})

describe('space order', () => {
  const HOME = chat({ id: 'main', name: 'Home', extension: 'home' })
  const A = chat({ id: 'a', order: 0 })
  const B = chat({ id: 'b', order: 1 })
  const P = chat({ id: 'p', order: 0, pinned: true })
  const SUB = chat({ id: 's', parentId: 'a', worker: true })
  const OLD = chat({ id: 'old', archived: true })
  const chats = [B, SUB, A, OLD, P, HOME]

  test('Home, then pinned, then the other spaces; no workers or archived ones', () => {
    expect(spaceOrder(chats).map((c) => c.id)).toEqual(['main', 'p', 'a', 'b'])
    expect(spaceOrder(chats.filter((c) => c !== HOME)).map((c) => c.id)).toEqual(['p', 'a', 'b'])
  })

  test('up and down step through it and stop at the ends', () => {
    expect(stepSpace(chats, 'main', 1)).toBe('p')
    expect(stepSpace(chats, 'p', 1)).toBe('a')
    expect(stepSpace(chats, 'b', 1)).toBeUndefined()
    expect(stepSpace(chats, 'main', -1)).toBeUndefined()
    expect(stepSpace(chats, 'a', -1)).toBe('p')
  })

  test('from a worker, up is its space and down the next space', () => {
    expect(stepSpace(chats, 's', -1)).toBe('a')
    expect(stepSpace(chats, 's', 1)).toBe('b')
  })

  test('from nothing or an archived chat, down starts at the top and up at the bottom', () => {
    expect(stepSpace(chats, '', 1)).toBe('main')
    expect(stepSpace(chats, 'old', -1)).toBe('b')
  })

  test('numbers count the same entries', () => {
    expect(nthSpace(chats, 1)).toBe('main')
    expect(nthSpace(chats, 3)).toBe('a')
    expect(nthSpace(chats, 9)).toBeUndefined()
  })
})

describe('in the window', () => {
  let root: Root
  let container: HTMLElement
  beforeEach(() => {
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const press = (target: EventTarget, init: KeyboardEventInit) =>
    act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })))
  const mod = navigator.platform.includes('Mac') ? { metaKey: true } : { ctrlKey: true }

  function Harness({ ran }: { ran: string[] }) {
    useShortcuts({ nextSpace: () => ran.push('next'), settings: () => ran.push('settings') })
    return <input aria-label="field" />
  }

  test('runs a handler for its keys, even from a text field, and takes the key from the field', () => {
    const ran: string[] = []
    act(() => root.render(<Harness ran={ran} />))
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true, ...mod })
    act(() => void container.querySelector('input')!.dispatchEvent(event))
    expect(ran).toEqual(['next'])
    expect(event.defaultPrevented).toBe(true)
    press(window, { key: 'ArrowDown', code: 'ArrowDown' })
    expect(ran).toEqual(['next'])
  })

  test('follows a remap at once', () => {
    const ran: string[] = []
    act(() => root.render(<Harness ran={ran} />))
    act(() => setBinding('settings', 'Alt+S'))
    press(window, { key: ',', code: 'Comma', ...mod })
    press(window, { key: 'ß', code: 'KeyS', altKey: true })
    expect(ran).toEqual(['settings'])
  })

  test('Settings records new keys, refuses bare letters, warns on a conflict and resets', () => {
    const ran: string[] = []
    act(() =>
      root.render(
        <Tooltip.Provider>
          <Harness ran={ran} />
          <ShortcutsPage />
        </Tooltip.Provider>,
      ),
    )
    const row = (id: string) => container.querySelector(`[data-action="${id}"]`)!
    const keysButton = (id: string) => row(id).querySelector('button[aria-pressed]') as HTMLButtonElement

    act(() => keysButton('newSpace').click())
    expect(keysButton('newSpace').textContent).toBe('Press keys…')
    press(keysButton('newSpace'), { key: 'k', code: 'KeyK' })
    expect(row('newSpace').textContent).toMatch(/Add/)
    expect(bindings().newSpace).toBe('Mod+N')

    // The recorder swallows the keys, so recording ⌘, doesn't open Settings.
    press(keysButton('newSpace'), { key: ',', code: 'Comma', ...mod })
    expect(ran).toEqual([])
    expect(row('newSpace').textContent).toMatch(/Already Settings/)
    expect(bindings().newSpace).toBe('Mod+N')
    act(() => ([...row('newSpace').querySelectorAll('button')].find((b) => b.textContent === 'Use here instead')!).click())
    expect(bindings().newSpace).toBe('Mod+,')
    expect(bindings().settings).toBeNull()

    act(() => (row('settings').querySelector('[aria-label="Reset Settings"]') as HTMLButtonElement).click())
    expect(bindings().settings).toBe('Mod+,')

    act(() => keysButton('jump2').click())
    press(keysButton('jump2'), { key: 'Escape', code: 'Escape' })
    expect(keysButton('jump2').getAttribute('aria-pressed')).toBe('false')

    act(() => ([...container.querySelectorAll('button')].find((b) => b.textContent === 'Reset all')!).click())
    expect(bindings().newSpace).toBe('Mod+N')
  })

  // Like the app: both panels' toggle buttons and keys share one state.
  function Panels({ covered = false, chatOpen = true }: { covered?: boolean; chatOpen?: boolean }) {
    const [sidebar, setSidebar] = useState(true)
    const [context, setContext] = useState(false)
    const toggleSidebar = () => setSidebar((open) => !open)
    const toggleContext = () => setContext((open) => !open)
    useShortcuts(panelShortcuts({ covered, chatOpen, toggleSidebar, toggleContext }))
    return (
      <Tooltip.Provider delayDuration={0}>
        <PanelToggle
          side="left"
          label="Sidebar"
          noun="sidebar"
          open={sidebar}
          toggle={toggleSidebar}
          action="toggleSidebar"
        />
        <PanelToggle
          side="right"
          label="Context panel"
          noun="context"
          open={context}
          toggle={toggleContext}
          action="toggleContextPanel"
        />
        <textarea aria-label="composer" />
      </Tooltip.Provider>
    )
  }
  const pressed = (label: string) =>
    container.querySelector(`[aria-label="${label}"]`)!.getAttribute('aria-pressed') === 'true'

  test('⌘[ and ⌘] show and hide the sidebar and the context panel, even from the composer', () => {
    act(() => root.render(<Panels />))
    expect([pressed('Sidebar'), pressed('Context panel')]).toEqual([true, false])
    const composer = container.querySelector('textarea')!
    press(composer, { key: '[', code: 'BracketLeft', ...mod })
    expect(pressed('Sidebar')).toBe(false)
    press(composer, { key: '[', code: 'BracketLeft', ...mod })
    expect(pressed('Sidebar')).toBe(true)
    // A layout that types another character on the key (here German, ü) still matches the physical key.
    press(composer, { key: '+', code: 'BracketRight', ...mod })
    expect([pressed('Sidebar'), pressed('Context panel')]).toEqual([true, true])
  })

  test("the bracket keys never reach the browser, so its own ⌘[ / ⌘] (back and forward) don't run", () => {
    act(() => root.render(<Panels />))
    const keys = [
      { key: '[', code: 'BracketLeft' },
      { key: ']', code: 'BracketRight' },
    ]
    for (const init of keys) {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init, ...mod })
      act(() => void window.dispatchEvent(event))
      expect(event.defaultPrevented).toBe(true)
    }
  })

  test('a saved remap of a panel key is kept; without one, the panel keys are the bracket defaults', () => {
    localStorage.setItem('kothar.shortcuts', JSON.stringify({ toggleSidebar: 'Mod+B' }))
    reloadShortcuts()
    expect([bindings().toggleSidebar, bindings().toggleContextPanel]).toEqual(['Mod+B', 'Mod+]'])
    localStorage.removeItem('kothar.shortcuts')
    reloadShortcuts()
    expect([bindings().toggleSidebar, bindings().toggleContextPanel]).toEqual(['Mod+[', 'Mod+]'])
  })

  test('the panel keys follow a remap, and do nothing behind a dialog or, for the context panel, without a chat', () => {
    act(() => root.render(<Panels />))
    act(() => setBinding('toggleSidebar', 'Mod+Shift+S'))
    press(window, { key: '[', code: 'BracketLeft', ...mod })
    expect(pressed('Sidebar')).toBe(true)
    press(window, { key: 'S', code: 'KeyS', shiftKey: true, ...mod })
    expect(pressed('Sidebar')).toBe(false)

    act(() => root.render(<Panels covered />))
    press(window, { key: 'S', code: 'KeyS', shiftKey: true, ...mod })
    press(window, { key: ']', code: 'BracketRight', ...mod })
    expect([pressed('Sidebar'), pressed('Context panel')]).toEqual([false, false])

    act(() => root.render(<Panels chatOpen={false} />))
    press(window, { key: ']', code: 'BracketRight', ...mod })
    expect(pressed('Context panel')).toBe(false)
    press(window, { key: 'S', code: 'KeyS', shiftKey: true, ...mod })
    expect(pressed('Sidebar')).toBe(true)
  })

  test("a panel toggle's tooltip shows the user's current keys", async () => {
    act(() => root.render(<Panels />))
    const tooltip = async (label: string) => {
      const button = container.querySelector(`[aria-label="${label}"]`) as HTMLElement
      act(() => button.focus())
      await act(() => new Promise((done) => setTimeout(done, 10)))
      return document.querySelector('[role="tooltip"]')?.textContent ?? ''
    }
    expect(await tooltip('Sidebar')).toBe(`Hide sidebar${formatBinding('Mod+[')}`)
    expect(await tooltip('Context panel')).toBe(`Show context${formatBinding('Mod+]')}`)
    act(() => setBinding('toggleContextPanel', 'Mod+Shift+K'))
    expect(await tooltip('Context panel')).toBe(`Show context${formatBinding('Mod+Shift+K')}`)
    act(() => setBinding('toggleContextPanel', null))
    expect(await tooltip('Context panel')).toBe('Show context')
  })

  test('the panel keys are on the menu, and clash with no other default', () => {
    const all = bindings()
    expect([all.toggleSidebar, all.toggleContextPanel]).toEqual(['Mod+[', 'Mod+]'])
    expect(conflictsOf('toggleSidebar', 'Mod+[')).toEqual([])
    expect(conflictsOf('toggleContextPanel', 'Mod+]')).toEqual([])
    expect([refusal('Mod+['), refusal('Mod+]')]).toEqual([undefined, undefined])
    expect([acceleratorOf('Mod+['), acceleratorOf('Mod+]')]).toEqual(['CmdOrCtrl+[', 'CmdOrCtrl+]'])
    expect([formatBinding('Mod+[', true), formatBinding('Mod+]', false)]).toEqual(['⌘[', 'Ctrl+]'])
    expect(bindingOf({ key: '[', code: 'BracketLeft', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, true)).toBe('Mod+[')
  })
})
