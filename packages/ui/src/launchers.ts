import { useSyncExternalStore } from 'react'

/**
 * Where the left sidebar shows extension launchers (panels with `launcher: true`, such as Notes and Artifacts): at the
 * top under Home (the default), at the bottom above Settings, or not at all. Set in Settings → Appearance; it lives in
 * this window, not the garage. Hidden launchers' panels still open from the right panel's tabs and their shortcuts.
 */
export type LauncherPlace = 'top' | 'bottom' | 'hidden'

export const LAUNCHER_PLACES: { value: LauncherPlace; label: string }[] = [
  { value: 'top', label: 'Top' },
  { value: 'bottom', label: 'Bottom' },
  { value: 'hidden', label: 'Hidden' },
]

const KEY = 'kothar.launchers'
const listeners = new Set<() => void>()

function read(): LauncherPlace {
  const saved = localStorage.getItem(KEY)
  return LAUNCHER_PLACES.some((p) => p.value === saved) ? (saved as LauncherPlace) : 'top'
}

let current = read()

export function placeLaunchers(place: LauncherPlace) {
  current = place
  localStorage.setItem(KEY, place)
  for (const listener of listeners) listener()
}

/** Rereads the saved place, for tests that clear storage. */
export function reloadLaunchers() {
  current = read()
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const snapshot = () => current

export function useLauncherPlace(): LauncherPlace {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** Which launchers go at the top of the sidebar and which above Settings, for the place the user picked. */
export function placedLaunchers<T>(place: LauncherPlace, launchers: T[]): { top: T[]; bottom: T[] } {
  return { top: place === 'top' ? launchers : [], bottom: place === 'bottom' ? launchers : [] }
}
