// Inspector: what Kothar actually sent the engine for each turn, labelled by who it's from (you, Kothar, the chat's
// context, each extension, tools, how the turn ran, and what the engine adds that Kothar can't see). Only the public
// extension API: the core hands each turn over in onTurnSent, and this keeps it in the chat's own storage (so it goes
// with the chat), capped at the last turns and with each distinct text stored once.
import { createHash } from 'node:crypto'
import type {
  ActivityEvent,
  ChatDetail,
  Extension,
  ExtensionHost,
  ExtensionMessage,
  ExtensionStorage,
  ExtensionView,
  SentSection,
  SentSource,
  SentTurn,
} from '@kothar/extension-api'
import { activityStore, activityView, type Scope, type StoredEvent } from './activity.ts'

// Compacted to the turns kept after this many events are added to one chat's Activity.
const COMPACT_EVERY = 100
// Open Activity tabs draw again at most this often while events come in.
const REDRAW_MS = 300

export const SENT_FILE = 'inspector/sent.json'
export const TEXT_DIR = 'inspector/text'
export const DEFAULT_KEEP = 30

// A section as kept: its text stored once by hash, in TEXT_DIR. at: when a steered message came in.
export type StoredSection = Omit<SentSection, 'text'> & { hash: string; chars: number; at?: string }
export type StoredTurn = Omit<SentTurn, 'sections' | 'kind' | 'id'> & { sections: StoredSection[] }

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32)
// About four characters a token, as a rough guide.
export const tokensOf = (chars: number) => Math.ceil(chars / 4)
const short = (tokens: number) => (tokens >= 1000 ? `~${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : `~${tokens}`)

export function parseTurns(text: string | undefined): StoredTurn[] {
  if (!text) return []
  try {
    const parsed = JSON.parse(text) as { turns?: unknown }
    return Array.isArray(parsed.turns)
      ? parsed.turns.filter(
          (turn): turn is StoredTurn =>
            typeof turn === 'object' && turn !== null && typeof turn.turn === 'string' && Array.isArray(turn.sections),
        )
      : []
  } catch {
    return []
  }
}

// One chat's record: its turns, oldest first, and the texts they point at.
export function sentStore(storage: ExtensionStorage) {
  const read = () => parseTurns(storage.read(SENT_FILE))
  const text = (hash: string) => storage.read(`${TEXT_DIR}/${hash}.txt`) ?? ''
  const keep = (section: SentSection, at?: string): StoredSection => {
    const { text: body, ...rest } = section
    const hash = hashOf(body)
    const file = `${TEXT_DIR}/${hash}.txt`
    // The same text (the instructions, a tool) turn after turn is stored once.
    if (storage.read(file) === undefined) storage.write(file, body)
    return { ...rest, hash, chars: body.length, ...(at && { at }) }
  }
  // Keeps the newest `limit` turns, and drops texts no kept turn points at.
  const write = (turns: StoredTurn[], limit: number) => {
    const kept = turns.slice(-Math.max(1, limit))
    storage.write(SENT_FILE, JSON.stringify({ turns: kept }) + '\n')
    const used = new Set(kept.flatMap((turn) => turn.sections.map((section) => `${section.hash}.txt`)))
    for (const file of storage.list(TEXT_DIR)) if (!used.has(file.name)) storage.remove(`${TEXT_DIR}/${file.name}`)
  }
  const add = (sent: SentTurn, limit: number) => {
    const turns = read()
    if (sent.kind === 'steer') {
      const turn = turns.find((t) => t.turn === sent.turn)
      if (!turn) return
      turn.sections.push(...sent.sections.map((section) => keep(section, sent.at)))
      return write(turns, limit)
    }
    const { id: _id, kind: _kind, sections, ...rest } = sent
    turns.push({ ...rest, sections: sections.map((section) => keep(section)) })
    write(turns, limit)
  }
  return { read, text, add }
}

// One of the user's messages in a chat's log: where it is (its entry), when it was sent and what it said.
export type UserMessage = Pick<ExtensionMessage, 'entry' | 'at' | 'text'>

// How many of a turn's latest earlier messages are tried for it: a queue is rarely longer.
const LOOK_BACK = 20

// The kept turn each of the user's messages went out in, by entry. A message steered into a running turn gets the turn
// whose steered part holds it. Any other gets the turn that started at or after it and whose message (the "You" part)
// holds its text, the latest such message for each turn, so one turn has one message and a message older than the
// turns kept gets none. A message with no text (only attachments) gets none.
export function turnsByEntry(turns: StoredTurn[], messages: readonly UserMessage[], text: (hash: string) => string) {
  const read = new Map<string, string>()
  const textOf = (hash: string) => {
    if (!read.has(hash)) read.set(hash, text(hash))
    return read.get(hash)!
  }
  const found = new Map<number, StoredTurn>()
  const left: UserMessage[] = []
  for (const message of messages) {
    if (!message.text) continue
    const steered = turns.find((turn) =>
      turn.sections.some((section) => section.at !== undefined && section.at <= message.at && textOf(section.hash).includes(message.text)),
    )
    if (steered) found.set(message.entry, steered)
    else left.push(message)
  }
  for (const turn of turns) {
    if (turn.continued) continue
    const sent = turn.sections
      .filter((section) => section.source === 'you' && section.at === undefined)
      .map((section) => textOf(section.hash))
      .join('\n')
    if (!sent) continue
    const before = left.filter((message) => message.at <= turn.at)
    const match = before.slice(-LOOK_BACK).findLast((message) => sent.includes(message.text))
    if (!match) continue
    found.set(match.entry, turn)
    left.splice(left.indexOf(match), 1)
  }
  return found
}

const SOURCES: Record<SentSource, { tag: string; tone: 'accent' | 'muted' | 'faint' | 'warning' | 'success' | 'normal' }> = {
  you: { tag: 'You', tone: 'accent' },
  core: { tag: 'Kothar core', tone: 'normal' },
  context: { tag: 'Context', tone: 'success' },
  extension: { tag: 'Extension', tone: 'normal' },
  tools: { tag: 'Tools', tone: 'muted' },
  turn: { tag: 'This turn', tone: 'muted' },
  engine: { tag: 'Engine-added, not visible', tone: 'warning' },
}

const PARTS: { part: SentSection['part']; title: string }[] = [
  { part: 'instructions', title: 'Instructions (the session’s system prompt)' },
  { part: 'prompt', title: 'Message (what the engine was sent as the turn’s prompt)' },
  { part: 'other', title: 'Tools, how it ran, and what Kothar can’t see' },
]

const settingsLink = (extension: string, prompt?: string) =>
  `kothar:settings/extension:${extension}${prompt ? `#prompt-${extension}-${prompt.replace(/[^a-z0-9-]/gi, '-')}` : ''}`

// The whole turn as text, for Copy all.
export function turnText(turn: StoredTurn, text: (hash: string) => string) {
  return turn.sections.map((section) => `### ${section.label}\n\n${text(section.hash)}`).join('\n\n')
}

