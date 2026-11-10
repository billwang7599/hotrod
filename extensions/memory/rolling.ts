import type { CompletionRequest, MemoryMessage, ExtensionStorage } from '@kothar/extension-api'
import {
  clip,
  COMPACT_DEBOUNCE_MS,
  COMPACT_MIN_CHARS,
  COMPLETE_TIMEOUT_MS,
  fullMessage,
  LINE_MAX_CHARS,
  oneLine,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  TAIL_MAX_CHARS,
  VIEW_MAX_CHARS,
} from './tree.ts'

// The rolling summary: one summary of everything older than the latest messages, rewritten as messages leave them.
// Cheaper than the tree (one call per fold instead of one per message and block), but it can't be zoomed back into
// the past beyond each message whole, and what the summary dropped is gone from the view.

export const ROLLING_FILE = 'rolling.json'
// Fold once this much has left the tail since the last fold, so calls come in steps rather than every turn.
export const ROLLING_STEP_CHARS = 20_000
export const ROLLING_SUMMARY_MAX_CHARS = 8_000
// What one fold reads at most: the old summary plus the messages it folds in, each clipped.
export const ROLLING_INPUT_MAX_CHARS = 60_000
export const ROLLING_MESSAGE_MAX_CHARS = 4_000
// Messages between the summary and the tail, shown as one line each until the next fold.
export const GAP_MAX_CHARS = VIEW_MAX_CHARS / 2

export const ROLLING_INSTRUCTIONS =
  'Each message you get starts with your memory of this chat, oldest first: a summary of its older part, then the ' +
  'messages since the summary, one line each, then the latest messages in full. Items are tagged by kind: user ' +
  "(the user's words), work (a report from a worker or a message from another chat), talk (your replies), tool " +
  '(your tool calls), echo (their output) and note (a turn that ended early). The latest word on a thing is the ' +
  'truth. The summary keeps little of tool output, so say in your reply what you learned that will matter later.'

export const ROLLING_ZOOM_INSTRUCTIONS =
  'zoom(id, 1) gives message id whole, and date(id) its date and time. Before you act on something the summary ' +
  'mentions only briefly, find the message and zoom it.'

const FOLD_INSTRUCTIONS = `You keep the memory of a long chat between a user and an AI agent, as one summary. You \
get the summary so far (empty at first) and the messages that come after it, oldest first. Write the new summary of \
everything: the old summary with the new messages folded in.

Message kinds: user (the user's words), work (a report from a worker or a message from another chat), talk (the \
agent's reply), tool (a tool call), echo (a tool's output), note (a turn that ended early).

- Keep the specifics: the user's requests and decisions in their own words, names, ids, hashes, numbers, paths, URLs, \
commands, errors, and what is still open or undecided. Cite message ids as #id where it helps to zoom.
- When a later message settles or reverses an earlier one, keep the outcome. Drop greetings, filler and the steps that \
led to a result.
- At most max_chars characters. Plain text, no preamble.`

export type Rolling = { upTo: number; at: string; text: string }

export function readRolling(storage: Pick<ExtensionStorage, 'read'>, messages: MemoryMessage[]): Rolling | undefined {
  try {
    const saved = JSON.parse(storage.read(ROLLING_FILE) ?? 'null') as Rolling | null
    if (!saved || !Number.isInteger(saved.upTo) || saved.upTo < 1 || typeof saved.text !== 'string') return undefined
    // Like a tree summary, it names its last message's time, so one left over from other numbering is dropped.
    return messages[saved.upTo - 1]?.at === saved.at ? saved : undefined
  } catch {
    return undefined
  }
}

// Where the latest messages in full begin: newest first while they fit TAIL_MAX_CHARS, the newest always.
export function tailStart(messages: MemoryMessage[], zoomable: boolean) {
  let budget = TAIL_MAX_CHARS
  let start = messages.length
  while (start > 0) {
    const chars = fullMessage(messages[start - 1]!, zoomable).length
    if (chars > budget && start < messages.length) break
    budget -= chars
    start--
  }
  return start
}

const lineOf = ({ id, kind, text }: MemoryMessage) => `${id}|${clip(oneLine(`${kind}: ${text}`), LINE_MAX_CHARS)}`

export function rollingView(messages: MemoryMessage[], rolling: Rolling | undefined, zoomable: boolean) {
  if (!messages.length) return ''
  const start = tailStart(messages, zoomable)
  const from = Math.min(rolling?.upTo ?? 0, start)
  const parts: string[] = []
  if (rolling && from > 0) {
    parts.push(`<summary of="0-${rolling.upTo - 1}">\n${rolling.text.replaceAll('</summary', '<\\/summary')}\n</summary>`)
  }
  const gap: string[] = []
  let budget = GAP_MAX_CHARS
  let first = start
  for (let id = start - 1; id >= from; id--) {
    const line = lineOf(messages[id]!)
    if (line.length + 1 > budget) break
    budget -= line.length + 1
    gap.unshift(line)
    first = id
  }
  if (first > from) {
    const zoom = zoomable ? '; zoom them by id' : ''
    parts.push(`(messages ${from} to ${first - 1} are not summarized yet${zoom})`)
  }
  if (gap.length) parts.push(gap.join('\n'))
  parts.push(...messages.slice(start).map((message) => fullMessage(message, zoomable)))
  return parts.join('\n\n')
}

