import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { AnimatePresence, m } from 'motion/react'
import { Dialog } from 'radix-ui'
import type { ClientMessage, SearchHit } from '@kothar/core/shared'
import { MOTION, useReturnFocus } from './controls.tsx'
import { Keys } from './shortcuts-page.tsx'
import { useBindings } from './shortcuts.ts'
import type { ChatView } from './state.ts'

export const SEARCH_DEBOUNCE_MS = 150
const MAX_NAMES = 8
const MAX_RECENT = 12

/**
 * A message match the chat view scrolls to once it opens: the nth message in the chat whose text holds the query, at
 * `entry` in its log (which the view loads back to first, if it's older than what's loaded).
 */
export type Reveal = { chatId: string; query: string; nth: number; entry?: number }
let pendingReveal: Reveal | null = null
export const revealLater = (reveal: Reveal) => {
  pendingReveal = reveal
}
export const takeReveal = (chatId: string): Reveal | null => {
  if (pendingReveal?.chatId !== chatId) return null
  const reveal = pendingReveal
  pendingReveal = null
  return reveal
}

const lastActive = (c: ChatView) => [c.doneAt, c.readAt, c.createdAt].filter(Boolean).sort().at(-1)!

/** How long ago, short: "just now", "5m", "3h", "2d", else the date. */
export function ago(iso: string, now = Date.now()) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

type Result = { key: string; chat: ChatView; hit?: SearchHit }

/**
 * What the palette lists: with no query, recent chats (the open one last, so Enter goes back to the one before);
 * otherwise chats whose name matches, then the core's message matches. Home and spaces only, never workers.
 */
export function paletteResults(
  chats: ChatView[],
  selectedId: string,
  query: string,
  hits: SearchHit[] | undefined,
): Result[] {
  const listed = chats.filter((c) => !c.worker)
  const q = query.trim().toLowerCase()
  if (!q) {
    const recent = [...listed].sort((a, b) => lastActive(b).localeCompare(lastActive(a)))
    const ordered = [...recent.filter((c) => c.id !== selectedId), ...recent.filter((c) => c.id === selectedId)]
    return ordered.slice(0, MAX_RECENT).map((chat) => ({ key: chat.id, chat }))
  }
  const names = listed
    .filter((c) => c.name.toLowerCase().includes(q))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
    .slice(0, MAX_NAMES)
    .map((chat) => ({ key: chat.id, chat }))
  const byId = new Map(listed.map((c) => [c.id, c]))
  const messages = (hits ?? []).flatMap((hit) => {
    const chat = byId.get(hit.chatId)
    return chat ? [{ key: `${hit.chatId}/${hit.at}/${hit.nth}`, chat, hit }] : []
  })
  return [...names, ...messages]
}

type PaletteProps = {
  open: boolean
  close: () => void
  chats: ChatView[]
  selectedId: string
  search?: { id: number; query: string; hits: SearchHit[] }
  connected: boolean
  send: (m: ClientMessage) => void
  select: (chatId: string) => void
}

