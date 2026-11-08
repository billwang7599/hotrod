// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { PANEL_LIMITS, RESIZE_STEP_PX, reloadPanelWidths, ResizeHandle, usePanelWidth, type Panel } from './panel-width.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root
let container: HTMLElement

beforeEach(() => {
  localStorage.clear()
  reloadPanelWidths()
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  localStorage.clear()
  reloadPanelWidths()
})

function Probe({ panel }: { panel: Panel }) {
  return (
    <aside data-panel={panel} style={{ width: usePanelWidth(panel) }}>
      <ResizeHandle panel={panel} />
    </aside>
  )
}

function render(panel: Panel) {
  act(() => root.render(<Probe panel={panel} />))
  return container.querySelector<HTMLElement>('[role="separator"]')!
}

const widthOf = (panel: Panel) => container.querySelector<HTMLElement>(`[data-panel="${panel}"]`)!.style.width

function drag(handle: HTMLElement, fromX: number, toX: number) {
  act(() => {
    handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: fromX, button: 0 }))
  })
  expect(document.body.style.userSelect).toBe('none')
  expect(handle.dataset.dragging).toBe('true')
  act(() => {
    dispatchEvent(new MouseEvent('pointermove', { clientX: toX }))
  })
  act(() => {
    dispatchEvent(new MouseEvent('pointerup', { clientX: toX }))
  })
  expect(document.body.style.userSelect).toBe('')
  expect(handle.dataset.dragging).toBeUndefined()
}

test('dragging the sidebar edge resizes it and saves the width', () => {
  const sidebar = PANEL_LIMITS.sidebar
  const handle = render('sidebar')
  expect(handle.getAttribute('aria-orientation')).toBe('vertical')
  expect(widthOf('sidebar')).toBe(`${sidebar.default}px`)

  drag(handle, 200, 250)
  expect(widthOf('sidebar')).toBe(`${sidebar.default + 50}px`)
  expect(handle.getAttribute('aria-valuenow')).toBe(String(sidebar.default + 50))
  expect(localStorage.getItem(sidebar.key)).toBe(String(sidebar.default + 50))

  // A move after release does nothing.
  act(() => {
    dispatchEvent(new MouseEvent('pointermove', { clientX: 400 }))
  })
  expect(widthOf('sidebar')).toBe(`${sidebar.default + 50}px`)

  act(() => root.unmount())
  root = createRoot(container)
  reloadPanelWidths()
  render('sidebar')
  expect(widthOf('sidebar')).toBe(`${sidebar.default + 50}px`)
})

test('the right panel grows when its left edge is dragged left', () => {
  const handle = render('context')
  drag(handle, 500, 460)
  expect(widthOf('context')).toBe(`${PANEL_LIMITS.context.default + 40}px`)
})

test('the width stays between the min and max, and a saved width out of range is clamped', () => {
  const { min, max, key } = PANEL_LIMITS.sidebar
  const handle = render('sidebar')
  drag(handle, 200, 2000)
  expect(widthOf('sidebar')).toBe(`${max}px`)
  drag(handle, 2000, -2000)
  expect(widthOf('sidebar')).toBe(`${min}px`)

  localStorage.setItem(key, '9999')
  act(() => reloadPanelWidths())
  expect(widthOf('sidebar')).toBe(`${max}px`)
  localStorage.setItem(key, 'wide')
  act(() => reloadPanelWidths())
  expect(widthOf('sidebar')).toBe(`${PANEL_LIMITS.sidebar.default}px`)
})

test('double-clicking the handle resets the default width', () => {
  const sidebar = PANEL_LIMITS.sidebar
  const handle = render('sidebar')
  drag(handle, 200, 300)
  act(() => {
    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  expect(widthOf('sidebar')).toBe(`${sidebar.default}px`)
  expect(localStorage.getItem(sidebar.key)).toBe(String(sidebar.default))
})

test('the arrow keys resize from the focused handle, towards the arrow', () => {
  const key = (handle: HTMLElement, k: string) =>
    act(() => {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
    })
  const sidebar = render('sidebar')
  expect(sidebar.tabIndex).toBe(0)
  key(sidebar, 'ArrowRight')
  expect(widthOf('sidebar')).toBe(`${PANEL_LIMITS.sidebar.default + RESIZE_STEP_PX}px`)
  key(sidebar, 'ArrowLeft')
  key(sidebar, 'ArrowLeft')
  expect(widthOf('sidebar')).toBe(`${PANEL_LIMITS.sidebar.default - RESIZE_STEP_PX}px`)

  const context = render('context')
  key(context, 'ArrowLeft')
  expect(widthOf('context')).toBe(`${PANEL_LIMITS.context.default + RESIZE_STEP_PX}px`)
})