// What to fold next: the messages after the summary up to where the tail starts, once they pass ROLLING_STEP_CHARS
// (and the chat passes COMPACT_MIN_CHARS), as many as one call reads.
export function foldOf(messages: MemoryMessage[], rolling: Rolling | undefined, minChars = COMPACT_MIN_CHARS) {
  const total = messages.reduce((sum, m) => sum + m.text.length, 0)
  const from = rolling?.upTo ?? 0
  const end = tailStart(messages, true)
  if (total <= minChars || end <= from) return undefined
  const waiting = messages.slice(from, end).reduce((sum, m) => sum + m.text.length, 0)
  if (waiting < ROLLING_STEP_CHARS) return undefined
  let chars = rolling?.text.length ?? 0
  const items: string[] = []
  let upTo = from
  for (const { id, kind, text } of messages.slice(from, end)) {
    const item = `<message id="${id}" kind="${kind}">\n${clip(text, ROLLING_MESSAGE_MAX_CHARS)}\n</message>`
    if (items.length && chars + item.length > ROLLING_INPUT_MAX_CHARS) break
    chars += item.length
    items.push(item)
    upTo = id + 1
  }
  const old = rolling ? rolling.text : '(empty)'
  const prompt =
    `<summary max_chars="${ROLLING_SUMMARY_MAX_CHARS}">\n${old}\n</summary>\n\n<messages>\n${items.join('\n')}\n</messages>`
  return { upTo, at: messages[upTo - 1]!.at, prompt }
}

type RollingChat = { messages: MemoryMessage[]; storage: Pick<ExtensionStorage, 'read' | 'write'> }

// Folds chats one call at a time, latest touched first, with backoff on failure, like the tree's compactor.
export function openRollingCompactor(options: {
  chat(chatId: string): RollingChat | undefined
  complete(request: CompletionRequest): Promise<string>
  onFailure?(reason: string): void
  debounceMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  minChars?: number
}) {
  const { debounceMs = COMPACT_DEBOUNCE_MS, retryBaseMs = RETRY_BASE_MS, retryMaxMs = RETRY_MAX_MS } = options
  const touched = new Set<string>()
  const backoffs = new Map<string, { failures: number; retryAtMs: number }>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let closed = false
  let failing = false
  const idleWaiters: (() => void)[] = []
  const settleIdle = () => {
    if (closed || (!running && timer === undefined && !touched.size)) idleWaiters.splice(0).forEach((done) => done())
  }
  const schedule = (delayMs: number) => {
    if (closed) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void run()
    }, delayMs)
  }

  const nextJob = () => {
    for (const chatId of [...touched].reverse()) {
      if ((backoffs.get(chatId)?.retryAtMs ?? 0) > Date.now()) continue
      const chat = options.chat(chatId)
      const fold = chat && foldOf(chat.messages, readRolling(chat.storage, chat.messages), options.minChars)
      if (chat && fold) return { chatId, chat, fold }
      touched.delete(chatId)
    }
  }

  async function run() {
    if (running || closed) return
    running = true
    try {
      for (let job = nextJob(); job && !closed; job = nextJob()) {
        const { chatId, chat, fold } = job
        let reason = ''
        let text = ''
        try {
          const reply = await options.complete({ system: FOLD_INSTRUCTIONS, prompt: fold.prompt, timeoutMs: COMPLETE_TIMEOUT_MS })
          text = reply.trim()
          if (!text) reason = 'the reply was empty'
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error)
        }
        if (closed) return
        if (text) {
          const rolling: Rolling = { upTo: fold.upTo, at: fold.at, text: clip(text, ROLLING_SUMMARY_MAX_CHARS) }
          try {
            chat.storage.write(ROLLING_FILE, JSON.stringify(rolling) + '\n')
          } catch {
            touched.delete(chatId)
            continue
          }
          backoffs.delete(chatId)
          failing = false
          continue
        }
        const failures = (backoffs.get(chatId)?.failures ?? 0) + 1
        backoffs.set(chatId, { failures, retryAtMs: Date.now() + Math.min(retryMaxMs, retryBaseMs * 2 ** (failures - 1)) })
        if (!failing) options.onFailure?.(reason)
        failing = true
      }
    } finally {
      running = false
    }
    const retryAtMs = Math.min(...[...touched].map((chatId) => backoffs.get(chatId)?.retryAtMs ?? Infinity))
    if (retryAtMs < Infinity) schedule(retryAtMs - Date.now())
    settleIdle()
  }

  return {
    touch(chatId: string) {
      touched.delete(chatId)
      touched.add(chatId)
      schedule(debounceMs)
    },
    whenIdle() {
      const done = new Promise<void>((resolve) => idleWaiters.push(resolve))
      settleIdle()
      return done
    },
    close() {
      closed = true
      clearTimeout(timer)
      settleIdle()
    },
  }
}
