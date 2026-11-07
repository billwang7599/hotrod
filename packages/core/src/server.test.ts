import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createFakeAdapter } from './adapters/fake.ts'
import { openCore } from './core.ts'
import { localMachine } from './machine.ts'
import { startServer } from './server.ts'
import { BAD_TOKEN_CLOSE_CODE, type Adapter, type CoreMessage, type EngineEvent, type SessionOptions } from './types.ts'

const origin = 'http://localhost:4318'
const token = 'test-token-0123456789'
const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function start() {
  const garage = mkdtempSync(join(tmpdir(), 'hotrod-test-'))
  const project = mkdtempSync(join(tmpdir(), 'hotrod-test-'))
  const core = openCore({
    garage,
    adapters: [createFakeAdapter(undefined, 0)],
    defaultEngine: 'fake',
    machine: localMachine,
  })
  const server = await startServer({
    core,
    port: 0,
    uiOrigin: origin,
    token,
  })
  cleanups.push(() => {
    core.close()
    rmSync(garage, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  })
  cleanups.push(() => server.close())
  const base = `ws://127.0.0.1:${server.port}`
  return { base, url: `${base}/?token=${token}`, project }
}

function connect(url: string, headers: { origin?: string }) {
  const socket = new WebSocket(url, headers)
  const messages: CoreMessage[] = []
  socket.on('message', (data) => messages.push(JSON.parse(String(data))))
  socket.on('error', () => {})
  cleanups.push(() => socket.terminate())
  return { socket, messages }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
  if (!check()) throw new Error('timed out')
}

it('rejects other origins', async () => {
  const { url } = await start()
  for (const headers of [{ origin: 'http://evil.example' }, {}]) {
    const { socket } = connect(url, headers)
    const status = await new Promise<number>((resolve) =>
      socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)),
    )
    expect(status).toBe(403)
  }
})

it('closes connections without the right token before sending anything', async () => {
  const { base } = await start()
  for (const query of ['', '?token=', '?token=wrong', `?token=${token.slice(0, -1)}X`, `?token=${token}x`]) {
    const { socket, messages } = connect(`${base}/${query}`, { origin })
    const close = await new Promise<{ code: number; reason: string }>((resolve) =>
      socket.on('close', (code, reason) => resolve({ code, reason: String(reason) })),
    )
    expect(close).toEqual({ code: BAD_TOKEN_CLOSE_CODE, reason: 'Missing or wrong token' })
    expect(messages).toEqual([])
  }
})

it('sends a snapshot, then broadcasts to every client', async () => {
  const { url, project } = await start()
  const a = connect(url, { origin })
  const b = connect(url, { origin })
  await until(() => a.messages.length > 0 && b.messages.length > 0)
  expect(a.messages[0]).toMatchObject({
    type: 'snapshot',
    engines: [{ id: 'fake', enabled: false }],
    projects: [],
    chats: [expect.objectContaining({ id: 'main', title: 'Workshop' })],
    accounts: [{ engine: 'fake', active: 'default' }],
  })

  a.socket.send(JSON.stringify({ type: 'project.add', path: project }))
  await until(() => b.messages.some((m) => m.type === 'project.added'))
  const added = b.messages.find((m) => m.type === 'project.added')
  if (added?.type !== 'project.added') throw new Error('no project')

  a.socket.send(JSON.stringify({ type: 'chat.setEngine', chatId: added.chat.id, engine: 'nope' }))
  await until(() => a.messages.some((m) => m.type === 'error'))
  a.socket.send(JSON.stringify({ type: 'engine.setEnabled', engine: 'fake', enabled: true }))
  await until(() => b.messages.some((m) => m.type === 'engine.updated' && m.engine.enabled))
  a.socket.send(JSON.stringify({ type: 'chat.setEngine', chatId: added.chat.id, engine: 'fake' }))
  await until(() => b.messages.some((m) => m.type === 'chat.updated'))
  expect(b.messages.some((m) => m.type === 'error')).toBe(false)

  a.socket.send(JSON.stringify({ type: 'chat.send', chatId: added.chat.id, text: 'hi' }))
  await until(() => b.messages.some((m) => m.type === 'chat.status' && m.status === 'waiting'))
  expect(b.messages.some((m) => m.type === 'chat.delta')).toBe(true)

  a.socket.send(JSON.stringify({ type: 'chat.send', chatId: added.chat.id, text: 'again' }))
  await until(() => a.messages.filter((m) => m.type === 'error').length === 2)
  expect(b.messages.some((m) => m.type === 'error')).toBe(false)
})

