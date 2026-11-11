// Which replies and thoughts type out as they arrive, and which show whole.
// oxlint-disable react/refs -- what was there when the chat opened is read and pinned during render, on purpose: it
// must be settled before the first frame draws, and changing it never needs a render of its own.
import { useRef } from 'react'
import type { RevealFrom } from '../smooth.ts'
import type { ChatView, Item } from '../state.ts'
import type { RevealOf } from './transcript-items.tsx'

/**
 * A chat's nth reply keeps one name from draft to finished item, so its reveal carries over. Texts already there when
 * the chat was opened show whole; ones that arrive while it's open type out.
 * Older pages count down from the first loaded, so the numbers of what was already there don't change.
 */
export function useRevealNumbers(chat: ChatView) {
  const shift = chat.shift ?? 0
  const older = chat.items.slice(0, shift)
  const replyNumbers = new Map<Item, number>()
  const thoughtNumbers = new Map<Item, number>()
  let replies = -older.filter((i) => i.kind === 'text').length
  let thoughts = -older.filter((i) => i.kind === 'thinking').length
  for (const i of chat.items) {
    if (i.kind === 'text') replyNumbers.set(i, replies++)
    else if (i.kind === 'thinking') thoughtNumbers.set(i, thoughts++)
  }
  const draftKey = `${chat.id}:text:${replies}`
  const opened = useRef({ chatId: '', texts: 0, thoughts: 0, draftKey: '' })
  if (opened.current.chatId !== chat.id) {
    opened.current = { chatId: chat.id, texts: replies, thoughts, draftKey: chat.draft ? draftKey : '' }
  }
  // A finished turn drops its thinking, so the next turn's thoughts count from zero again.
  opened.current.thoughts = Math.min(opened.current.thoughts, thoughts)
  const revealOf: RevealOf = (item) => {
    const reply = replyNumbers.get(item)
    if (reply !== undefined)
      return { key: `${chat.id}:text:${reply}`, from: reply >= opened.current.texts ? 'start' : 'none' }
    const thought = thoughtNumbers.get(item)
    if (thought === undefined) return undefined
    return { key: `${chat.id}:thinking:${thought}`, from: thought >= opened.current.thoughts ? 'start' : 'end' }
  }
  const draftFrom: RevealFrom = draftKey === opened.current.draftKey ? 'end' : 'start'
  return { revealOf, draftKey, draftFrom }
}
