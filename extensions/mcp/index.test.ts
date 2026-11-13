import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ActivityEvent, ActivityInput, Extension, SentTurn } from '@kothar/extension-api'
import { startCore } from '@kothar/core/main'
import type { Adapter, ClientMessage, CoreMessage, SessionOptions } from '@kothar/core/shared'
import { sandboxingMachine } from '@kothar/core/test-machine'
import { until as waitUntil } from '@kothar/core/test-wait'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_CRASHES, openClients } from './clients.ts'
import { createMcpExtension } from './index.ts'
import { MAX_TOOL_NAME, relayedName } from './names.ts'
import { checkedServer, hint, masked, openStore, type ServerConfig } from './store.ts'

const FAKE = fileURLToPath(new URL('./fixtures/fake-server.mjs', import.meta.url))
const until = (check: () => boolean) => waitUntil(check, { tries: 600 })

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const tempDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const fakeServer = (change: Partial<ServerConfig> = {}): ServerConfig => ({
  id: 'fake',
  name: 'Fake',
  enabled: true,
  transport: 'stdio',
  command: process.execPath,
  args: [FAKE],
  env: {},
  secretEnv: ['FAKE_TOKEN'],
  approval: 'ask',
  spaces: 'all',
  addedAt: '2026-11-12T00:00:00.000Z',
  ...change,
})

describe('names', () => {
  it('names a relayed tool <server>__<tool>, cleaned', () => {
    expect(relayedName('github', 'create_issue')).toBe('github__create_issue')
    expect(relayedName('my-server', 'do.thing now')).toBe('my-server__do_thing_now')
  })

  it('keeps long names within the limit, apart by a hash', () => {
    const a = relayedName('atlassian', 'x'.repeat(60) + 'a')
    const b = relayedName('atlassian', 'x'.repeat(60) + 'b')
    expect(a.length).toBe(MAX_TOOL_NAME)
    expect(a).not.toBe(b)
    expect(a.startsWith('atlassian__xxx')).toBe(true)
  })
})

describe('store', () => {
  it('keeps secrets out of servers.json, in a file only the user can read', () => {
    const store = openStore(tempDir('kothar-mcp-store-'))
    store.put(fakeServer())
    store.setSecrets('fake', { env: { FAKE_TOKEN: 'ghp_supersecret123' } })
    expect(readFileSync(join(store.dir, 'servers.json'), 'utf8')).not.toContain('ghp_supersecret123')
    expect(statSync(join(store.dir, 'secrets.json')).mode & 0o777).toBe(0o600)
    expect(store.secrets('fake')).toEqual({ env: { FAKE_TOKEN: 'ghp_supersecret123' } })
    store.remove('fake')
    expect(store.servers()).toEqual([])
    expect(store.secrets('fake')).toEqual({})
  })

  it('drops servers it can’t use, and repeats', () => {
    expect(checkedServer({ ...fakeServer(), id: 'Bad Id' })).toBeUndefined()
    expect(checkedServer({ ...fakeServer(), command: '' })).toBeUndefined()
    expect(checkedServer({ id: 'r', name: 'R', transport: 'http', url: 'ftp://x' })).toBeUndefined()
    expect(checkedServer({ id: 'r', name: 'R', transport: 'http', url: 'https://x.dev/mcp' })).toMatchObject({ approval: 'ask', spaces: 'all', enabled: false })
  })

  it('masks every secret in text, and hints at one by its end', () => {
    expect(masked('token=abcd1234 and abcd1234 again, short=ab', ['abcd1234', 'ab'])).toBe('token=[secret] and [secret] again, short=ab')
    expect(hint('ghp_supersecret123')).toBe('••••t123')
    expect(hint('short')).toBe('••••')
  })
})

