/** Unsent composer text per chat id, kept across chat switches and reloads. Attachments aren't kept. */
const KEY = 'hotrod.drafts'
/** How long typing pauses before the draft is written, so a keystroke never waits on localStorage. */
export const DRAFT_SAVE_MS = 300

// Typed text not yet written to localStorage, by chat id.
const unsaved = new Map<string, string>()
let timer: ReturnType<typeof setTimeout> | undefined

function read(): Record<string, string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (!saved || typeof saved !== 'object') return {}
    return Object.fromEntries(Object.entries(saved).filter(([, text]) => typeof text === 'string' && text !== ''))
  } catch {
    return {}
  }
}

function write(drafts: Record<string, string>) {
  if (Object.keys(drafts).length) localStorage.setItem(KEY, JSON.stringify(drafts))
  else localStorage.removeItem(KEY)
}

export function draftOf(chatId: string): string {
  return unsaved.get(chatId) ?? read()[chatId] ?? ''
}

/** Saves `text` as the chat's draft now; empty text clears it. */
export function saveDraft(chatId: string, text: string) {
  unsaved.delete(chatId)
  const drafts = read()
  if ((drafts[chatId] ?? '') === text) return
  if (text) drafts[chatId] = text
  else delete drafts[chatId]
  write(drafts)
}

/** Saves `text` as the chat's draft once typing pauses. `flushDrafts` writes it sooner. */
export function saveDraftSoon(chatId: string, text: string) {
  unsaved.set(chatId, text)
  clearTimeout(timer)
  timer = setTimeout(flushDrafts, DRAFT_SAVE_MS)
}

/** Writes every draft still waiting on `saveDraftSoon`. */
export function flushDrafts() {
  clearTimeout(timer)
  timer = undefined
  if (!unsaved.size) return
  const drafts = read()
  for (const [chatId, text] of unsaved) {
    if (text) drafts[chatId] = text
    else delete drafts[chatId]
  }
  unsaved.clear()
  write(drafts)
}

/** Drops the drafts of chats that no longer exist. */
export function pruneDrafts(chatIds: Iterable<string>) {
  flushDrafts()
  const drafts = read()
  const kept = new Set(chatIds)
  const stale = Object.keys(drafts).filter((id) => !kept.has(id))
  if (!stale.length) return
  for (const id of stale) delete drafts[id]
  write(drafts)
}

// A reload or quit mid-word still keeps the draft.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushDrafts)
  window.addEventListener('beforeunload', flushDrafts)
}
