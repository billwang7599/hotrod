import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModHost, ModTool, ModValues } from '@kothar/mod-api'
import { openKotharMcp, WORKER_NAME_MAX_CHARS } from './kothar-mcp.ts'
import type { ChatEntry, ChatState, NewChat } from './shared.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const at = '2026-11-07T00:00:00.000Z'

function chat(id: string, change: Partial<ChatState> = {}): ChatState {
  return {
    id,
    name: `Chat ${id}`,
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

const said = (...texts: string[]): ChatEntry[] =>
  texts.map((text, i) => (i % 2 ? { at, type: 'text.completed', text } : { at, type: 'user.message', text }))

async function start(workers = { enabled: false, limit: 4 }) {
  const dir = mkdtempSync(join(tmpdir(), 'kothar-mcp-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const chats: ChatState[] = [
    chat('main', { entries: said('hello', 'hi there') }),
    chat('aaaa0001', { folders: ['/tmp/app'], entries: said('build it', 'on it', 'and test it', 'done') }),
    chat('bbbb0001'),
    chat('cccc0001'),
  ]
  const calls: unknown[][] = []
  const created = (spec: NewChat & { parentId?: string; worker?: boolean }) => {
    calls.push(['createChat', spec])
    const made = chat('dddd0001', { parentId: spec.parentId, ...(spec.worker && { worker: true }) })
    chats.push(made)
    return made
  }
  const modTools: { tool: ModTool; values: ModValues }[] = []
  const host = {
    createChat: ({ name, folders, files, engine }) => created({ name, folders, files, engine }),
    send: (chatId, text) => void calls.push(['send', chatId, text]),
  } as Partial<ModHost> as ModHost
  const mcp = openKotharMcp({
    chats: () => chats,
    seesAll: (chatId) => chatId === 'main',
    modTools: () => modTools.map((entry) => ({ ...entry, host })),
    createChild: (parentId, spec) => created({ parentId, ...spec, worker: true }),
    workers: () => workers,
    send(chatId, text) {
      calls.push(['send', chatId, text])
    },
    deliver(chatId, text) {
      calls.push(['deliver', chatId, text])
      const status = chats.find((c) => c.id === chatId)!.status
      return status === 'idle' ? 'sent' : status === 'running' ? 'steered' : 'queued'
    },
    stop(chatId) {
      calls.push(['stop', chatId])
      chats.find((c) => c.id === chatId)!.status = 'stopping'
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
  return { mcp, chats, calls, modTools, rpc, tool, json, grant, names, workers }
}

describe('Kothar MCP server', () => {
  it('turns away requests without a live token', async () => {
    const { mcp, rpc, grant } = await start()
    expect((await rpc('', 'tools/list')).status).toBe(401)
    expect((await rpc('made-up', 'tools/list')).status).toBe(401)
    const token = grant('main')
    expect((await rpc(token, 'tools/list')).status).toBe(200)
    mcp.revoke(token)
    expect((await rpc(token, 'tools/list')).status).toBe(401)
  })

  it('gives no token to a chat that neither sees every chat, spawns workers nor gets a mod tool', async () => {
    const { mcp } = await start()
    expect(mcp.grant('bbbb0001')).toBeUndefined()
    expect(mcp.grant('cccc0001')).toBeUndefined()
    expect(mcp.grant('nope')).toBeUndefined()
  })

  it('offers the chat tools to a chat that sees every chat', async () => {
    const { names } = await start()
    expect(await names('main')).toEqual(['list_chats', 'read_chat', 'send_message', 'stop_chat'])
  })

  it('lists every other chat to a chat that sees every chat', async () => {
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
    const token = grant('main')
    expect(await tool(token, 'read_chat', { chatId: 'cccc0001' })).toEqual({
      isError: false,
      text: 'User: List the files\n\nTool Bash: ls -la\n\nAssistant: Two files.\n\n[Turn ended early: Interrupted]',
    })
    expect((await tool(token, 'read_chat', { chatId: 'cccc0001', last: 2 })).text).toBe(
      'Assistant: Two files.\n\n[Turn ended early: Interrupted]',
    )
  })

  it('refuses to read or message a chat the caller cannot reach', async () => {
    const { calls, tool, grant } = await start({ enabled: true, limit: 4 })
    const token = grant('aaaa0001')
    for (const chatId of ['main', 'aaaa0001', 'bbbb0001', 'nope']) {
      const refused = { isError: true, text: `No chat "${chatId}" this chat can reach` }
      expect(await tool(token, 'read_chat', { chatId })).toEqual(refused)
      expect((await tool(token, 'send_message', { chatId, text: 'hi' })).isError).toBe(true)
      expect(await tool(token, 'stop_chat', { chatId })).toEqual(refused)
    }
    expect(await tool(grant('main'), 'read_chat', { chatId: 'main' })).toMatchObject({ isError: true })
    expect(calls).toEqual([])
  })

  it('sends a message to a chat it can reach, steering or queueing it into a busy one', async () => {
    const { chats, calls, tool, grant } = await start()
    const token = grant('main')
    expect(await tool(token, 'send_message', { chatId: 'cccc0001', text: 'Go on' })).toEqual({
      isError: false,
      text: '{"delivered":"sent"}',
    })
    chats.find((c) => c.id === 'aaaa0001')!.status = 'running'
    expect(await tool(token, 'send_message', { chatId: 'aaaa0001', text: 'Hi' })).toEqual({
      isError: false,
      text: '{"delivered":"steered"}',
    })
    chats.find((c) => c.id === 'bbbb0001')!.status = 'waiting'
    expect((await tool(token, 'send_message', { chatId: 'bbbb0001', text: 'Hey' })).text).toBe('{"delivered":"queued"}')
    expect(calls).toEqual([
      ['deliver', 'cccc0001', 'Go on'],
      ['deliver', 'aaaa0001', 'Hi'],
      ['deliver', 'bbbb0001', 'Hey'],
    ])
  })

  it('stops a chat it can reach, and says so when it is already idle or stopping', async () => {
    const { chats, calls, tool, grant } = await start()
    const token = grant('main')
    expect(await tool(token, 'stop_chat', { chatId: 'cccc0001' })).toEqual({
      isError: false,
      text: 'Chat "cccc0001" is already idle',
    })
    chats.find((c) => c.id === 'aaaa0001')!.status = 'running'
    expect(await tool(token, 'stop_chat', { chatId: 'aaaa0001' })).toEqual({
      isError: false,
      text: 'Stopping chat "aaaa0001"',
    })
    expect((await tool(token, 'stop_chat', { chatId: 'aaaa0001' })).text).toBe('Chat "aaaa0001" is already stopping')
    expect(await tool(token, 'stop_chat', { chatId: 'main' })).toMatchObject({ isError: true })
    expect(calls).toEqual([['stop', 'aaaa0001']])
  })

  describe('mod tools', () => {
    const make: ModTool = {
      name: 'make',
      description: 'Make a chat',
      inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'] },
      offered: (caller) => caller.id !== 'bbbb0001',
      async run(input, { caller, values, host }) {
        if (input.name === 'fail') throw new Error('No such luck')
        const made = host.createChat({ name: String(input.name), folders: ['/tmp/x'] })
        host.send(made.id, 'Go')
        return { caller: caller.id, worker: caller.worker ?? false, values, chatId: made.id }
      },
    }

    it('offers a mod tool to the callers it picks, with a token for a chat that has nothing else', async () => {
      const { modTools, names, mcp } = await start()
      modTools.push({ tool: make, values: { size: 2 } })
      expect(await names('main')).toContain('make')
      expect(await names('aaaa0001')).toEqual(['make'])
      expect(mcp.grant('bbbb0001')).toBeUndefined()
      modTools.splice(0)
      expect(mcp.grant('aaaa0001')).toBeUndefined()
    })

    it('runs it with the caller, its values and a host that makes top-level chats and starts them', async () => {
      const { modTools, calls, json, grant } = await start()
      modTools.push({ tool: make, values: { size: 2 } })
      expect(await json(grant('aaaa0001'), 'make', { name: 'Docs' })).toEqual({
        caller: 'aaaa0001',
        worker: false,
        values: { size: 2 },
        chatId: 'dddd0001',
      })
      expect(calls).toEqual([
        ['createChat', { name: 'Docs', folders: ['/tmp/x'] }],
        ['send', 'dddd0001', 'Go'],
      ])
    })

    it('answers a thrown error or input its schema rules out as a tool error', async () => {
      const { modTools, calls, tool, grant } = await start()
      modTools.push({ tool: make, values: {} })
      expect(await tool(grant('main'), 'make', { name: 'fail' })).toEqual({ isError: true, text: 'No such luck' })
      expect((await tool(grant('main'), 'make', { name: '' })).isError).toBe(true)
      expect((await tool(grant('main'), 'make', {})).isError).toBe(true)
      expect(calls).toEqual([])
    })
  })

  describe('workers', () => {
    const on = (limit = 4) => start({ enabled: true, limit })

    it('offers spawn_worker to every chat but a worker, only while the mod is on', async () => {
      const off = await start()
      expect(await off.names('main')).not.toContain('spawn_worker')
      expect(off.mcp.grant('bbbb0001')).toBeUndefined()

      const { names, mcp, chats } = await on()
      expect(await names('main')).toContain('spawn_worker')
      const tools = ['list_chats', 'read_chat', 'send_message', 'spawn_worker', 'stop_chat']
      expect(await names('aaaa0001')).toEqual(tools)
      expect(await names('bbbb0001')).toEqual(tools)
      chats.push(chat('eeee0001', { parentId: 'bbbb0001', worker: true }))
      expect(mcp.grant('eeee0001')).toBeUndefined()
    })

    it('refuses to spawn once the mod is turned off mid-session', async () => {
      const { calls, tool, grant, workers } = await on()
      const token = grant('aaaa0001')
      workers.enabled = false
      expect((await tool(token, 'spawn_worker', { task: 'Go' })).isError).toBe(true)
      expect(calls).toEqual([])
    })

    it("spawns a worker named after its task on its role's models, never an engine it names, and starts it", async () => {
      const { calls, json, tool, grant } = await on()
      expect(await json(grant('aaaa0001'), 'spawn_worker', { task: 'Read the tests' })).toEqual({
        chatId: 'dddd0001',
      })
      const search = { task: 'Search', engine: 'pi', role: 'searching' }
      expect(await json(grant('main'), 'spawn_worker', search)).toEqual({ chatId: 'dddd0001' })
      const long = `Lint   every file\nin ${'x'.repeat(WORKER_NAME_MAX_CHARS)}`
      expect(await json(grant('bbbb0001'), 'spawn_worker', { task: long })).toEqual({ chatId: 'dddd0001' })
      const name = `${`Lint every file in ${'x'.repeat(WORKER_NAME_MAX_CHARS)}`.slice(0, WORKER_NAME_MAX_CHARS)}…`
      const worker = { worker: true }
      expect(calls).toEqual([
        ['createChat', { parentId: 'aaaa0001', name: 'Read the tests', ...worker }],
        ['send', 'dddd0001', 'Read the tests'],
        ['createChat', { parentId: 'main', name: 'Search', worker: true, role: 'searching' }],
        ['send', 'dddd0001', 'Search'],
        ['createChat', { parentId: 'bbbb0001', name, ...worker }],
        ['send', 'dddd0001', long],
      ])
      expect((await tool(grant('main'), 'spawn_worker', { task: 'Go', role: 'chat' })).isError).toBe(true)
      expect(calls).toHaveLength(6)
    })

    it('counts running, waiting and stopping workers against the limit, never idle ones', async () => {
      const limit = 3
      const { chats, calls, tool, grant } = await on(limit)
      const under = (status: ChatState['status'], parentId = 'aaaa0001') => ({ parentId, worker: true, status })
      chats.push(
        chat('s1', under('running')),
        chat('s2', under('waiting')),
        chat('s3', under('stopping')),
        chat('s4', under('idle')),
        chat('s5', under('running', 'bbbb0001')),
      )
      expect(await tool(grant('aaaa0001'), 'spawn_worker', { task: 'One more' })).toEqual({
        isError: true,
        text: `This chat already has ${limit} workers running; the limit is ${limit}`,
      })
      expect(calls).toEqual([])
      chats.find((c) => c.id === 's3')!.status = 'idle'
      expect(await tool(grant('aaaa0001'), 'spawn_worker', { task: 'One more' })).toMatchObject({ isError: false })
    })

    it('never limits when the limit is -1', async () => {
      const { chats, tool, grant } = await on(-1)
      for (let i = 0; i < 20; i++) chats.push(chat(`s${i}`, { parentId: 'main', worker: true, status: 'running' }))
      expect(await tool(grant('main'), 'spawn_worker', { task: 'Go' })).toMatchObject({ isError: false })
    })

    it('shows a worker only to its own parent', async () => {
      const { chats, json, tool, grant } = await on()
      chats.push(
        chat('s1', { parentId: 'aaaa0001', worker: true }),
        chat('s2', { parentId: 'bbbb0001', worker: true }),
        chat('s3', { parentId: 'main', worker: true }),
      )
      const ids = async (chatId: string) => (await json(grant(chatId), 'list_chats')).map((c: { id: string }) => c.id)
      expect(await ids('main')).toEqual(['aaaa0001', 'bbbb0001', 'cccc0001', 's3'])
      expect(await ids('aaaa0001')).toEqual(['s1'])
      expect(await ids('bbbb0001')).toEqual(['s2'])
      expect(await tool(grant('bbbb0001'), 'read_chat', { chatId: 'aaaa0001' })).toEqual({
        isError: true,
        text: 'No chat "aaaa0001" this chat can reach',
      })
      expect((await tool(grant('main'), 'send_message', { chatId: 's1', text: 'hi' })).isError).toBe(true)
      expect(await tool(grant('bbbb0001'), 'send_message', { chatId: 's2', text: 'hi' })).toMatchObject({
        isError: false,
      })
    })
  })
})
