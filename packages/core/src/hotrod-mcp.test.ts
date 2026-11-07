import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openHotrodMcp } from './hotrod-mcp.ts'
import type { ChatEntry, ChatState, Project } from './types.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const at = '2026-11-07T00:00:00.000Z'

function chat(id: string, change: Partial<ChatState> = {}): ChatState {
  const main = id === 'main' || id.endsWith('/main')
  const projectId = id.includes('/') ? id.split('/')[0] : undefined
  return {
    id,
    ...(projectId ? { projectId } : {}),
    main,
    title: main ? 'Main' : `Chat ${id}`,
    engine: 'fake',
    archived: false,
    createdAt: at,
    status: 'idle',
    entries: [],
    draft: '',
    ...change,
  }
}

async function start() {
  const projects: Project[] = [
    { id: 'app', name: 'app', path: '/tmp/app', archived: false },
    { id: 'web', name: 'web', path: '/tmp/web', archived: false },
  ]
  const chats: ChatState[] = [
    chat('main'),
    chat('aaaa0001'),
    chat('app/main'),
    chat('bbbb0001', { projectId: 'app' }),
    chat('web/main'),
    chat('cccc0001', { projectId: 'web' }),
  ]
  const calls: unknown[][] = []
  const mcp = openHotrodMcp({
    chats: () => chats,
    projects: () => projects,
    addProject(path, name) {
      calls.push(['addProject', path, name])
      const project = { id: 'new', name: name ?? 'new', path, archived: false }
      projects.push(project)
      return project
    },
    createChat(projectId, engine) {
      calls.push(['createChat', projectId, engine])
      const created = chat('dddd0001', projectId ? { projectId } : {})
      chats.push(created)
      return created
    },
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
  return { mcp, chats, calls, rpc, tool, json, grant }
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

  it('gives subchats no token', async () => {
    const { mcp } = await start()
    expect(mcp.grant('aaaa0001')).toBeUndefined()
    expect(mcp.grant('bbbb0001')).toBeUndefined()
    expect(mcp.grant('nope')).toBeUndefined()
  })

  it('offers create_project to the Workshop only', async () => {
    const { rpc, grant } = await start()
    const names = async (chatId: string) =>
      (await rpc(grant(chatId), 'tools/list')).body.result.tools.map((t: { name: string }) => t.name).sort()
    expect(await names('main')).toEqual(['create_chat', 'create_project', 'list_chats', 'read_chat', 'send_message'])
    expect(await names('app/main')).toEqual(['create_chat', 'list_chats', 'read_chat', 'send_message'])
  })

  it('lists every other chat to the Workshop', async () => {
    const { json, grant } = await start()
    const listed = await json(grant('main'), 'list_chats')
    expect(listed.map((c: { id: string }) => c.id)).toEqual([
      'aaaa0001',
      'app/main',
      'bbbb0001',
      'web/main',
      'cccc0001',
    ])
    expect(listed[1]).toEqual({
      id: 'app/main',
      title: 'Main',
      project: { id: 'app', name: 'app', path: '/tmp/app' },
      status: 'idle',
      engine: 'fake',
      archived: false,
    })
  })

  it("lists only its own project's subchats to a project main chat", async () => {
    const { json, grant } = await start()
    const listed = await json(grant('app/main'), 'list_chats')
    expect(listed.map((c: { id: string }) => c.id)).toEqual(['bbbb0001'])
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
    chats.find((c) => c.id === 'bbbb0001')!.entries = entries
    const token = grant('app/main')
    expect(await tool(token, 'read_chat', { chatId: 'bbbb0001' })).toEqual({
      isError: false,
      text: 'User: List the files\n\nTool Bash: ls -la\n\nAssistant: Two files.\n\n[Turn ended early: Interrupted]',
    })
    expect((await tool(token, 'read_chat', { chatId: 'bbbb0001', last: 2 })).text).toBe(
      'Assistant: Two files.\n\n[Turn ended early: Interrupted]',
    )
  })

  it('refuses to read or message a chat outside the caller’s subtree', async () => {
    const { calls, tool, grant } = await start()
    const token = grant('app/main')
    for (const chatId of ['main', 'aaaa0001', 'web/main', 'cccc0001', 'app/main', 'nope']) {
      const refused = { isError: true, text: `No chat "${chatId}" below this one` }
      expect(await tool(token, 'read_chat', { chatId })).toEqual(refused)
      expect((await tool(token, 'send_message', { chatId, text: 'hi' })).isError).toBe(true)
    }
    expect(calls).toEqual([])
  })

  it('sends a message to an idle descendant and refuses a busy one', async () => {
    const { chats, calls, tool, grant } = await start()
    const token = grant('main')
    expect(await tool(token, 'send_message', { chatId: 'bbbb0001', text: 'Go on' })).toMatchObject({ isError: false })
    expect(calls).toEqual([['send', 'bbbb0001', 'Go on']])
    chats.find((c) => c.id === 'app/main')!.status = 'running'
    expect(await tool(token, 'send_message', { chatId: 'app/main', text: 'Hi' })).toEqual({
      isError: true,
      text: 'Chat "app/main" is running; wait until it is idle',
    })
    expect(calls).toHaveLength(1)
  })

  it('creates a subchat under the caller and starts it with the prompt', async () => {
    const { calls, json, tool, grant } = await start()
    expect(await json(grant('main'), 'create_chat', { prompt: 'Research X' })).toEqual({ chatId: 'dddd0001' })
    expect(await json(grant('main'), 'create_chat', { prompt: 'Fix Y', projectId: 'web', engine: 'pi' })).toEqual({
      chatId: 'dddd0001',
    })
    expect(await json(grant('app/main'), 'create_chat', { prompt: 'Fix Z' })).toEqual({ chatId: 'dddd0001' })
    expect(await tool(grant('app/main'), 'create_chat', { prompt: 'Sneak', projectId: 'web' })).toEqual({
      isError: true,
      text: 'No project "web" below this chat',
    })
    expect(calls).toEqual([
      ['createChat', undefined, undefined],
      ['send', 'dddd0001', 'Research X'],
      ['createChat', 'web', 'pi'],
      ['send', 'dddd0001', 'Fix Y'],
      ['createChat', 'app', undefined],
      ['send', 'dddd0001', 'Fix Z'],
    ])
  })

  it('creates a project from an absolute path, making the folder but never touching its contents', async () => {
    const { calls, json, tool, grant } = await start()
    const root = mkdtempSync(join(tmpdir(), 'hotrod-mcp-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const existing = join(root, 'existing')
    mkdirSync(existing)
    writeFileSync(join(existing, 'keep.txt'), 'keep')
    const fresh = join(root, 'deep', 'fresh')
    const token = grant('main')

    expect(await tool(token, 'create_project', { path: 'relative/dir' })).toEqual({
      isError: true,
      text: 'The path must be absolute: relative/dir',
    })
    expect((await json(token, 'create_project', { path: existing })).project.id).toBe('new')
    expect(await json(token, 'create_project', { path: fresh, name: 'Fresh' })).toEqual({
      project: { id: 'new', name: 'Fresh', path: fresh },
      chatId: 'new/main',
    })
    expect(readdirSync(existing)).toEqual(['keep.txt'])
    expect(existsSync(fresh)).toBe(true)
    expect(calls).toEqual([
      ['addProject', existing, undefined],
      ['addProject', fresh, 'Fresh'],
    ])
  })

  it('refuses create_project from a project main chat', async () => {
    const { calls, tool, grant } = await start()
    const result = await tool(grant('app/main'), 'create_project', { path: '/tmp/x' })
    expect(result.isError).toBe(true)
    expect(calls).toEqual([])
  })
})
