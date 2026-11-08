/** Unsent composer text per chat id, kept across chat switches and reloads. Attachments aren't kept. */
const KEY = 'hotrod.drafts'

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
  return read()[chatId] ?? ''
}

/** Saves `text` as the chat's draft; empty text clears it. */
export function saveDraft(chatId: string, text: string) {
  const drafts = read()
  if ((drafts[chatId] ?? '') === text) return
  if (text) drafts[chatId] = text
  else delete drafts[chatId]
  write(drafts)
}

/** Drops the drafts of chats that no longer exist. */
export function pruneDrafts(chatIds: Iterable<string>) {
  const drafts = read()
  const kept = new Set(chatIds)
  const stale = Object.keys(drafts).filter((id) => !kept.has(id))
  if (!stale.length) return
  for (const id of stale) delete drafts[id]
  write(drafts)
}
