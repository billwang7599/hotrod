import type { ChatSummary, MemoryMessage, Extension, ExtensionContext, ExtensionHost, ExtensionValues } from '@kothar/extension-api'
import { FOLD_INSTRUCTIONS, openRollingCompactor, readRolling, ROLLING_INSTRUCTIONS, ROLLING_ZOOM_INSTRUCTIONS, rollingView } from './rolling.ts'
import { deleteSummaries, storageView } from './storage.ts'
import {
  COMPACTOR_INSTRUCTIONS,
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

// One of this extension's prompts as the user left it in Settings (host.prompt), else its default, as with a host
// that has no prompts (a test's).
const promptOf = (host: { prompt?: (id: string) => string } | undefined, id: string, fallback: string) =>
  typeof host?.prompt === 'function' ? host.prompt(id) : fallback

// Its prompts (Settings → Extensions → Memory → Prompts).
export const PROMPTS = [
  { id: 'rolling', label: 'How to read the memory (Rolling summary)', text: ROLLING_INSTRUCTIONS, where: 'instructions' },
  { id: 'rolling-zoom', label: 'How to zoom (Rolling summary)', text: ROLLING_ZOOM_INSTRUCTIONS, where: 'instructions' },
  { id: 'tree', label: 'How to read the memory (Summary tree)', text: MEMORY_INSTRUCTIONS, where: 'instructions' },
  { id: 'tree-zoom', label: 'How to zoom (Summary tree)', text: ZOOM_INSTRUCTIONS, where: 'instructions' },
  { id: 'parent-zoom', label: 'Reading the lead’s memory (workers)', text: PARENT_ZOOM_INSTRUCTIONS, where: 'instructions' },
  {
    id: 'summarizer-rolling',
    label: 'The summarizer’s instructions (Rolling summary)',
    text: FOLD_INSTRUCTIONS,
    where: 'background',
    description: 'Sent to the model that folds new messages into the summary, outside the chat’s turn.',
  },
  {
    id: 'summarizer-tree',
    label: 'The summarizer’s instructions (Summary tree)',
    text: COMPACTOR_INSTRUCTIONS,
    where: 'background',
    description: 'Sent to the model that writes the summary lines, outside the chat’s turn.',
  },
] as const satisfies Extension['prompts']
const defaultOf = (id: (typeof PROMPTS)[number]['id']) => PROMPTS.find((prompt) => prompt.id === id)!.text

const modeOf = (values: ExtensionValues): MemoryMode => (values.mode === 'tree' ? 'tree' : 'rolling')

// Options for tests and the bench; Kothar loads the default export.
export type MemoryExtensionOptions = { debounceMs?: number; retryBaseMs?: number; minChars?: number }

// whenIdle: resolves once the summaries every touched chat needs are written (tests and the bench).
export function createMemoryExtension(options: MemoryExtensionOptions = {}): Extension & { whenIdle(): Promise<void> } {
  // Summaries read once per chat and kept, as the core kept them; a removed chat's go with it.
  const trees = new Map<string, Summaries>()
  let host: ExtensionHost | undefined
  let values: ExtensionValues = {}
  let compactors: { tree: ReturnType<typeof openCompactor>; rolling: ReturnType<typeof openRollingCompactor> } | undefined
  // Whether the extension runs now (between onStart and onStop): its mode's files are in use.
  let running = false

  const remember = (context: ExtensionContext) => {
    host = context.host
    values = context.values
    return context.host
  }
  const treeOf = (host: ExtensionHost, chatId: string) => {
    let summaries = trees.get(chatId)
    if (!summaries) {
      summaries = openSummaries(summaryFileOf(host.chatStorage(chatId)))
      trees.set(chatId, summaries)
    }
    return summaries
  }
  const messagesOf = (host: ExtensionHost, chatId: string): MemoryMessage[] | undefined => {
    try {
      return host.messages(chatId)
    } catch {
      return undefined
    }
  }
  const touch = (chatId: string) => compactors?.[modeOf(values)].touch(chatId)

  const failing = (reason: string) => host?.error(`summaries are failing: ${reason}. Retrying.`)
  const compactorFor = <M extends MemoryMode>(host: ExtensionHost, mode: M): NonNullable<typeof compactors>[M] => {
    const shared = {
      complete: (request: Parameters<ExtensionHost['complete']>[0]) => host.complete(request),
      system: () => (mode === 'tree' ? promptOf(host, 'summarizer-tree', COMPACTOR_INSTRUCTIONS) : promptOf(host, 'summarizer-rolling', FOLD_INSTRUCTIONS)),
      onFailure: failing,
      now: () => host.now().getTime(),
      ...(options.debounceMs !== undefined && { debounceMs: options.debounceMs }),
      ...(options.retryBaseMs !== undefined && { retryBaseMs: options.retryBaseMs }),
      ...(options.minChars !== undefined && { minChars: options.minChars }),
    }
    if (mode === 'tree') {
      return openCompactor({
        ...shared,
        chat(chatId) {
          const messages = messagesOf(host, chatId)
          return messages && { messages, summaries: treeOf(host, chatId) }
        },
      }) as NonNullable<typeof compactors>[M]
    }
    return openRollingCompactor({
      ...shared,
      chat(chatId) {
        const messages = messagesOf(host, chatId)
        return messages && { messages, storage: host.chatStorage(chatId) }
      },
    }) as NonNullable<typeof compactors>[M]
  }
  // A fresh compactor for the mode, so nothing it had queued is written.
  const reopen = (host: ExtensionHost, mode: MemoryMode) => {
    if (!compactors) return
    compactors[mode].close()
    if (mode === 'tree') compactors.tree = compactorFor(host, 'tree')
    else compactors.rolling = compactorFor(host, 'rolling')
  }
  // The backlog: every chat, the most recently active last, so it's summarized first.
  const catchUp = (host: ExtensionHost) => {
    const lastAt = (chatId: string) => host.read(chatId, { last: 1 })[0]?.at ?? ''
    const byActivity = host.chats().map((chat) => ({ id: chat.id, at: lastAt(chat.id) }))
    byActivity.sort((a, b) => a.at.localeCompare(b.at))
    for (const { id } of byActivity) touch(id)
  }
  const start = (context: ExtensionContext) => {
    const host = remember(context)
    running = true
    if (compactors) return
    compactors = { tree: compactorFor(host, 'tree'), rolling: compactorFor(host, 'rolling') }
    catchUp(host)
  }
  // Deletes one mode's files from every chat folder, unless the mode is in use, and forgets what was read of them.
  const deleteMode = (host: ExtensionHost, mode: MemoryMode) => {
    if (running && modeOf(values) === mode) throw new Error("Memory uses these summaries now, so they can't be deleted")
    reopen(host, mode)
    if (mode === 'tree') trees.clear()
    return deleteSummaries(host, mode)
  }

  // The messages zoom and date read: the caller's own, or a worker's parent's as they were at its launch.
  const readable = (caller: ChatSummary, host: ExtensionHost, parent?: unknown) => {
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
    prompts: [...PROMPTS],
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
        const text = (id: (typeof PROMPTS)[number]['id']) => promptOf(context.host, id, defaultOf(id))
        return [
          text(rolling ? 'rolling' : 'tree'),
          ...(tools ? [text(rolling ? 'rolling-zoom' : 'tree-zoom')] : []),
          ...(tools && chat.worker ? [text('parent-zoom')] : []),
        ].join('\n\n')
      },
    },
    settingsView: {
      render(context) {
        remember(context)
        return storageView(context.host, running ? modeOf(context.values) : undefined)
      },
      onAction(action, context) {
        const host = remember(context)
        if (action.name !== 'delete' || (action.value !== 'tree' && action.value !== 'rolling')) return
        deleteMode(host, action.value)
      },
    },
    onStart: start,
    // A new mode, or Memory on again (onStart), catches up every chat's backlog at once, not at each one's next turn.
    // The old mode's queue is dropped: its summaries aren't used now.
    onSettingsChanged({ key, previous }, context) {
      const host = remember(context)
      if (key !== 'mode' || !compactors) return
      reopen(host, previous === 'tree' ? 'tree' : 'rolling')
      catchUp(host)
    },
    onStop() {
      running = false
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

export default createMemoryExtension()
