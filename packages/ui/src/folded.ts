import { useSyncExternalStore } from 'react'

/** Chats whose workers are folded away in the sidebar. Unfolded by default, kept in localStorage. */
const KEY = 'kothar.foldedChats'
const listeners = new Set<() => void>()

function read(): ReadonlySet<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

let current = read()

export function foldChat(chatId: string, folded: boolean) {
  const next = new Set(current)
  if (folded) next.add(chatId)
  else next.delete(chatId)
  current = next
  localStorage.setItem(KEY, JSON.stringify([...next]))
  for (const listener of listeners) listener()
}

/** Rereads the saved choice, for tests that clear storage. */
export function reloadFolded() {
  current = read()
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const snapshot = () => current

export function useFoldedChats(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
