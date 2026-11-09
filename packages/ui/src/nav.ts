import { chatTree, type ChatView } from './state.ts'

/** Home (when its mod is on) and the spaces, top to bottom as the sidebar lists them; no subagents or archived ones. */
export const spaceOrder = (chats: ChatView[]): ChatView[] =>
  chatTree(chats)
    .active.filter((r) => r.depth === 0)
    .map((r) => r.chat)

function rootOf(chats: ChatView[], chat: ChatView): ChatView {
  const parent = chats.find((c) => c.id === chat.parentId)
  return parent ? rootOf(chats, parent) : chat
}

/**
 * The entry one step up or down from the open chat, or undefined at either end. From a subagent, up goes to its own
 * space and down to the space after it. From nothing or an archived chat, down starts at the top and up at the bottom.
 */
export function stepSpace(chats: ChatView[], selectedId: string, by: -1 | 1): string | undefined {
  const order = spaceOrder(chats)
  const selected = chats.find((c) => c.id === selectedId)
  const root = selected && rootOf(chats, selected)
  const at = root ? order.findIndex((c) => c.id === root.id) : -1
  if (at < 0) return (by > 0 ? order[0] : order.at(-1))?.id
  if (by < 0 && root!.id !== selectedId) return root!.id
  return order[at + by]?.id
}

/** The nth entry (from 1), as Cmd+1…9 jump to it. */
export const nthSpace = (chats: ChatView[], n: number): string | undefined => spaceOrder(chats)[n - 1]?.id