describe('clients', () => {
  const open = (change: Partial<ServerConfig> = {}, idleMs = 60_000) => {
    const store = openStore(tempDir('kothar-mcp-clients-'))
    const server = fakeServer({ ...change, env: { FAKE_STARTS: join(store.dir, 'starts.log'), ...change.env } })
    store.put(server)
    store.setSecrets(server.id, { env: { FAKE_TOKEN: 'sk-live-0123456789' } })
    const events: ActivityInput[] = []
    const slept: number[] = []
    const clients = openClients({
      store,
      now: () => Date.now(),
      record: (event) => events.push(event),
      idleMs: () => idleMs,
      sleep: async (ms) => void slept.push(ms),
    })
    cleanups.push(() => clients.stopAll())
    const starts = () => readFileSync(join(store.dir, 'starts.log'), 'utf8').trim().split('\n').length
    return { store, server, clients, events, slept, starts }
  }

  it('starts a server on first call, passes it its secrets, and records the call masked', async () => {
    const { clients, server, events, store } = open()
    const result = await clients.call(server, 'echo', { text: 'hi sk-live-0123456789' }, 'chat1')
    expect(result.content).toEqual([{ type: 'text', text: 'hi sk-live-0123456789 token=sk-live-0123456789' }])
    expect(clients.status('fake').state).toBe('connected')
    expect(store.tools('fake')?.tools.map((t) => t.name)).toEqual(['echo', 'picture', 'fail', 'crash', 'add_tool'])
    const call = events.find((e) => e.kind === 'tool')!
    expect(call).toMatchObject({ chatId: 'chat1', title: 'Called echo on MCP server Fake', result: 'hi [secret] token=[secret]' })
    expect(JSON.stringify(events)).not.toContain('sk-live-0123456789')
    expect(events.map((e) => e.title)).toContain('Started MCP server Fake')
  })

  it('passes pictures and tool errors through', async () => {
    const { clients, server } = open()
    expect((await clients.call(server, 'picture', {}, 'c')).content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect(await clients.call(server, 'fail', {}, 'c')).toMatchObject({ isError: true })
  })

  it('restarts a crashed server on the next call after a pause, and gives up after too many in a row', async () => {
    const { clients, server, events, slept, starts } = open()
    await clients.call(server, 'echo', { text: 'a' }, 'c')
    await expect(clients.call(server, 'crash', {}, 'c')).rejects.toThrow()
    await until(() => clients.status('fake').crashes === 1)
    expect(events.map((e) => e.title)).toContain('MCP server Fake stopped unexpectedly')
    await clients.call(server, 'echo', { text: 'b' }, 'c')
    expect(starts()).toBe(2)
    expect(slept.length).toBe(1)
    expect(events.find((e) => e.kind === 'retry')?.title).toBe('Restarted MCP server Fake (crash 1 in a row)')
    // A call that works clears the count; then crash after crash until it gives up.
    expect(clients.status('fake').crashes).toBe(0)
    for (let i = 1; i <= MAX_CRASHES; i++) {
      await expect(clients.call(server, 'crash', {}, 'c')).rejects.toThrow()
      await until(() => clients.status('fake').crashes === i)
    }
    expect(clients.status('fake').state).toBe('failed')
    await expect(clients.call(server, 'echo', { text: 'c' }, 'c')).rejects.toThrow('left it stopped')
    expect(slept).toEqual([expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number)])
    await clients.reset('fake')
    expect((await clients.call(server, 'echo', { text: 'd' }, 'c')).content[0]).toMatchObject({ text: expect.stringContaining('d') })
  })

  it('stops a server once it’s idle, and starts it again when called', async () => {
    const { clients, server, events, starts } = open({}, 30)
    await clients.call(server, 'echo', { text: 'a' }, 'c')
    await until(() => !clients.running('fake'))
    expect(events.map((e) => e.detail)).toContain('Because it was idle')
    await clients.call(server, 'echo', { text: 'b' }, 'c')
    expect(starts()).toBe(2)
  })

  it('lists the tools again when the server says they changed', async () => {
    const { clients, server, store } = open()
    await clients.call(server, 'add_tool', {}, 'c')
    await until(() => store.tools('fake')!.tools.some((t) => t.name === 'added'))
  })

  it('tests a connection without disturbing one in use, and says why one fails', async () => {
    const { clients, server, events } = open()
    expect((await clients.test(server)).tools).toHaveLength(5)
    expect(clients.running('fake')).toBe(false)
    const broken = fakeServer({ id: 'broken', name: 'Broken', args: ['-e', 'console.error("missing API key sk-live-0123456789"); process.exit(1)'] })
    await expect(clients.test(broken)).rejects.toThrow('missing API key [secret]')
    expect(clients.status('broken').state).toBe('failed')
    expect(JSON.stringify(events)).not.toContain('sk-live-0123456789')
  })
})

