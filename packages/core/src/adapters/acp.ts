import type { McpServer } from '@kothar/extension-api'
import type { EngineEvent, EngineProcess, ImageInput, Session, ThinkingLevel, ToolKind } from '../shared.ts'
import { type RpcError, rpcClient } from './rpc.ts'

// The Agent Client Protocol (agentclientprotocol.com): JSON-RPC 2.0 over an agent's stdio, one message per line. This
// module is the protocol half any ACP engine needs: one session mapped to Kothar's events, over the JSON-RPC client in
// rpc.ts. What differs between agents (how a tool is named and classed, what an agent reports outside the protocol)
// comes in as hooks; the OpenCode adapter is the first user.

export const ACP_PROTOCOL_VERSION = 1

const errorText = (error: RpcError) => {
  const data = error.data as any
  const detail = typeof data === 'string' ? data : (data?.message ?? (data && JSON.stringify(data)))
  return [error.message, typeof detail === 'string' && detail !== error.message ? detail : '']
    .filter(Boolean)
    .join(': ')
}

// ACP's tool kinds, as Kothar classes them; `think`, `delete`, `move` and `switch_mode` are other, or edit.
const ACP_KINDS: Record<string, ToolKind> = {
  execute: 'shell',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
  read: 'read',
  search: 'search',
  fetch: 'fetch',
}

export const kindOfAcp = (kind: unknown): ToolKind => ACP_KINDS[String(kind)] ?? 'other'

// What Kothar knows of one tool call, built from ACP's tool_call and tool_call_update and kept by id.
export type AcpToolCall = {
  id: string
  // The title the call first came with; agents often name the tool there before they have its input.
  firstTitle?: string
  title?: string
  kind?: string
  rawInput?: any
  locations: string[]
}

export type AcpTool = { name: string; kind: ToolKind; summary: string; path?: string; command?: string }

export type AcpHooks = {
  // How Kothar names and classes a call, from what ACP said of it.
  tool(call: AcpToolCall): AcpTool
  // Whether a call's input is complete enough to show its start; else it starts at its first permission request or
  // when it ends.
  hasInput?(call: AcpToolCall): boolean
  // A line on the agent's output that isn't JSON-RPC, such as a log line.
  line?(line: string, turn: AcpTurn): void
  // The turn's error when the agent ended it without saying why (ACP has no error stop reason).
  turnError?(): string | undefined
  // A new turn starts.
  turnStarted?(): void
}

// What a hook may do to the running turn.
export type AcpTurn = { limit(message: string, resetsAt?: string): void; running: boolean }

// One of Kothar's thinking levels as the value an agent's thought_level option takes, if it takes one close enough.
export function effortFor(level: ThinkingLevel, values: string[]): string | undefined {
  if (values.includes(level)) return level
  if (level === 'off') return values.find((v) => v === 'none')
  if (level === 'low') return values.find((v) => v === 'minimal')
  return undefined
}

// The thinking levels an agent's effort values give, cheapest first.
export function levelsOfEfforts(values: string[]): ThinkingLevel[] {
  const all: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max']
  return all.filter((level) => effortFor(level, values) !== undefined)
}

export type AcpSessionOptions = {
  cwd: string
  mcpServers: AcpMcpServer[]
  model?: string
  thinking?: ThinkingLevel
  // How the agent is named in errors.
  name: string
}

export type AcpMcpServer =
  | { type: 'http'; name: string; url: string; headers: { name: string; value: string }[] }
  | { name: string; command: string; args: string[]; env: { name: string; value: string }[] }

export const acpStdioServer = (server: McpServer): AcpMcpServer => ({
  name: server.name,
  command: server.command,
  args: server.args ?? [],
  env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
})

const textOf = (content: any): string =>
  (Array.isArray(content) ? content : [])
    .map((block: any) => (block?.type === 'content' ? block.content : block))
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n')

const LINES_KEPT = 20

