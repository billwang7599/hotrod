import { createContext, useSyncExternalStore } from 'react'

/**
 * Whether a chat shows its thinking and tool calls unfolded: a finished turn's steps stay listed instead of folding
 * into "N steps", and each thinking and tool row starts open. Settings → Appearance sets the default (folded); the
 * Context panel overrides it per chat.
 */
type Saved = { default: boolean; chats: Record<string, boolean> }

const KEY = 'hotrod.showSteps'
const listeners = new Set<() => void>()

function read(): Saved {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    const chats = saved.chats && typeof saved.chats === 'object' ? saved.chats : {}
    return {
      default: saved.default === true,
      chats: Object.fromEntries(Object.entries(chats).filter(([, on]) => typeof on === 'boolean')) as Saved['chats'],
    }
  } catch {
    return { default: false, chats: {} }
  }
}

let current = read()

function save(next: Saved) {
  current = next
  localStorage.setItem(KEY, JSON.stringify(current))
  for (const listener of listeners) listener()
}

/** Sets the default for every chat without a choice of its own. */
export function showStepsByDefault(shown: boolean) {
  save({ ...current, default: shown })
}

/** Sets one chat's choice; undefined drops it, so the chat follows Settings again. */
export function showStepsIn(chatId: string, shown: boolean | undefined) {
  const { [chatId]: _, ...chats } = current.chats
  save({ ...current, chats: shown === undefined ? chats : { ...chats, [chatId]: shown } })
}

/** One chat's own choice, undefined while it follows Settings. */
export function useStepsChoice(chatId: string): boolean | undefined {
  return useSyncExternalStore(subscribe, snapshot, snapshot).chats[chatId]
}

/** Rereads the saved choice, for tests that clear storage. */
export function reloadSteps() {
  current = read()
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const snapshot = () => current

export function useStepsDefault(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot).default
}

export function useStepsShown(chatId: string): boolean {
  const saved = useSyncExternalStore(subscribe, snapshot, snapshot)
  return saved.chats[chatId] ?? saved.default
}

/** Whether thinking and tool rows start open, for the rows inside one chat's transcript. */
export const StepsOpen = createContext(false)
