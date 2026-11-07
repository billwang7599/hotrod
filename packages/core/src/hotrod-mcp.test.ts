import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openHotrodMcp, SUBAGENT_NAME_MAX_CHARS } from './hotrod-mcp.ts'
import { WORKSHOP_NAME, type ChatEntry, type ChatState } from './types.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const at = '2026-11-07T00:00:00.000Z'

function chat(id: string, change: Partial<ChatState> = {}): ChatState {
  return {
    id,
    name: id === 'main' ? WORKSHOP_NAME : `Chat ${id}`,
    ...(id !== 'main' && { parentId: 'main' }),
    folders: [],
    files: [],
    engine: 'fake',
    archived: false,
    createdAt: at,
    status: 'idle',
    entries: [],
    draft: '',
    queue: [],
    ...change,
  }
}

async function start(subagents = { enabled: false, limit: 4 }) {
  const chats: ChatState[] = [
    chat('main'),
    chat('aaaa0001', { folders: ['/tmp/app'] }),
    chat('bbbb0001'),
    chat('cccc0001', { parentId: 'aaaa0001' }),
  ]
  const nestable = new Set(['main', 'aaaa0001'])
  const calls: unknown[][] = []
  const mcp = openHotrodMcp({
    chats: () => chats,
    canNest: (chatId) => nestable.has(chatId),
    createChat(spec) {
      calls.push(['createChat', spec])
      const created = chat('dddd0001', { parentId: spec.parentId, ...(spec.subagent && { subagent: true }) })
      chats.push(created)
      return created
    },
    subagents: () => subagents,
    send(chatId, text) {
      calls.push(['send', chatId, text])
    },
  })
  const http = createServer((request, response) => void mcp.handle(request, response))
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => http.close(() => resolve())))
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`

  let id = 0
  const rpc = async (token: string, method: string, params: unknown = {}) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    })
    return { status: response.status, body: response.status === 200 ? await response.json() : undefined }
  }
  const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const { body } = await rpc(token, 'tools/call', { name, arguments: args })
    if (body.error) return { isError: true, text: String(body.error.message) }
    const result = body.result
    const text = result.content.map((c: { text: string }) => c.text).join('\n')
    return { isError: result.isError === true, text }
  }
  const json = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const result = await tool(token, name, args)
    expect(result).toMatchObject({ isError: false })
    return JSON.parse(result.text)
  }
  const grant = (chatId: string) => {
    const token = mcp.grant(chatId)
    if (!token) throw new Error(`no token for ${chatId}`)
    return token
  }
  const names = async (chatId: string) =>
    (await rpc(grant(chatId), 'tools/list')).body.result.tools.map((t: { name: string }) => t.name).sort()
  return { mcp, chats, calls, rpc, tool, json, grant, names, subagents }
}

describe('Hotrod MCP server', () => {
  it('turns away requests without a live token', async () => {
    const { mcp, rpc, grant } = await start()
    expect((await rpc('', 'tools/list')).status).toBe(401)
    expect((await rpc('made-up', 'tools/list')).status).toBe(401)
    const token = grant('main')
    expect((await rpc(token, 'tools/list')).status).toBe(200)
    mcp.revoke(token)
    expect((await rpc(token, 'tools/list')).status).toBe(401)
  })

  it('gives no token to a chat that can neither nest chats nor spawn subagents', async () => {
    const { mcp } = await start()
    expect(mcp.grant('bbbb0001')).toBeUndefined()
    expect(mcp.grant('cccc0001')).toBeUndefined()
    expect(mcp.grant('nope')).toBeUndefined()
  })

  it('offers the chat tools to every chat that may nest chats', async () => {
    const { names } = await start()
    const tools = ['create_chat', 'list_chats', 'read_chat', 'send_message']
    expect(await names('main')).toEqual(tools)
    expect(await names('aaaa0001')).toEqual(tools)
  })

  it('lists every chat below the caller, nested ones included', async () => {
    const { json, grant } = await start()
    const listed = await json(grant('main'), 'list_chats')
    expect(listed.map((c: { id: string }) => c.id)).toEqual(['aaaa0001', 'bbbb0001', 'cccc0001'])
    expect(listed[0]).toEqual({
      id: 'aaaa0001',
      name: 'Chat aaaa0001',
      folders: ['/tmp/app'],
      status: 'idle',
      engine: 'fake',
      archived: false,
    })
    expect((await json(grant('aaaa0001'), 'list_chats')).map((c: { id: string }) => c.id)).toEqual(['cccc0001'])
  })

  it('reads a chat as messages, with tool calls as their summary', async () => {
    const { chats, tool, grant } = await start()
    const entries: ChatEntry[] = [
      { at, type: 'user.message', text: 'List the files' },
      { at, type: 'turn.started' },
      { at, type: 'tool.started', toolId: 't1', name: 'Bash', kind: 'shell', summary: 'ls -la', input: {} },
      { at, type: 'tool.completed', toolId: 't1', output: 'a\nb', isError: false },
      { at, type: 'text.completed', text: 'Two files.' },
      { at, type: 'turn.completed', error: 'Interrupted' },
    ]
    chats.find((c) => c.id === 'cccc0001')!.entries = entries
    const token = grant('aaaa0001')
    expect(await tool(token, 'read_chat', { chatId: 'cccc0001' })).toEqual({
      isError: false,
      text: 'User: List the files\n\nTool Bash: ls -la\n\nAssistant: Two files.\n\n[Turn ended early: Interrupted]',
    })
    expect((await tool(token, 'read_chat', { chatId: 'cccc0001', last: 2 })).text).toBe(
      'Assistant: Two files.\n\n[Turn ended early: Interrupted]',
    )
  })

  it('refuses to read or message a chat outside the caller’s subtree', async () => {
    const { calls, tool, grant } = await start()
    const token = grant('aaaa0001')
    for (const chatId of ['main', 'aaaa0001', 'bbbb0001', 'nope']) {
      const refused = { isError: true, text: `No chat "${chatId}" below this one` }
      expect(await tool(token, 'read_chat', { chatId })).toEqual(refused)
      expect((await tool(token, 'send_message', { chatId, text: 'hi' })).isError).toBe(true)
    }
    expect(calls).toEqual([])
  })

  it('sends a message to an idle descendant and refuses a busy one', async () => {
    const { chats, calls, tool, grant } = await start()
    const token = grant('main')
    expect(await tool(token, 'send_message', { chatId: 'cccc0001', text: 'Go on' })).toMatchObject({ isError: false })
    expect(calls).toEqual([['send', 'cccc0001', 'Go on']])
    chats.find((c) => c.id === 'aaaa0001')!.status = 'running'
    expect(await tool(token, 'send_message', { chatId: 'aaaa0001', text: 'Hi' })).toEqual({
      isError: true,
      text: 'Chat "aaaa0001" is running; wait until it is idle',
    })
    expect(calls).toHaveLength(1)
  })

  it('creates a named chat under the caller, making missing folders, and starts it only on a prompt', async () => {
    const { calls, json, tool, grant } = await start()
    const root = mkdtempSync(join(tmpdir(), 'hotrod-mcp-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const existing = join(root, 'existing')
    mkdirSync(existing)
    writeFileSync(join(existing, 'keep.txt'), 'keep')
    const fresh = join(root, 'deep', 'fresh')
    const token = grant('main')

    expect(await json(token, 'create_chat', { name: 'Research', prompt: 'Research X' })).toEqual({ chatId: 'dddd0001' })
    const app = { name: 'App', folders: [existing, fresh], files: ['/tmp/notes.md'], engine: 'pi' }
    expect(await json(token, 'create_chat', app)).toEqual({ chatId: 'dddd0001' })
    expect(await json(grant('aaaa0001'), 'create_chat', { name: 'Nested' })).toEqual({ chatId: 'dddd0001' })
    expect(readdirSync(existing)).toEqual(['keep.txt'])
    expect(existsSync(fresh)).toBe(true)
    expect(calls).toEqual([
      ['createChat', { parentId: 'main', name: 'Research' }],
      ['send', 'dddd0001', 'Research X'],
      ['createChat', { parentId: 'main', ...app }],
      ['createChat', { parentId: 'aaaa0001', name: 'Nested' }],
    ])

    expect(await tool(token, 'create_chat', { name: 'Bad', folders: ['relative/dir'] })).toEqual({
      isError: true,
      text: 'The path must be absolute: relative/dir',
    })
    expect((await tool(token, 'create_chat', { prompt: 'No name' })).isError).toBe(true)
    expect(calls).toHaveLength(4)
  })

  describe('subagents', () => {
    const on = (limit = 4) => start({ enabled: true, limit })

    it('offers spawn_subagent to every chat but a subagent, only while the mod is on', async () => {
      const off = await start()
      expect(await off.names('main')).not.toContain('spawn_subagent')
      expect(off.mcp.grant('bbbb0001')).toBeUndefined()

      const { names, mcp, chats } = await on()
      expect(await names('main')).toContain('spawn_subagent')
      expect(await names('aaaa0001')).toContain('spawn_subagent')
      expect(await names('bbbb0001')).toEqual(['list_chats', 'read_chat', 'send_message', 'spawn_subagent'])
      chats.push(chat('eeee0001', { parentId: 'bbbb0001', subagent: true }))
      expect(mcp.grant('eeee0001')).toBeUndefined()
    })

    it('refuses to spawn once the mod is turned off mid-session', async () => {
      const { calls, tool, grant, subagents } = await on()
      const token = grant('aaaa0001')
      subagents.enabled = false
      expect((await tool(token, 'spawn_subagent', { task: 'Go' })).isError).toBe(true)
      expect(calls).toEqual([])
    })

    it("spawns a subagent named after its task with the parent's engine, and starts it with the task", async () => {
      const { calls, json, tool, grant } = await on()
      expect(await json(grant('aaaa0001'), 'spawn_subagent', { task: 'Read the tests' })).toEqual({
        chatId: 'dddd0001',
      })
      const search = { task: 'Search', engine: 'pi', role: 'searching' }
      expect(await json(grant('main'), 'spawn_subagent', search)).toEqual({ chatId: 'dddd0001' })
      const long = `Lint   every file\nin ${'x'.repeat(SUBAGENT_NAME_MAX_CHARS)}`
      expect(await json(grant('bbbb0001'), 'spawn_subagent', { task: long })).toEqual({ chatId: 'dddd0001' })
      const name = `${`Lint every file in ${'x'.repeat(SUBAGENT_NAME_MAX_CHARS)}`.slice(0, SUBAGENT_NAME_MAX_CHARS)}…`
      const subagent = { engine: 'fake', subagent: true }
      expect(calls).toEqual([
        ['createChat', { parentId: 'aaaa0001', name: 'Read the tests', ...subagent }],
        ['send', 'dddd0001', 'Read the tests'],
        ['createChat', { parentId: 'main', name: 'Search', engine: 'pi', subagent: true, role: 'searching' }],
        ['send', 'dddd0001', 'Search'],
        ['createChat', { parentId: 'bbbb0001', name, ...subagent }],
        ['send', 'dddd0001', long],
      ])
      expect((await tool(grant('main'), 'spawn_subagent', { task: 'Go', role: 'chat' })).isError).toBe(true)
      expect(calls).toHaveLength(6)
    })

    it('counts running, waiting and stopping subagents against the limit, never idle ones', async () => {
      const limit = 3
      const { chats, calls, tool, grant } = await on(limit)
      const under = (status: ChatState['status'], parentId = 'aaaa0001') => ({ parentId, subagent: true, status })
      chats.push(
        chat('s1', under('running')),
        chat('s2', under('waiting')),
        chat('s3', under('stopping')),
        chat('s4', under('idle')),
        chat('s5', under('running', 'bbbb0001')),
      )
      expect(await tool(grant('aaaa0001'), 'spawn_subagent', { task: 'One more' })).toEqual({
        isError: true,
        text: `This chat already has ${limit} subagents running; the limit is ${limit}`,
      })
      expect(calls).toEqual([])
      chats.find((c) => c.id === 's3')!.status = 'idle'
      expect(await tool(grant('aaaa0001'), 'spawn_subagent', { task: 'One more' })).toMatchObject({ isError: false })
    })

    it('never limits when the limit is -1', async () => {
      const { chats, tool, grant } = await on(-1)
      for (let i = 0; i < 20; i++) chats.push(chat(`s${i}`, { subagent: true, status: 'running' }))
      expect(await tool(grant('main'), 'spawn_subagent', { task: 'Go' })).toMatchObject({ isError: false })
    })

    it('shows a subagent only to its own parent', async () => {
      const { chats, json, tool, grant } = await on()
      chats.push(
        chat('s1', { parentId: 'aaaa0001', subagent: true }),
        chat('s2', { parentId: 'bbbb0001', subagent: true }),
        chat('s3', { subagent: true }),
      )
      const ids = async (chatId: string) => (await json(grant(chatId), 'list_chats')).map((c: { id: string }) => c.id)
      expect(await ids('main')).toEqual(['aaaa0001', 'bbbb0001', 'cccc0001', 's3'])
      expect(await ids('aaaa0001')).toEqual(['cccc0001', 's1'])
      expect(await ids('bbbb0001')).toEqual(['s2'])
      expect(await tool(grant('bbbb0001'), 'read_chat', { chatId: 'aaaa0001' })).toEqual({
        isError: true,
        text: 'No chat "aaaa0001" below this one',
      })
      expect((await tool(grant('main'), 'send_message', { chatId: 's1', text: 'hi' })).isError).toBe(true)
      expect(await tool(grant('bbbb0001'), 'send_message', { chatId: 's2', text: 'hi' })).toMatchObject({
        isError: false,
      })
    })
  })
})
