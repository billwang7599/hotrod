import { useState, useSyncExternalStore } from 'react'
import { PANEL_PX } from './state.ts'

/** The left sidebar and the right panel, each resized by dragging its inner edge; widths saved in localStorage. */
export type Panel = keyof typeof PANEL_PX

export const PANEL_LIMITS: Record<Panel, { key: string; min: number; max: number; default: number }> = {
  sidebar: { key: 'hotrod.sidebarWidth', min: 180, max: 420, default: PANEL_PX.sidebar },
  context: { key: 'hotrod.contextWidth', min: 260, max: 560, default: PANEL_PX.context },
}
export const RESIZE_STEP_PX = 16

const listeners = new Set<() => void>()

export function clampWidth(panel: Panel, px: number) {
  const { min, max } = PANEL_LIMITS[panel]
  return Math.min(Math.max(Math.round(px), min), max)
}

function stored(panel: Panel) {
  const px = Number(localStorage.getItem(PANEL_LIMITS[panel].key) ?? NaN)
  return Number.isFinite(px) ? clampWidth(panel, px) : PANEL_LIMITS[panel].default
}

const read = () => ({ sidebar: stored('sidebar'), context: stored('context') })
let current = read()

export function setPanelWidth(panel: Panel, px: number) {
  const width = clampWidth(panel, px)
  if (width === current[panel]) return
  current = { ...current, [panel]: width }
  localStorage.setItem(PANEL_LIMITS[panel].key, String(width))
  for (const listener of listeners) listener()
}

/** Rereads the saved widths, for tests that clear storage. */
export function reloadPanelWidths() {
  current = read()
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const snapshot = () => current

export const usePanelWidths = () => useSyncExternalStore(subscribe, snapshot, snapshot)
export const usePanelWidth = (panel: Panel) => usePanelWidths()[panel]

const LABELS: Record<Panel, string> = { sidebar: 'Resize sidebar', context: 'Resize right panel' }

/** A thin handle on the panel's inner edge: drag, arrow keys, or double-click to reset. */
export function ResizeHandle({ panel }: { panel: Panel }) {
  const width = usePanelWidth(panel)
  const { min, max } = PANEL_LIMITS[panel]
  // The sidebar's handle is on its right edge, so dragging right widens it; the right panel's is on its left.
  const grow = panel === 'sidebar' ? 1 : -1
  const [dragging, startDrag] = useDrag()
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={LABELS[panel]}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-dragging={dragging || undefined}
      className={`absolute inset-y-0 z-10 w-5 cursor-col-resize transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none data-dragging:bg-accent/60 ${panel === 'sidebar' ? 'right-0' : 'left-0'}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const startX = e.clientX
        const startWidth = width
        startDrag((x) => setPanelWidth(panel, startWidth + grow * (x - startX)))
      }}
      onDoubleClick={() => setPanelWidth(panel, PANEL_LIMITS[panel].default)}
      onKeyDown={(e) => {
        const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
        if (step) {
          e.preventDefault()
          setPanelWidth(panel, width + grow * step * RESIZE_STEP_PX)
        } else if (e.key === 'Home' || e.key === 'End') {
          e.preventDefault()
          setPanelWidth(panel, e.key === 'Home' ? min : max)
        }
      }}
    />
  )
}

/** Follows the pointer across the whole window until release, with text selection off meanwhile. */
function useDrag() {
  const [dragging, setDragging] = useState(false)
  const start = (move: (x: number) => void) => {
    setDragging(true)
    const body = document.body.style
    const saved = { userSelect: body.userSelect, cursor: body.cursor }
    body.userSelect = 'none'
    body.cursor = 'col-resize'
    const onMove = (e: PointerEvent) => move(e.clientX)
    const onUp = () => {
      setDragging(false)
      Object.assign(body, saved)
      removeEventListener('pointermove', onMove)
      removeEventListener('pointerup', onUp)
      removeEventListener('pointercancel', onUp)
    }
    addEventListener('pointermove', onMove)
    addEventListener('pointerup', onUp)
    addEventListener('pointercancel', onUp)
  }
  return [dragging, start] as const
}
