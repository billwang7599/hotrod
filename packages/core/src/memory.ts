import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import type { Attachment, ChatEntry, CompletionRequest } from './types.ts'

export const LINE_MAX_CHARS = 280
export const LINE_CHARS_PER_LEVEL = 40
export const SUMMARY_CLIP_FACTOR = 2
const PREVIOUS_PREVIEW_CHARS = 150
export const MESSAGE_MAX_CHARS = 4_000
export const TAIL_MAX_CHARS = 40_000
export const COMPACT_MIN_CHARS = TAIL_MAX_CHARS / 2
export const VIEW_MAX_CHARS = 48_000
export const LINES_PER_LEVEL = [16, 12, 8, 4]
export const ZOOM_PAGE_CHARS = 25_000
export const LEAF_INPUT_MAX_CHARS = 12_000
export const BATCH_MAX_ITEMS = 24
export const BATCH_MAX_INPUT_CHARS = 60_000
export const ITEM_MAX_ATTEMPTS = 3
export const COMPACT_DEBOUNCE_MS = 2_000
export const RETRY_BASE_MS = 10_000
export const RETRY_MAX_MS = 600_000
export const COMPLETE_TIMEOUT_MS = 180_000

export const MEMORY_INSTRUCTIONS =
  'Each message you get starts with your memory of this chat: the whole conversation, oldest first. Older ' +
  'messages appear as one-line summaries, id+n|text, each covering the n messages from id on. Recent lines ' +
  'cover one message each; the older the messages, the more a line covers. The latest messages follow in full. ' +
  'Items are tagged by kind: user (the user\'s words), work (a report from a subagent or a message from another ' +
  'chat), talk (your replies), tool (your tool calls), echo (their output) and note (a turn that ended early). ' +
  "The memory's latest word on a thing is the truth. Summaries keep little of tool output, so say in your reply " +
  'what you learned that will matter later.'

export const ZOOM_INSTRUCTIONS =
  'zoom(id, n) opens line id+n into the two lines of n/2 under it, and zoom(id, 1) gives message id whole, in ' +
  `pages of ${ZOOM_PAGE_CHARS.toLocaleString('en-US')} characters past that (offset and limit pick a part). You ` +
  'can zoom out too: zoom(id, n) opens any block with n a power of 2 and id a multiple of n. date(id) gives the ' +
  'date and time of message id. Before you act, guess or ask about something, find its latest mention and zoom ' +
  'until you have it whole.'

const COMPACTOR_INSTRUCTIONS = `You write the memory of a long chat between a user and an AI agent. Each <item> is \
either one message to summarize, or two adjacent summaries (key|text lines, oldest first) to merge into one. Write \
one summary per item, as a single line of plain text.

Message kinds: user (the user's words), work (a report from a subagent or a message from another chat), talk (the \
agent's reply), tool (a tool call), echo (a tool's output), note (a turn that ended early).

- Tag what you keep by kind, in order: "user: … talk: … tool: … echo: …".
- Keep the specifics: the user's requests and decisions in their own words, names, ids, hashes, numbers, paths, \
URLs, commands, errors, and what is still open or undecided.
- max_chars is a hard limit. A merge must fit in about the length of one half, so compress both: keep decisions, \
outcomes, findings and open questions, and drop the steps that led to them. Never copy the halves or their keys.
- Drop greetings, filler and repetition. When a later part settles or reverses an earlier one, keep the outcome.
- A message may open with "(previous: …)", the message before it. That is context only; don't summarize it.
- No newlines, no preamble.

Reply with JSON only: {"summaries":[{"key":"<the item's key>","text":"<summary>"}]}, one entry per item.`

