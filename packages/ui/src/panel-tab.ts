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
