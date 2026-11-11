import { useSyncExternalStore } from 'react'

/**
 * Which tab the right sidebar shows: general, context, or an extension's panel as `extension:<extension>/<panel>`.
 * Kept in localStorage, and shared so a note in the chat can open its extension's panel.
 */
const KEY = 'kothar.panelTab'
const listeners = new Set<() => void>()

export const extensionTabId = (extension: string, panel: string) => `extension:${extension}/${panel}`

export function choosePanelTab(id: string) {
  localStorage.setItem(KEY, id)
  for (const listener of listeners) listener()
}

export function usePanelTab() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => {
      const saved = localStorage.getItem(KEY)
      // Permissions was a tab of its own; its switches now live in General. Extensions' tabs were saved as `mod:`.
      if (saved === 'permissions') return 'general'
      return saved?.startsWith('mod:') ? `extension:${saved.slice(4)}` : (saved ?? 'context')
    },
  )
}

/**
 * The extension popup that's open (ExtensionPanel.placement 'popup'), by extensionTabId, or null. Shared so a shortcut,
 * a sidebar entry or a note in the chat can open one. Not kept across reloads.
 */
let popup: string | null = null
const popupListeners = new Set<() => void>()

export const currentPopup = () => popup

export function openPopup(id: string | null) {
  popup = id
  for (const listener of popupListeners) listener()
}

export function usePopup() {
  return useSyncExternalStore(
    (listener) => {
      popupListeners.add(listener)
      return () => popupListeners.delete(listener)
    },
    () => popup,
  )
}

/**
 * The extension dock panel that's open beside the chat (ExtensionPanel.placement 'dock'), by extensionTabId, or null,
 * and whether it's widened to fill the chat pane. Shared so a shortcut, a sidebar entry, a note in the chat or the
 * extension itself (host.showPanel) can open one. Not kept across reloads.
 */
export type DockState = { open: string | null; wide: boolean }
let dock: DockState = { open: null, wide: false }
const dockListeners = new Set<() => void>()

export const currentDock = () => dock

function setDock(next: DockState) {
  if (next.open === dock.open && next.wide === dock.wide) return
  dock = next
  for (const listener of dockListeners) listener()
}

/** Opens a dock panel (null closes it). Closing, or opening another, narrows it back beside the chat. */
export const openDock = (id: string | null) => setDock({ open: id, wide: id !== null && id === dock.open && dock.wide })

export const widenDock = (wide: boolean) => setDock({ ...dock, wide: dock.open !== null && wide })

export function useDock() {
  return useSyncExternalStore(
    (listener) => {
      dockListeners.add(listener)
      return () => dockListeners.delete(listener)
    },
    () => dock,
  )
}

/** Whether an extension's panel shown for chatId opens: the user is looking at that chat, or at one below it. */
export function showsFor(chats: { id: string; parentId?: string }[], selectedId: string, chatId: string) {
  for (let id: string | undefined = selectedId, i = 0; id !== undefined && i < 32; i++) {
    if (id === chatId) return true
    id = chats.find((c) => c.id === id)?.parentId
  }
  return false
}
