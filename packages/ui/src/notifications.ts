import { useSyncExternalStore } from 'react'
import type { ChatEntry, CoreMessage } from '@kothar/core/shared'
import type { ChatView } from './state.ts'

/**
 * System notifications: a chat needs the user (a permission request, a question, an extension's waiting bar), a
 * space or Home finished a turn, a turn (a worker's too) ended with an error, or an extension asked for one
 * (host.notify). Shown only while the user isn't looking at that chat: with Kothar's window in front, only what needs
 * them or failed in another space shows; a finished turn there already turns its space bold. A burst (several workers
 * failing at once) becomes one notification. Settings → Appearance → Notifications turns them off, or one kind of them.
 */
export type NotifyKind = 'needsYou' | 'finished' | 'errors'
export type NotificationPrefs = { enabled: boolean } & Record<NotifyKind, boolean>
export const DEFAULT_NOTIFICATIONS: NotificationPrefs = { enabled: true, needsYou: true, finished: true, errors: true }

const PREFS_KEY = 'kothar.notifications'
// A burst arriving within this long shows as one notification.
export const COALESCE_MS = 1_000
const EXCERPT_CHARS = 140
// A turn the user stopped ends with this; they know.
const INTERRUPTED = 'Interrupted'

export type Notice = {
  kind: NotifyKind | 'extension'
  // The chat it's about, and the one clicking opens (a worker's space: workers are view only and go once they report).
  chatId?: string
  open?: string
  title: string
  body: string
}

// What the user sees now: the open chat, and whether Kothar's window is in front.
export type Seen = { chats: ChatView[]; selectedId: string; looking: boolean }

// The more urgent of two notices about one chat in a burst is the one kept.
const URGENCY: Record<Notice['kind'], number> = { needsYou: 3, errors: 2, extension: 1, finished: 0 }

export const excerpt = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > EXCERPT_CHARS ? `${line.slice(0, EXCERPT_CHARS - 1)}…` : line
}

function rootOf(chats: ChatView[], chat: ChatView): ChatView {
  const parent = chats.find((c) => c.id === chat.parentId)
  return parent && parent !== chat ? rootOf(chats, parent) : chat
}

function readPrefs(): NotificationPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
    const pick = (key: keyof NotificationPrefs) =>
      typeof saved[key] === 'boolean' ? (saved[key] as boolean) : DEFAULT_NOTIFICATIONS[key]
    return { enabled: pick('enabled'), needsYou: pick('needsYou'), finished: pick('finished'), errors: pick('errors') }
  } catch {
    return DEFAULT_NOTIFICATIONS
  }
}

const listeners = new Set<() => void>()
let prefs = typeof localStorage === 'undefined' ? DEFAULT_NOTIFICATIONS : readPrefs()

export const notificationPrefs = () => prefs

export function setNotificationPref(key: keyof NotificationPrefs, on: boolean) {
  prefs = { ...prefs, [key]: on }
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  for (const listener of listeners) listener()
}

/** Rereads the saved choices, for tests that clear storage. */
export function reloadNotificationPrefs() {
  prefs = readPrefs()
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export const useNotificationPrefs = () => useSyncExternalStore(subscribe, notificationPrefs, notificationPrefs)

/** Whether the user would see this notice, by their settings and what they're looking at. */
export function wanted(notice: Notice, seen: Seen, settings: NotificationPrefs): boolean {
  if (!settings.enabled) return false
  if (notice.kind !== 'extension' && !settings[notice.kind]) return false
  if (!seen.looking) return true
  if (notice.kind === 'finished') return false
  const chat = notice.chatId === undefined ? undefined : seen.chats.find((c) => c.id === notice.chatId)
  const selected = seen.chats.find((c) => c.id === seen.selectedId)
  return !chat || !selected || rootOf(seen.chats, chat).id !== rootOf(seen.chats, selected).id
}

type Shown = { title: string; body: string; open?: string }

/** Several notices as the one notification that shows them; clicking opens the most urgent one's chat. */
export function merged(notices: Notice[]): Shown {
  const first = [...notices].sort((a, b) => URGENCY[b.kind] - URGENCY[a.kind])[0]!
  const open = first.open === undefined ? {} : { open: first.open }
  if (notices.length === 1) return { title: first.title, body: first.body, ...open }
  const kinds = new Set(notices.map((n) => n.kind))
  const n = notices.length
  const title =
    kinds.size > 1
      ? `${n} updates in Kothar`
      : kinds.has('needsYou')
        ? `${n} need you`
        : kinds.has('finished')
          ? `${n} finished`
          : kinds.has('errors')
            ? `${n} ended with an error`
            : `${n} notifications`
  return { title, body: excerpt(notices.map((notice) => notice.title).join(', ')), ...open }
}

export type Timer = { set(run: () => void, ms: number): unknown; clear(handle: unknown): void }
const REAL_TIMER: Timer = { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as number) }

