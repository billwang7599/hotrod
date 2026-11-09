import { useEffect, useSyncExternalStore } from 'react'
import { isUnread, type ClientMessage } from '@hotrod/core/shared'
import type { ChatView } from './state.ts'

// The user is looking at this window: it's focused and not hidden. The open chat counts as seen only then.
const looking = () => document.visibilityState === 'visible' && document.hasFocus()

function subscribe(changed: () => void) {
  addEventListener('focus', changed)
  addEventListener('blur', changed)
  document.addEventListener('visibilitychange', changed)
  return () => {
    removeEventListener('focus', changed)
    removeEventListener('blur', changed)
    document.removeEventListener('visibilitychange', changed)
  }
}

export const useLooking = () => useSyncExternalStore(subscribe, looking)

/**
 * Bold in the sidebar: the chat finished a turn the user hasn't seen. Running and waiting chats have their dot
 * instead, and the chat open in a window the user is looking at is being seen right now.
 */
export const showsUnread = (chat: ChatView, open: boolean) => chat.status === 'idle' && isUnread(chat) && !open

/**
 * Marks the open chat read whenever it has an unseen turn while the user looks at this window. `seen` is false while
 * disconnected too, since the message would be dropped; it's sent again once the core is back.
 */
export function useMarkRead(chat: ChatView | undefined, seen: boolean, send: (m: ClientMessage) => void) {
  const unread = chat !== undefined && isUnread(chat)
  const id = chat?.id
  const doneAt = chat?.doneAt
  useEffect(() => {
    if (unread && seen && id !== undefined) send({ type: 'chat.read', chatId: id })
  }, [unread, seen, id, doneAt, send])
}