const nameOf = (section: StoredSection) => section.extensionName ?? section.extension ?? 'Kothar'

function sectionView(section: StoredSection, text: (hash: string) => string, open: boolean): ExtensionView {
  const source = SOURCES[section.source] ?? SOURCES.core
  const edited = section.prompts?.some((prompt) => prompt.edited)
  const tag = section.source === 'extension' ? nameOf(section) : section.source === 'tools' && section.extension ? `Tools · ${nameOf(section)}` : source.tag
  const body = text(section.hash)
  const children: ExtensionView[] = [
    body ? { type: 'code', text: body, maxLines: 40 } : { type: 'text', text: '(empty)', tone: 'faint', small: true },
  ]
  if (!section.extension && section.settings) {
    children.push({ type: 'row', children: [{ type: 'link', text: 'Edit in Settings', url: `kothar:settings/${section.settings}` }] })
  }
  if (section.extension && section.editable) {
    const prompts = section.prompts ?? []
    children.push({
      type: 'row',
      children: prompts.length
        ? prompts.map((prompt) => ({ type: 'link', text: `Edit “${prompt.label}”`, url: settingsLink(section.extension!, prompt.id) }))
        : [{ type: 'link', text: `Edit in ${nameOf(section)}’s settings`, url: settingsLink(section.extension) }],
    })
  }
  if (section.at) children.unshift({ type: 'text', text: `Steered in at ${section.at}`, small: true, tone: 'muted' })
  return {
    type: 'card',
    title: section.label,
    open,
    badges: [
      { text: tag, tone: source.tone, ...(section.source === 'engine' && { hint: 'Kothar can’t see this part' }) },
      { text: `${short(tokensOf(section.chars))} tokens`, tone: 'faint', hint: 'A rough estimate: about 4 characters a token' },
      ...(edited ? [{ text: 'Edited', tone: 'accent' as const, hint: 'You changed this prompt in Settings' }] : []),
    ],
    children,
  }
}