/**
 * Turns the core's messages into notifications. observe sees each message before the UI's state takes it in, with
 * what the user saw then; show gets each burst as one notification.
 */
export function createNotifier(show: (shown: Shown) => void, options: { timer?: Timer; settings?: () => NotificationPrefs } = {}) {
  const timer = options.timer ?? REAL_TIMER
  const settings = options.settings ?? notificationPrefs
  // Each chat's last reply in the running turn, and the chats whose turn end has been told already (a session that
  // ends after its turn completed says nothing new).
  const lastText = new Map<string, string>()
  const ended = new Set<string>()
  let pending = new Map<string, Notice>()
  let handle: unknown

  const flush = () => {
    handle = undefined
    const notices = [...pending.values()]
    pending = new Map()
    if (notices.length) show(merged(notices))
  }

  const add = (notice: Notice, seen: Seen) => {
    if (!wanted(notice, seen, settings())) return
    const key = notice.chatId ?? `extension:${pending.size}`
    const before = pending.get(key)
    if (!before || URGENCY[notice.kind] >= URGENCY[before.kind]) pending.set(key, notice)
    handle ??= timer.set(flush, COALESCE_MS)
  }

  const aboutChat = (seen: Seen, chatId: string, kind: NotifyKind, body: string): Notice | undefined => {
    const chat = seen.chats.find((c) => c.id === chatId)
    if (!chat) return undefined
    const root = rootOf(seen.chats, chat)
    const title = root === chat ? chat.name : `${root.name}: ${chat.name}`
    return { kind, chatId, open: root.id, title, body: excerpt(body) }
  }

  const onEntry = (seen: Seen, chatId: string, entry: ChatEntry): Notice | undefined => {
    switch (entry.type) {
      case 'turn.started':
      case 'user.message':
        ended.delete(chatId)
        lastText.delete(chatId)
        return undefined
      case 'text.completed':
        lastText.set(chatId, entry.text)
        return undefined
      case 'permission.requested':
        return aboutChat(seen, chatId, 'needsYou', `Asks to ${entry.command ?? entry.path ?? entry.summary}`)
      case 'question.asked':
        return aboutChat(seen, chatId, 'needsYou', entry.questions[0]?.question ?? 'Has a question for you')
      case 'turn.completed':
      case 'session.ended': {
        if (ended.has(chatId)) return undefined
        if (entry.type === 'session.ended' && !entry.error) return undefined
        ended.add(chatId)
        const reply = lastText.get(chatId)
        lastText.delete(chatId)
        if (entry.error) return entry.error === INTERRUPTED ? undefined : aboutChat(seen, chatId, 'errors', entry.error)
        const chat = seen.chats.find((c) => c.id === chatId)
        if (!chat || chat.worker || chat.parentId) return undefined
        return aboutChat(seen, chatId, 'finished', reply || 'Finished')
      }
      default:
        return undefined
    }
  }

  return {
    observe(message: CoreMessage, seen: Seen) {
      let notice: Notice | undefined
      if (message.type === 'chat.entry') notice = onEntry(seen, message.chatId, message.entry)
      else if (message.type === 'chat.waits') {
        const before = new Set(seen.chats.find((c) => c.id === message.chatId)?.waits?.map((w) => w.text))
        const fresh = message.waits.find((w) => !before.has(w.text))
        if (fresh) notice = aboutChat(seen, message.chatId, 'needsYou', fresh.text)
      } else if (message.type === 'notify') {
        const chat = message.chatId === undefined ? undefined : seen.chats.find((c) => c.id === message.chatId)
        notice = {
          kind: 'extension',
          ...(chat && { chatId: chat.id, open: rootOf(seen.chats, chat).id }),
          title: message.title,
          body: excerpt(message.body),
        }
      } else if (message.type === 'chat.removed') {
        lastText.delete(message.chatId)
        ended.delete(message.chatId)
      }
      if (notice) add(notice, seen)
    },
    /** Shows what's waiting now, for tests and before the window goes. */
    flush() {
      if (handle !== undefined) timer.clear(handle)
      flush()
    },
  }
}

/**
 * Shows one notification: the desktop app's own (Electron), or the browser's in a tab, if the user allowed them.
 * Clicking it brings Kothar to the front and opens the chat.
 */
export function deliver(shown: Shown, open: (chatId: string) => void) {
  if (window.kothar?.notify) return window.kothar.notify(shown)
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const notification = new Notification(shown.title, { body: shown.body })
  notification.onclick = () => {
    window.focus()
    if (shown.open !== undefined) open(shown.open)
    notification.close()
  }
}

/** In a browser tab, notifications need the user's leave: true once given (always true in the desktop app). */
export const notificationsAllowed = () =>
  !!window.kothar?.notify || (typeof Notification !== 'undefined' && Notification.permission === 'granted')

export const askNotificationLeave = async () =>
  typeof Notification === 'undefined' ? 'denied' : await Notification.requestPermission()
