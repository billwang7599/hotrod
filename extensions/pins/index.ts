// Pins: the user pins messages in a long chat and finds them again in a Pinned tab, which scrolls the chat back to one.
// Only the public extension API: a message action marks and unmarks, and a tab quotes each pin with a message view.
import type { ChatDetail, Extension, ExtensionHost, ExtensionMessage, ExtensionStorage, ExtensionView } from '@kothar/extension-api'

// Each chat's pins, in its chat storage (the chat's own folder, so the file goes when the chat is deleted). Only where each message is in the log and when it was pinned: the text is
// read from the log, so nothing is copied.
export const PINS_FILE = 'pins.json'
export type Pin = { entry: number; pinnedAt: string }

const isPin = (value: unknown): value is Pin =>
  typeof value === 'object' &&
  value !== null &&
  Number.isInteger((value as Pin).entry) &&
  (value as Pin).entry >= 0 &&
  typeof (value as Pin).pinnedAt === 'string'

/** The pins in a pins.json, by entry, oldest message first. A broken or missing file has none. */
export function parsePins(text: string | undefined): Pin[] {
  if (!text) return []
  try {
    const parsed: unknown = JSON.parse(text)
    const list = Array.isArray(parsed) ? parsed : (parsed as { pins?: unknown })?.pins
    if (!Array.isArray(list)) return []
    const byEntry = new Map<number, Pin>()
    for (const pin of list) if (isPin(pin) && !byEntry.has(pin.entry)) byEntry.set(pin.entry, { entry: pin.entry, pinnedAt: pin.pinnedAt })
    return [...byEntry.values()].sort((a, b) => a.entry - b.entry)
  } catch {
    return []
  }
}

export const pinsText = (pins: Pin[]) => JSON.stringify({ pins }, null, 2) + '\n'

/** Pins the message at entry, or unpins it if it was pinned. */
export function toggled(pins: Pin[], entry: number, now: Date): Pin[] {
  return pins.some((p) => p.entry === entry)
    ? pins.filter((p) => p.entry !== entry)
    : [...pins, { entry, pinnedAt: now.toISOString() }].sort((a, b) => a.entry - b.entry)
}

const AUTHORS: Record<ExtensionMessage['kind'], string> = { user: 'You', talk: 'Agent', work: 'Worker report' }
export const authorOf = (kind: ExtensionMessage['kind']) => AUTHORS[kind]

function store(host: ExtensionHost, chatId: string) {
  const storage: ExtensionStorage = host.chatStorage(chatId)
  const read = () => parsePins(storage.read(PINS_FILE))
  const write = (pins: Pin[]) => (pins.length ? storage.write(PINS_FILE, pinsText(pins)) : storage.remove(PINS_FILE))
  // The pins whose messages are still in the log, each with its message. Pins whose message is gone (the log was cut
  // by hand, say) are dropped from the file quietly.
  const live = () => {
    const pins = read()
    const found = pins.flatMap((pin) => {
      const message = host.message(chatId, pin.entry)
      return message ? [{ pin, message }] : []
    })
    if (found.length !== pins.length) write(found.map((f) => f.pin))
    return found
  }
  return { read, write, live }
}

function pinView(pin: Pin, message: ExtensionMessage): ExtensionView {
  return {
    type: 'message',
    entry: message.entry,
    author: authorOf(message.kind),
    at: message.at,
    text: message.text,
    hint: 'Show this message in the chat',
    buttons: [
      { type: 'copy', text: message.text, label: 'Copy', hint: 'Copy the message' },
      {
        type: 'button',
        label: 'Unpin',
        variant: 'ghost',
        action: { name: 'unpin', value: pin.entry },
        hint: 'Take this message out of Pinned',
      },
    ],
  }
}

export function createPinsExtension(): Extension {
  return {
    id: 'pins',
    name: 'Pins',
    description:
      'Pin messages in a chat, yours or the agent’s, and find them again in the Pinned tab. Clicking a pin scrolls ' +
      'the chat back to it. Agents don’t see your pins.',
    enabledByDefault: true,
    messageActions: [
      {
        id: 'pin',
        label: 'Pin',
        activeLabel: 'Unpin',
        icon: 'pin',
        hint: 'Pin to the Pinned tab',
        activeHint: 'Unpin from the Pinned tab',
        marked: (chat, { host }) => store(host, chat.id).live().map((f) => f.pin.entry),
        run(message, chat, { host }) {
          const pins = store(host, chat.id)
          pins.write(toggled(pins.read(), message.entry, host.now()))
        },
      },
    ],
    panels: [
      {
        id: 'pinned',
        title: 'Pinned',
        render(chat: ChatDetail, { host }) {
          const found = store(host, chat.id).live()
          if (!found.length) return { type: 'empty', text: 'No pinned messages. Pin one from the buttons beside Copy.' }
          return { type: 'stack', gap: 'normal', children: found.map(({ pin, message }) => pinView(pin, message)) }
        },
        onAction(action, chat, { host }) {
          if (action.name !== 'unpin' || typeof action.value !== 'number') return
          const pins = store(host, chat.id)
          pins.write(pins.read().filter((p) => p.entry !== action.value))
          // The message's mark in the transcript goes too.
          host.refresh(chat.id)
        },
      },
    ],
  }
}

export default createPinsExtension()