// Kothar with the extension and a fake engine that holds its turn open, so a test can call Kothar's MCP server as
// the engine would, with the session's token.
async function kotharWith(servers: ServerConfig[], secrets: Record<string, Record<string, string>> = {}) {
  const garage = tempDir('kothar-mcp-core-')
  const sessions: { options: SessionOptions }[] = []
  const held: Adapter = {
    id: 'held',
    kotharMcp: true,
    detect: async () => ({ installed: true, signedIn: true }),
    start(_machine, options, emit) {
      sessions.push({ options })
      return {
        prompt: () => emit({ type: 'turn.started' }),
        interrupt: () => emit({ type: 'turn.completed', error: 'Interrupted' }),
        respond() {},
        close() {},
      }
    },
  }
  const mcp = createMcpExtension({ shell: '' })
  const activity: ActivityEvent[] = []
  const sent: SentTurn[] = []
  const watcher: Extension = {
    id: 'watcher',
    name: 'Watcher',
    description: '',
    enabledByDefault: true,
    onActivity: (event) => void activity.push(event),
    onTurnSent: (turn) => void sent.push(turn),
  }
  const env = { KOTHAR_ENGINE: 'held', KOTHAR_GARAGE: garage, KOTHAR_WORK: join(garage, 'work'), KOTHAR_PORT: '0' }
  const kothar = await startCore({ env, adapters: [held], extensions: [mcp, watcher], machine: sandboxingMachine })
  cleanups.push(async () => {
    await kothar.close(true)
  })
  const messages: CoreMessage[] = []
  kothar.core.onMessage((m) => messages.push(m))
  const handle = (m: ClientMessage) => kothar.core.handle(m, (r) => messages.push(r))
  handle({ type: 'engine.setEnabled', engine: 'held', enabled: true })
  handle({ type: 'workFolder.set', path: join(garage, 'work') })
  await until(() => mcp.state().store !== undefined)
  const { store } = mcp.state()
  for (const server of servers) store!.put(server)
  for (const [id, env] of Object.entries(secrets)) store!.setSecrets(id, { env })
  handle({ type: 'chat.create', name: 'Space' })
  const chatId = kothar.core.chats().findLast((c) => c.name === 'Space')!.id
  const chat = () => kothar.core.chats().find((c) => c.id === chatId)!

  let id = 0
  const rpc = async (method: string, params: unknown = {}) => {
    const { url, token } = sessions.at(-1)!.options.kotharMcp!
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    })
    const body = await response.json()
    return body.result ?? { rpcError: body.error }
  }
  const turn = async (text = 'go') => {
    const count = sessions.length
    if (chat().status !== 'idle') {
      handle({ type: 'chat.interrupt', chatId })
      await until(() => chat().status === 'idle')
    }
    handle({ type: 'chat.send', chatId, text })
    await until(() => sessions.length > count)
  }
  const names = async () => ((await rpc('tools/list')).tools as { name: string }[]).map((t) => t.name).filter((n) => n.includes('__')).sort()
  const card = (name: string) => chat().entries.findLast((e) => e.type === 'permission.requested' && e.name === name)
  return { kothar, mcp, store: store!, chatId, chat, handle, rpc, turn, names, card, activity, sent, sessions }
}

