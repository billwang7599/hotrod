// Kothar's activity: what it and its extensions do on their own, outside the agent's own tool calls (model calls they
// make, permission answers and the rule behind each, how extensions changed a turn, chats they start or message, tools
// they call each other's, turns carried on or run again, account switches). One generic stream: the core and the
// extension host emit into it, and extensions that watch (Extension.onActivity) get each event, such as the Inspector,
// which keeps them. Nothing is built when no extension that's on watches.
import { randomUUID } from 'node:crypto'
import type { ActivityEvent, ActivityInput, Extension } from '@kothar/extension-api'

// Long texts are cut before they're handed on: a prompt section, and a result or detail.
export const ACTIVITY_SECTION_CHARS = 100_000
export const ACTIVITY_RESULT_CHARS = 20_000

export type ActivityChat = { info: { id: string }; sentTurn?: string; status?: string }

export type ActivityDeps<C extends ActivityChat> = {
  now: () => Date
  chat: (chatId: string) => C | undefined
  // The extensions that are on (for the chat, if any) and watch.
  watchers: (chat: C | undefined) => Extension[]
  deliver: (extension: Extension, event: ActivityEvent) => void
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text)

// What an emitter gives: the event less what the stream adds (id, time, turn), and who did it.
export type ActivityEmit = ActivityInput & Partial<Pick<ActivityEvent, 'decision' | 'rule'>> & { by?: Extension }

export function openActivity<C extends ActivityChat>(deps: ActivityDeps<C>) {
  const watchersFor = (chatId: string | undefined) => deps.watchers(chatId === undefined ? undefined : deps.chat(chatId))
  // Whether anyone would get an event for the chat: emitters check before they build anything costly.
  const listening = (chatId?: string) => watchersFor(chatId).length > 0
  // build runs only when someone watches.
  const emit = (chatId: string | undefined, build: () => ActivityEmit) => {
    const watchers = watchersFor(chatId)
    if (!watchers.length) return
    let input: ActivityEmit
    try {
      input = build()
    } catch (error) {
      console.error('Kothar could not describe an activity:', error)
      return
    }
    const chat = chatId === undefined ? undefined : deps.chat(chatId)
    const { by, sections, result, detail, error, ...rest } = input
    const event: ActivityEvent = {
      ...rest,
      id: randomUUID(),
      at: deps.now().toISOString(),
      ...(chatId !== undefined && { chatId }),
      ...(chat?.sentTurn && chat.status !== 'idle' && { turn: chat.sentTurn }),
      by: by ? { extension: by.id, name: by.name } : { name: 'Kothar' },
      title: String(input.title).slice(0, 300),
      ...(detail !== undefined && { detail: cut(String(detail), ACTIVITY_RESULT_CHARS) }),
      ...(sections?.length && {
        sections: sections.map((section) => ({ label: String(section.label), text: cut(String(section.text), ACTIVITY_SECTION_CHARS) })),
      }),
      ...(result !== undefined && { result: cut(String(result), ACTIVITY_RESULT_CHARS) }),
      ...(error !== undefined && { error: cut(String(error), ACTIVITY_RESULT_CHARS) }),
    }
    for (const extension of watchers) deps.deliver(extension, event)
  }
  return { emit, listening }
}

export type Activity = ReturnType<typeof openActivity>

const KINDS = new Set<ActivityEvent['kind']>(['model', 'permission', 'turn', 'worker', 'tool', 'retry', 'account', 'browser', 'other'])

// An extension's own event (host.activity), checked: a known kind and a title.
export function checkedActivity(input: ActivityInput): ActivityInput {
  if (typeof input !== 'object' || input === null) throw new Error('An activity is an object')
  if (!KINDS.has(input.kind)) throw new Error(`Unknown activity kind "${String(input.kind)}"`)
  if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('An activity needs a title')
  if (input.sections !== undefined && !Array.isArray(input.sections)) throw new Error('An activity’s sections are a list')
  return input
}
