import { useSyncExternalStore } from 'react'

/** Where file paths can show. Each is off by default and turned on in Settings → Appearance. */
export type PathPlace = 'header' | 'context'

const KEY = 'kothar.showPaths'
const listeners = new Set<() => void>()

function read(): Record<PathPlace, boolean> {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return { header: saved.header === true, context: saved.context === true }
  } catch {
    return { header: false, context: false }
  }
}

let current = read()

export function showPaths(place: PathPlace, shown: boolean) {
  current = { ...current, [place]: shown }
  localStorage.setItem(KEY, JSON.stringify(current))
  for (const listener of listeners) listener()
}

/** Rereads the saved choice, for tests that clear storage. */
export function reloadPaths() {
  current = read()
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const snapshot = () => current

export function usePathsShown(): Record<PathPlace, boolean> {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
