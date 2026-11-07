import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createFakeAdapter } from './adapters/fake.ts'
import { openCore } from './core.ts'
import { localMachine } from './machine.ts'
import { MEMORY_INSTRUCTIONS, MESSAGE_MAX_CHARS, ZOOM_INSTRUCTIONS } from './memory.ts'
import { startServer } from './server.ts'
import {
  BAD_TOKEN_CLOSE_CODE,
  WORKSHOP_NAME,
  type Adapter,
  type CoreMessage,
  type EngineEvent,
  type SessionOptions,
} from './shared.ts'

const origin = 'http://localhost:4318'
const token = 'test-token-0123456789'
const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function start(port = 0) {
  const garage = mkdtempSync(join(tmpdir(), 'hotrod-test-'))
  const project = mkdtempSync(join(tmpdir(), 'hotrod-test-'))
  const core = openCore({
    garage,
    adapters: [createFakeAdapter(undefined, 0)],
    defaultEngine: 'fake',
    machine: localMachine,
  })
  cleanups.push(() => {
    core.close()
    rmSync(garage, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  })
  const server = await startServer({
    core,
    port,
    uiOrigin: origin,
    token,
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

it('rejects with a readable error when the port is taken, leaving nothing uncaught', async () => {
  const taken = createServer()
  await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => taken.close(() => resolve())))
  const { port } = taken.address() as AddressInfo
  const uncaught: unknown[] = []
  const onUncaught = (error: unknown) => uncaught.push(error)
  process.on('uncaughtException', onUncaught)
  cleanups.push(() => void process.off('uncaughtException', onUncaught))

  await expect(start(port)).rejects.toThrow(`Port ${port} is in use. Is Hotrod already running?`)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(uncaught).toEqual([])
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
    chats: [expect.objectContaining({ id: 'main', name: WORKSHOP_NAME })],
    accounts: [{ engine: 'fake', active: 'default' }],
    modelLists: { fake: { chat: [], planning: [], searching: [], subagents: [] } },
    memory: {},
  })

  expect(a.messages[0]).not.toHaveProperty('projects')

  a.socket.send(JSON.stringify({ type: 'chat.create', name: 'App', folders: [project] }))
  await until(() => b.messages.some((m) => m.type === 'chat.added'))
  const added = b.messages.find((m) => m.type === 'chat.added')
  if (added?.type !== 'chat.added') throw new Error('no chat')

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
  await until(() => b.messages.some((m) => m.type === 'chat.queue' && m.queue[0]?.text === 'again'))
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

it("serves a chat's attachments with the token, images and PDFs inline and anything else as a download", async () => {
  const garage = mkdtempSync(join(tmpdir(), 'hotrod-test-'))
  const core = openCore({ garage, adapters: [createFakeAdapter([], 0)], defaultEngine: 'fake', machine: localMachine })
  const server = await startServer({ core, port: 0, uiOrigin: origin, token })
  cleanups.push(() => {
    core.close()
    rmSync(garage, { recursive: true, force: true })
  })
  cleanups.push(() => server.close())
  const handle = (m: Parameters<typeof core.handle>[0]) => core.handle(m, () => {})
  handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true })
  const upload = (name: string, mimeType: string, text: string) => ({
    name,
    mimeType,
    base64: Buffer.from(text).toString('base64'),
  })
  handle({
    type: 'chat.send',
    chatId: 'main',
    text: 'files',
    attachments: [
      upload('shot.png', 'image/png', 'png bytes'),
      upload('page é.html', 'text/html', '<script>'),
      upload('doc.pdf', 'application/pdf', '%PDF-1.4'),
    ],
  })
  handle({ type: 'chat.create', name: 'Other' })
  const other = core.chats().find((c) => c.name === 'Other')!
  await until(() => core.chats().every((c) => c.status === 'idle'))
  const base = `http://127.0.0.1:${server.port}`
  const get = (path: string, key = token) => fetch(`${base}${path}?token=${encodeURIComponent(key)}`)

  const image = await get('/chats/main/attachments/shot.png')
  expect(image.status).toBe(200)
  expect(image.headers.get('content-type')).toBe('image/png')
  expect(image.headers.get('content-disposition')).toBeNull()
  expect(image.headers.get('x-content-type-options')).toBe('nosniff')
  expect(image.headers.get('content-security-policy')).toBe('sandbox')
  expect(image.headers.get('access-control-allow-origin')).toBe(origin)
  expect(await image.text()).toBe('png bytes')
  const pdf = await get('/chats/main/attachments/doc.pdf')
  expect(pdf.headers.get('content-type')).toBe('application/pdf')
  expect(pdf.headers.get('content-disposition')).toBeNull()
  expect(pdf.headers.get('content-security-policy')).toBe('sandbox')
  expect(pdf.headers.get('x-content-type-options')).toBe('nosniff')
  const page = await get(`/chats/main/attachments/${encodeURIComponent('page é.html')}`)
  expect(page.headers.get('content-type')).toBe('application/octet-stream')
  expect(page.headers.get('content-disposition')).toBe(`attachment; filename*=UTF-8''page%20%C3%A9.html`)
  expect(page.headers.get('content-security-policy')).toBe('sandbox')
  expect(await page.text()).toBe('<script>')

  expect((await get('/chats/main/attachments/shot.png', 'wrong')).status).toBe(401)
  expect((await fetch(`${base}/chats/main/attachments/shot.png`)).status).toBe(401)
  for (const path of [
    '/chats/main/attachments/log.jsonl',
    '/chats/main/attachments/%2E%2E%2Flog.jsonl',
    '/chats/main/attachments/..%2Fchat.json',
    '/chats/main/attachments/%E0%A4%A',
    `/chats/${other.id}/attachments/shot.png`,
    '/chats/nope/attachments/shot.png',
  ]) {
    expect((await get(path)).status, path).toBe(404)
  }
})

