import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeAdapter } from './adapters/fake.ts'
import { sandboxingMachine } from './adapters/test-machine.ts'
import { openCore, type Core } from './core.ts'
import { searchChats, type Searchable } from './search.ts'
import type { ChatEntry, CoreMessage } from './shared.ts'

const user = (at: string, text: string): ChatEntry => ({ at, type: 'user.message', text })
const reply = (at: string, text: string): ChatEntry => ({ at, type: 'text.completed', text })

describe('searchChats', () => {
  const chats: Searchable[] = [
    {
      id: 'a',
      name: 'Alpha',
      entries: [
        user('2026-01-01T00:00:01Z', 'Fix the LOGIN page'),
        { at: '2026-01-01T00:00:02Z', type: 'tool.started', toolId: 't', name: 'Bash', kind: 'shell', input: 'login' } as ChatEntry,
        reply('2026-01-01T00:00:03Z', 'The login form\n\nnow   validates'),
      ],
    },
    { id: 'b', name: 'Beta', entries: [user('2026-01-02T00:00:00Z', 'Nothing to see; log in later')] },
  ]

  it('finds message text case-insensitively, newest first, one hit per message, skipping tool calls', () => {
    const hits = searchChats(chats, 'Login')
    expect(hits.map((h) => [h.chatId, h.kind, h.nth])).toEqual([
      ['a', 'text', 1],
      ['a', 'user', 0],
    ])
    const [first] = hits
    expect(first!.snippet).toBe('The login form now validates')
    expect(first!.snippet.slice(first!.match.start, first!.match.start + first!.match.length)).toBe('login')
  })

  it('trims the snippet around a match deep in a long message, marking the cuts', () => {
    const long = `${'x'.repeat(100)} needle ${'y'.repeat(300)}`
    const [hit] = searchChats([{ id: 'c', name: 'C', entries: [user('2026-01-03T00:00:00Z', long)] }], 'needle')
    expect(hit!.snippet.startsWith('…')).toBe(true)
    expect(hit!.snippet.endsWith('…')).toBe(true)
    expect(hit!.snippet.slice(hit!.match.start, hit!.match.start + 6)).toBe('needle')
  })

  it('takes the query literally, ignores a blank one and caps the results', () => {
    expect(searchChats(chats, 'log.in')).toEqual([])
    expect(searchChats(chats, '   ')).toEqual([])
    const many = Array.from({ length: 80 }, (_, i) => user(`2026-02-01T00:00:${String(i % 60).padStart(2, '0')}Z`, `hit ${i}`))
    expect(searchChats([{ id: 'd', name: 'D', entries: many }], 'hit')).toHaveLength(50)
    expect(searchChats([{ id: 'd', name: 'D', entries: many }], 'hit', 5)).toHaveLength(5)
  })
})

describe('the core', () => {
  const dirs: string[] = []
  const cores: Core[] = []
  afterEach(async () => {
    await Promise.all(cores.splice(0).map((core) => core.close(true)))
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function chatOnDisk(garage: string, id: string, info: object, entries: ChatEntry[]) {
    const dir = join(garage, 'chats', id)
    mkdirSync(dir, { recursive: true })
    const base = { name: id, folders: [], files: [], engine: 'fake', archived: false, createdAt: '2026-01-01T00:00:00Z' }
    writeFileSync(join(dir, 'chat.json'), JSON.stringify({ ...base, ...info }))
    writeFileSync(join(dir, 'log.jsonl'), entries.map((e) => JSON.stringify(e) + '\n').join(''))
  }

  it('answers search with hits from spaces, not subagents, under the request id', () => {
    const garage = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-search-')))
    dirs.push(garage)
    chatOnDisk(garage, 'space', { name: 'Space' }, [user('2026-01-01T00:00:01Z', 'deploy the widget')])
    chatOnDisk(garage, 'sub', { name: 'Sub', subagent: true, parentId: 'space' }, [
      user('2026-01-01T00:00:02Z', 'widget task'),
    ])
    const adapter = createFakeAdapter([], 0)
    const core = openCore({ garage, adapters: [adapter], defaultEngine: adapter.id, machine: sandboxingMachine, mods: [] })
    cores.push(core)
    const replies: CoreMessage[] = []
    core.handle({ type: 'search', id: 7, query: 'WIDGET' }, (r) => replies.push(r))
    expect(replies).toEqual([
      {
        type: 'search.results',
        id: 7,
        query: 'WIDGET',
        hits: [
          {
            chatId: 'space',
            at: '2026-01-01T00:00:01Z',
            kind: 'user',
            snippet: 'deploy the widget',
            match: { start: 11, length: 6 },
            nth: 0,
          },
        ],
      },
    ])
  })
})
