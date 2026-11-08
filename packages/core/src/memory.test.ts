import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BATCH_MAX_INPUT_CHARS,
  BATCH_MAX_ITEMS,
  COMPACT_MIN_CHARS,
  ITEM_MAX_ATTEMPTS,
  LINE_MAX_CHARS,
  LINES_PER_LEVEL,
  MEMORY_INSTRUCTIONS,
  MESSAGE_MAX_CHARS,
  SUMMARY_CLIP_FACTOR,
  TAIL_MAX_CHARS,
  VIEW_MAX_CHARS,
  ZOOM_INSTRUCTIONS,
  ZOOM_PAGE_CHARS,
  dateOf,
  lineMaxChars,
  memoryPrompt,
  messagesOf,
  openCompactor,
  openSummaries,
  pendingOf,
  zoom,
  type MemoryMessage,
  type MessageKind,
  type Summaries,
} from './memory.ts'
import type { ChatEntry, CompletionRequest } from './shared.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hotrod-memory-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

let stores = 0
const store = () => openSummaries(join(dir, `summaries-${stores++}.jsonl`))

const longText = (count: number) => chat(count, (id) => `message ${id} `.padEnd(LINE_MAX_CHARS + 10, '.'))
const at = (id: number) => new Date(Date.UTC(2026, 10, 6) + id * 60_000).toISOString()
const KINDS: MessageKind[] = ['user', 'talk', 'tool', 'echo', 'talk']
const chat = (count: number, textOf = (id: number) => `message ${id}`): MemoryMessage[] =>
  Array.from({ length: count }, (_, id) => ({ id, kind: KINDS[id % KINDS.length]!, at: at(id), text: textOf(id) }))

const blocks = (count: number) => {
  const all: { id: number; n: number }[] = []
  for (let n = 1; n <= count; n *= 2) for (let id = 0; id + n <= count; id += n) all.push({ id, n })
  return all
}

const summarizeAll = (
  messages: MemoryMessage[],
  summaries: Summaries,
  textOf = (id: number, n: number) => `talk: block ${id}+${n}`,
  skip = (_id: number, _n: number) => false,
) =>
  put(
    messages,
    summaries,
    blocks(messages.length).flatMap(({ id, n }) => (skip(id, n) ? [] : [{ id, n, text: textOf(id, n) }])),
  )

const put = (messages: MemoryMessage[], summaries: Summaries, list: { id: number; n: number; text: string }[]) =>
  summaries.add(list.map((summary) => ({ ...summary, at: messages[summary.id + summary.n - 1]!.at })))

// Long enough that two of them never fit in their parent's line, so every block needs its own summary.
const wide = (label: string, n: number) => `${label} `.padEnd(Math.ceil(lineMaxChars(n) * 0.6), '.')
const wideText = (id: number, n: number) => wide(`talk: block ${id}+${n}`, n)

const linesOf = (prompt: string) =>
  [...prompt.matchAll(/^(\d+)\+(\d+)\|(.*)$/gm)].map(([, id, n, text]) => ({ id: Number(id), n: Number(n), text: text! }))
const fullOf = (prompt: string) => [...prompt.matchAll(/^<message id="(\d+)"/gm)].map(([, id]) => Number(id))
const tailChars = (prompt: string) =>
  [...prompt.matchAll(/^<message id="\d+"[\s\S]*?\n<\/message>$/gm)].reduce((sum, [block]) => sum + block.length, 0)
const range = (start: number, count: number) => Array.from({ length: count }, (_, i) => start + i)
const covered = (prompt: string) =>
  [...linesOf(prompt).flatMap(({ id, n }) => range(id, n)), ...fullOf(prompt)].sort((a, b) => a - b)
const isPowerOf2 = (n: number) => n > 0 && (n & (n - 1)) === 0
const countBySize = (lines: { n: number }[]) => {
  const counts = new Map<number, number>()
  for (const { n } of lines) counts.set(n, (counts.get(n) ?? 0) + 1)
  return counts
}

