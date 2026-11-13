// Kothar's own connections to the user's MCP servers. Kothar is the only MCP client: engines see these servers' tools
// only as Kothar's (index.ts relays them), so every call passes through here, where it's checked, timed and recorded,
// and secrets never leave Kothar for an engine.
//
// A server starts on first use (a tool call, or Test connection) and stops after it's been idle a while. If it dies,
// the next call starts it again, after a pause that doubles with each crash in a row (1 s up to 30 s); after
// MAX_CRASHES in a row it stays stopped until the user restarts it. Each start, stop, crash and restart is recorded
// in the Activity.
import { homedir } from 'node:os'
import type { ActivityInput, McpToolResult } from '@kothar/extension-api'
import { Client, SSEClientTransport, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { masked, type CachedTool, type ServerConfig, type Store } from './store.ts'

export const MAX_CRASHES = 5
export const CONNECT_TIMEOUT_MS = 60_000
export const CALL_TIMEOUT_MS = 10 * 60_000
export const RESULT_RECORDED_CHARS = 4000

export type State = 'stopped' | 'starting' | 'connected' | 'failed' | 'needs-sign-in'
export type Status = { state: State; error?: string; since?: number; crashes: number }

export type ClientsDeps = {
  store: Store
  now: () => number
  // An Activity record (host.activity); the manager masks secrets before it calls this.
  record: (event: ActivityInput) => void
  idleMs: () => number
  // Runs a stdio server through the user's login shell, so it finds what their Terminal finds (npx, uvx, docker).
  // Tests leave it out to run the command as it is.
  shell?: string
  // Waits between restarts; tests make it instant.
  sleep?: (ms: number) => Promise<void>
  // An OAuth sign-in for a remote server, if it has one (oauth.ts).
  authProvider?: (server: ServerConfig) => unknown
  // A server's tool list changed (it said so, or Kothar listed it again).
  toolsChanged?: (serverId: string) => void
}

type Live = { client: Client; config: ServerConfig; closing: boolean; idle?: ReturnType<typeof setTimeout>; calls: number }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
// An HTTP error's status, the SDK's or a cause's.
const httpStatus = (error: unknown): number | undefined => {
  const value = error as { status?: unknown; code?: unknown; cause?: unknown } | undefined
  if (typeof value?.status === 'number') return value.status
  if (value?.cause) return httpStatus(value.cause)
  return undefined
}
const signInNeeded = (error: unknown) =>
  error instanceof UnauthorizedError || [401, 403].includes(httpStatus(error) ?? 0) || /\b401\b|unauthori[sz]ed/i.test(messageOf(error))
// The SDK's HTTP errors can end in an empty status text; say the status then.
const httpMessage = (error: unknown) => {
  const status = httpStatus(error)
  const text = messageOf(error).replace(/:\s*$/, '')
  return status && !text.includes(String(status)) ? `${text} (HTTP ${status})` : text
}

export function openClients(deps: ClientsDeps) {
  const { store } = deps
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const live = new Map<string, Live>()
  const starting = new Map<string, Promise<Live>>()
  const statuses = new Map<string, Status>()
  const lastCrash = new Map<string, number>()

  const statusOf = (id: string): Status => statuses.get(id) ?? { state: 'stopped', crashes: 0 }
  const setStatus = (id: string, change: Partial<Status>) => statuses.set(id, { ...statusOf(id), ...change })
  const hide = (text: string) => masked(text, store.secretValues())
  const record = (event: ActivityInput) =>
    deps.record({
      ...event,
      title: hide(event.title),
      ...(event.detail !== undefined && { detail: hide(event.detail) }),
      ...(event.result !== undefined && { result: hide(event.result) }),
      ...(event.error !== undefined && { error: hide(event.error) }),
      ...(event.sections && { sections: event.sections.map((s) => ({ label: s.label, text: hide(s.text) })) }),
    })

  // What a server runs or reaches, as the user and the Activity see it (secrets masked by record).
  const describe = (server: ServerConfig) =>
    server.transport === 'stdio' ? [server.command, ...(server.args ?? [])].join(' ') : `${server.transport.toUpperCase()} ${server.url}`

  const transportOf = (server: ServerConfig) => {
    const secrets = store.secrets(server.id)
    if (server.transport === 'stdio') {
      const env = { ...getDefaultEnvironment(), ...server.env, ...secrets.env }
      const [command, args] = deps.shell
        ? [deps.shell, ['-lc', 'exec "$@"', 'mcp-server', server.command!, ...(server.args ?? [])]]
        : [server.command!, server.args ?? []]
      return new StdioClientTransport({ command, args, env, stderr: 'pipe', cwd: homedir() })
    }
    const headers = { ...server.headers, ...secrets.headers }
    const authProvider = deps.authProvider?.(server)
    const options = { requestInit: { headers }, ...(authProvider ? { authProvider: authProvider as never } : {}) }
    const url = new URL(server.url!)
    return server.transport === 'sse' ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options)
  }

  const listAll = async (client: Client) => {
    const tools: CachedTool[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor })
      for (const tool of page.tools) {
        tools.push({
          name: tool.name,
          ...(tool.description !== undefined && { description: tool.description }),
          inputSchema: tool.inputSchema as CachedTool['inputSchema'],
          ...(tool.annotations && { annotations: tool.annotations as CachedTool['annotations'] }),
        })
      }
      cursor = page.nextCursor
    } while (cursor)
    return tools
  }

  // A fresh client, connected and with its tools listed; stderr's tail goes into a failure's message.
  const connect = async (server: ServerConfig) => {
    const transport = transportOf(server)
    let stderr = ''
    const pipe = (transport as { stderr?: NodeJS.ReadableStream | null }).stderr
    pipe?.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)))
    const client = new Client({ name: 'kothar', version: '1.0.0' })
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
      const tools = await listAll(client)
      return { client, tools }
    } catch (error) {
      await client.close().catch(() => {})
      const tail = stderr.trim().split('\n').slice(-5).join('\n')
      throw tail ? new Error(`${messageOf(error)}\n${tail}`, { cause: error }) : error
    }
  }

  const saveTools = (id: string, tools: CachedTool[]) => {
    store.setTools(id, tools, new Date(deps.now()).toISOString())
    deps.toolsChanged?.(id)
  }

  const stopIdle = (entry: Live) => {
    if (entry.idle) clearTimeout(entry.idle)
    entry.idle = setTimeout(() => {
      if (entry.calls > 0) return stopIdle(entry)
      void stop(entry.config.id, 'idle')
    }, deps.idleMs())
    entry.idle.unref?.()
  }

  const start = async (server: ServerConfig, chatId?: string): Promise<Live> => {
    const { crashes } = statusOf(server.id)
    if (crashes >= MAX_CRASHES) {
      throw new Error(`${server.name} stopped ${crashes} times in a row, so Kothar left it stopped. Restart it in Settings → MCP servers.`)
    }
    if (crashes > 0) {
      const wait = Math.min(30_000, 1000 * 2 ** (crashes - 1)) - (deps.now() - (lastCrash.get(server.id) ?? 0))
      if (wait > 0) await sleep(wait)
      record({ kind: 'retry', title: `Restarted MCP server ${server.name} (crash ${crashes} in a row)`, ...(chatId && { chatId }) })
    }
    setStatus(server.id, { state: 'starting', since: deps.now() })
    const started = deps.now()
    let connected: Awaited<ReturnType<typeof connect>>
    try {
      connected = await connect(server)
    } catch (error) {
      const signIn = signInNeeded(error)
      setStatus(server.id, { state: signIn ? 'needs-sign-in' : 'failed', error: hide(httpMessage(error)), since: deps.now() })
      record({
        kind: 'other',
        title: signIn ? `MCP server ${server.name} needs you to sign in` : `Couldn't start MCP server ${server.name}`,
        detail: describe(server),
        error: httpMessage(error),
        ...(chatId && { chatId }),
      })
      throw signIn ? new Error(`${server.name} needs you to sign in: Settings → Extensions → MCP servers`, { cause: error }) : error
    }
    const entry: Live = { client: connected.client, config: server, closing: false, calls: 0 }
    connected.client.onclose = () => {
      if (live.get(server.id) !== entry) return
      live.delete(server.id)
      if (entry.idle) clearTimeout(entry.idle)
      if (entry.closing) return
      const count = statusOf(server.id).crashes + 1
      lastCrash.set(server.id, deps.now())
      setStatus(server.id, { state: count >= MAX_CRASHES ? 'failed' : 'stopped', crashes: count, since: deps.now(), error: 'It stopped unexpectedly' })
      record({ kind: 'other', title: `MCP server ${server.name} stopped unexpectedly`, detail: `${count} in a row` })
    }
    // A server that changes its tools says so; Kothar lists them again for the next session.
    connected.client.setNotificationHandler('notifications/tools/list_changed' as never, (async () => {
      try {
        saveTools(server.id, await listAll(connected.client))
      } catch {
        // It's listed again on its next start.
      }
    }) as never)
    live.set(server.id, entry)
    setStatus(server.id, { state: 'connected', since: deps.now(), error: undefined })
    saveTools(server.id, connected.tools)
    record({
      kind: 'other',
      title: `Started MCP server ${server.name}`,
      detail: `${describe(server)}\n${connected.tools.length} tools, ${deps.now() - started} ms`,
      ...(chatId && { chatId }),
    })
    stopIdle(entry)
    return entry
  }

  const ensure = (server: ServerConfig, chatId?: string) => {
    const running = live.get(server.id)
    if (running) return Promise.resolve(running)
    let pending = starting.get(server.id)
    if (!pending) {
      pending = start(server, chatId).finally(() => starting.delete(server.id))
      starting.set(server.id, pending)
    }
    return pending
  }

  const stop = async (id: string, why: 'idle' | 'user' | 'changed' | 'quit') => {
    const entry = live.get(id)
    if (!entry) return
    entry.closing = true
    if (entry.idle) clearTimeout(entry.idle)
    live.delete(id)
    setStatus(id, { state: 'stopped', since: deps.now(), error: undefined })
    if (why !== 'quit') {
      const words = { idle: 'it was idle', user: 'you asked', changed: 'its settings changed' }[why]
      record({ kind: 'other', title: `Stopped MCP server ${entry.config.name}`, detail: `Because ${words}` })
    }
    await entry.client.close().catch(() => {})
  }

  return {
    status: statusOf,
    running: (id: string) => live.has(id),
    tools: (id: string) => store.tools(id)?.tools ?? [],
    describe,
    // Calls a tool, starting the server first if it isn't running. Recorded in the Activity with its input, result
    // (cut to RESULT_RECORDED_CHARS) and time, secrets masked.
    async call(server: ServerConfig, tool: string, input: Record<string, unknown>, chatId: string): Promise<McpToolResult> {
      const started = deps.now()
      const sections = [{ label: 'Input', text: JSON.stringify(input, null, 2) }]
      const title = `Called ${tool} on MCP server ${server.name}`
      let entry: Live | undefined
      try {
        entry = await ensure(server, chatId)
        entry.calls++
        const result = (await entry.client.callTool({ name: tool, arguments: input }, { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true })) as McpToolResult
        // A call that worked shows the server is healthy again.
        setStatus(server.id, { crashes: 0 })
        const text = result.content.map((block) => (block.type === 'text' ? String(block.text) : `[${block.type}]`)).join('\n')
        record({
          kind: 'tool',
          chatId,
          title,
          detail: `${deps.now() - started} ms${result.isError ? ', the server answered with an error' : ''}`,
          sections,
          result: text.length > RESULT_RECORDED_CHARS ? `${text.slice(0, RESULT_RECORDED_CHARS)}… (${text.length} characters)` : text,
        })
        return result
      } catch (error) {
        record({ kind: 'tool', chatId, title, detail: `${deps.now() - started} ms`, sections, error: messageOf(error) })
        throw new Error(hide(messageOf(error)), { cause: error })
      } finally {
        if (entry) {
          entry.calls--
          stopIdle(entry)
        }
      }
    },
    // Test connection: a separate, short-lived client, so it never disturbs one in use. Saves the tools it lists.
    async test(server: ServerConfig) {
      const started = deps.now()
      try {
        const { client, tools } = await connect(server)
        await client.close().catch(() => {})
        saveTools(server.id, tools)
        if (!live.has(server.id)) setStatus(server.id, { state: 'stopped', error: undefined, crashes: 0, since: deps.now() })
        record({ kind: 'other', title: `Tested MCP server ${server.name}`, detail: `${describe(server)}\n${tools.length} tools, ${deps.now() - started} ms` })
        return { tools }
      } catch (error) {
        const signIn = signInNeeded(error)
        setStatus(server.id, { state: signIn ? 'needs-sign-in' : 'failed', error: hide(httpMessage(error)), since: deps.now() })
        record({ kind: 'other', title: `Testing MCP server ${server.name} failed`, detail: describe(server), error: httpMessage(error) })
        throw new Error(hide(signIn ? `It needs you to sign in. ${httpMessage(error)}` : httpMessage(error)), { cause: error })
      }
    },
    // Restart after crashes, or after its settings changed: stops it and clears the crash count.
    async reset(id: string) {
      await stop(id, 'changed')
      setStatus(id, { state: 'stopped', crashes: 0, error: undefined })
    },
    stop: (id: string) => stop(id, 'user'),
    async stopAll() {
      await Promise.all([...live.keys()].map((id) => stop(id, 'quit')))
    },
  }
}

export type Clients = ReturnType<typeof openClients>
