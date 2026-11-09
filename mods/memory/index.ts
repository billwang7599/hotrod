import type { ChatSummary, MemoryMessage, Mod, ModContext, ModHost, ModValues } from '@kothar/mod-api'
import { openRollingCompactor, readRolling, ROLLING_INSTRUCTIONS, ROLLING_ZOOM_INSTRUCTIONS, rollingView } from './rolling.ts'
import {
  dateOf,
  MEMORY_INSTRUCTIONS,
  memoryView,
  openCompactor,
  openSummaries,
  summaryFileOf,
  zoom,
  ZOOM_INSTRUCTIONS,
  type Summaries,
} from './tree.ts'

export type MemoryMode = 'tree' | 'rolling'

export const PARENT_ZOOM_INSTRUCTIONS = "zoom and date read your parent chat's memory, as it was when it started you, with parent: true."

const modeOf = (values: ModValues): MemoryMode => (values.mode === 'tree' ? 'tree' : 'rolling')

// Options for tests and the bench; Kothar loads the default export.
export type MemoryModOptions = { debounceMs?: number; retryBaseMs?: number; minChars?: number }

// whenIdle: resolves once the summaries every touched chat needs are written (tests and the bench).
export function createMemoryMod(options: MemoryModOptions = {}): Mod & { whenIdle(): Promise<void> } {
  // Summaries read once per chat and kept, as the core kept them; a removed chat's go with it.
  const trees = new Map<string, Summaries>()
  let host: ModHost | undefined
  let values: ModValues = {}
  let compactors: { tree: ReturnType<typeof openCompactor>; rolling: ReturnType<typeof openRollingCompactor> } | undefined

  const remember = (context: ModContext) => {
    host = context.host
    values = context.values
    return context.host
  }
  const treeOf = (host: ModHost, chatId: string) => {
    let summaries = trees.get(chatId)
    if (!summaries) {
      summaries = openSummaries(summaryFileOf(host.chatStorage(chatId)))
      trees.set(chatId, summaries)
    }
    return summaries
  }
  const messagesOf = (host: ModHost, chatId: string): MemoryMessage[] | undefined => {
    try {
      return host.messages(chatId)
    } catch {
      return undefined
    }
  }
  const touch = (chatId: string) => compactors?.[modeOf(values)].touch(chatId)

  const failing = (reason: string) => host?.error(`summaries are failing: ${reason}. Retrying.`)
  const start = (context: ModContext) => {
    const host = remember(context)
    if (compactors) return
    const shared = {
      complete: (request: Parameters<ModHost['complete']>[0]) => host.complete(request),
      onFailure: failing,
      ...(options.debounceMs !== undefined && { debounceMs: options.debounceMs }),
      ...(options.retryBaseMs !== undefined && { retryBaseMs: options.retryBaseMs }),
      ...(options.minChars !== undefined && { minChars: options.minChars }),
    }
    compactors = {
      tree: openCompactor({
        ...shared,
        chat(chatId) {
          const messages = messagesOf(host, chatId)
          return messages && { messages, summaries: treeOf(host, chatId) }
        },
      }),
      rolling: openRollingCompactor({
        ...shared,
        chat(chatId) {
          const messages = messagesOf(host, chatId)
          return messages && { messages, storage: host.chatStorage(chatId) }
        },
      }),
    }
    // The backlog: every chat, the most recently active last, so it's summarized first.
    const lastAt = (chatId: string) => host.read(chatId, { last: 1 })[0]?.at ?? ''
    const byActivity = host.chats().map((chat) => ({ id: chat.id, at: lastAt(chat.id) }))
    byActivity.sort((a, b) => a.at.localeCompare(b.at))
    for (const { id } of byActivity) touch(id)
  }

  // The messages zoom and date read: the caller's own, or a worker's parent's as they were at its launch.
  const readable = (caller: ChatSummary, host: ModHost, parent?: unknown) => {
    if (parent !== true) return { messages: host.messages(caller.id), summaries: treeOf(host, caller.id) }
    const detail = host.chat(caller.id)
    if (!caller.worker || caller.parentId === undefined) throw new Error("Only a worker can read its parent chat's memory")
    const messages = host.messages(caller.parentId).slice(0, detail?.parentMessages ?? 0)
    return { messages, summaries: treeOf(host, caller.parentId) }
  }
  const integer = (value: unknown, name: string) => {
    if (value === undefined) return undefined
    if (!Number.isInteger(value)) throw new Error(`${name} must be a whole number`)
    return value as number
  }
  const PARENT = { type: 'boolean', description: "A worker's parent chat, as it was at launch" }

  return {
    async whenIdle() {
      await compactors?.tree.whenIdle()
      await compactors?.rolling.whenIdle()
    },
    id: 'memory',
    name: 'Memory',
    description:
      'Every chat remembers its whole conversation: older messages as short summaries an agent can zoom back into. ' +
      'Off, a fresh session sees only the latest messages that fit.',
    enabledByDefault: true,
    settings: [
      {
        key: 'mode',
        label: 'Older messages',
        description:
          'Rolling summary (the default): one summary of everything older than the latest messages, rewritten as ' +
          'they leave; few summary calls. Summary tree: a line per message and per block, finer toward the present, ' +
          'which agents can zoom into; more detail, many more summary calls.',
        type: 'select',
        options: [
          { value: 'rolling', label: 'Rolling summary' },
          { value: 'tree', label: 'Summary tree (zoomable)' },
        ],
        default: 'rolling',
      },
    ],
    tools: [
      {
        name: 'zoom',
        description:
          'Open a line of your memory. zoom(id, n) gives the two lines of n/2 under line id+n; zoom(id, 1) gives ' +
          'message id whole, in pages (offset and limit pick a part).',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            n: { type: 'integer' },
            offset: { type: 'integer' },
            limit: { type: 'integer' },
            parent: PARENT,
          },
          required: ['id'],
        },
        offered: () => true,
        run(input, { caller, host }) {
          const { messages, summaries } = readable(caller, host, input.parent)
          const id = integer(input.id, 'id')!
          return zoom(messages, summaries, id, integer(input.n, 'n'), integer(input.offset, 'offset'), integer(input.limit, 'limit'))
        },
      },
      {
        name: 'date',
        description: 'The date and time of message id in your memory.',
        inputSchema: { type: 'object', properties: { id: { type: 'integer' }, parent: PARENT }, required: ['id'] },
        offered: () => true,
        run(input, { caller, host }) {
          return dateOf(readable(caller, host, input.parent).messages, integer(input.id, 'id')!)
        },
      },
    ],
    memory: {
      view({ chat, messages, tools }, context) {
        const host = remember(context)
        if (modeOf(context.values) === 'rolling') {
          return rollingView(messages, readRolling(host.chatStorage(chat.id), messages), tools)
        }
        return memoryView(messages, treeOf(host, chat.id), { zoom: tools })
      },
      instructions({ chat, tools }, context) {
        remember(context)
        const rolling = modeOf(context.values) === 'rolling'
        return [
          rolling ? ROLLING_INSTRUCTIONS : MEMORY_INSTRUCTIONS,
          ...(tools ? [rolling ? ROLLING_ZOOM_INSTRUCTIONS : ZOOM_INSTRUCTIONS] : []),
          ...(tools && chat.worker ? [PARENT_ZOOM_INSTRUCTIONS] : []),
        ].join('\n\n')
      },
    },
    onStart: start,
    onStop() {
      compactors?.tree.close()
      compactors?.rolling.close()
      compactors = undefined
    },
    onSessionEnded({ chat }, context) {
      remember(context)
      touch(chat.id)
    },
    onChatRemoved(chat) {
      trees.delete(chat.id)
    },
  }
}

export default createMemoryMod()
