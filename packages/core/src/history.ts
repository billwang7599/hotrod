import type { ChatEntry } from './shared.ts'

// A page of a chat's history, as the UI gets it: about this many entries, or fewer once their JSON passes the char
// budget (a few large tool outputs can be most of a log).
export const PAGE_ENTRIES = 100
export const PAGE_CHARS = 200_000

const startsTurn = (entry: ChatEntry) => entry.type === 'user.message' || (entry.type === 'worker.report' && entry.quiet !== true)

// Where the page that ends just before `before` starts: back a page's worth, then on back to the start of that turn
// so a turn isn't cut in two, unless its start is more than another page's worth back. `to`: start no later than this
// entry (and its turn), however far back it is.
export function pageStart(entries: readonly ChatEntry[], before: number, to?: number): number {
  const end = Math.max(0, Math.min(before, entries.length))
  let start = end
  let chars = 0
  const back = () => {
    start--
    chars += JSON.stringify(entries[start]).length
  }
  while (start > 0 && start > end - PAGE_ENTRIES && chars < PAGE_CHARS) back()
  if (to !== undefined && to >= 0) while (start > to) back()
  const limit = { entries: start - PAGE_ENTRIES, chars: chars + PAGE_CHARS }
  let snapped = start
  let snapChars = chars
  while (snapped > 0 && !startsTurn(entries[snapped]!) && snapped > limit.entries && snapChars < limit.chars) {
    snapped--
    snapChars += JSON.stringify(entries[snapped]).length
  }
  return snapped === 0 || startsTurn(entries[snapped]!) ? snapped : start
}

// The page of entries that ends just before `before` (the whole log's end by default), and where it starts.
export function pageOf(entries: readonly ChatEntry[], before = entries.length, to?: number) {
  const end = Math.max(0, Math.min(before, entries.length))
  const from = pageStart(entries, end, to)
  return { from, entries: entries.slice(from, end) }
}