describe('relayed through Kothar’s MCP server', () => {
  it('offers the servers’ tools to every engine through Kothar’s server alone, and runs one after the user allows it', async () => {
    const t = await kotharWith([fakeServer()], { fake: { FAKE_TOKEN: 'sk-live-0123456789' } })
    await t.mcp.state().clients!.test(fakeServer())
    await t.turn()
    // The engine is handed no MCP server of its own, and no secret.
    expect(t.sessions.at(-1)!.options.mcpServers).toBeUndefined()
    expect(JSON.stringify(t.sessions.at(-1)!.options)).not.toContain('sk-live')
    expect(await t.names()).toEqual(['fake__add_tool', 'fake__crash', 'fake__echo', 'fake__fail', 'fake__picture'])
    const call = t.rpc('tools/call', { name: 'fake__echo', arguments: { text: 'hello' } })
    await until(() => t.card('MCP fake/echo') !== undefined)
    const card = t.card('MCP fake/echo')!
    if (card.type !== 'permission.requested') throw new Error('no card')
    expect(card).toMatchObject({ kind: 'mcp', summary: 'Fake: echo', input: { text: 'hello' } })
    t.handle({ type: 'permission.respond', chatId: t.chatId, requestId: card.requestId, allow: true })
    expect((await call).content).toEqual([{ type: 'text', text: 'hello token=sk-live-0123456789' }])
    // Recorded: the permission with its rule, and the call, masked.
    expect(t.activity.find((e) => e.kind === 'permission')).toMatchObject({ decision: 'allowed', rule: 'You' })
    expect(t.activity.find((e) => e.kind === 'tool' && e.title === 'Called echo on MCP server Fake')).toMatchObject({ result: 'hello token=[secret]' })
    expect(JSON.stringify(t.activity)).not.toContain('sk-live-0123456789')
    // The Inspector's record of the turn lists the relayed tools as this extension's, with their descriptions.
    const tools = t.sent.at(-1)!.sections.filter((s) => s.source === 'tools' && s.label.includes('fake__'))
    expect(tools.map((s) => s.label)).toContain('MCP servers tool: fake__echo')
    expect(tools.find((s) => s.label.endsWith('fake__echo'))!.text).toContain('[Fake] Echo the text back')
    expect(JSON.stringify(t.sent)).not.toContain('sk-live-0123456789')
  })

  it('tells the agent when the user says no', async () => {
    const t = await kotharWith([fakeServer()])
    await t.mcp.state().clients!.test(fakeServer())
    await t.turn()
    const call = t.rpc('tools/call', { name: 'fake__fail', arguments: {} })
    await until(() => t.card('MCP fake/fail') !== undefined)
    const card = t.card('MCP fake/fail')!
    if (card.type !== 'permission.requested') throw new Error('no card')
    t.handle({ type: 'permission.respond', chatId: t.chatId, requestId: card.requestId, allow: false })
    expect(await call).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining("didn't allow") }] })
  })

  it('lets the server’s setting allow its read-only tools, or all of them, recorded with that rule', async () => {
    const t = await kotharWith([fakeServer({ approval: 'reads' })])
    await t.mcp.state().clients!.test(fakeServer())
    await t.turn()
    expect((await t.rpc('tools/call', { name: 'fake__echo', arguments: { text: 'x' } })).content[0].text).toBe('x')
    expect(t.activity.find((e) => e.kind === 'permission')).toMatchObject({ decision: 'allowed', rule: 'Extension: MCP servers' })
    const write = t.rpc('tools/call', { name: 'fake__fail', arguments: {} })
    await until(() => t.card('MCP fake/fail') !== undefined)
    t.store.put(fakeServer({ approval: 'all' }))
    const card = t.card('MCP fake/fail')!
    if (card.type !== 'permission.requested') throw new Error('no card')
    t.handle({ type: 'permission.respond', chatId: t.chatId, requestId: card.requestId, allow: true })
    await write
    expect(await t.rpc('tools/call', { name: 'fake__add_tool', arguments: {} })).toMatchObject({ content: [{ text: 'added' }] })
  })

  it('offers a chat only the servers on for its space and not switched off for it, from its next message', async () => {
    const t = await kotharWith([fakeServer(), fakeServer({ id: 'other', name: 'Other', spaces: ['not-this-space'] })])
    await t.mcp.state().clients!.test(fakeServer())
    await t.mcp.state().clients!.test(fakeServer({ id: 'other', name: 'Other' }))
    await t.turn()
    expect((await t.names()).some((n) => n.startsWith('other__'))).toBe(false)
    expect((await t.names()).some((n) => n.startsWith('fake__'))).toBe(true)
    t.store.put(fakeServer({ id: 'other', name: 'Other', spaces: [t.chatId] }))
    t.kothar.core.handle({ type: 'chat.interrupt', chatId: t.chatId }, () => {})
    await t.turn()
    expect((await t.names()).some((n) => n.startsWith('other__'))).toBe(true)
    // Off for this chat: Kothar's server lists tools afresh on every request, so it's gone at once, even for a
    // session that listed it before; a call to it is refused.
    t.mcp.setChatOff(t.chatId, ['fake'])
    expect((await t.names()).some((n) => n.startsWith('fake__'))).toBe(false)
    const refused = await t.rpc('tools/call', { name: 'fake__echo', arguments: { text: 'x' } })
    expect(refused.isError === true || refused.rpcError !== undefined).toBe(true)
    await t.turn()
    expect((await t.names()).some((n) => n.startsWith('fake__'))).toBe(false)
  })

  it('lists a server never connected before in the background, for the next message', async () => {
    const t = await kotharWith([fakeServer()])
    await t.turn()
    expect(await t.names()).toEqual([])
    await until(() => (t.store.tools('fake')?.tools.length ?? 0) > 0)
    await t.turn()
    expect(await t.names()).toContain('fake__echo')
  })
})