// One ACP session on a started agent process: initialize, session/new, then a prompt per turn. Each Kothar session
// is one ACP session; nothing is loaded or resumed.
export function startAcpSession(
  proc: EngineProcess,
  options: AcpSessionOptions,
  hooks: AcpHooks,
  emit: (event: EngineEvent) => void,
): Session {
  const tools = new Map<string, AcpToolCall>()
  const started = new Set<string>()
  // Permission requests not yet answered: Kothar's request id to the JSON-RPC id and the options offered.
  const asked = new Map<string, { rpcId: string | number; options: any[] }>()
  // The latest lines that weren't JSON-RPC, for the error when the agent exits.
  let otherLines: string[] = []
  let sessionId: string | undefined
  let failure: string | undefined
  let closed = false
  let running = false
  let interrupted = false
  let limited = false
  let reply = { messageId: undefined as string | undefined, text: '' }
  let queued: { text: string; images: ImageInput[] } | undefined

  const turn: AcpTurn = {
    limit(message, resetsAt) {
      if (limited || !running || interrupted) return
      limited = true
      emit({ type: 'limit.reached', message, ...(resetsAt && { resetsAt }) })
    },
    get running() {
      return running
    },
  }

  const flushReply = () => {
    if (reply.text) emit({ type: 'text.completed', text: reply.text })
    reply = { messageId: undefined, text: '' }
  }

  const cancelAsked = () => {
    for (const { rpcId } of asked.values()) client.respond(rpcId, { outcome: { outcome: 'cancelled' } })
    asked.clear()
  }

  const endTurn = (error?: string) => {
    if (!running) return
    flushReply()
    cancelAsked()
    running = false
    const reason = interrupted ? 'Interrupted' : (error ?? hooks.turnError?.())
    interrupted = false
    emit({ type: 'turn.completed', ...(reason && { error: reason }) })
  }

  const startTool = (call: AcpToolCall, fallbackInput?: unknown) => {
    if (started.has(call.id)) return
    started.add(call.id)
    flushReply()
    const { name, kind, summary, path } = hooks.tool(call)
    const input = call.rawInput ?? fallbackInput ?? {}
    emit({ type: 'tool.started', toolId: call.id, name, kind, summary, input, ...(path !== undefined && { path }) })
  }

  const track = (update: any): AcpToolCall => {
    const id = String(update.toolCallId)
    const call = tools.get(id) ?? { id, locations: [] }
    if (call.firstTitle === undefined && typeof update.title === 'string') call.firstTitle = update.title
    if (typeof update.title === 'string') call.title = update.title
    if (typeof update.kind === 'string') call.kind = update.kind
    if (update.rawInput !== undefined) call.rawInput = update.rawInput
    if (Array.isArray(update.locations)) {
      const paths = update.locations.map((l: any) => l?.path).filter((p: unknown) => typeof p === 'string')
      if (paths.length) call.locations = paths
    }
    tools.set(id, call)
    return call
  }

  const hasInput = (call: AcpToolCall) =>
    hooks.hasInput ? hooks.hasInput(call) : call.rawInput !== undefined && Object.keys(call.rawInput).length > 0

  const onUpdate = (update: any) => {
    if (!running) return
    switch (update?.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = update.content?.type === 'text' ? update.content.text : undefined
        if (typeof text !== 'string' || !text) return
        if (reply.messageId !== undefined && update.messageId !== undefined && update.messageId !== reply.messageId) {
          flushReply()
        }
        reply.messageId ??= update.messageId
        reply.text += text
        emit({ type: 'text.delta', text })
        return
      }
      case 'agent_thought_chunk': {
        const text = update.content?.type === 'text' ? update.content.text : undefined
        if (typeof text === 'string' && text) emit({ type: 'thinking.delta', text })
        return
      }
      case 'tool_call':
      case 'tool_call_update': {
        const call = track(update)
        const done = update.status === 'completed' || update.status === 'failed'
        if (done || hasInput(call)) startTool(call)
        if (!done) return
        tools.delete(call.id)
        started.delete(call.id)
        const output = textOf(update.content) || textOf(update.rawOutput?.content) || stringOf(update.rawOutput?.output)
        emit({ type: 'tool.completed', toolId: call.id, output, isError: update.status === 'failed' })
      }
    }
  }

  const onPermission = (rpcId: string | number, params: any) => {
    if (!running || interrupted) return client.respond(rpcId, { outcome: { outcome: 'cancelled' } })
    const asking = params?.toolCall ?? {}
    const id = String(asking.toolCallId ?? rpcId)
    const call = tools.get(id) ?? { id, locations: [] }
    tools.set(id, call)
    // The request describes what is asked (its title and input can differ from the call's own); the call's name wins.
    const request: AcpToolCall = {
      id,
      firstTitle: call.firstTitle ?? asking.title,
      title: asking.title ?? call.title,
      kind: asking.kind ?? call.kind,
      rawInput: asking.rawInput ?? call.rawInput,
      locations: (asking.locations ?? []).map((l: any) => l?.path).filter((p: unknown) => typeof p === 'string'),
    }
    if (!request.locations.length) request.locations = call.locations
    if (!started.has(id)) {
      if (call.rawInput === undefined) call.rawInput = request.rawInput
      if (!call.locations.length) call.locations = request.locations
      startTool(call)
    }
    const { name, kind, summary, path, command } = hooks.tool(request)
    const requestId = `acp-${String(rpcId)}`
    asked.set(requestId, { rpcId, options: Array.isArray(params?.options) ? params.options : [] })
    emit({
      type: 'permission.requested',
      requestId,
      toolId: id,
      name,
      kind,
      summary,
      ...(path !== undefined && { path }),
      ...(command !== undefined && { command }),
      input: request.rawInput ?? {},
    })
  }

  // Lines that aren't JSON-RPC (an agent's logs) go to onOther.
  const client = rpcClient(proc, {
    jsonrpc: true,
    errorText,
    onRequest(rpcId, method, params) {
      if (method === 'session/request_permission') return onPermission(rpcId, params)
      // Kothar offers no file system or terminal to the agent; it uses its own tools.
      client.fail(rpcId, { code: -32601, message: `Method not found: ${method}` })
    },
    onNotification(method, params) {
      if (method === 'session/update' && params?.sessionId === sessionId) onUpdate(params.update)
    },
    onOther(line) {
      otherLines = [...otherLines, line].slice(-LINES_KEPT)
      hooks.line?.(line, turn)
    },
  })

  const send = async (text: string, images: ImageInput[]) => {
    const prompt = [{ type: 'text', text }, ...images.map(({ mimeType, base64 }) => ({ type: 'image', mimeType, data: base64 }))]
    try {
      const result = await client.request('session/prompt', { sessionId, prompt })
      endTurn(result?.stopReason === 'refusal' ? `${options.name} refused to go on` : undefined)
    } catch (error) {
      endTurn(messageOf(error))
    }
  }

  // The model and thinking level, through the session's config options (ACP's model and thought_level categories).
  const configure = async (configOptions: any[]) => {
    const option = (category: string) => configOptions.find((o) => o?.category === category || o?.id === category)
    const values = (o: any): string[] => (o?.options ?? []).map((v: any) => v?.value).filter((v: unknown) => typeof v === 'string')
    const set = async (o: any, value: string) => {
      if (o.currentValue === value) return o
      const result = await client.request('session/set_config_option', { sessionId, configId: o.id, value })
      return result?.configOptions ?? configOptions
    }
    if (options.model) {
      const model = option('model')
      if (!model) throw new Error(`${options.name} doesn't let Kothar pick a model`)
      if (!values(model).includes(options.model)) throw new Error(`${options.name} doesn't offer the model ${options.model}`)
      const next = await set(model, options.model)
      if (Array.isArray(next)) configOptions = next
    }
    if (options.thinking) {
      const effort = option('thought_level')
      const value = effort && effortFor(options.thinking, values(effort))
      if (value) await set(effort, value)
    }
  }

  const ready = (async () => {
    try {
      await client.request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      })
      const created = await client.request('session/new', { cwd: options.cwd, mcpServers: options.mcpServers })
      sessionId = created?.sessionId
      if (typeof sessionId !== 'string') throw new Error(`${options.name} started no session`)
      await configure(created?.configOptions ?? [])
    } catch (error) {
      failure = messageOf(error)
    }
    const waiting = queued
    queued = undefined
    if (!waiting) return
    if (failure) return endTurn(failure)
    if (interrupted) return endTurn()
    void send(waiting.text, waiting.images)
  })()
  void ready

  proc.onExit((code, stderrTail) => {
    client.flush()
    client.abandon(`${options.name} exited`)
    const error = code === 0 || closed ? undefined : stderrTail.trim() || otherLines.join('\n').trim() || `${options.name} exited with code ${code}`
    if (running) endTurn(error ?? `${options.name} exited`)
    emit({ type: 'session.ended', ...(error && { error }) })
  })

  return {
    prompt(text, images = []) {
      running = true
      interrupted = false
      limited = false
      reply = { messageId: undefined, text: '' }
      hooks.turnStarted?.()
      emit({ type: 'turn.started' })
      if (failure) return endTurn(failure)
      if (sessionId === undefined) {
        queued = { text, images }
        return
      }
      void send(text, images)
    },
    interrupt() {
      if (!running) return
      interrupted = true
      cancelAsked()
      if (sessionId === undefined) {
        queued = undefined
        return endTurn()
      }
      client.notify('session/cancel', { sessionId })
    },
    respond(requestId, allow) {
      const waiting = asked.get(requestId)
      if (!waiting) return
      asked.delete(requestId)
      const wanted = allow ? 'allow_once' : 'reject_once'
      const picked =
        waiting.options.find((o) => o?.kind === wanted) ??
        waiting.options.find((o) => String(o?.kind).startsWith(allow ? 'allow' : 'reject'))
      if (!picked) return client.respond(waiting.rpcId, { outcome: { outcome: 'cancelled' } })
      client.respond(waiting.rpcId, { outcome: { outcome: 'selected', optionId: picked.optionId } })
    },
    close() {
      closed = true
      proc.closeStdin()
      proc.kill()
    },
  }
}

const stringOf = (value: unknown) => (typeof value === 'string' ? value : '')
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
