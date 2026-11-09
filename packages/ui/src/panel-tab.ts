import { useSyncExternalStore } from 'react'

/**
 * Which tab the right sidebar shows: general, context, or a mod's panel as `mod:<mod>/<panel>`. Kept in
 * localStorage, and shared so a note in the chat can open its mod's panel.
 */
const KEY = 'hotrod.panelTab'
const listeners = new Set<() => void>()

export const modTabId = (mod: string, panel: string) => `mod:${mod}/${panel}`

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
      // Permissions was a tab of its own; its switches now live in General.
      return saved === 'permissions' ? 'general' : (saved ?? 'context')
    },
  )
}
