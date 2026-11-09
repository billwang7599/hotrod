import type { ChatEntry, SearchHit } from './shared.ts'

/** What search reads of a chat: its name and its log (as loaded from log.jsonl and appended to since). */
export type Searchable = { id: string; name: string; entries: readonly ChatEntry[] }

export const SEARCH_LIMIT = 50
const SNIPPET_BEFORE = 40
const SNIPPET_LENGTH = 160
const MAX_QUERY = 200

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const textOf = (entry: ChatEntry): { kind: SearchHit['kind']; text: string } | undefined => {
  if (entry.type === 'user.message') return { kind: 'user', text: entry.text }
  if (entry.type === 'text.completed') return { kind: 'text', text: entry.text }
  if (entry.type === 'worker.report') return { kind: 'report', text: entry.text }
  return undefined
}

/**
 * Message text matching `query`, case-insensitively: newest first, one hit per message, at most `limit`. Each hit
 * carries a one-line snippet around the match, where the match sits in it, and `nth`: how many earlier messages in
 * the same chat also match, so the UI can find that message on screen.
 */
export function searchChats(chats: readonly Searchable[], query: string, limit = SEARCH_LIMIT): SearchHit[] {
  const needle = query.trim().slice(0, MAX_QUERY)
  if (!needle) return []
  const pattern = new RegExp(escape(needle), 'iu')
  const hits: SearchHit[] = []
  for (const chat of chats) {
    let nth = 0
    for (const entry of chat.entries) {
      const found = textOf(entry)
      if (!found) continue
      const match = pattern.exec(found.text)
      if (!match) continue
      hits.push({ chatId: chat.id, at: entry.at, kind: found.kind, nth: nth++, ...snippet(found.text, match.index, match[0].length) })
    }
  }
  return hits.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
}

function snippet(text: string, index: number, length: number) {
  const start = Math.max(0, index - SNIPPET_BEFORE)
  const end = Math.min(text.length, Math.max(index + length, start + SNIPPET_LENGTH))
  const lead = start > 0 ? '…' : ''
  const raw = text.slice(start, end)
  // One line: whitespace runs become a space, so the match's place in the snippet has to be counted after that.
  const flat = (s: string) => s.replace(/\s+/g, ' ')
  const before = lead + flat(raw.slice(0, index - start)).trimStart()
  const match = flat(raw.slice(index - start, index - start + length))
  const after = flat(raw.slice(index - start + length)).trimEnd() + (end < text.length ? '…' : '')
  return { snippet: before + match + after, match: { start: before.length, length: match.length } }
}
