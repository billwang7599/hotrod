import { appendFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeAdapter } from './adapters/fake.ts'
import { sandboxingMachine } from './adapters/test-machine.ts'
import { openCore } from './core.ts'
import { PAGE_CHARS, PAGE_ENTRIES, pageOf } from './history.ts'
import type { ChatEntry, ClientMessage, CoreMessage } from './shared.ts'

const at = '2026-01-01T00:00:00.000Z'
const user = (text: string): ChatEntry => ({ at, type: 'user.message', text })
const reply = (text: string): ChatEntry => ({
  at,
  type: 'text.completed',
  text,
})
const tool = (n: number): ChatEntry[] => [
  {
    at,
    type: 'tool.started',
    toolId: `t${n}`,
    name: 'Bash',
    kind: 'shell',
    summary: `step ${n}`,
    input: {},
  },
  { at, type: 'tool.completed', toolId: `t${n}`, output: 'ok', isError: false },
]
// turns turns of a question, steps tool calls (two entries each) and a reply.
const turnsOf = (turns: number, steps = 3) =>
  Array.from({ length: turns }, (_, i) => [
    user(`question ${i}`),
    ...Array.from({ length: steps }, (_, s) => tool(i * 1000 + s)).flat(),
    reply(`answer ${i}`),
  ]).flat()

const startsTurn = (e?: ChatEntry) => e?.type === 'user.message'

describe('a page of a chat log', () => {
  it('is the whole log when it is short', () => {
    const log = turnsOf(3)
    expect(pageOf(log)).toEqual({ from: 0, entries: log })
  })

  it('is empty for an empty chat', () => {
    expect(pageOf([])).toEqual({ from: 0, entries: [] })
  })

  it('is the latest page, starting where a turn starts', () => {
    const log = turnsOf(100)
    const { from, entries } = pageOf(log)
    expect(from).toBeGreaterThan(0)
    expect(entries).toEqual(log.slice(from))
    expect(startsTurn(log[from])).toBe(true)
    expect(entries.length).toBeGreaterThanOrEqual(PAGE_ENTRIES)
    expect(entries.length).toBeLessThan(PAGE_ENTRIES + 8)
  })

  it('pages back from an entry until the log runs out', () => {
    const log = turnsOf(100)
    const seen: ChatEntry[][] = []
    let before = log.length
    while (before > 0) {
      const page = pageOf(log, before)
      expect(page.from).toBeLessThan(before)
      expect(page.from === 0 || startsTurn(log[page.from])).toBe(true)
      seen.unshift(page.entries)
      before = page.from
    }
    expect(seen.flat()).toEqual(log)
  })

  it('reaches back to a given entry and the start of its turn', () => {
    const log = turnsOf(100)
    const { from } = pageOf(log, log.length, 9)
    expect(from).toBe(8)
    expect(pageOf(log, 400, 9).entries).toEqual(log.slice(8, 400))
  })

  it('stops at its char budget when entries are large, and cuts a turn too long to fit', () => {
    const big = 'x'.repeat(PAGE_CHARS / 4)
    const log = [user('long job'), ...Array.from({ length: 40 }, () => reply(big)), user('next'), reply(big)]
    const { from, entries } = pageOf(log)
    expect(from).toBeGreaterThan(1)
    expect(entries.length).toBeLessThan(15)
    expect(entries.at(-1)).toEqual(log.at(-1))
  })

  it('takes a turn start up to a page back rather than cutting a turn', () => {
    const log = [user('start'), ...turnsOf(1, PAGE_ENTRIES / 2 + 5).slice(1), ...turnsOf(1, 2)]
    expect(pageOf(log).from).toBe(0)
  })
})

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function open(garage: string) {
  const core = openCore({
    garage,
    adapters: [createFakeAdapter(() => [])],
    defaultEngine: 'fake',
    machine: sandboxingMachine,
    extensions: [],
  })
  const replies: CoreMessage[] = []
  const handle = (m: ClientMessage) => core.handle(m, (answer) => replies.push(answer))
  return { core, replies, handle }
}

describe("the UI's chat history", () => {
  it('gets the latest page of a long chat, and older pages on request, while agents still read it all', async () => {
    const garage = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-history-')))
    cleanups.push(() => rmSync(garage, { recursive: true, force: true }))
    const first = open(garage)
    first.handle({ type: 'chat.create', name: 'Long' })
    const id = first.core.chats().find((c) => c.name === 'Long')!.id
    first.handle({ type: 'chat.create', name: 'Empty' })
    await first.core.close(true)
    const log = turnsOf(100)
    appendFileSync(join(garage, 'chats', id, 'log.jsonl'), log.map((e) => JSON.stringify(e) + '\n').join(''))

    const t = open(garage)
    cleanups.push(() => t.core.close(true))
    const shown = t.core.chats().find((c) => c.id === id)!
    expect(shown.from).toBe(pageOf(log).from)
    expect(shown.entries).toEqual(log.slice(shown.from))
    const empty = t.core.chats().find((c) => c.name === 'Empty')!
    expect(empty.entries).toEqual([])
    expect(empty.from).toBeUndefined()

    t.handle({ type: 'chat.history', chatId: id, before: shown.from! })
    const older = t.replies.at(-1) as Extract<CoreMessage, { type: 'chat.history' }>
    expect(older).toMatchObject({
      type: 'chat.history',
      chatId: id,
      before: shown.from,
    })
    expect(older.entries).toEqual(log.slice(older.from, shown.from))

    t.handle({ type: 'chat.history', chatId: id, before: older.from, to: 0 })
    const rest = t.replies.at(-1) as Extract<CoreMessage, { type: 'chat.history' }>
    expect(rest.from).toBe(0)
    expect([...rest.entries, ...older.entries, ...shown.entries]).toEqual(log)

    t.handle({ type: 'chat.history', chatId: id, before: 0 })
    expect(t.replies.at(-1)).toEqual({
      type: 'chat.history',
      chatId: id,
      before: 0,
      from: 0,
      entries: [],
    })

    t.handle({ type: 'search', id: 1, query: 'question 3' })
    const search = t.replies.at(-1) as Extract<CoreMessage, { type: 'search.results' }>
    expect(search.hits.find((h) => h.snippet === 'question 3')?.entry).toBe(
      log.findIndex((e) => e.type === 'user.message' && e.text === 'question 3'),
    )
  })
})
