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
 * a sidebar launcher or a note in the chat can open one. Not kept across reloads.
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
 * The extension dock panel open beside each chat (ExtensionPanel.placement 'dock'), by extensionTabId, or null; whether
 * it's widened to fill the chat pane; and whether the right sidebar is in front of it. Only one right-hand column
 * shows at a time: while a dock is open, the right sidebar hides, and toggling the sidebar swaps the two (the dock stays
 * mounted, hidden, so its scroll and drafts survive). Kept per chat, so each chat shows what was left open in it. Shared
 * so a shortcut, a sidebar launcher, a note in the chat or the extension itself (host.showPanel) can open one. Not kept
 * across reloads.
 */
export type DockState = { open: string | null; wide: boolean; panel: boolean }
const CLOSED: DockState = { open: null, wide: false, panel: false }
let docks: Record<string, DockState> = {}
// The chat the user is looking at, for a dock opened without one (a shortcut, a launcher, host.showPanel).
let dockChat = ''
const dockListeners = new Set<() => void>()

/** Which chat a dock opened without a chat id belongs to: the selected one. */
export const selectDockChat = (chatId: string) => {
  dockChat = chatId
}

export const currentDock = (chatId = dockChat) => docks[chatId] ?? CLOSED

function setDock(chatId: string, next: DockState) {
  const now = currentDock(chatId)
  if (next.open === now.open && next.wide === now.wide && next.panel === now.panel) return
  docks = { ...docks, [chatId]: next }
  if (next.open === null) delete docks[chatId]
  for (const listener of dockListeners) listener()
}

/**
 * Opens a dock panel beside the chat (null closes it), in front of the right sidebar. Closing, or opening another,
 * narrows it back beside the chat.
 */
export const openDock = (id: string | null, chatId = dockChat) => {
  const dock = currentDock(chatId)
  setDock(chatId, { open: id, wide: id !== null && id === dock.open && dock.wide, panel: false })
}

export const widenDock = (wide: boolean, chatId = dockChat) => {
  const dock = currentDock(chatId)
  setDock(chatId, { ...dock, wide: dock.open !== null && wide })
}

/** With a dock open, puts the right sidebar in front of it (true) or the dock back (false). Without one, nothing. */
export const panelOverDock = (panel: boolean, chatId = dockChat) => {
  const dock = currentDock(chatId)
  if (dock.open !== null) setDock(chatId, { ...dock, panel })
}

/** Forgets every chat's dock, for tests. */
export const resetDocks = () => {
  docks = {}
  for (const listener of dockListeners) listener()
}

export function useDock(chatId = dockChat) {
  return useSyncExternalStore(
    (listener) => {
      dockListeners.add(listener)
      return () => dockListeners.delete(listener)
    },
    () => currentDock(chatId),
  )
}

/**
 * Which right-hand column shows, when the right sidebar docks beside the chat (not over it): only one at a time. With
 * no dock open, the sidebar shows as the user left it (sidebarOpen). With one open, the dock shows, unless the user
 * swapped the sidebar in front of it. sidebarOpen itself is never changed by a dock, so closing the dock brings the
 * sidebar back as it was.
 */
export function rightColumn(sidebarOpen: boolean, dock: { open: boolean; panel: boolean }) {
  if (!dock.open) return { sidebar: sidebarOpen, dock: false }
  return { sidebar: dock.panel, dock: !dock.panel }
}

/** Whether an extension's panel shown for chatId opens: the user is looking at that chat, or at one below it. */
export function showsFor(chats: { id: string; parentId?: string }[], selectedId: string, chatId: string) {
  for (let id: string | undefined = selectedId, i = 0; id !== undefined && i < 32; i++) {
    if (id === chatId) return true
    id = chats.find((c) => c.id === id)?.parentId
  }
  return false
}