const SUMMARIES_SCHEMA = {
  type: 'object',
  properties: {
    summaries: {
      type: 'array',
      items: {
        type: 'object',
        properties: { key: { type: 'string' }, text: { type: 'string' } },
        required: ['key', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['summaries'],
  additionalProperties: false,
}

export type MessageKind = 'user' | 'work' | 'talk' | 'tool' | 'echo' | 'note'
export type MemoryMessage = { id: number; kind: MessageKind; at: string; text: string }
export type Summary = { id: number; n: number; text: string; at: string }
export type Summaries = ReturnType<typeof openSummaries>
type Block = { id: number; n: number }
type LineOf = (id: number, n: number) => string | undefined

export function withAttachments(text: string, attachments: Attachment[] = []) {
  if (!attachments.length) return text
  const list = ['Attached files:', ...attachments.map((a) => `- ${a.path} (${a.mimeType})`)].join('\n')
  return text ? `${text}\n\n${list}` : list
}

export function messagesOf(entries: ChatEntry[]): MemoryMessage[] {
  const messages: MemoryMessage[] = []
  const add = (kind: MessageKind, at: string, text: string) => messages.push({ id: messages.length, kind, at, text })
  for (const entry of entries) {
    if (entry.type === 'user.message') {
      const kind = entry.text.startsWith('[subagent "') ? 'work' : 'user'
      add(kind, entry.at, withAttachments(entry.text, entry.attachments))
    }
    if (entry.type === 'text.completed') add('talk', entry.at, entry.text)
    if (entry.type === 'tool.started') add('tool', entry.at, `${entry.name} ${JSON.stringify(entry.input) ?? ''}`.trim())
    if (entry.type === 'tool.completed') add('echo', entry.at, entry.isError ? `(error) ${entry.output}` : entry.output)
    if ((entry.type === 'turn.completed' || entry.type === 'session.ended') && entry.error) {
      add('note', entry.at, `Turn ended early: ${entry.error}`)
    }
  }
  return messages
}

const keyOf = (id: number, n: number) => `${id}+${n}`

export function openSummaries(file: string) {
  const records = new Map<string, Summary>()
  for (const line of (existsSync(file) ? readFileSync(file, 'utf8') : '').split('\n')) {
    try {
      const { id, n, text, at } = JSON.parse(line)
      if (typeof text === 'string' && text && typeof at === 'string') records.set(keyOf(id, n), { id, n, text, at })
    } catch {}
  }
  return {
    get: (id: number, n: number) => records.get(keyOf(id, n)),
    add(summaries: Summary[]) {
      if (!summaries.length) return
      appendFileSync(file, summaries.map((summary) => JSON.stringify(summary) + '\n').join(''))
      for (const summary of summaries) records.set(keyOf(summary.id, summary.n), summary)
    },
  }
}

export const lineMaxChars = (n: number) => LINE_MAX_CHARS + LINE_CHARS_PER_LEVEL * Math.log2(n)

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()
const clip = (text: string, maxChars: number) =>
  text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text
const lowBit = (b: number) => b & -b
const floorPow2 = (x: number) => 2 ** (31 - Math.clz32(x))
const escapeTag = (text: string, tag: string) => text.replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1')

function lineReader(messages: MemoryMessage[], summaries: Summaries): LineOf {
  const memo = new Map<string, string | undefined>()
  const lineOf: LineOf = (id, n) => {
    if (id + n > messages.length) return undefined
    const key = keyOf(id, n)
    if (memo.has(key)) return memo.get(key)
    // A summary names its last message's time, so one left over from other numbering is ignored and redone.
    const stored = summaries.get(id, n)
    let line = stored?.at === messages[id + n - 1]!.at ? stored.text : undefined
    if (line === undefined && n === 1) {
      const { kind, text } = messages[id]!
      const verbatim = oneLine(`${kind}: ${text}`)
      if (verbatim.length <= LINE_MAX_CHARS) line = verbatim
    }
    if (line === undefined && n > 1) {
      const left = lineOf(id, n / 2)
      const right = lineOf(id + n / 2, n / 2)
      if (left !== undefined && right !== undefined && left.length + 1 + right.length <= lineMaxChars(n)) {
        line = `${left} ${right}`
      }
    }
    memo.set(key, line)
    return line
  }
  return lineOf
}

function blockLines(messages: MemoryMessage[], lineOf: LineOf, { id, n }: Block, zoomable: boolean): string[] {
  const line = lineOf(id, n)
  if (line !== undefined) return [`${id}+${n}|${line}`]
  const half = n / 2
  const left = n > 1 ? lineOf(id, half) : undefined
  const right = n > 1 ? lineOf(id + half, half) : undefined
  if (left !== undefined && right !== undefined) return [`${id}+${half}|${left}`, `${id + half}+${half}|${right}`]
  const missing = zoomable ? ' (not summarized yet: zoom it)' : ''
  return [`${id}+${n}|${fallbackLine(messages, lineOf, { id, n })}${missing}`]
}

function fallbackLine(messages: MemoryMessage[], lineOf: LineOf, { id, n }: Block): string {
  if (n === 1) return clip(oneLine(`${messages[id]!.kind}: ${messages[id]!.text}`), lineMaxChars(1))
  const halfChars = Math.floor((lineMaxChars(n) - 1) / 2)
  const half = (start: number) =>
    clip(lineOf(start, n / 2) ?? fallbackLine(messages, lineOf, { id: start, n: n / 2 }), halfChars)
  return `${half(id)} ${half(id + n / 2)}`
}

function coverOf(ranges: [number, number][], perLevel: number): Block[] {
  const blocks: Block[] = []
  let level = 0
  let count = 0
  for (const [start, end] of ranges) {
    for (let b = end; b > start; ) {
      const n = Math.min(2 ** level, lowBit(b), floorPow2(b - start))
      blocks.push({ id: b - n, n })
      b -= n
      if (n === 2 ** level) count++
      if (count >= perLevel && b % 2 ** (level + 1) === 0) {
        level++
        count = 0
      }
    }
  }
  return blocks
}

function fullMessage({ id, kind, text }: MemoryMessage, zoomable: boolean) {
  const rest = zoomable ? `; zoom(${id}) for the rest` : ''
  const body =
    zoomable && text.length > MESSAGE_MAX_CHARS
      ? `${text.slice(0, MESSAGE_MAX_CHARS)}… cut at ${MESSAGE_MAX_CHARS} of ${text.length} chars${rest}`
      : text
  return `<message id="${id}" kind="${kind}">\n${escapeTag(body, 'message')}\n</message>`
}

export function memoryPrompt(
  messages: MemoryMessage[],
  summaries: Summaries,
  message: string,
  { zoom: zoomable }: { zoom: boolean },
) {
  if (!messages.length) return message
  const asked = messages.findLastIndex((m) => m.kind === 'user' || m.kind === 'work')
  const lastTalk = messages.findLastIndex((m) => m.kind === 'talk')
  const full = new Map<number, string>()
  for (const id of new Set([asked, lastTalk > asked ? lastTalk : -1])) {
    if (id >= 0) full.set(id, fullMessage(messages[id]!, zoomable))
  }
  let budget = TAIL_MAX_CHARS - [...full.values()].reduce((sum, text) => sum + text.length, 0)
  for (let id = messages.length - 1; id >= 0; id--) {
    if (full.has(id)) continue
    const text = fullMessage(messages[id]!, zoomable)
    if (text.length > budget) break
    budget -= text.length
    full.set(id, text)
  }

  const ranges: [number, number][] = []
  for (let id = messages.length - 1, end = messages.length; id >= -1; id--) {
    if (id >= 0 && !full.has(id)) continue
    if (end > id + 1) ranges.push([id + 1, end])
    end = id
  }
  const lineOf = lineReader(messages, summaries)
  let lines: { id: number; text: string }[] = []
  for (const perLevel of LINES_PER_LEVEL) {
    lines = coverOf(ranges, perLevel).reverse().flatMap((block) =>
      blockLines(messages, lineOf, block, zoomable).map((text) => ({ id: block.id, text })),
    )
    if (lines.reduce((sum, line) => sum + line.text.length + 1, 0) <= VIEW_MAX_CHARS) break
  }

  const items = [...lines, ...[...full].map(([id, text]) => ({ id, text, full: true }))]
  items.sort((a, b) => a.id - b.id)
  const body = items.map((item, i) => (i > 0 && ('full' in item || 'full' in items[i - 1]!) ? '\n\n' : '\n') + item.text)
  return `This is the conversation so far:\n${body.join('')}\n\nNew message from the user:\n\n${message}`
}

const checkId = (messages: MemoryMessage[], id: number) => {
  if (!Number.isInteger(id) || id < 0 || id >= messages.length) {
    const has = messages.length ? `messages 0 to ${messages.length - 1}` : 'no messages yet'
    throw new Error(`No message ${id}; this chat has ${has}`)
  }
  return messages[id]!
}

export function zoom(
  messages: MemoryMessage[],
  summaries: Summaries,
  id: number,
  n = 1,
  offset = 0,
  limit = ZOOM_PAGE_CHARS,
) {
  const message = checkId(messages, id)
  if (!Number.isInteger(n) || n < 1 || (n & (n - 1)) !== 0) throw new Error(`zoom(${id}, ${n}): n must be a power of 2`)
  if (id % n !== 0) throw new Error(`zoom(${id}, ${n}): id must be a multiple of n`)
  if (n === 1) {
    const { kind, at, text } = message
    if (!Number.isInteger(offset) || offset < 0 || (offset > 0 && offset >= text.length)) {
      throw new Error(`zoom(${id}, 1): offset must be from 0 to ${Math.max(0, text.length - 1)}`)
    }
    const end = Math.min(text.length, offset + Math.min(Math.max(1, Math.floor(limit)), ZOOM_PAGE_CHARS))
    const paged = offset > 0 || end < text.length ? `, chars ${offset}–${end} of ${text.length}` : ''
    const more = end < text.length ? `\n\n(more: zoom(${id}, 1, offset=${end}))` : ''
    return `${id}|${kind}, ${at}${paged}\n\n${text.slice(offset, end)}${more}`
  }
  const lineOf = lineReader(messages, summaries)
  const half = n / 2
  const blocks: Block[] = []
  for (const start of [id, id + half]) {
    const end = Math.min(start + half, messages.length)
    for (let b = start; b < end; b += blocks.at(-1)!.n) {
      blocks.push({ id: b, n: Math.min(b === 0 ? Infinity : lowBit(b), floorPow2(end - b)) })
    }
  }
  return blocks.flatMap((block) => blockLines(messages, lineOf, block, true)).join('\n')
}

export const dateOf = (messages: MemoryMessage[], id: number) => checkId(messages, id).at

export function pendingOf(messages: MemoryMessage[], summaries: Summaries): Block[] {
  const lineOf = lineReader(messages, summaries)
  const pending: Block[] = []
  for (let n = 1; n <= messages.length; n *= 2) {
    for (let id = 0; id + n <= messages.length; id += n) {
      if (lineOf(id, n) !== undefined) continue
      if (n === 1 || (lineOf(id, n / 2) !== undefined && lineOf(id + n / 2, n / 2) !== undefined)) {
        pending.push({ id, n })
      }
    }
  }
  return pending.sort((a, b) => b.id + b.n - (a.id + a.n) || a.n - b.n)
}

function itemInput(messages: MemoryMessage[], lineOf: LineOf, { id, n }: Block) {
  const key = keyOf(id, n)
  if (n > 1) {
    const half = n / 2
    const halves = `${id}+${half}|${lineOf(id, half)}\n${id + half}+${half}|${lineOf(id + half, half)}`
    return `<item key="${key}" max_chars="${lineMaxChars(n)}">\n${halves}\n</item>`
  }
  const { kind, text } = messages[id]!
  const headChars = Math.floor((LEAF_INPUT_MAX_CHARS * 2) / 3)
  const body =
    text.length > LEAF_INPUT_MAX_CHARS
      ? `${text.slice(0, headChars)}\n… [${text.length - LEAF_INPUT_MAX_CHARS} chars cut] …\n` +
        text.slice(text.length - (LEAF_INPUT_MAX_CHARS - headChars))
      : text
  const previous = messages[id - 1]
  const context = previous
    ? `(previous: ${previous.kind}: ${oneLine(previous.text).slice(0, PREVIOUS_PREVIEW_CHARS)})\n`
    : ''
  return `<item key="${key}" kind="${kind}" max_chars="${lineMaxChars(1)}">\n${context}${escapeTag(body, 'item')}\n</item>`
}

function parseReply(reply: string) {
  const start = reply.indexOf('{')
  try {
    const { summaries } = JSON.parse(reply.slice(start, reply.lastIndexOf('}') + 1))
    if (start < 0 || !Array.isArray(summaries)) return undefined
    const lines = new Map<string, string>()
    for (const { key, text } of summaries) {
      const line = typeof text === 'string' ? oneLine(text.replace(/\b\d+\+\d+\|/g, '')) : ''
      if (typeof key === 'string' && line) lines.set(key, line)
    }
    return lines
  } catch {
    return undefined
  }
}

type CompactorChat = { messages: MemoryMessage[]; summaries: Summaries }

export function openCompactor(options: {
  chat(chatId: string): CompactorChat | undefined
  complete(request: CompletionRequest): Promise<string>
  onFailure?(reason: string): void
  debounceMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  minChars?: number
}) {
  const {
    debounceMs = COMPACT_DEBOUNCE_MS,
    retryBaseMs = RETRY_BASE_MS,
    retryMaxMs = RETRY_MAX_MS,
    minChars = COMPACT_MIN_CHARS,
  } = options
  const touched = new Set<string>()
  const backoffs = new Map<string, { failures: number; batchMaxItems: number; retryAtMs: number }>()
  // mark: how many calls had succeeded at the item's first failed try, then at its last try alone.
  const items = new Map<string, { tries: number; mark: number; alone: boolean }>()
  let successes = 0
  let failing = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let closed = false

  const schedule = (delayMs: number) => {
    if (closed) return
    clearTimeout(timer)
    timer = setTimeout(run, delayMs)
  }

  const nextJob = () => {
    for (const chatId of [...touched].reverse()) {
      if ((backoffs.get(chatId)?.retryAtMs ?? 0) > Date.now()) continue
      const chat = options.chat(chatId)
      const chars = chat?.messages.reduce((sum, m) => sum + m.text.length, 0) ?? 0
      const pending = chat && chars > minChars ? pendingOf(chat.messages, chat.summaries) : []
      const failedAlone = (block: Block) => items.get(`${chatId}:${keyOf(block.id, block.n)}`)?.alone === true
      if (chat && pending.length) {
        return { chatId, ...chat, pending: [...pending.filter((b) => !failedAlone(b)), ...pending.filter(failedAlone)] }
      }
      touched.delete(chatId)
    }
  }

  const fail = (chatId: string, batchItems: number, reason: string) => {
    const failures = (backoffs.get(chatId)?.failures ?? 0) + 1
    const retryAtMs = Date.now() + Math.min(retryMaxMs, retryBaseMs * 2 ** (failures - 1))
    backoffs.set(chatId, { failures, batchMaxItems: Math.max(1, Math.floor(batchItems / 2)), retryAtMs })
    if (!failing) options.onFailure?.(reason)
    failing = true
  }

  async function run() {
    if (running || closed) return
    running = true
    try {
      for (let job = nextJob(); job && !closed; job = nextJob()) {
        const { chatId, messages, summaries, pending } = job
        const lineOf = lineReader(messages, summaries)
        const batch: (Block & { input: string })[] = []
        let promptChars = 0
        for (const block of pending.slice(0, backoffs.get(chatId)?.batchMaxItems ?? BATCH_MAX_ITEMS)) {
          const input = itemInput(messages, lineOf, block)
          if (batch.length && promptChars + 2 + input.length > BATCH_MAX_INPUT_CHARS) break
          promptChars += (batch.length ? 2 : 0) + input.length
          batch.push({ ...block, input })
        }
        let lines: Map<string, string> | undefined
        let reason = ''
        try {
          const prompt = batch.map((item) => item.input).join('\n\n')
          const reply = await options.complete({
            system: COMPACTOR_INSTRUCTIONS,
            prompt,
            schema: SUMMARIES_SCHEMA,
            timeoutMs: COMPLETE_TIMEOUT_MS,
          })
          lines = parseReply(reply)
          if (!lines) reason = `the reply wasn't JSON (${clip(oneLine(reply), 200) || 'empty'})`
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error)
        }
        if (closed) return
        if (lines) successes++
        const written: Summary[] = []
        for (const { id, n } of batch) {
          const itemKey = `${chatId}:${keyOf(id, n)}`
          const at = messages[id + n - 1]!.at
          const line = lines?.get(keyOf(id, n))
          if (line !== undefined) {
            items.delete(itemKey)
            const kind = n === 1 ? messages[id]!.kind : undefined
            const tagged = kind && !line.startsWith(`${kind}:`) ? `${kind}: ${line}` : line
            written.push({ id, n, text: clip(tagged, lineMaxChars(n) * SUMMARY_CLIP_FACTOR), at })
            continue
          }
          // A failed call counts against one item only when it was sent alone and the engine has worked since its
          // last try, so an outage never turns items into fallbacks.
          const item = items.get(itemKey)
          const alone = lines === undefined && batch.length === 1
          const counts = lines !== undefined || (alone && item !== undefined && successes > item.mark)
          const tries = (item?.tries ?? 0) + (counts ? 1 : 0)
          if (tries < ITEM_MAX_ATTEMPTS) {
            const mark = alone || !item ? successes : item.mark
            items.set(itemKey, { tries, mark, alone: alone || item?.alone === true })
            continue
          }
          items.delete(itemKey)
          written.push({ id, n, text: fallbackLine(messages, lineOf, { id, n }), at })
        }
        try {
          summaries.add(written)
        } catch {
          touched.delete(chatId)
          continue
        }
        if (lines && written.length) {
          backoffs.delete(chatId)
          failing = false
        } else {
          fail(chatId, batch.length, reason || 'the model left every item out')
        }
      }
    } finally {
      running = false
    }
    const retryAtMs = Math.min(...[...touched].map((chatId) => backoffs.get(chatId)?.retryAtMs ?? Infinity))
    if (retryAtMs < Infinity) schedule(retryAtMs - Date.now())
  }

  return {
    touch(chatId: string) {
      touched.delete(chatId)
      touched.add(chatId)
      schedule(debounceMs)
    },
    close() {
      closed = true
      clearTimeout(timer)
    },
  }
}
