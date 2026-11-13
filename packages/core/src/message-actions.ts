// Extensions' buttons on transcript messages (Extension.messageActions): which log entries are messages, and what the
// UI gets of an extension's buttons for a chat, with the messages each marks.
import type { ExtensionMessage, ExtensionMessageAction, ExtensionMessageDetail } from '@kothar/extension-api'
import type { ChatEntry, MessageActionInfo, MessageDetailInfo } from './shared.ts'

const KINDS: readonly ExtensionMessage['kind'][] = ['user', 'work', 'talk']
const ICONS: readonly ExtensionMessageAction['icon'][] = ['pin', 'bookmark', 'star', 'eye']
// More marks than this in one chat are left off, so a runaway list can't swamp the UI.
export const MAX_MARKS = 1000

/** The message at `entry` in a chat's log, if one is there: the user's, a worker's report or the agent's reply. */
export function messageAt(entries: readonly ChatEntry[], entry: number): ExtensionMessage | undefined {
  if (!Number.isInteger(entry) || entry < 0) return undefined
  const found = entries[entry]
  if (found?.type === 'user.message') {
    // Logs from before reports had their own entry carry them as user messages in this form.
    const kind = found.text.startsWith('[subagent "') ? 'work' : 'user'
    return { entry, kind, at: found.at, text: found.text }
  }
  if (found?.type === 'worker.report') return { entry, kind: 'work', at: found.at, text: found.text }
  if (found?.type === 'text.completed') return { entry, kind: 'talk', at: found.at, text: found.text }
  return undefined
}

/** What the UI gets of one message action: its labels, icon and kinds checked, and the entries it marks. */
export function messageActionInfo(extension: string, action: ExtensionMessageAction, marked: unknown): MessageActionInfo {
  const { id, label, activeLabel, icon, hint, activeHint, kinds } = action
  if (typeof id !== 'string' || !id || typeof label !== 'string' || !label) {
    throw new Error('A message action needs an id and a label')
  }
  if (!ICONS.includes(icon)) throw new Error(`A message action's icon is one of ${ICONS.join(', ')}`)
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)
  const offered = Array.isArray(kinds) ? KINDS.filter((k) => kinds.includes(k)) : [...KINDS]
  const entries = Array.isArray(marked) ? marked.filter((n): n is number => Number.isInteger(n) && n >= 0) : []
  return {
    extension,
    id,
    label,
    icon,
    kinds: offered,
    marked: [...new Set(entries)].slice(0, MAX_MARKS),
    ...(text(activeLabel) && { activeLabel: text(activeLabel) }),
    ...(text(hint) && { hint: text(hint) }),
    ...(text(activeHint) && { activeHint: text(activeHint) }),
  }
}

/** What the UI gets of one message detail: its label and kinds checked, and the entries that get it (all when absent). */
export function messageDetailInfo(extension: string, detail: ExtensionMessageDetail, entries: unknown): MessageDetailInfo {
  const { id, label, hint, kinds } = detail
  if (typeof id !== 'string' || !id || typeof label !== 'string' || !label) {
    throw new Error('A message detail needs an id and a label')
  }
  if (typeof detail.render !== 'function') throw new Error('A message detail needs render')
  const offered = Array.isArray(kinds) ? KINDS.filter((k) => kinds.includes(k)) : [...KINDS]
  const listed = Array.isArray(entries) ? entries.filter((n): n is number => Number.isInteger(n) && n >= 0) : undefined
  return {
    extension,
    id,
    label,
    kinds: offered,
    ...(typeof hint === 'string' && hint && { hint }),
    ...(listed && { entries: [...new Set(listed)].slice(0, MAX_MARKS) }),
  }
}
