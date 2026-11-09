import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Mod } from '@hotrod/mod-api'
import { afterEach, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createFakeAdapter } from './adapters/fake.ts'
import { sandboxingMachine } from './adapters/test-machine.ts'
import { openCore } from './core.ts'
import { SUBAGENT_INSTRUCTIONS, SUBAGENTS_MOD } from './hotrod-mcp.ts'
import { MEMORY_INSTRUCTIONS, MESSAGE_MAX_CHARS, ZOOM_INSTRUCTIONS } from './memory.ts'
import { startServer } from './server.ts'
import {
  BAD_TOKEN_CLOSE_CODE,
  GLOBAL_CONTEXT,
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
    machine: sandboxingMachine,
  })
  core.handle({ type: 'workFolder.set', path: join(garage, 'work') }, () => {})
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
    chats: [],
    accounts: [{ engine: 'fake', active: 'default' }],
    modelLists: { fake: { chat: [], planning: [], searching: [], subagents: [] } },
    memory: {},
    mods: [expect.objectContaining({ id: SUBAGENTS_MOD.id, enabled: true, values: { limit: expect.any(Number), instructions: SUBAGENT_INSTRUCTIONS } })],
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
    machine: sandboxingMachine,
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
  const core = openCore({
    garage,
    adapters: [createFakeAdapter([], 0)],
    defaultEngine: 'fake',
    machine: sandboxingMachine,
  })
  core.handle({ type: 'workFolder.set', path: join(garage, 'work') }, () => {})
  const server = await startServer({ core, port: 0, uiOrigin: origin, token })
  cleanups.push(() => {
    core.close()
    rmSync(garage, { recursive: true, force: true })
  })
  cleanups.push(() => server.close())
  const handle = (m: Parameters<typeof core.handle>[0]) => core.handle(m, () => {})
  handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true })
  handle({ type: 'chat.create', name: 'Mine' })
  const mine = core.chats().find((c) => c.name === 'Mine')!.id
  const upload = (name: string, mimeType: string, text: string) => ({
    name,
    mimeType,
    base64: Buffer.from(text).toString('base64'),
  })
  handle({
    type: 'chat.send',
    chatId: mine,
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

  const image = await get(`/chats/${mine}/attachments/shot.png`)
  expect(image.status).toBe(200)
  expect(image.headers.get('content-type')).toBe('image/png')
  expect(image.headers.get('content-disposition')).toBeNull()
  expect(image.headers.get('x-content-type-options')).toBe('nosniff')
  expect(image.headers.get('content-security-policy')).toBe('sandbox')
  expect(image.headers.get('access-control-allow-origin')).toBe(origin)
  expect(await image.text()).toBe('png bytes')
  const pdf = await get(`/chats/${mine}/attachments/doc.pdf`)
  expect(pdf.headers.get('content-type')).toBe('application/pdf')
  expect(pdf.headers.get('content-disposition')).toBeNull()
  expect(pdf.headers.get('content-security-policy')).toBe('sandbox')
  expect(pdf.headers.get('x-content-type-options')).toBe('nosniff')
  const page = await get(`/chats/${mine}/attachments/${encodeURIComponent('page é.html')}`)
  expect(page.headers.get('content-type')).toBe('application/octet-stream')
  expect(page.headers.get('content-disposition')).toBe(`attachment; filename*=UTF-8''page%20%C3%A9.html`)
  expect(page.headers.get('content-security-policy')).toBe('sandbox')
  expect(await page.text()).toBe('<script>')

  expect((await get(`/chats/${mine}/attachments/shot.png`, 'wrong')).status).toBe(401)
  expect((await fetch(`${base}/chats/${mine}/attachments/shot.png`)).status).toBe(401)
  for (const path of [
    `/chats/${mine}/attachments/log.jsonl`,
    `/chats/${mine}/attachments/%2E%2E%2Flog.jsonl`,
    `/chats/${mine}/attachments/..%2Fchat.json`,
    `/chats/${mine}/attachments/%E0%A4%A`,
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

const mainMod: Mod = {
  id: 'main-mod',
  name: 'Main mod',
  description: '',
  enabledByDefault: true,
  chats: [{ id: 'main', name: 'Main', instructions: 'MAIN ROLE', seesAll: true }],
  tools: [
    {
      name: 'make_space',
      description: 'Make a space and start it',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          prompt: { type: 'string' },
          folders: { type: 'array', items: { type: 'string' } },
          engine: { type: 'string' },
        },
        required: ['name'],
      },
      offered: (caller) => caller.id === 'main',
      run({ prompt, ...spec }, { host }) {
        const chat = host.createChat(spec as { name: string })
        if (typeof prompt === 'string') host.send(chat.id, prompt)
        return { chatId: chat.id }
      },
    },
  ],
}

async function startHeld({ hotrodMcp = true, mods = [mainMod] } = {}) {
  const garage = realpathSync(mkdtempSync(join(tmpdir(), 'hotrod-test-')))
  const sessions: {
    options: SessionOptions
    prompt?: string
    end: (reply?: string, error?: string) => void
    emit: (event: EngineEvent) => void
  }[] = []
  const held: Adapter = {
    id: 'held',
    hotrodMcp,
    detect: async () => ({ installed: true, signedIn: true, ...heldOffers }),
    start(_machine, options, emit: (event: EngineEvent) => void) {
      const end = (reply?: string, error?: string) => {
        if (reply !== undefined) emit({ type: 'text.completed', text: reply })
        emit({ type: 'turn.completed', ...(error && { error }) })
      }
      const session: (typeof sessions)[number] = { options, end, emit }
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
  const core = openCore({
    garage,
    adapters: [held],
    defaultEngine: 'held',
    machine: sandboxingMachine,
    mods,
  })
  core.handle({ type: 'engine.setEnabled', engine: 'held', enabled: true }, () => {})
  core.handle({ type: 'workFolder.set', path: join(garage, 'work') }, () => {})
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

it("runs a mod's tool, whose host makes a top-level chat and starts it, shown like ones the user made", async () => {
  const { core, garage, messages, sessions, tool, json, send } = await startHeld()
  const bearer = send('main', 'hi').options.hotrodMcp!.token
  const folder = join(garage, 'made', 'app')
  mkdirSync(folder, { recursive: true })

  const bad = { name: 'App', prompt: 'x', folders: [folder], engine: 'nope' }
  expect(await tool(bearer, 'make_space', bad)).toMatchObject({ isError: true })
  const made = { name: 'App', prompt: 'Look around', folders: [folder] }
  const { chatId } = await json(bearer, 'make_space', made)
  const child = core.chats().find((c) => c.id === chatId)
  const folders = [realpathSync(folder)]
  expect(child).toMatchObject({ name: 'App', folders, engine: 'held', status: 'running' })
  expect(child).not.toHaveProperty('parentId')
  expect(messages.some((m) => m.type === 'chat.added' && m.chat.id === chatId)).toBe(true)
  expect(sessions.at(-1)?.prompt).toBe('Look around')
  expect(sessions.at(-1)?.options).toMatchObject({ cwd: join(garage, 'work', chatId), extraDirs: folders })

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
const subagentsOn = (core: ReturnType<typeof openCore>, limit?: number) => {
  handleOn(core)({ type: 'mod.setEnabled', modId: SUBAGENTS_MOD.id, enabled: true })
  if (limit !== undefined) handleOn(core)({ type: 'mod.setValue', modId: SUBAGENTS_MOD.id, key: 'limit', value: limit })
}
const chatIn = (core: ReturnType<typeof openCore>, id: string) => core.chats().find((c) => c.id === id)!

it('lets every user chat spawn subagents while the mod is on, up to the limit of running ones', async () => {
  const { core, garage, sessions, post, tool, json, send } = await startHeld()
  const handle = handleOn(core)
  handle({ type: 'mod.setEnabled', modId: SUBAGENTS_MOD.id, enabled: false })
  const workshop = send('main', 'hi').options.hotrodMcp!.token
  expect((await (await post(workshop, 'spawn_subagent', { task: 'x' })).json()).error.message).toBe(
    'Tool spawn_subagent not found',
  )
  handle({ type: 'chat.create', name: 'Side' })
  const subchat = core.chats().find((c) => c.id !== 'main')!
  const offered = send(subchat.id, 'hi').options
  expect(offered.instructions).not.toContain(SUBAGENT_INSTRUCTIONS)
  const before = offered.hotrodMcp!.token
  expect((await (await post(before, 'spawn_subagent', { task: 'x' })).json()).error.message).toBe(
    'Tool spawn_subagent not found',
  )

  subagentsOn(core, 1)
  handle({ type: 'chat.interrupt', chatId: subchat.id, force: true })
  const leading = send(subchat.id, 'again').options
  expect(leading.instructions).toContain(SUBAGENT_INSTRUCTIONS)
  const lead = leading.hotrodMcp!.token
  const { chatId } = await json(lead, 'spawn_subagent', { task: 'Read the tests' })
  expect(sessions.at(-1)?.options.instructions).not.toContain(SUBAGENT_INSTRUCTIONS)
  expect(chatIn(core, chatId)).toMatchObject({
    name: 'Read the tests',
    parentId: subchat.id,
    subagent: true,
    engine: 'held',
    status: 'running',
  })
  const cwd = join(garage, 'work', subchat.id)
  expect(sessions.at(-1)).toMatchObject({ prompt: 'Read the tests', options: { cwd } })
  expect(JSON.parse(readFileSync(join(garage, 'chats', chatId, 'chat.json'), 'utf8')).parentId).toBe(subchat.id)

  expect(await tool(lead, 'spawn_subagent', { task: 'More' })).toEqual({
    isError: true,
    text: 'This chat already has 1 subagents running; the limit is 1',
  })
  sessions.at(-1)!.end('Done')
  expect((await json(lead, 'spawn_subagent', { task: 'More' })).chatId).not.toBe(chatId)
  expect((await json(workshop, 'list_chats')).map((c: { id: string }) => c.id)).toEqual([subchat.id])
})

it('tells a chat that can spawn subagents the saved subagent instructions, or the default when blank', async () => {
  const { core, sessions, send } = await startHeld()
  subagentsOn(core)
  const setInstructions = (value: string) =>
    handleOn(core)({ type: 'mod.setValue', modId: SUBAGENTS_MOD.id, key: 'instructions', value })
  setInstructions('Spawn one subagent per failing test.')
  const custom = send('main', 'hi').options.instructions
  expect(custom).toContain('Spawn one subagent per failing test.')
  expect(custom).not.toContain(SUBAGENT_INSTRUCTIONS)
  sessions.at(-1)!.end()

  setInstructions('  \n')
  expect(send('main', 'again').options.instructions).toContain(SUBAGENT_INSTRUCTIONS)
})

it("starts a subagent on its parent's model and thinking level, unless a role or the Subagents list picks them", async () => {
  const { core, garage, json, send, sessionOf } = await startHeld()
  const handle = handleOn(core)
  await core.refreshEngines()
  subagentsOn(core, -1)
  const [large, small] = heldOffers.models as [string, string]
  const thinking = heldOffers.thinking[1]
  handle({ type: 'chat.setModel', chatId: 'main', model: large, thinking })
  handle({ type: 'models.setList', engine: 'held', role: 'chat', models: [small] })
  handle({ type: 'models.setList', engine: 'held', role: 'planning', models: [large] })
  const token = send('main', 'Plan it').options.hotrodMcp!.token

  const helper = (await json(token, 'spawn_subagent', { task: 'Go' })).chatId
  expect(chatIn(core, helper)).toMatchObject({ role: 'subagents', model: large, thinking })
  expect(sessionOf(helper).options).toMatchObject({ model: large, thinking })

  const planner = (await json(token, 'spawn_subagent', { task: 'Plan', role: 'planning' })).chatId
  expect(sessionOf(planner).options.model).toBe(large)
  expect(JSON.parse(readFileSync(join(garage, 'chats', planner, 'chat.json'), 'utf8')).role).toBe('planning')

  // A Subagents row picks the model, and its own thinking level instead of the parent's.
  handle({ type: 'models.setList', engine: 'held', role: 'subagents', models: [{ model: small, thinking: 'low' }] })
  const next = (await json(token, 'spawn_subagent', { task: 'Again' })).chatId
  expect(chatIn(core, next)).not.toHaveProperty('model')
  expect(chatIn(core, next)).not.toHaveProperty('thinking')
  expect(sessionOf(next).options).toMatchObject({ model: small, thinking: 'low' })
})

it("wakes the parent with a subagent's final reply, queued while the parent is busy, then removes the subagent", async () => {
  const { core, garage, sessionOf, sessionsOf, json, tool, send } = await startHeld()
  subagentsOn(core, -1)
  const parent = send('main', 'Plan it')
  const token = parent.options.hotrodMcp!.token
  const { chatId } = await json(token, 'spawn_subagent', { task: 'Search the docs' })
  expect(existsSync(join(garage, 'chats', chatId))).toBe(true)

  sessionOf(chatId).end('Found it')
  const report = { chatId, name: 'Search the docs' }
  expect(chatIn(core, 'main').queue).toMatchObject([{ text: 'Found it', report }])
  expect(core.chats().some((c) => c.id === chatId)).toBe(false)
  expect(existsSync(join(garage, 'chats', chatId))).toBe(false)
  expect(await tool(token, 'send_message', { chatId, text: 'more' })).toMatchObject({ isError: true })
  expect(await tool(token, 'read_chat', { chatId })).toMatchObject({ isError: true })
  core.handle({ type: 'chat.send', chatId: 'main', text: 'Also check the FAQ' }, () => {})
  parent.end('Waiting')
  const prompt = sessionOf('main').prompt!
  expect(prompt).toContain(`Report from subagent "Search the docs" (${chatId}):\n\nFound it`)
  expect(prompt.endsWith('New message from the user:\n\nAlso check the FAQ')).toBe(true)
  expect(chatIn(core, 'main').status).toBe('running')
  // The report is its own entry, apart from the user's words, so neither the UI nor memory takes it as theirs.
  const logged = chatIn(core, 'main').entries.filter((e) => e.type === 'user.message' || e.type === 'subagent.report')
  expect(logged.slice(-2)).toMatchObject([
    { type: 'subagent.report', text: 'Found it', ...report },
    { type: 'user.message', text: 'Also check the FAQ' },
  ])
  const lead = sessionOf('main')

  const stopped = (await json(lead.options.hotrodMcp!.token, 'spawn_subagent', { task: 'Look again' })).chatId
  lead.end('Thanks')
  sessionOf(stopped).end(undefined, 'Interrupted')
  const failed = `Report from subagent "Look again" (${stopped}):\n\n(No reply)\n\n(The turn ended early: Interrupted)`
  expect(sessionOf('main').prompt?.endsWith(failed)).toBe(true)
  expect(sessionOf('main').prompt).not.toContain('New message from the user')
  expect(chatIn(core, 'main').entries.at(-2)).toMatchObject({ type: 'subagent.report', text: '', error: 'Interrupted' })
  expect(sessionsOf('main')).toHaveLength(3)
  expect(core.chats().some((c) => c.id === stopped)).toBe(false)
  expect(existsSync(join(garage, 'chats', stopped))).toBe(false)
})

it("sends a limited turn again whole, a lead's reports included, and keeps a subagent sent again", async () => {
  const retried: string[] = []
  const retrier: Mod = {
    id: 'retrier',
    name: 'Retrier',
    description: '',
    enabledByDefault: true,
    onLimitReached({ chat }, { host }) {
      retried.push(chat.id)
      host.retry(chat.id)
    },
  }
  const { core, sessionOf, sessionsOf, json, send } = await startHeld({ mods: [mainMod, retrier] })
  subagentsOn(core, -1)
  const lead = send('main', 'Plan it')
  const { chatId } = await json(lead.options.hotrodMcp!.token, 'spawn_subagent', { task: 'Search' })
  const limit = (chat: string) => {
    sessionOf(chat).emit({ type: 'limit.reached', message: 'Out of usage' })
    sessionOf(chat).end(undefined, 'Out of usage')
  }

  limit(chatId)
  expect(retried).toEqual([chatId])
  expect(chatIn(core, chatId).status).toBe('running')
  expect(sessionsOf(chatId)).toHaveLength(2)
  expect(sessionOf(chatId).prompt).toContain('Search')
  expect(chatIn(core, 'main').queue).toEqual([])

  // The report and the user's message wait for the lead together, so one turn starts with both.
  sessionOf(chatId).end('Found it')
  expect(core.chats().some((c) => c.id === chatId)).toBe(false)
  core.handle({ type: 'chat.send', chatId: 'main', text: 'Also the FAQ' }, () => {})
  lead.end('Waiting')
  limit('main')
  expect(retried).toEqual([chatId, 'main'])
  expect(sessionsOf('main')).toHaveLength(3)
  const again = sessionOf('main').prompt!
  expect(again).toContain(`Report from subagent "Search" (${chatId}):\n\nFound it`)
  expect(again.endsWith('New message from the user:\n\nAlso the FAQ')).toBe(true)
  const inputs = chatIn(core, 'main').entries.filter((e) => e.type === 'user.message' || e.type === 'subagent.report')
  expect(inputs.slice(-4).map((e) => e.type)).toEqual([
    'subagent.report',
    'user.message',
    'subagent.report',
    'user.message',
  ])
})

it("gives a subagent its parent's items plus its own while it works", async () => {
  const { core, garage, sessionOf, json, send } = await startHeld()
  const handle = handleOn(core)
  subagentsOn(core)
  handle({ type: 'chat.create', name: 'Side' })
  const subchat = core.chats().find((c) => c.id !== 'main')!
  writeFileSync(join(garage, 'AGENTS.md'), 'WORKSHOP')
  writeFileSync(join(garage, 'chats', subchat.id, 'AGENTS.md'), 'PARENT')
  const lead = send(subchat.id, 'hi').options.hotrodMcp!.token
  const { chatId } = await json(lead, 'spawn_subagent', { task: 'Go' })
  writeFileSync(join(garage, 'chats', chatId, 'AGENTS.md'), 'OWN')

  const itemsOf = (id: string) => {
    const replies: CoreMessage[] = []
    core.handle({ type: 'context.get', chatId: id }, (m) => replies.push(m))
    return replies[0]?.type === 'chat.context' ? replies[0].items : []
  }
  expect(itemsOf(chatId).map((i) => i.from)).toEqual([GLOBAL_CONTEXT, subchat.id, chatId])
  const instructions = sessionOf(chatId).options.instructions.split('\n\n')
  expect(instructions.slice(1, 3)).toEqual([MEMORY_INSTRUCTIONS, ZOOM_INSTRUCTIONS])
  expect(instructions.slice(-2)).toEqual(['WORKSHOP', 'PARENT'])

  const parentRules = join(garage, 'chats', subchat.id, 'AGENTS.md')
  handle({ type: 'context.set', chatId: subchat.id, path: parentRules, enabled: false })
  expect(itemsOf(chatId).find((i) => i.path === parentRules)).toMatchObject({ enabled: false })
  sessionOf(chatId).end('ok')
  expect(core.chats().some((c) => c.id === chatId)).toBe(false)
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
  subagentsOn(core, -1)
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

  expect(await tool(token, 'zoom', { id: 1, parent: true })).toEqual({
    isError: true,
    text: 'No message 1; this chat has messages 0 to 0',
  })
  first.end('Checked')
  expect(core.chats().some((c) => c.id === chatId)).toBe(false)
})
