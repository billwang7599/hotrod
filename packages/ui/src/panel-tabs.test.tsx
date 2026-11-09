// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ChatView, State } from './state.ts'
import { ContextPanel } from './context-panel.tsx'
import { fitTabs } from './panel-tabs.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('fitTabs', () => {
  test('keeps every tab when they all fit', () => {
    expect(fitTabs([60, 60, 90], 300, 24, 0)).toEqual([true, true, true])
  })

  test('shows every tab before the row is measured', () => {
    expect(fitTabs([60, 60, 90], 0, 24, 1)).toEqual([true, true, true])
  })

  test('keeps the open tab, then the others in order while they fit beside More', () => {
    // More 24 + open tab 92 + first tab 62 = 178; the next would need 62 more.
    expect(fitTabs([60, 60, 60, 90], 200, 24, 3)).toEqual([true, false, false, true])
  })

  test('keeps the open tab even when it alone overflows', () => {
    expect(fitTabs([60, 300], 100, 24, 1)).toEqual([false, true])
  })
})

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
const modUi: State['modUi'] = { chatId: 'space', panels: [{ mod: 'git', id: 'changes', title: 'Changes' }], commands: [] }

// Each tab is 7px a letter plus 16px padding (General 65, Context 65, Permissions 93, Changes 65; 294 with gaps); the
// More button 24.
let room: number
let resize: () => void
let root: Root
let host: HTMLDivElement

beforeEach(() => {
  localStorage.clear()
  room = 400
  resize = () => {}
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => room)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = this.textContent ? this.textContent.length * 7 + 16 : 24
    return { width, height: 24, top: 0, left: 0, right: width, bottom: 24, x: 0, y: 0, toJSON: () => ({}) }
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = () => act(() => callback())
      }
      observe() {}
      disconnect() {}
    },
  )
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function render() {
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
              send={() => {}}
              modUi={modUi}
            />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
}

const tabs = () => [...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent)
const tab = (name: string) => [...host.querySelectorAll('[role="tab"]')].find((t) => t.textContent === name) as HTMLElement
const more = () => host.querySelector<HTMLElement>('[aria-label^="More tabs"]')

function openMore() {
  act(() => void more()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

test('the tabs sit in one row with no More menu when they fit', () => {
  render()
  expect(tabs()).toEqual(['General', 'Context', 'Permissions', 'Changes'])
  expect(more()).toBeNull()
  expect(host.querySelector('[role="tablist"]')!.className).not.toContain('overflow-x-auto')
})

test("tabs that don't fit go into the More menu, in order", () => {
  room = 200
  render()
  // More 24 + Context 67 + General 67 = 158; Permissions would need 95 more.
  expect(tabs()).toEqual(['General', 'Context'])
  expect(more()!.getAttribute('aria-label')).toBe('More tabs: Permissions, Changes')
  expect(openMore().map((i) => i.textContent)).toEqual(['Permissions', 'Changes'])
})

test('the open tab stays in the row even when later tabs fold away', () => {
  localStorage.setItem('hotrod.panelTab', 'mod:git/changes')
  room = 200
  render()
  expect(tabs()).toEqual(['General', 'Changes'])
  expect(tab('Changes').getAttribute('aria-selected')).toBe('true')
})

test('choosing a tab from More opens it and brings it into the row', () => {
  room = 200
  render()
  const permissions = openMore().find((i) => i.textContent === 'Permissions')!
  act(() => permissions.click())
  expect(tab('Permissions').getAttribute('aria-selected')).toBe('true')
  expect(tabs()).toEqual(['General', 'Permissions'])
  expect(host.querySelector('[role="tabpanel"]')!.getAttribute('aria-label')).toBe('Permissions')
})

test('widening the panel brings folded tabs back', () => {
  room = 200
  render()
  expect(more()).not.toBeNull()
  room = 320
  resize()
  expect(tabs()).toEqual(['General', 'Context', 'Permissions', 'Changes'])
  expect(more()).toBeNull()
})
