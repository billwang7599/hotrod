// @vitest-environment jsdom
import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AnimatePresence, domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { ExtensionView } from '@kothar/extension-api'
import type { ClientMessage, PanelTab } from '@kothar/core/shared'
import { ExtensionDock, useOpenDock } from './extension-dock.tsx'
import { launcherEntries, usePanelShortcuts } from './extension-popups.tsx'
import { currentDock, openDock, showsFor, widenDock } from './panel-tab.ts'
import { reloadShortcuts } from './shortcuts.ts'
import { panelKey, type State } from './state.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const artifacts: PanelTab = { extension: 'artifacts', id: 'artifacts', title: 'Artifacts', placement: 'dock', shortcut: 'Mod+Shift+A', launcher: true }
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
  act(() => openDock(null))
  act(() => root.unmount())
  host.remove()
})

function Docked({ panels, panelViews }: { panels: PanelTab[]; panelViews: State['panelViews'] }) {
  const panel = useOpenDock(panels)
  return (
    <AnimatePresence>
      {panel && <ExtensionDock key={panel.id} chatId="space" panel={panel} panelViews={panelViews} connected send={(m) => sent.push(m)} />}
    </AnimatePresence>
  )
}

function render(panelViews: State['panelViews'] = {}, panels: PanelTab[] = [artifacts, changes]) {
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider delayDuration={0}>
            <textarea aria-label="Message" />
            <Docked panels={panels} panelViews={panelViews} />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
}

const dock = () => document.querySelector('[data-dock]') as HTMLElement | null
const button = (label: string) => document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement

test('a dock panel opens beside the chat without taking focus, asks for its view and sends its actions', () => {
  render()
  const composer = document.querySelector('textarea')!
  composer.focus()
  expect(dock()).toBeNull()
  act(() => openDock('extension:artifacts/artifacts'))
  expect(dock()!.getAttribute('aria-label')).toBe('Artifacts')
  expect(document.activeElement).toBe(composer)
  expect(sent).toEqual([{ type: 'extension.panel.get', chatId: 'space', extension: 'artifacts', panel: 'artifacts' }])
  const view: ExtensionView = { type: 'button', label: 'Restore', action: { name: 'restore', value: 2 } }
  render({ [panelKey('space', 'artifacts', 'artifacts')]: { view } })
  act(() => [...dock()!.querySelectorAll('button')].find((b) => b.textContent === 'Restore')!.click())
  expect(sent.at(-1)).toEqual({
    type: 'extension.panel.action',
    chatId: 'space',
    extension: 'artifacts',
    panel: 'artifacts',
    action: { name: 'restore', value: 2 },
  })
})

test('it widens to fill the chat pane and back, Esc narrows it, and × closes it', async () => {
  render()
  act(() => openDock('extension:artifacts/artifacts'))
  expect(dock()!.dataset.wide).toBeUndefined()
  expect(dock()!.querySelector('[role="separator"]')!.getAttribute('aria-label')).toBe('Resize Artifacts')
  act(() => button('Widen Artifacts').click())
  expect(dock()!.dataset.wide).toBe('true')
  expect(currentDock().wide).toBe(true)
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(currentDock().wide).toBe(false)
  act(() => button('Close Artifacts').click())
  expect(currentDock().open).toBeNull()
  // It slides out first.
  await act(() => new Promise((done) => setTimeout(done, 400)))
  expect(dock()).toBeNull()
})

test('closing or opening another narrows it again; only a dock panel of the chat shows', () => {
  render(undefined, [changes])
  act(() => openDock('extension:artifacts/artifacts'))
  expect(dock()).toBeNull()
  act(() => widenDock(true))
  act(() => openDock(null))
  expect(currentDock()).toEqual({ open: null, wide: false })
  act(() => widenDock(true))
  expect(currentDock().wide).toBe(false)
})

test('its shortcut opens and closes it, and its sidebar entry opens it', () => {
  const got: { handlers: ReturnType<typeof usePanelShortcuts> } = { handlers: {} }
  function Keys() {
    const handlers = usePanelShortcuts([artifacts], () => {})
    useLayoutEffect(() => {
      got.handlers = handlers
    })
    return null
  }
  act(() => root.render(<Keys />))
  act(() => got.handlers['extension:artifacts/artifacts']!())
  expect(currentDock().open).toBe('extension:artifacts/artifacts')
  act(() => got.handlers['extension:artifacts/artifacts']!())
  expect(currentDock().open).toBeNull()
  const [entry] = launcherEntries([artifacts, changes], {}, () => {})
  act(() => entry!.open())
  act(() => entry!.open())
  expect(currentDock().open).toBe('extension:artifacts/artifacts')
})

test('an extension’s panel opens for the chat the user looks at, or one above it', () => {
  const chats = [{ id: 'space' }, { id: 'worker', parentId: 'space' }, { id: 'other' }]
  expect(showsFor(chats, 'space', 'space')).toBe(true)
  expect(showsFor(chats, 'worker', 'space')).toBe(true)
  expect(showsFor(chats, 'space', 'worker')).toBe(false)
  expect(showsFor(chats, 'other', 'space')).toBe(false)
  expect(showsFor(chats, '', 'space')).toBe(false)
})