export function turnView(
  turn: StoredTurn,
  text: (hash: string) => string,
  options: { position?: string; nav?: ExtensionView[]; titled?: boolean } = {},
): ExtensionView {
  const visible = turn.sections.filter((section) => section.source !== 'engine')
  const total = visible.reduce((sum, section) => sum + section.chars, 0)
  const head: ExtensionView = {
    type: 'row',
    justify: 'between',
    children: [
      options.titled === false
        ? { type: 'text', text: 'Everything Kothar handed the engine for this turn, in order', small: true, tone: 'muted' }
        : { type: 'heading', text: 'What was sent', hint: 'Everything Kothar handed the engine for this turn, in order' },
      {
        type: 'row',
        justify: 'end',
        children: [
          { type: 'badge', text: `${short(tokensOf(total))} tokens in all`, hint: 'What Kothar sent, estimated; the engine adds its own on top' },
          { type: 'copy', text: turnText(turn, text), label: 'Copy all', hint: 'Copy every section as text' },
        ],
      },
    ],
  }
  const about = [turn.engine, turn.model, turn.continued ? 'continuing the last turn' : undefined, options.position].filter(Boolean)
  return {
    type: 'stack',
    gap: 'normal',
    children: [
      head,
      { type: 'text', text: `${turn.at} · ${about.join(' · ')}`, small: true, tone: 'muted' },
      ...(options.nav?.length ? [{ type: 'row' as const, children: options.nav }] : []),
      ...PARTS.flatMap(({ part, title }) => {
        const sections = turn.sections.filter((section) => section.part === part)
        if (!sections.length) return []
        return [
          { type: 'heading' as const, text: title },
          ...sections.map((section) => sectionView(section, text, section.source === 'you' || section.source === 'engine')),
        ]
      }),
    ],
  }
}