describe('remote servers', () => {
  // A Streamable HTTP MCP server on a spare port that wants Authorization: Bearer right-token.
  async function remote() {
    const { createServer } = await import('node:http')
    const { McpServer } = await import('@modelcontextprotocol/server')
    const { NodeStreamableHTTPServerTransport } = await import('@modelcontextprotocol/node')
    const z = await import('zod')
    const seen: string[] = []
    const http = createServer(async (request, response) => {
      seen.push(String(request.headers['x-team'] ?? ''))
      if (request.headers.authorization !== 'Bearer right-token-123') return void response.writeHead(401).end()
      const server = new McpServer({ name: 'remote', version: '1.0.0' })
      server.registerTool('whoami', { description: 'Who you are', inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text' as const, text: 'you' }] }))
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      await server.connect(transport)
      await transport.handleRequest(request, response)
    })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => http.close(() => resolve())))
    const port = (http.address() as { port: number }).port
    return { url: `http://127.0.0.1:${port}/mcp`, seen }
  }

  const remoteServer = (url: string): ServerConfig => ({
    id: 'remote',
    name: 'Remote',
    enabled: true,
    transport: 'http',
    url,
    headers: { 'x-team': 'core' },
    secretHeaders: ['Authorization'],
    approval: 'ask',
    spaces: 'all',
    addedAt: '2026-11-12T00:00:00.000Z',
  })

  it('reaches a remote server with its secret header, and says when it needs a sign-in', async () => {
    const { url, seen } = await remote()
    const store = openStore(tempDir('kothar-mcp-remote-'))
    const events: ActivityInput[] = []
    const clients = openClients({ store, now: () => Date.now(), record: (e) => events.push(e), idleMs: () => 60_000 })
    cleanups.push(() => clients.stopAll())
    const server = remoteServer(url)
    store.put(server)
    await expect(clients.test(server)).rejects.toThrow(/sign in/)
    expect(clients.status('remote').state).toBe('needs-sign-in')
    store.setSecrets('remote', { headers: { Authorization: 'Bearer right-token-123' } })
    expect((await clients.test(server)).tools.map((t) => t.name)).toEqual(['whoami'])
    expect((await clients.call(server, 'whoami', {}, 'c')).content).toEqual([{ type: 'text', text: 'you' }])
    expect(seen).toContain('core')
    expect(JSON.stringify(events)).not.toContain('right-token-123')
  })
})