async function until(check: () => boolean, timeoutMs = 5000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

describe('messagesOf', () => {
  it('numbers the counted log entries from 0 in log order', () => {
    const attachment = { name: 'a.png', path: '/g/a.png', mimeType: 'image/png', size: 3 }
    const tool = { toolId: 't1', name: 'Bash', kind: 'shell' as const, summary: 'ls', input: { command: 'ls' } }
    const entries: ChatEntry[] = [
      { at: at(0), type: 'user.message', text: 'list the folder', attachments: [attachment] },
      { at: at(1), type: 'turn.started' },
      { at: at(2), type: 'text.completed', text: 'Looking.' },
      { at: at(3), type: 'tool.started', ...tool },
      { at: at(4), type: 'permission.requested', requestId: 'r1', ...tool },
      { at: at(5), type: 'permission.resolved', requestId: 'r1', allow: true },
      { at: at(6), type: 'tool.completed', toolId: 't1', output: 'README.md', isError: false },
      { at: at(7), type: 'tool.completed', toolId: 't2', output: 'No such file', isError: true },
      { at: at(8), type: 'turn.completed' },
      { at: at(9), type: 'user.message', text: '[subagent "Tests" (ab12cd34)] All green' },
      { at: at(10), type: 'turn.completed', error: 'Interrupted' },
      { at: at(11), type: 'session.ended' },
      { at: at(12), type: 'session.ended', error: 'Claude Code exited with code 1' },
      { at: at(13), type: 'subagent.report', chatId: 'ef56ab78', name: 'Docs', text: 'Found it' },
      { at: at(14), type: 'subagent.report', chatId: 'ef56ab79', name: 'Lint', text: '', error: 'Interrupted' },
    ]
    expect(messagesOf(entries)).toEqual([
      { id: 0, kind: 'user', at: at(0), text: 'list the folder\n\nAttached files:\n- /g/a.png (image/png)' },
      { id: 1, kind: 'talk', at: at(2), text: 'Looking.' },
      { id: 2, kind: 'tool', at: at(3), text: 'Bash {"command":"ls"}' },
      { id: 3, kind: 'echo', at: at(6), text: 'README.md' },
      { id: 4, kind: 'echo', at: at(7), text: '(error) No such file' },
      { id: 5, kind: 'work', at: at(9), text: '[subagent "Tests" (ab12cd34)] All green' },
      { id: 6, kind: 'note', at: at(10), text: 'Turn ended early: Interrupted' },
      { id: 7, kind: 'note', at: at(12), text: 'Turn ended early: Claude Code exited with code 1' },
      { id: 8, kind: 'work', at: at(13), text: 'Report from subagent "Docs" (ef56ab78):\n\nFound it' },
      {
        id: 9,
        kind: 'work',
        at: at(14),
        text: 'Report from subagent "Lint" (ef56ab79):\n\n(No reply)\n\n(The turn ended early: Interrupted)',
      },
    ])
  })
})

describe('openSummaries', () => {
  it('appends JSON lines, lets a later line for the same block win and skips a torn line', () => {
    const file = join(dir, 'summaries.jsonl')
    const summaries = openSummaries(file)
    summaries.add([
      { id: 0, n: 2, text: 'first', at: at(1) },
      { id: 2, n: 1, text: 'leaf', at: at(2) },
    ])
    summaries.add([{ id: 0, n: 2, text: 'second', at: at(1) }])
    expect(summaries.get(0, 2)?.text).toBe('second')
    appendFileSync(file, '{"id":4,"n')

    const reopened = openSummaries(file)
    expect(reopened.get(0, 2)?.text).toBe('second')
    expect(reopened.get(2, 1)?.text).toBe('leaf')
    expect(reopened.get(4, 1)).toBeUndefined()
    const [first] = readFileSync(file, 'utf8').split('\n')
    expect(JSON.parse(first!)).toEqual({ id: 0, n: 2, text: 'first', at: at(1) })
  })

  it("ignores a summary whose last message's time doesn't match, so it is redone", () => {
    const messages = longText(2)
    const summaries = store()
    summaries.add([
      { id: 0, n: 1, text: 'user: right', at: messages[0]!.at },
      { id: 1, n: 1, text: 'talk: moved', at: at(99) },
    ])
    expect(zoom(messages, summaries, 0, 2)).toContain('0+1|user: right')
    expect(pendingOf(messages, summaries)).toEqual([{ id: 1, n: 1 }])
  })
})

describe('lines', () => {
  it('shows a short message word for word and a long one once summarized', () => {
    const short = 'x'.repeat(LINE_MAX_CHARS - 'user: '.length)
    const long = 'y'.repeat(LINE_MAX_CHARS - 'talk: '.length + 1)
    const messages = chat(2, (id) => (id === 0 ? short : long))
    messages[0]!.text = `${short.slice(0, 10)}\n${short.slice(11)}`
    const summaries = store()
    expect(zoom(messages, summaries, 0, 2).split('\n')).toEqual([
      `0+1|user: ${short.slice(0, 10)} ${short.slice(11)}`,
      `1+1|${`talk: ${long}`.slice(0, LINE_MAX_CHARS - 1)}… (not summarized yet: zoom it)`,
    ])
    expect(pendingOf(messages, summaries)).toEqual([{ id: 1, n: 1 }])

    put(messages, summaries, [{ id: 1, n: 1, text: 'talk: a long y' }])
    expect(zoom(messages, summaries, 0, 2)).toContain('1+1|talk: a long y')
    expect(pendingOf(messages, summaries)).toEqual([])
  })

  it('joins two lines that fit in their parent line, and asks for a summary when they do not', () => {
    const messages = chat(4)
    const summaries = store()
    expect(zoom(messages, summaries, 0, 4).split('\n')).toEqual([
      '0+2|user: message 0 talk: message 1',
      '2+2|tool: message 2 echo: message 3',
    ])
    expect(pendingOf(messages, summaries)).toEqual([])

    const wide = chat(2, () => 'w'.repeat(lineMaxChars(2) / 2))
    expect(pendingOf(wide, summaries)).toEqual([{ id: 0, n: 2 }])
  })
})

describe('memoryPrompt', () => {
  it('sends the message alone in a new chat', () => {
    expect(memoryPrompt([], store(), 'hi', { zoom: true })).toBe('hi')
  })

  it("frames subagents' reports as theirs, before any words from the user", () => {
    const report = { text: 'Found it', report: { chatId: 'ef56ab78', name: 'Docs' } }
    const found = 'Report from subagent "Docs" (ef56ab78):\n\nFound it'
    expect(memoryPrompt([], store(), '', { zoom: true }, [report])).toBe(found)
    const prompt = memoryPrompt(chat(2), store(), 'and the FAQ?', { zoom: true }, [report])
    expect(prompt.endsWith(`</message>\n\n${found}\n\nNew message from the user:\n\nand the FAQ?`)).toBe(true)
    expect(memoryPrompt(chat(2), store(), '', { zoom: true }, [report]).endsWith(`</message>\n\n${found}`)).toBe(true)
  })

  it('renders a short chat in full, then the new message', () => {
    const prompt = memoryPrompt(chat(10), store(), 'hi', { zoom: true })
    expect(prompt.startsWith('This is the conversation so far:\n\n<message id="0" kind="user">\nmessage 0\n</message>'))
      .toBe(true)
    expect(fullOf(prompt)).toEqual(range(0, 10))
    expect(linesOf(prompt)).toEqual([])
    expect(prompt).toContain('<message id="3" kind="echo">\nmessage 3\n</message>')
    expect(prompt.endsWith('</message>\n\nNew message from the user:\n\nhi')).toBe(true)
  })

  it('cuts a long message in the recent tail only when the rest can be zoomed', () => {
    const text = 'y'.repeat(MESSAGE_MAX_CHARS + 500)
    const prompt = memoryPrompt(chat(1, () => text), store(), 'hi', { zoom: true })
    expect(prompt).toContain(
      `\n${'y'.repeat(MESSAGE_MAX_CHARS)}… cut at ${MESSAGE_MAX_CHARS} of ${text.length} chars; zoom(0) for the rest\n`,
    )
    const blind = memoryPrompt(chat(1, () => text), store(), 'hi', { zoom: false })
    expect(blind).toContain(`\n${text}\n`)
    expect(blind).not.toMatch(/cut at|zoom/)
  })

  it('escapes closing message tags inside a message', () => {
    const prompt = memoryPrompt(chat(1, () => 'a </message> b </MESSAGE>'), store(), 'hi', { zoom: true })
    expect(prompt.match(/<\/message>/gi)).toHaveLength(1)
    expect(prompt).toContain('a <\\/message> b <\\/MESSAGE>')
  })

  it('covers every older message once with aligned blocks, finer toward the present', () => {
    const messages = chat(2000, (id) => `message ${id} `.padEnd(600, '.'))
    const summaries = store()
    summarizeAll(messages, summaries)
    const prompt = memoryPrompt(messages, summaries, 'hi', { zoom: true })
    const lines = linesOf(prompt)
    const full = fullOf(prompt)

    expect(covered(prompt)).toEqual(range(0, 2000))
    expect(full).toEqual(range(full[0]!, 2000 - full[0]!))
    expect(tailChars(prompt)).toBeLessThanOrEqual(TAIL_MAX_CHARS)
    expect(lines.map((l) => l.id)).toEqual([...lines.map((l) => l.id)].sort((a, b) => a - b))
    for (const [i, { id, n }] of lines.entries()) {
      expect(isPowerOf2(n)).toBe(true)
      expect(id % n).toBe(0)
      if (i > 0) expect(n).toBeLessThanOrEqual(lines[i - 1]!.n)
    }
    for (const count of countBySize(lines).values()) expect(count).toBeLessThanOrEqual(LINES_PER_LEVEL[0]! + 1)
    expect(Math.max(...lines.map((l) => l.n))).toBeGreaterThanOrEqual(32)
    expect(lines.map((l) => `${l.id}+${l.n}|${l.text}`).join('\n').length).toBeLessThanOrEqual(VIEW_MAX_CHARS)
  })

  it('keeps the older lines the same from turn to turn', () => {
    const textOf = (id: number) => `message ${id} `.padEnd(600, '.')
    const summaries = store()
    summarizeAll(chat(2012, textOf), summaries)
    const before = linesOf(memoryPrompt(chat(2000, textOf), summaries, 'hi', { zoom: true }))
    const after = linesOf(memoryPrompt(chat(2012, textOf), summaries, 'hi', { zoom: true }))
    const kept = before.findIndex((line, i) => after[i]?.id !== line.id || after[i]?.n !== line.n)
    expect(kept).toBeGreaterThanOrEqual(before.length / 2)
  })

  it('uses fewer lines per level when the lines would pass VIEW_MAX_CHARS', () => {
    const messages = chat(20_000, (id) => `message ${id} `.padEnd(600, '.'))
    const summaries = store()
    summarizeAll(messages, summaries, (id, n) => `talk: ${id}+${n} `.padEnd(lineMaxChars(n), '.'))
    const lines = linesOf(memoryPrompt(messages, summaries, 'hi', { zoom: true }))
    expect(covered(memoryPrompt(messages, summaries, 'hi', { zoom: true }))).toEqual(range(0, 20_000))
    expect(lines.map((l) => `${l.id}+${l.n}|${l.text}`).join('\n').length).toBeLessThanOrEqual(VIEW_MAX_CHARS)
    expect(Math.max(...countBySize(lines).values())).toBeLessThan(LINES_PER_LEVEL[0]!)
  })

  it('always keeps the last exchange in full, with the steps between as lines', () => {
    const big = 'b'.repeat(3000)
    const messages: MemoryMessage[] = chat(20)
    const add = (kind: MessageKind, text: string) => messages.push({ id: messages.length, kind, at: at(0), text })
    add('user', 'do it')
    for (let i = 0; i < 200; i++) {
      add('tool', big)
      add('echo', big)
    }
    add('talk', 'All done')
    const asked = 20
    const replied = messages.length - 1
    const summaries = store()
    summarizeAll(messages, summaries)
    const prompt = memoryPrompt(messages, summaries, 'hi', { zoom: true })
    expect(fullOf(prompt)).toContain(asked)
    expect(fullOf(prompt)).toContain(replied)
    expect(covered(prompt)).toEqual(range(0, messages.length))
    expect(tailChars(prompt)).toBeLessThanOrEqual(TAIL_MAX_CHARS)
    expect(linesOf(prompt).some(({ id }) => id > asked && id < replied)).toBe(true)
    expect(prompt.indexOf('<message id="20"')).toBeLessThan(prompt.indexOf('\n21+1|'))
  })

  it('splits a block missing its summary when its halves are ready, else shows what its parts say, clipped', () => {
    const messages = chat(2000, (id) => `message ${id} `.padEnd(600, '.'))
    const all = store()
    summarizeAll(messages, all, wideText)
    const [oldest] = linesOf(memoryPrompt(messages, all, 'hi', { zoom: true }))
    const { id, n } = oldest!
    const half = n / 2

    const split = store()
    summarizeAll(messages, split, wideText, (i, size) => i === id && size === n)
    const splitLines = linesOf(memoryPrompt(messages, split, 'hi', { zoom: true })).slice(0, 2)
    expect(splitLines).toEqual([
      { id, n: half, text: wideText(id, half) },
      { id: id + half, n: half, text: wideText(id + half, half) },
    ])

    const missing = store()
    summarizeAll(messages, missing, wideText, (i, size) => i === id && (size === n || size === half))
    const zoomable = linesOf(memoryPrompt(messages, missing, 'hi', { zoom: true }))[0]!
    expect(zoomable).toMatchObject({ id, n })
    expect(zoomable.text).toMatch(/ \(not summarized yet: zoom it\)$/)
    const blind = linesOf(memoryPrompt(messages, missing, 'hi', { zoom: false }))[0]!
    expect(blind).toMatchObject({ id, n })
    expect(blind.text).not.toContain('not summarized')
    expect(blind.text.length).toBeLessThanOrEqual(lineMaxChars(n))
    expect(blind.text).toContain(wideText(id, half / 2).slice(0, 20))
    expect(blind.text).toContain(wideText(id + half, half).slice(0, 20))
  })
})

describe('zoom and dateOf', () => {
  it('gives a message whole, in pages past ZOOM_PAGE_CHARS', () => {
    const text = 'a'.repeat(ZOOM_PAGE_CHARS) + 'b'.repeat(100)
    const messages = chat(3, (id) => (id === 1 ? text : `message ${id}`))
    const summaries = store()
    expect(zoom(messages, summaries, 0)).toBe(`0|user, ${at(0)}\n\nmessage 0`)

    const first = zoom(messages, summaries, 1)
    expect(first).toBe(
      `1|talk, ${at(1)}, chars 0–${ZOOM_PAGE_CHARS} of ${text.length}\n\n${'a'.repeat(ZOOM_PAGE_CHARS)}` +
        `\n\n(more: zoom(1, 1, offset=${ZOOM_PAGE_CHARS}))`,
    )
    expect(zoom(messages, summaries, 1, 1, ZOOM_PAGE_CHARS)).toBe(
      `1|talk, ${at(1)}, chars ${ZOOM_PAGE_CHARS}–${text.length} of ${text.length}\n\n${'b'.repeat(100)}`,
    )
    expect(zoom(messages, summaries, 1, 1, 10, 5)).toContain(`chars 10–15 of ${text.length}\n\naaaaa\n\n(more:`)
    expect(zoom(messages, summaries, 1, 1, 0, ZOOM_PAGE_CHARS * 2).length).toBe(first.length)
  })

  it('opens a block into its two halves, and a block past the end into what exists', () => {
    const messages = chat(6)
    const summaries = store()
    put(messages, summaries, [
      { id: 0, n: 2, text: 'talk: first pair' },
      { id: 2, n: 2, text: 'talk: second pair' },
      { id: 0, n: 4, text: 'talk: first four' },
    ])
    expect(zoom(messages, summaries, 0, 4)).toBe('0+2|talk: first pair\n2+2|talk: second pair')
    expect(zoom(messages, summaries, 0, 2)).toBe('0+1|user: message 0\n1+1|talk: message 1')
    expect(zoom(messages, summaries, 0, 16)).toBe('0+4|talk: first four\n4+2|talk: message 4 user: message 5')
  })

  it('refuses ids and blocks that do not exist', () => {
    const messages = chat(6)
    const summaries = store()
    expect(() => zoom(messages, summaries, 6)).toThrow('No message 6')
    expect(() => zoom(messages, summaries, -1)).toThrow('No message -1')
    expect(() => zoom(messages, summaries, 0, 3)).toThrow('power of 2')
    expect(() => zoom(messages, summaries, 2, 4)).toThrow('multiple of n')
    expect(() => dateOf(messages, 9)).toThrow('No message 9')
    expect(() => zoom([], summaries, 0)).toThrow('No message 0; this chat has no messages yet')
  })

  it('gives the date and time of a message', () => {
    expect(dateOf(chat(6), 4)).toBe(at(4))
  })
})

describe('instructions', () => {
  it('mention zoom and date only in ZOOM_INSTRUCTIONS', () => {
    expect(MEMORY_INSTRUCTIONS).not.toMatch(/zoom|date\(/)
    expect(ZOOM_INSTRUCTIONS).toContain('zoom(id, n)')
    expect(ZOOM_INSTRUCTIONS).toContain('date(id)')
    expect(ZOOM_INSTRUCTIONS).toContain(ZOOM_PAGE_CHARS.toLocaleString('en-US'))
  })
})

describe('openCompactor', () => {
  const keysOf = (request: CompletionRequest) => [...request.prompt.matchAll(/<item key="([^"]+)"/g)].map(([, k]) => k!)

  function summarizer(
    options: {
      omit?: string[]
      failures?: number
      fail?: (request: CompletionRequest) => boolean
      reply?: string
      text?: (key: string) => string
    } = {},
  ) {
    const requests: (CompletionRequest & { atMs: number; settled: boolean })[] = []
    let active = 0
    let maxActive = 0
    let failures = options.failures ?? 0
    const complete = async (request: CompletionRequest) => {
      const sent = { ...request, atMs: Date.now(), settled: false }
      requests.push(sent)
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active--
      sent.settled = true
      if (failures-- > 0 || options.fail?.(request)) throw new Error('rate limited')
      if (options.reply !== undefined) return options.reply
      const keys = keysOf(request).filter((key) => !options.omit?.includes(key))
      const text = options.text ?? ((key: string) => wide(`summary of ${key}`, Number(key.split('+')[1])))
      return JSON.stringify({ summaries: keys.map((key) => ({ key, text: text(key) })) })
    }
    return { complete, requests, maxActive: () => maxActive }
  }

  const longChat = (count: number, word = 'message') =>
    chat(count, (id) => (id % 3 === 0 ? `${word} ${id} `.padEnd(LINE_MAX_CHARS + 10, '.') : `${word} ${id}`))

  it('summarizes every long message and every complete block, newest first, in batches', async () => {
    const messages = longChat(300)
    const summaries = store()
    const pending = pendingOf(messages, summaries)
    const model = summarizer()
    const compactor = openCompactor({
      chat: () => ({ messages, summaries }),
      complete: model.complete,
      debounceMs: 0,
      minChars: 0,
    })
    compactor.touch('a')
    await until(() => pendingOf(messages, summaries).length === 0)
    compactor.close()

    const first = keysOf(model.requests[0]!)
    expect(first).toEqual(pending.slice(0, first.length).map(({ id, n }) => `${id}+${n}`))
    expect(first[0]).toBe('297+1')
    for (const request of model.requests) {
      const keys = keysOf(request)
      expect(keys.length).toBeLessThanOrEqual(BATCH_MAX_ITEMS)
      if (keys.length > 1) expect(request.prompt.length).toBeLessThanOrEqual(BATCH_MAX_INPUT_CHARS)
      expect(request.schema).toBeDefined()
    }
    expect(summaries.get(3, 1)?.text).toMatch(new RegExp(`^${messages[3]!.kind}: summary of 3\\+1 \\.+$`))
    expect(summaries.get(0, 256)?.text).toMatch(/^summary of 0\+256 \.+$/)
    const node = model.requests.map((r) => r.prompt).find((p) => p.includes('<item key="0+256"'))!
    expect(node).toMatch(/\n0\+128\|summary of 0\+128 \.+\n128\+128\|summary of 128\+128 \.+\n/)
  })

  it('leaves a chat alone until its messages pass COMPACT_MIN_CHARS', async () => {
    const messages = chat(4, () => 'x'.repeat(COMPACT_MIN_CHARS / 4))
    const summaries = store()
    const model = summarizer()
    const compactor = openCompactor({ chat: () => ({ messages, summaries }), complete: model.complete, debounceMs: 0 })
    compactor.touch('a')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(model.requests).toHaveLength(0)

    messages.push({ id: 4, kind: 'talk', at: at(4), text: 'one more' })
    compactor.touch('a')
    await until(() => pendingOf(messages, summaries).length === 0)
    compactor.close()
    expect(model.requests.length).toBeGreaterThan(0)
  })

  it('runs one job at a time across chats, the latest touched first', async () => {
    const chats: Record<string, { messages: MemoryMessage[]; summaries: Summaries }> = {
      a: { messages: longChat(60, 'alpha'), summaries: store() },
      b: { messages: longChat(60, 'beta'), summaries: store() },
    }
    const model = summarizer()
    const compactor = openCompactor({ chat: (id) => chats[id], complete: model.complete, debounceMs: 5, minChars: 0 })
    compactor.touch('a')
    compactor.touch('b')
    await until(() => Object.values(chats).every((c) => pendingOf(c.messages, c.summaries).length === 0))
    compactor.close()
    expect(model.requests[0]!.prompt).toContain('beta')
    expect(model.requests[0]!.prompt).not.toContain('alpha')
    expect(model.maxActive()).toBe(1)
  })

  it('waits until touches stop for the debounce time', async () => {
    const messages = longChat(10)
    const summaries = store()
    const model = summarizer()
    const debounceMs = 40
    const compactor = openCompactor({
      chat: () => ({ messages, summaries }),
      complete: model.complete,
      debounceMs,
      minChars: 0,
    })
    const start = Date.now()
    compactor.touch('a')
    await new Promise((resolve) => setTimeout(resolve, 20))
    compactor.touch('a')
    await until(() => model.requests.length > 0)
    compactor.close()
    expect(model.requests[0]!.atMs - start).toBeGreaterThanOrEqual(20 + debounceMs - 2)
  })

  it('retries with backoff and a smaller batch after a failure', async () => {
    const messages = longChat(300)
    const summaries = store()
    const model = summarizer({ failures: 2 })
    const retryBaseMs = 20
    const compactor = openCompactor({
      minChars: 0,
      chat: () => ({ messages, summaries }),
      complete: model.complete,
      debounceMs: 0,
      retryBaseMs,
    })
    compactor.touch('a')
    await until(() => pendingOf(messages, summaries).length === 0)
    compactor.close()
    const [one, two, three, four] = model.requests
    expect(two!.atMs - one!.atMs).toBeGreaterThanOrEqual(retryBaseMs - 2)
    expect(three!.atMs - two!.atMs).toBeGreaterThanOrEqual(2 * retryBaseMs - 2)
    expect(keysOf(one!)).toHaveLength(BATCH_MAX_ITEMS)
    expect(keysOf(two!)).toHaveLength(BATCH_MAX_ITEMS / 2)
    expect(keysOf(three!)).toHaveLength(BATCH_MAX_ITEMS / 4)
    expect(keysOf(four!)).toHaveLength(BATCH_MAX_ITEMS)
  })

  it('backs off only the chat whose call failed', async () => {
    const chats: Record<string, { messages: MemoryMessage[]; summaries: Summaries }> = {
      a: { messages: longChat(30, 'alpha'), summaries: store() },
      b: { messages: longChat(30, 'beta'), summaries: store() },
    }
    const model = summarizer({ fail: (request) => request.prompt.includes('alpha') })
    const compactor = openCompactor({
      chat: (id) => chats[id],
      complete: model.complete,
      debounceMs: 0,
      minChars: 0,
      retryBaseMs: 60_000,
    })
    compactor.touch('b')
    compactor.touch('a')
    await until(() => pendingOf(chats.b!.messages, chats.b!.summaries).length === 0)
    compactor.close()
    expect(model.requests[0]!.prompt).toContain('alpha')
    expect(model.requests.filter((r) => r.prompt.includes('alpha'))).toHaveLength(1)
  })

  for (const outage of ['throws', 'prints an error and exits 0'] as const) {
    it(`never writes fallbacks while every call fails (the engine ${outage})`, async () => {
      const messages = longChat(30)
      const summaries = store()
      const before = pendingOf(messages, summaries)
      const model = summarizer(outage === 'throws' ? { fail: () => true } : { reply: 'Error: usage limit reached' })
      const compactor = openCompactor({
        chat: () => ({ messages, summaries }),
        complete: model.complete,
        debounceMs: 0,
        minChars: 0,
        retryBaseMs: 1,
        retryMaxMs: 2,
      })
      compactor.touch('a')
      await until(() => model.requests.filter((r) => keysOf(r).length === 1).length >= 4 * ITEM_MAX_ATTEMPTS)
      compactor.close()
      expect(pendingOf(messages, summaries)).toEqual(before)
    })
  }

  it('writes a fallback line for an item whose calls keep failing while other calls work', async () => {
    const messages = longChat(30)
    const summaries = store()
    const bad = '<item key="3+1"'
    const model = summarizer({ fail: (request) => request.prompt.includes(bad) })
    const compactor = openCompactor({
      chat: () => ({ messages, summaries }),
      complete: model.complete,
      debounceMs: 0,
      minChars: 0,
      retryBaseMs: 1,
      retryMaxMs: 2,
    })
    const triedAloneAfter = (start: number) =>
      model.requests.slice(start).some((r) => r.settled && keysOf(r).join() === '3+1')
    compactor.touch('a')
    for (let round = 0; round <= ITEM_MAX_ATTEMPTS && !summaries.get(3, 1); round++) {
      if (round > 0) {
        const id = messages.length
        messages.push({ id, kind: 'talk', at: at(id), text: `more ${id} `.padEnd(LINE_MAX_CHARS + 10, '.') })
        compactor.touch('a')
        await until(() => summaries.get(id, 1) !== undefined)
      }
      const start = model.requests.length
      await until(() => triedAloneAfter(start) || summaries.get(3, 1) !== undefined)
    }
    await until(() => pendingOf(messages, summaries).length === 0)
    compactor.close()
    expect(summaries.get(3, 1)?.text).toBe(
      `${messages[3]!.kind}: ${messages[3]!.text}`.slice(0, LINE_MAX_CHARS - 1) + '…',
    )
    expect(pendingOf(messages, summaries)).toEqual([])
  })

  it('reports a failure once per streak, not once per retry', async () => {
    const messages = longChat(30)
    const summaries = store()
    let down = true
    const model = summarizer({ fail: () => down })
    const reports: string[] = []
    const compactor = openCompactor({
      chat: () => ({ messages, summaries }),
      complete: model.complete,
      debounceMs: 0,
      minChars: 0,
      retryBaseMs: 1,
      retryMaxMs: 2,
      onFailure: (reason) => reports.push(reason),
    })
    compactor.touch('a')
    await until(() => model.requests.length >= 5)
    expect(reports).toEqual(['rate limited'])
    down = false
    await until(() => pendingOf(messages, summaries).length === 0)
    down = true
    messages.push({ id: 30, kind: 'talk', at: at(30), text: 'more '.padEnd(LINE_MAX_CHARS + 10, '.') })
    compactor.touch('a')
    const start = model.requests.length
    await until(() => model.requests.length >= start + 3)
    compactor.close()
    expect(reports).toEqual(['rate limited', 'rate limited'])
  })

  it('treats an empty summary as left out', async () => {
    const messages = longChat(1)
    const summaries = store()
    const model = summarizer({ text: (key) => `${key}|` })
    const compactor = openCompactor({
      chat: () => ({ messages, summaries }),
      complete: model.complete,
      debounceMs: 0,
      minChars: 0,
      retryBaseMs: 1,
    })
    compactor.touch('a')
    await until(() => pendingOf(messages, summaries).length === 0)
    compactor.close()
    expect(model.requests).toHaveLength(ITEM_MAX_ATTEMPTS)
    expect(summaries.get(0, 1)?.text).toBe(`user: ${messages[0]!.text}`.slice(0, LINE_MAX_CHARS - 1) + '…')
  })

  it('writes a fallback line for an item the model keeps leaving out', async () => {
    const messages = longChat(30)
    const summaries = store()
    const model = summarizer({ omit: ['3+1'] })
    const compactor = openCompactor({
      minChars: 0,
      chat: () => ({ messages, summaries }),
      complete: model.complete,
      debounceMs: 0,
      retryBaseMs: 1,
    })
    compactor.touch('a')
    await until(() => pendingOf(messages, summaries).length === 0)
    compactor.close()
    expect(model.requests.filter((r) => keysOf(r).includes('3+1'))).toHaveLength(ITEM_MAX_ATTEMPTS)
    expect(summaries.get(3, 1)?.text).toBe(`${messages[3]!.kind}: ${messages[3]!.text}`.slice(0, LINE_MAX_CHARS - 1) + '…')
  })

  it('clips a summary that runs past its line length', async () => {
    const messages = longChat(4)
    const summaries = store()
    const model = summarizer({ text: () => 'w'.repeat(10_000) })
    const compactor = openCompactor({
      chat: () => ({ messages, summaries }),
      complete: model.complete,
      debounceMs: 0,
      minChars: 0,
    })
    compactor.touch('a')
    await until(() => pendingOf(messages, summaries).length === 0)
    compactor.close()
    expect(summaries.get(0, 1)?.text).toHaveLength(lineMaxChars(1) * SUMMARY_CLIP_FACTOR)
    expect(summaries.get(0, 4)?.text).toHaveLength(lineMaxChars(4) * SUMMARY_CLIP_FACTOR)
  })

  it('drops line keys a summary copied from its halves', async () => {
    const messages = chat(2, () => 'z'.repeat(LINE_MAX_CHARS))
    const summaries = store()
    const model = summarizer({ text: (key) => (key === '0+2' ? '0+1|user: a 1+1|talk: b' : 'w'.repeat(200)) })
    const compactor = openCompactor({
      chat: () => ({ messages, summaries }),
      complete: model.complete,
      debounceMs: 0,
      minChars: 0,
    })
    compactor.touch('a')
    await until(() => pendingOf(messages, summaries).length === 0)
    compactor.close()
    expect(summaries.get(0, 2)?.text).toBe('user: a talk: b')
  })

  it('stops on close and drops a reply that arrives after it', async () => {
    const messages = longChat(30)
    const summaries = store()
    const requests: CompletionRequest[] = []
    let answer = (_reply: string) => {}
    const complete = (request: CompletionRequest) => {
      requests.push(request)
      return new Promise<string>((resolve) => (answer = resolve))
    }
    const compactor = openCompactor({ chat: () => ({ messages, summaries }), complete, debounceMs: 0, minChars: 0 })
    compactor.touch('a')
    await until(() => requests.length === 1)
    compactor.close()
    answer(JSON.stringify({ summaries: keysOf(requests[0]!).map((key) => ({ key, text: 'late' })) }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    compactor.touch('a')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(requests).toHaveLength(1)
    expect(summaries.get(27, 1)).toBeUndefined()
  })
})