/** Search across Home and every space: ⌘O by default. Arrows move, Enter opens, Esc closes. */
export function SearchPalette({ open, close, chats, selectedId, search, connected, send, select }: PaletteProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const requestId = useRef(0)
  // The latest request sent, so render can tell its answer from an older one.
  const [latest, setLatest] = useState(0)
  const focus = useReturnFocus()
  const keys = useBindings()

  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setQuery('')
      setActive(0)
    }
  }

  const trimmed = query.trim()
  useEffect(() => {
    if (!open || !trimmed || !connected) return
    const timer = setTimeout(() => {
      const id = ++requestId.current
      setLatest(id)
      send({ type: 'search', id, query: trimmed })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [open, trimmed, connected, send])

  // Only the answer to the latest request counts; an older one still in flight is dropped.
  const hits = search && search.id === latest && search.query === trimmed ? search.hits : undefined
  const searching = !!trimmed && connected && !hits
  const results = paletteResults(chats, selectedId, query, hits)
  const at = Math.min(active, Math.max(0, results.length - 1))

  const choose = (result: Result | undefined) => {
    if (!result) return
    if (result.hit) revealLater({ chatId: result.chat.id, query: trimmed, nth: result.hit.nth, entry: result.hit.entry })
    select(result.chat.id)
    close()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      if (!results.length) return
      const by = e.key === 'ArrowDown' ? 1 : -1
      setActive((at + by + results.length) % results.length)
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      choose(results[at])
    }
  }

  useEffect(() => {
    document.querySelector(`[data-palette-index="${at}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [at])

  const firstMessage = results.findIndex((r) => r.hit)
  const status = !trimmed
    ? undefined
    : !connected
      ? 'Disconnected from the core, so only names are searched'
      : searching
        ? 'Searching messages…'
        : results.length === 0
          ? 'Nothing matches'
          : undefined

  return (
    <Dialog.Root open={open} onOpenChange={(o) => o || close()}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay forceMount asChild>
              <m.div className="fixed inset-0 bg-backdrop" {...MOTION.fade} />
            </Dialog.Overlay>
            <Dialog.Content
              forceMount
              asChild
              aria-describedby={undefined}
              onOpenAutoFocus={focus.remember}
              onCloseAutoFocus={focus.restore}
            >
              <m.div
                className="fixed inset-x-0 top-[12vh] mx-auto flex max-h-[min(520px,76vh)] w-[min(620px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border bg-panel text-text shadow-overlay"
                {...MOTION.pop}
              >
                <Dialog.Title className="sr-only">Search</Dialog.Title>
                <div className="flex items-center gap-8 border-b px-14">
                  <input
                    autoFocus
                    className="h-44 min-w-0 flex-1 border-0 bg-transparent px-0 text-body shadow-none outline-none focus:shadow-none"
                    placeholder="Search spaces and messages"
                    aria-label="Search"
                    role="combobox"
                    aria-expanded
                    aria-controls="palette-results"
                    aria-activedescendant={results[at] ? `palette-${at}` : undefined}
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value)
                      setActive(0)
                    }}
                    onKeyDown={onKeyDown}
                  />
                  {keys.search && <Keys binding={keys.search} />}
                </div>
                <ul id="palette-results" role="listbox" aria-label="Results" className="min-h-0 flex-1 scroll-inset overflow-y-auto py-6 pl-6">
                  {!trimmed && results.length > 0 && <li className="px-8 pt-4 pb-2 text-xs text-faint">Recent</li>}
                  {results.map((result, i) => (
                    <PaletteRow
                      key={result.key}
                      index={i}
                      result={result}
                      active={i === at}
                      heading={i === firstMessage ? 'Messages' : undefined}
                      hover={() => setActive(i)}
                      choose={() => choose(result)}
                    />
                  ))}
                  {status && <li className="px-8 py-10 text-sm text-muted">{status}</li>}
                </ul>
              </m.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}

type RowProps = { index: number; result: Result; active: boolean; heading?: string; hover: () => void; choose: () => void }

function PaletteRow({ index, result, active, heading, hover, choose }: RowProps) {
  const { chat, hit } = result
  const name = (
    <span className={`truncate ${hit ? 'text-sm text-muted' : ''}`}>
      {chat.name}
      {chat.archived && <span className="text-faint"> · archived</span>}
    </span>
  )
  return (
    <>
      {heading && <li className="px-8 pt-8 pb-2 text-xs text-faint">{heading}</li>}
      <li
        id={`palette-${index}`}
        data-palette-index={index}
        role="option"
        aria-selected={active}
        className={`flex cursor-default flex-col gap-2 rounded px-8 py-6 ${active ? 'bg-raised' : ''}`}
        onPointerMove={hover}
        onClick={choose}
      >
        <div className="flex items-center gap-8">
          {name}
          <span className="ml-auto shrink-0 text-xs text-faint">{ago(hit?.at ?? lastActive(chat))}</span>
        </div>
        {hit && (
          <div className="truncate text-sm" data-snippet>
            {hit.snippet.slice(0, hit.match.start)}
            <mark className="rounded-sm bg-accent/20 text-text">
              {hit.snippet.slice(hit.match.start, hit.match.start + hit.match.length)}
            </mark>
            {hit.snippet.slice(hit.match.start + hit.match.length)}
          </div>
        )}
      </li>
    </>
  )
}

/** Which match on screen the reveal's message is: how many loaded messages before it (from `from` on) match too. */
export function localNth(entries: readonly { type: string; text?: string }[], from: number, reveal: Reveal) {
  const q = reveal.query.toLowerCase()
  const message = (e: { type: string }) => ['user.message', 'text.completed', 'worker.report'].includes(e.type)
  return entries
    .slice(0, Math.max(0, (reveal.entry ?? 0) - from))
    .filter((e) => message(e) && (e.text ?? '').toLowerCase().includes(q)).length
}

/**
 * Scrolls the open chat to a message the palette chose: the nth transcript entry (user message, reply or report) whose
 * text holds the query, or the last such one if fewer are on screen (a folded step hides its text). Flashes it.
 */
export function revealIn(container: HTMLElement, reveal: Reveal) {
  const q = reveal.query.toLowerCase()
  const found = [...container.querySelectorAll<HTMLElement>('[data-item-kind="user"],[data-item-kind="text"],[data-item-kind="report"]')].filter(
    (el) => (el.textContent ?? '').replace(/\s+/g, ' ').toLowerCase().includes(q),
  )
  const target = found[Math.min(reveal.nth, found.length - 1)]
  if (!target) return false
  target.scrollIntoView?.({ block: 'center' })
  target.dataset.revealed = ''
  setTimeout(() => delete target.dataset.revealed, 1600)
  return true
}