it('serves no files without a UI folder', async () => {
  const { base } = await start()
  const response = await fetch(base.replace('ws:', 'http:'))
  expect(response.ok).toBe(false)
})

const heldOffers = {
  models: ['large', 'small'],
  thinking: ['low', 'high'],
}

async function startHeld({ hotrodMcp = true } = {}) {
  const garage = realpathSync(mkdtempSync(join(tmpdir(), 'hotrod-test-')))
  const sessions: { options: SessionOptions; prompt?: string; end: (reply?: string, error?: string) => void }[] = []
  const held: Adapter = {
    id: 'held',
    hotrodMcp,
    detect: async () => ({ installed: true, signedIn: true, ...heldOffers }),
    start(_machine, options, emit: (event: EngineEvent) => void) {
      const end = (reply?: string, error?: string) => {
        if (reply !== undefined) emit({ type: 'text.completed', text: reply })
        emit({ type: 'turn.completed', ...(error && { error }) })
      }
      const session: (typeof sessions)[number] = { options, end }
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
  const owners = new Map<(typeof sessions)[number], string>()
  core.onMessage((m) => {
    if (m.type === 'chat.entry' && m.entry.type === 'turn.started') owners.set(sessions.at(-1)!, m.chatId)
  })
  const sessionsOf = (chatId: string) => sessions.filter((s) => owners.get(s) === chatId)
  const sessionOf = (chatId: string) => sessionsOf(chatId).at(-1)!
  return { core, garage, messages, sessions, sessionOf, sessionsOf, mcpUrl, post, tool, json, send }
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
  core.handle({ type: 'chat.create', name: 'Side' }, () => {})
  const named = core.chats().find((c) => c.id !== 'main')!
  expect(send(named.id, 'hi').options.hotrodMcp).toEqual({ url: mcpUrl, token: expect.any(String) })
})

it('lets the Workshop make a named chat with a folder and start it, shown like ones the user made', async () => {
  const { core, garage, messages, sessions, tool, json, send } = await startHeld()
  const bearer = send('main', 'hi').options.hotrodMcp!.token
  const folder = join(garage, 'made', 'app')

  const bad = { name: 'App', prompt: 'x', folders: [folder], engine: 'nope' }
  expect(await tool(bearer, 'create_chat', bad)).toMatchObject({ isError: true })
  const made = { name: 'App', prompt: 'Look around', folders: [folder] }
  const { chatId } = await json(bearer, 'create_chat', made)
  expect(existsSync(folder) && readdirSync(folder)).toEqual([])
  const child = core.chats().find((c) => c.id === chatId)
  const folders = [realpathSync(folder)]
  expect(child).toMatchObject({ name: 'App', parentId: 'main', folders, engine: 'held', status: 'running' })
  expect(messages.some((m) => m.type === 'chat.added' && m.chat.id === chatId)).toBe(true)
  expect(sessions.at(-1)?.prompt).toBe('Look around')
  expect(sessions.at(-1)?.options.cwd).toBe(folders[0])

  expect(await tool(bearer, 'send_message', { chatId, text: 'more' })).toEqual({
    isError: true,
    text: `Chat "${chatId}" is running; wait until it is idle`,
  })
  sessions.at(-1)!.end()
  expect(await tool(bearer, 'send_message', { chatId, text: 'more' })).toMatchObject({ isError: false })
  expect(sessions.at(-1)?.prompt).toContain('more')
})

const handleOn = (core: ReturnType<typeof openCore>) => (m: Parameters<typeof core.handle>[0]) =>
  core.handle(m, () => {})
const chatIn = (core: ReturnType<typeof openCore>, id: string) => core.chats().find((c) => c.id === id)!

it('lets every user chat spawn subagents while the mod is on, up to the limit of running ones', async () => {
  const { core, garage, sessions, post, tool, json, send } = await startHeld()
  const handle = handleOn(core)
  const workshop = send('main', 'hi').options.hotrodMcp!.token
  expect((await (await post(workshop, 'spawn_subagent', { task: 'x' })).json()).error.message).toBe(
    'Tool spawn_subagent not found',
  )
  handle({ type: 'chat.create', name: 'Side' })
  const subchat = core.chats().find((c) => c.id !== 'main')!
  const before = send(subchat.id, 'hi').options.hotrodMcp!.token
  expect((await (await post(before, 'spawn_subagent', { task: 'x' })).json()).error.message).toBe(
    'Tool spawn_subagent not found',
  )

  handle({ type: 'subagents.set', enabled: true, limit: 1 })
  handle({ type: 'chat.interrupt', chatId: subchat.id, force: true })
  const lead = send(subchat.id, 'again').options.hotrodMcp!.token
  const { chatId } = await json(lead, 'spawn_subagent', { task: 'Read the tests' })
  expect(chatIn(core, chatId)).toMatchObject({
    name: 'Read the tests',
    parentId: subchat.id,
    subagent: true,
    engine: 'held',
    status: 'running',
  })
  expect(sessions.at(-1)).toMatchObject({ prompt: 'Read the tests', options: { cwd: join(garage, 'home') } })
  expect(JSON.parse(readFileSync(join(garage, 'chats', chatId, 'chat.json'), 'utf8')).parentId).toBe(subchat.id)

  expect(await tool(lead, 'spawn_subagent', { task: 'More' })).toEqual({
    isError: true,
    text: 'This chat already has 1 subagents running; the limit is 1',
  })
  sessions.at(-1)!.end('Done')
  expect((await json(lead, 'spawn_subagent', { task: 'More' })).chatId).not.toBe(chatId)
  expect((await json(workshop, 'list_chats')).map((c: { id: string }) => c.id)).toEqual([subchat.id])
})

it("starts a subagent on its role's list, keeping only its parent's thinking level", async () => {
  const { core, garage, json, send, sessionOf } = await startHeld()
  const handle = handleOn(core)
  await core.refreshEngines()
  handle({ type: 'subagents.set', enabled: true, limit: -1 })
  const [large, small] = heldOffers.models as [string, string]
  const thinking = heldOffers.thinking[1]
  handle({ type: 'chat.setModel', chatId: 'main', model: large, thinking })
  handle({ type: 'models.setList', engine: 'held', role: 'chat', models: [small] })
  handle({ type: 'models.setList', engine: 'held', role: 'planning', models: [large] })
  const token = send('main', 'Plan it').options.hotrodMcp!.token

  const helper = (await json(token, 'spawn_subagent', { task: 'Go' })).chatId
  expect(chatIn(core, helper)).toMatchObject({ role: 'subagents', thinking })
  expect(chatIn(core, helper).model).toBeUndefined()
  expect(sessionOf(helper).options).toMatchObject({ model: small, thinking })

  const planner = (await json(token, 'spawn_subagent', { task: 'Plan', role: 'planning' })).chatId
  expect(sessionOf(planner).options.model).toBe(large)
  expect(JSON.parse(readFileSync(join(garage, 'chats', planner, 'chat.json'), 'utf8')).role).toBe('planning')

  handle({ type: 'models.setList', engine: 'held', role: 'subagents', models: [large] })
  const next = (await json(token, 'spawn_subagent', { task: 'Again' })).chatId
  expect(sessionOf(next).options.model).toBe(large)
})

it("wakes the parent with a subagent's final reply, queued while the parent is busy", async () => {
  const { core, sessionOf, sessionsOf, json, send } = await startHeld()
  const handle = handleOn(core)
  handle({ type: 'subagents.set', enabled: true, limit: -1 })
  const parent = send('main', 'Plan it')
  const { chatId } = await json(parent.options.hotrodMcp!.token, 'spawn_subagent', { task: 'Search the docs' })

  sessionOf(chatId).end('Found it')
  const report = `[subagent "Search the docs" (${chatId})] Found it`
  expect(chatIn(core, 'main').queue.map((q) => q.text)).toEqual([report])
  parent.end('Waiting')
  expect(sessionOf('main').prompt?.endsWith(report)).toBe(true)
  expect(chatIn(core, 'main').status).toBe('running')
  sessionOf('main').end('Thanks')

  handle({ type: 'chat.send', chatId, text: 'One more thing' })
  sessionOf(chatId).end(undefined, 'Interrupted')
  const failed = `[subagent "Search the docs" (${chatId})] (No reply) (The turn ended early: Interrupted)`
  expect(sessionOf('main').prompt?.endsWith(failed)).toBe(true)
  expect(sessionsOf('main')).toHaveLength(3)
})

it("gives a subagent its parent's items plus its own, and archives and deletes it with its parent", async () => {
  const { core, garage, sessionOf, sessionsOf, json, send } = await startHeld()
  const handle = handleOn(core)
  handle({ type: 'subagents.set', enabled: true, limit: 4 })
  handle({ type: 'chat.create', name: 'Side' })
  const subchat = core.chats().find((c) => c.id !== 'main')!
  writeFileSync(join(garage, 'AGENTS.md'), 'WORKSHOP')
  writeFileSync(join(garage, 'chats', subchat.id, 'AGENTS.md'), 'PARENT')
  const lead = send(subchat.id, 'hi').options.hotrodMcp!.token
  const { chatId } = await json(lead, 'spawn_subagent', { task: 'Go' })
  writeFileSync(join(garage, 'chats', chatId, 'AGENTS.md'), 'OWN')
  sessionOf(chatId).end('ok')
  sessionOf(subchat.id).end('ok')
  sessionOf(subchat.id).end('ok')

  const itemsOf = (id: string) => {
    const replies: CoreMessage[] = []
    core.handle({ type: 'context.get', chatId: id }, (m) => replies.push(m))
    return replies[0]?.type === 'chat.context' ? replies[0].items : []
  }
  expect(itemsOf(chatId).map((i) => i.from)).toEqual(['main', subchat.id, chatId])
  handle({ type: 'chat.send', chatId, text: 'again' })
  const instructions = sessionOf(chatId).options.instructions.split('\n\n')
  expect(instructions.slice(0, 2)).toEqual([MEMORY_INSTRUCTIONS, ZOOM_INSTRUCTIONS])
  expect(instructions.slice(-3)).toEqual(['WORKSHOP', 'PARENT', 'OWN'])
  sessionOf(chatId).end('ok')
  sessionOf(subchat.id).end('ok')
  expect(sessionsOf(subchat.id)).toHaveLength(3)

  const parentRules = join(garage, 'chats', subchat.id, 'AGENTS.md')
  handle({ type: 'context.set', chatId: subchat.id, path: parentRules, enabled: false })
  expect(itemsOf(chatId).find((i) => i.path === parentRules)).toMatchObject({ enabled: false })

  handle({ type: 'chat.archive', chatId: subchat.id, archived: true })
  expect(chatIn(core, chatId).archived).toBe(true)
  expect(() => handle({ type: 'chat.archive', chatId, archived: false })).toThrow(/Unarchive "Side" first/)
  handle({ type: 'chat.delete', chatId: subchat.id })
  expect(core.chats().some((c) => c.id === chatId)).toBe(false)
  expect(existsSync(join(garage, 'chats', chatId))).toBe(false)
})

it('lets every chat zoom its own memory, and cuts a long message only where zoom can bring it back', async () => {
  const long = 'x'.repeat(MESSAGE_MAX_CHARS + 10)
  for (const hotrodMcp of [true, false]) {
    const { send, tool } = await startHeld({ hotrodMcp })
    send('main', long).end('ok')
    const next = send('main', 'next')
    if (hotrodMcp) {
      expect(next.options.instructions.split('\n\n')).toContain(ZOOM_INSTRUCTIONS)
      expect(next.prompt).toContain(`cut at ${MESSAGE_MAX_CHARS} of ${long.length} chars; zoom(0) for the rest`)
      expect((await tool(next.options.hotrodMcp!.token, 'zoom', { id: 0 })).text).toMatch(new RegExp(`\\n\\n${long}$`))
    } else {
      expect(next.options.hotrodMcp).toBeUndefined()
      expect(next.options.instructions).not.toContain(ZOOM_INSTRUCTIONS)
      expect(next.prompt).toContain(`\n${long}\n`)
    }
  }
})

it("gives a subagent its parent's memory frozen at launch, with read-only zoom and date into it", async () => {
  const { core, garage, json, tool, send, sessionOf } = await startHeld()
  handleOn(core)({ type: 'subagents.set', enabled: true, limit: -1 })
  const parent = send('main', 'Plan the release')
  const { chatId } = await json(parent.options.hotrodMcp!.token, 'spawn_subagent', { task: 'Check the changelog' })
  const frozen = '<message id="0" kind="user">\nPlan the release\n</message>'
  const first = sessionOf(chatId)
  expect(first.options.instructions).toContain(`Your parent chat's memory when it started you`)
  expect(first.options.instructions).toContain(frozen)
  expect(first.prompt).toBe('Check the changelog')
  expect(chatIn(core, chatId).parentMessages).toBe(1)
  expect(JSON.parse(readFileSync(join(garage, 'chats', chatId, 'chat.json'), 'utf8')).parentMessages).toBe(1)
  const token = first.options.hotrodMcp!.token
  expect((await tool(token, 'zoom', { id: 0, parent: true })).text).toMatch(/\n\nPlan the release$/)
  expect((await tool(token, 'date', { id: 0, parent: true })).isError).toBe(false)

  first.end('Checked')
  parent.end('Waiting')
  sessionOf('main').end('Thanks')
  handleOn(core)({ type: 'chat.send', chatId, text: 'Once more' })
  const again = sessionOf(chatId)
  expect(again.options.instructions).toContain(frozen)
  expect(again.options.instructions).not.toContain('Waiting')
  expect(await tool(again.options.hotrodMcp!.token, 'zoom', { id: 1, parent: true })).toEqual({
    isError: true,
    text: 'No message 1; this chat has messages 0 to 0',
  })
})