it('answers bad messages with an error', async () => {
  const { url } = await start()
  const a = connect(url, { origin })
  await until(() => a.messages.length > 0)
  a.socket.send('not json')
  a.socket.send(JSON.stringify({ type: 'chat.send', chatId: 'nope', text: 'hi' }))
  await until(() => a.messages.filter((m) => m.type === 'error').length === 2)
})

it('serves the UI folder when given one', async () => {
  const garage = mkdtempSync(join(tmpdir(), 'hotrod-test-'))
  const uiDir = mkdtempSync(join(tmpdir(), 'hotrod-test-'))
  mkdirSync(join(uiDir, 'assets'))
  writeFileSync(join(uiDir, 'index.html'), '<html>hotrod</html>')
  writeFileSync(join(uiDir, 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(garage, 'secret.txt'), 'secret')
  const core = openCore({
    garage,
    adapters: [createFakeAdapter(undefined, 0)],
    defaultEngine: 'fake',
    machine: localMachine,
  })
  const server = await startServer({
    core,
    port: 0,
    uiOrigin: origin,
    token,
    uiDir,
  })
  cleanups.push(() => {
    core.close()
    rmSync(garage, { recursive: true, force: true })
    rmSync(uiDir, { recursive: true, force: true })
  })
  cleanups.push(() => server.close())
  const base = `http://127.0.0.1:${server.port}`

  const index = await fetch(`${base}/`)
  expect(index.headers.get('content-type')).toContain('text/html')
  expect(await index.text()).toBe('<html>hotrod</html>')
  const script = await fetch(`${base}/assets/app.js`)
  expect(script.headers.get('content-type')).toContain('text/javascript')
  expect(await script.text()).toBe('console.log(1)')
  expect(await (await fetch(`${base}/projects/x`)).text()).toBe('<html>hotrod</html>')
  const escaped = await fetch(`${base}/..%2f${basename(garage)}%2fsecret.txt`)
  expect(await escaped.text()).not.toContain('secret')
})

it('serves no files without a UI folder', async () => {
  const { base } = await start()
  const response = await fetch(base.replace('ws:', 'http:'))
  expect(response.ok).toBe(false)
})

async function startHeld() {
  const garage = mkdtempSync(join(tmpdir(), 'hotrod-test-'))
  const sessions: { options: SessionOptions; prompt?: string; end: () => void }[] = []
  const held: Adapter = {
    id: 'held',
    detect: async () => ({ installed: true, signedIn: true }),
    start(_machine, options, emit: (event: EngineEvent) => void) {
      const session: (typeof sessions)[number] = { options, end: () => emit({ type: 'turn.completed' }) }
      sessions.push(session)
      return {
        prompt: (text) => {
          session.prompt = text
          emit({ type: 'turn.started' })
        },
        interrupt: () => {},
        respond: () => {},
        close: () => {},
      }
    },
  }
  const core = openCore({ garage, adapters: [held], defaultEngine: 'held', machine: localMachine })
  core.handle({ type: 'engine.setEnabled', engine: 'held', enabled: true }, () => {})
  const messages: CoreMessage[] = []
  core.onMessage((m) => messages.push(m))
  const server = await startServer({ core, port: 0, uiOrigin: origin, token })
  cleanups.push(() => {
    core.close(true)
    rmSync(garage, { recursive: true, force: true })
  })
  cleanups.push(() => server.close())
  const mcpUrl = `http://127.0.0.1:${server.port}/mcp`
  const post = (bearer: string, name: string, args: Record<string, unknown> = {}) =>
    fetch(mcpUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
  const tool = async (bearer: string, name: string, args: Record<string, unknown> = {}) => {
    const { result } = await (await post(bearer, name, args)).json()
    return { isError: result.isError === true, text: result.content[0].text as string }
  }
  const json = async (bearer: string, name: string, args: Record<string, unknown> = {}) => {
    const result = await tool(bearer, name, args)
    expect(result).toMatchObject({ isError: false })
    return JSON.parse(result.text)
  }
  const send = (chatId: string, text: string) => {
    core.handle({ type: 'chat.send', chatId, text }, () => {})
    return sessions.at(-1)!
  }
  return { core, garage, messages, sessions, mcpUrl, post, tool, json, send }
}

it("gives a main chat's session the Hotrod MCP server, only while the session lives", async () => {
  const { core, mcpUrl, post, json, send } = await startHeld()
  const session = send('main', 'hi')
  const bearer = session.options.hotrodMcp?.token ?? ''
  expect(session.options.hotrodMcp).toEqual({ url: mcpUrl, token: expect.any(String) })
  expect(await json(bearer, 'list_chats')).toEqual([])
  expect((await post('wrong', 'list_chats')).status).toBe(401)
  expect((await post('', 'list_chats')).status).toBe(401)

  session.end()
  expect((await post(bearer, 'list_chats')).status).toBe(401)
  core.handle({ type: 'chat.create' }, () => {})
  const subchat = core.chats().find((c) => !c.main)!
  expect(send(subchat.id, 'hi').options.hotrodMcp).toBeUndefined()
})

it('lets the Workshop add a project and start a subchat in it, shown like ones the user made', async () => {
  const { core, garage, messages, sessions, tool, json, send } = await startHeld()
  const bearer = send('main', 'hi').options.hotrodMcp!.token
  const folder = join(garage, 'made', 'app')

  const made = await json(bearer, 'create_project', { path: folder, name: 'App' })
  expect(made).toEqual({ project: { id: 'App', name: 'App', path: expect.any(String) }, chatId: 'App/main' })
  expect(existsSync(folder) && readdirSync(folder)).toEqual([])
  expect(messages.some((m) => m.type === 'project.added' && m.project.id === 'App')).toBe(true)

  expect(await tool(bearer, 'create_chat', { prompt: 'x', projectId: 'App', engine: 'nope' })).toMatchObject({
    isError: true,
  })
  const { chatId } = await json(bearer, 'create_chat', { prompt: 'Look around', projectId: 'App' })
  const child = core.chats().find((c) => c.id === chatId)
  expect(child).toMatchObject({ projectId: 'App', main: false, engine: 'held', status: 'running' })
  expect(messages.some((m) => m.type === 'chat.added' && m.chat.id === chatId)).toBe(true)
  expect(sessions.at(-1)?.prompt).toBe('Look around')
  expect(sessions.at(-1)?.options.hotrodMcp).toBeUndefined()

  expect(await tool(bearer, 'send_message', { chatId, text: 'more' })).toEqual({
    isError: true,
    text: `Chat "${chatId}" is running; wait until it is idle`,
  })
  sessions.at(-1)!.end()
  expect(await tool(bearer, 'send_message', { chatId, text: 'more' })).toMatchObject({ isError: false })
  expect(sessions.at(-1)?.prompt).toContain('more')
})

it("keeps a project main chat to its own project's chats", async () => {
  const { garage, tool, json, send } = await startHeld()
  const workshop = send('main', 'hi').options.hotrodMcp!.token
  await json(workshop, 'create_project', { path: join(garage, 'a') })
  await json(workshop, 'create_project', { path: join(garage, 'b') })
  const inA = (await json(workshop, 'create_chat', { prompt: 'A work', projectId: 'a' })).chatId
  const inB = (await json(workshop, 'create_chat', { prompt: 'B work', projectId: 'b' })).chatId

  const lead = send('a/main', 'hi').options.hotrodMcp!.token
  expect((await json(lead, 'list_chats')).map((c: { id: string }) => c.id)).toEqual([inA])
  const refused = { isError: true, text: `No chat "${inB}" below this one` }
  expect(await tool(lead, 'read_chat', { chatId: inB })).toEqual(refused)
  expect(await tool(lead, 'read_chat', { chatId: 'main' })).toMatchObject({ isError: true })
  expect((await tool(lead, 'read_chat', { chatId: inA })).text).toBe('User: A work')
})