export function createInspectorExtension(): Extension {
  const storeOf = (host: ExtensionHost, chatId: string) => sentStore(host.chatStorage(chatId))
  // The user's messages in a chat's log, the latest ones only: a turn's message is never far before it.
  const userMessages = (host: ExtensionHost, chatId: string, kept: number): UserMessage[] => {
    const messages: UserMessage[] = []
    const entries = host.read(chatId)
    for (let entry = entries.length - 1; entry >= 0 && messages.length < kept * 2 + LOOK_BACK; entry--) {
      const found = entries[entry]
      // Reports from before they had their own entry are logged as user messages in this form.
      if (found?.type === 'user.message' && !found.text.startsWith('[subagent "')) messages.unshift({ entry, at: found.at, text: found.text })
    }
    return messages
  }
  const turnsOf = (host: ExtensionHost, chatId: string) => {
    const store = storeOf(host, chatId)
    const turns = store.read()
    return { store, turns, byEntry: turns.length ? turnsByEntry(turns, userMessages(host, chatId, turns.length), store.text) : new Map<number, StoredTurn>() }
  }
  const keepOf = (values: Record<string, unknown>) => (typeof values.keep === 'number' ? values.keep : DEFAULT_KEEP)
  // Activity: each chat's tab filters (its scope and kind); the chats whose Activity tab drew since the last event, so
  // only those draw again (a closed tab doesn't draw, so it drops out); events added per store since its compaction.
  const filters = new Map<string, { scope: Scope; kind: ActivityEvent['kind'] | 'all' }>()
  const watching = new Set<string>()
  const added = new Map<string, number>()
  let redraw: ReturnType<typeof setTimeout> | undefined
  const activityOf = (host: ExtensionHost, chatId: string | undefined) =>
    activityStore(chatId === undefined ? host.storage : host.chatStorage(chatId))
  const redrawSoon = (host: ExtensionHost) => {
    if (redraw || !watching.size) return
    redraw = setTimeout(() => {
      redraw = undefined
      const chats = [...watching]
      watching.clear()
      for (const chatId of chats) {
        try {
          host.refresh(chatId)
        } catch {
          // Gone.
        }
      }
    }, REDRAW_MS)
    redraw.unref?.()
  }
  // The space a chat is in (its top chat) and every chat under it, by id, with names.
  const spaceChats = (host: ExtensionHost, chat: ChatDetail) => {
    let top = chat as Pick<ChatDetail, 'id' | 'parentId' | 'name'>
    for (let parent = top.parentId && host.chat(top.parentId); parent; parent = parent.parentId && host.chat(parent.parentId)) top = parent
    const all = host.chats()
    const inside = new Map<string, string>([[top.id, top.name]])
    for (let grew = true; grew; ) {
      grew = false
      for (const other of all) {
        if (other.parentId && inside.has(other.parentId) && !inside.has(other.id)) {
          inside.set(other.id, other.name)
          grew = true
        }
      }
    }
    return inside
  }
  const eventsFor = (host: ExtensionHost, chat: ChatDetail, scope: Scope) => {
    type Shown = { event: StoredEvent; text: (hash: string) => string; where?: string }
    const from = (chatId: string | undefined, where?: string): Shown[] => {
      try {
        const store = activityOf(host, chatId)
        return store.read().map((event) => ({ event, text: store.text, ...(where && { where }) }))
      } catch {
        return []
      }
    }
    if (scope === 'none') return from(undefined)
    if (scope === 'chat') return from(chat.id)
    return [...spaceChats(host, chat)]
      .flatMap(([id, name]) => from(id, id === chat.id ? undefined : name))
      .sort((a, b) => (a.event.at < b.event.at ? -1 : a.event.at > b.event.at ? 1 : 0))
  }
  return {
    id: 'inspector',
    name: 'Inspector',
    description:
      'Shows what Kothar actually sends the engine each turn, folded under your message: Kothar’s own rules, each ' +
      'extension’s prompts and tools, the chat’s context and memory, and how the turn ran, each labelled. Kept in the ' +
      'chat’s folder, so it goes with the chat. Its Activity tab lists what Kothar and extensions did on their own: model ' +
      'calls, permission answers and the rule behind each, workers, retries and more.',
    enabledByDefault: true,
    settings: [
      {
        key: 'keep',
        label: 'Turns to keep',
        description:
          'How many of each chat’s latest turns to keep, for what was sent and for Activity. Texts that repeat (such as the instructions) are stored once.',
        type: 'number',
        default: DEFAULT_KEEP,
        min: 1,
        max: 500,
        integer: true,
      },
    ],
    onActivity(event, { host, values }) {
      const store = activityOf(host, event.chatId)
      store.add(event)
      const key = event.chatId ?? ''
      const count = (added.get(key) ?? 0) + 1
      if (count >= COMPACT_EVERY) {
        store.compact(keepOf(values))
        added.set(key, 0)
      } else added.set(key, count)
      redrawSoon(host)
    },
    onTurnSent(sent, { host, values }) {
      storeOf(host, sent.chat.id).add(sent, keepOf(values))
      host.refresh(sent.chat.id)
    },
    // A folded row under each of the user's messages the Inspector has a turn for; drawn only when unfolded.
    messageDetails: [
      {
        id: 'sent',
        label: 'What was sent',
        hint: 'Everything Kothar sent the engine with this message',
        kinds: ['user'],
        entries: (chat, { host }) => [...turnsOf(host, chat.id).byEntry.keys()],
        render(message, chat, { host }) {
          const { store, turns, byEntry } = turnsOf(host, chat.id)
          const turn = byEntry.get(message.entry)
          if (!turn) {
            return {
              type: 'empty',
              text: 'No record of this message: it was sent before the Inspector was on, or is older than the turns it keeps.',
            }
          }
          return turnView(turn, store.text, { position: `turn ${turns.indexOf(turn) + 1} of ${turns.length} kept`, titled: false })
        },
      },
    ],
    panels: [
      {
        id: 'activity',
        title: 'Activity',
        render(chat: ChatDetail, { host }) {
          watching.add(chat.id)
          const { scope, kind } = filters.get(chat.id) ?? { scope: 'chat', kind: 'all' }
          return activityView(eventsFor(host, chat, scope), scope, kind)
        },
        onAction(action, chat) {
          const current = filters.get(chat.id) ?? { scope: 'chat' as Scope, kind: 'all' as const }
          if (action.name === 'scope' && (action.value === 'chat' || action.value === 'space' || action.value === 'none')) {
            filters.set(chat.id, { scope: action.value, kind: 'all' })
          }
          if (action.name === 'kind' && typeof action.value === 'string') {
            filters.set(chat.id, { ...current, kind: action.value as ActivityEvent['kind'] | 'all' })
          }
        },
      },
    ],
    onChatRemoved(chat) {
      filters.delete(chat.id)
      watching.delete(chat.id)
      added.delete(chat.id)
    },
  }
}

export default createInspectorExtension()
