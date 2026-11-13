// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { ExtensionAction, ExtensionView } from '@kothar/extension-api'
import { ExtensionViewer } from './extension-view.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root
let host: HTMLElement
const sent: ExtensionAction[] = []
beforeEach(() => {
  sent.length = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete window.kothar
})

const show = (view: ExtensionView) =>
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider>
            <ExtensionViewer view={view} act={(action) => sent.push(action)} />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )

const trigger = () => host.querySelector<HTMLButtonElement>('button[aria-label="More for Plan"]')
const open = () => {
  act(() => void trigger()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

const menu: ExtensionView = {
  type: 'menu',
  label: 'More for Plan',
  items: [
    { label: 'Sort by edited', action: { name: 'sort', value: 'edited' }, checked: true },
    { label: 'Sort by title', action: { name: 'sort', value: 'title' }, checked: false },
    { type: 'divider' },
    { label: 'Import…', action: { name: 'import' }, pick: { kind: 'folder' } },
    { type: 'divider' },
    { label: 'Rename', action: { name: 'rename' } },
    { label: 'Locked', action: { name: 'locked' }, disabled: true },
    { label: 'Delete', action: { name: 'delete' }, danger: true },
  ],
}

test('a menu is one ⋯ button that opens its entries; picking one sends its action', () => {
  show(menu)
  expect(trigger()!.textContent).toBe('⋯')
  const items = open()
  expect(items.map((i) => i.textContent)).toEqual([
    '✓(selected) Sort by edited',
    'Sort by title',
    // Import… picks a folder, and a browser tab has no picker, so it's left out, and with it a divider.
    'Rename',
    'Locked',
    'Delete',
  ])
  expect(document.querySelectorAll('[role="separator"]').length).toBe(1)
  expect(items[3]!.getAttribute('aria-disabled')).toBe('true')
  expect(items[4]!.className).toContain('text-red')
  act(() => items[1]!.click())
  expect(sent).toEqual([{ name: 'sort', value: 'title' }])
})

test('in the desktop app a pick entry is drawn and sends the picked path', async () => {
  window.kothar = { pickFolder: async () => '/notes', pickFiles: async () => [] } as unknown as NonNullable<Window['kothar']>
  show(menu)
  const item = open().find((i) => i.textContent === 'Import…')!
  await act(async () => item.click())
  expect(sent).toEqual([{ name: 'import', value: '/notes' }])
})

test('a menu with nothing it can show draws no button', () => {
  show({ type: 'menu', label: 'More for Plan', items: [{ label: 'Import…', action: { name: 'import' }, pick: { kind: 'folder' } }] })
  expect(trigger()).toBeNull()
})
