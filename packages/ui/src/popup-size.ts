import { useSyncExternalStore } from 'react'

/**
 * How big each extension popup is (ExtensionPanel placement 'popup'), by its tab id: the size the user dragged it to,
 * and whether it's maximised. Kept in localStorage, so a popup opens as it was left. Without a saved size a popup takes
 * the default (POPUP_DEFAULT, cut to the window).
 */
export type PopupSize = { width?: number; height?: number; max?: boolean }

const KEY = 'kothar.popupSizes'
export const POPUP_MIN = { width: 480, height: 320 }
export const POPUP_DEFAULT_WIDTH = 1080
// Room kept around a popup that isn't maximised, and its top edge (as a share of the window's height).
export const POPUP_MARGIN = 16
export const POPUP_TOP = 0.06
export const POPUP_STEP = 32

const listeners = new Set<() => void>()

function read(): Record<string, PopupSize> {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
  } catch {
    return {}
  }
}

let current = read()

/** The largest a popup that isn't maximised may be, in a window this big. */
export function popupBounds(view: { width: number; height: number }) {
  return {
    width: Math.max(POPUP_MIN.width, view.width - 2 * POPUP_MARGIN),
    height: Math.max(POPUP_MIN.height, view.height - Math.round(view.height * POPUP_TOP) - POPUP_MARGIN),
  }
}

/** A size kept within the minimum and what fits the window. */
export function clampPopup(size: { width: number; height: number }, view: { width: number; height: number }) {
  const bounds = popupBounds(view)
  return {
    width: Math.round(Math.min(Math.max(size.width, POPUP_MIN.width), bounds.width)),
    height: Math.round(Math.min(Math.max(size.height, POPUP_MIN.height), bounds.height)),
  }
}

export function setPopupSize(id: string, size: PopupSize) {
  const next = { ...current[id], ...size }
  if (!next.max) delete next.max
  current = { ...current, [id]: next }
  localStorage.setItem(KEY, JSON.stringify(current))
  for (const listener of listeners) listener()
}

/** Forgets the popup's size, so it opens at the default again. Keeps whether it's maximised. */
export function resetPopupSize(id: string) {
  const { max } = current[id] ?? {}
  current = { ...current, [id]: max ? { max } : {} }
  localStorage.setItem(KEY, JSON.stringify(current))
  for (const listener of listeners) listener()
}

/** Rereads the saved sizes, for tests that clear storage. */
export function reloadPopupSizes() {
  current = read()
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const snapshot = () => current

const NONE: PopupSize = {}
export const usePopupSize = (id: string | undefined) => {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot)
  return (id && all[id]) || NONE
}
