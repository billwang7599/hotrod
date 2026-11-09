import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ChatSummary, Mod, ModHost, ModTool, ModValues } from '@kothar/mod-api'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import type { ChatInfo, ChatState, ModelRole, NewChat } from './shared.ts'

export const READ_CHAT_DEFAULT_LAST = 20
export const WORKER_NAME_MAX_CHARS = 40

export const WORKER_INSTRUCTIONS =
  'Delegate by default. Any task that needs more than a few tool calls (exploring code, making a change, running ' +
  'tests, researching) goes to a worker you start with spawn_worker, not to you, so you stay free to keep ' +
  'talking with the user while it runs. Split the work into as many workers as it needs, each with a whole task ' +
  "it can finish on its own, independent of the others. You can edit the same files, just ensure they're in " +
  'different worktrees, and make a stack PR so we have less merge conflicts. Do the work yourself only for quick ' +
  "answers and one-line changes. Each worker's final reply comes back to you as a message, so don't wait for it " +
  'or poll it; tell the user what you started and carry on. To stop a worker you no longer need, use stop_chat.'

export const WORKERS_MOD: Mod = {
  id: 'workers',
  name: 'Workers',
  description: 'Chats can hand a task to a new chat that reports back when it ends.',
  enabledByDefault: true,
  settings: [
    {
      key: 'limit',
      label: 'Max running per chat',
      description: 'How many workers one chat can run at once. -1 for no limit.',
      type: 'number',
      default: 4,
      min: -1,
      integer: true,
    },
    {
      key: 'instructions',
      label: 'Instructions',
      description: 'What every chat that can start workers is told about them.',
      type: 'text',
      default: WORKER_INSTRUCTIONS,
      rows: 6,
    },
  ],
}

type Hub = {
  chats(): ChatState[]
  seesAll(chatId: string): boolean
  createChat(spec: NewChat & { parentId?: string; worker?: boolean; role?: ModelRole }): ChatInfo
  send(chatId: string, text: string): void
  // A message for a chat that may be mid-turn, as its composer sends one: steered in, queued or sent.
  deliver(chatId: string, text: string): 'sent' | 'steered' | 'queued'
  // What the chat's Stop button does.
  stop(chatId: string): void
  workers(): { enabled: boolean; limit: number }
  modTools(): { tool: ModTool; values: ModValues; host: ModHost }[]
}

const reaches = (hub: Hub, caller: ChatState, chat: ChatState) =>
  chat.worker ? chat.parentId === caller.id : chat.id !== caller.id && hub.seesAll(caller.id)

export const summaryOf = ({ id, name, engine, parentId, worker }: ChatInfo): ChatSummary => ({
  id,
  name,
  engine,
  ...(parentId !== undefined && { parentId }),
  ...(worker && { worker }),
})

const workerName = (task: string) => {
  const line = task.trim().replace(/\s+/g, ' ')
  return line.length > WORKER_NAME_MAX_CHARS ? `${line.slice(0, WORKER_NAME_MAX_CHARS).trimEnd()}…` : line
}

function messages(chat: ChatState) {
  return chat.entries.flatMap((entry) => {
    if (entry.type === 'user.message') return [`User: ${entry.text}`]
    if (entry.type === 'worker.report') return [`Worker "${entry.name}" reported: ${entry.text || '(No reply)'}`]
    if (entry.type === 'text.completed') return [`Assistant: ${entry.text}`]
    if (entry.type === 'tool.started') return [`Tool ${entry.name}: ${entry.summary}`]
    if (entry.type === 'turn.completed' && entry.error) return [`[Turn ended early: ${entry.error}]`]
    return []
  })
}

type Context = { hub: Hub; caller: ChatState; reachable: (chatId: string) => ChatState }

type Tool = {
  for: 'reach' | 'workers'
  description: string
  input: z.ZodObject
  run(context: Context, input: any): unknown
}

const TOOLS: Record<string, Tool> = {
  list_chats: {
    for: 'reach',
    description: 'List the chats this one can reach, with their status.',
    input: z.object({}),
    run({ hub, caller }: Context) {
      return hub
        .chats()
        .filter((chat) => reaches(hub, caller, chat))
        .map(({ id, name, folders, status, engine, archived }) => ({ id, name, folders, status, engine, archived }))
    },
  },
  read_chat: {
    for: 'reach',
    description: `Read a chat this one can reach: its last messages (${READ_CHAT_DEFAULT_LAST} by default).`,
    input: z.object({ chatId: z.string(), last: z.number().int().positive().optional() }),
    run({ reachable }: Context, { chatId, last = READ_CHAT_DEFAULT_LAST }: { chatId: string; last?: number }) {
      return messages(reachable(chatId)).slice(-last).join('\n\n')
    },
  },
  send_message: {
    for: 'reach',
    description:
      'Send a message to a chat this one can reach. An idle chat starts a turn with it. A running chat takes it in ' +
      'at its next step when its engine can steer, as Enter does in its composer; otherwise, or while it waits for ' +
      'an approval or is stopping, it is queued and sent when the turn ends. Returns how it was delivered.',
    input: z.object({ chatId: z.string(), text: z.string().min(1) }),
    run({ hub, reachable }: Context, { chatId, text }: { chatId: string; text: string }) {
      reachable(chatId)
      return { delivered: hub.deliver(chatId, text) }
    },
  },
  stop_chat: {
    for: 'reach',
    description:
      "Stop a chat this one can reach, such as one of your workers, as its Stop button does. A stopped worker's " +
      'report still comes back to you.',
    input: z.object({ chatId: z.string() }),
    run({ hub, reachable }: Context, { chatId }: { chatId: string }) {
      const { status } = reachable(chatId)
      if (status === 'idle') return `Chat "${chatId}" is already idle`
      if (status === 'stopping') return `Chat "${chatId}" is already stopping`
      hub.stop(chatId)
      return `Stopping chat "${chatId}"`
    },
  },
  spawn_worker: {
    for: 'workers',
    description:
      'Start a worker: a new chat below this one that works on the task, in this folder, on the models the ' +
      'user picked for workers. Its final reply comes back to you as a message when its turn ends, so ' +
      "don't poll it. Give a role to run it on that role's models instead. Returns its id.",
    input: z.object({
      task: z.string().min(1),
      role: z.enum(['planning', 'searching']).optional(),
    }),
    run({ hub, caller }: Context, { task, role }: { task: string; role?: ModelRole }) {
      const { limit } = hub.workers()
      const running = hub.chats().filter((c) => c.parentId === caller.id && c.worker && c.status !== 'idle').length
      if (limit !== -1 && running >= limit) {
        throw new Error(`This chat already has ${running} workers running; the limit is ${limit}`)
      }
      const name = workerName(task)
      const chat = hub.createChat({ parentId: caller.id, name, worker: true, role })
      hub.send(chat.id, task)
      return { chatId: chat.id }
    },
  },
}

export const CORE_TOOL_NAMES = Object.keys(TOOLS)

export function openKotharMcp(hub: Hub) {
  const callers = new Map<string, string>()

  const offers = (caller: ChatState, tool: Tool) => {
    const spawns = !caller.worker && hub.workers().enabled
    if (tool.for === 'workers') return spawns
    return spawns || hub.seesAll(caller.id)
  }
  const modToolsFor = (caller: ChatState) => hub.modTools().filter(({ tool }) => tool.offered(summaryOf(caller)))

  const serverFor = (callerId: string) => {
    const server = new McpServer({ name: 'kothar', version: '0.0.0' })
    const caller = hub.chats().find((chat) => chat.id === callerId)
    if (!caller) return server
    const answer = async (run: (caller: ChatState, chats: ChatState[]) => unknown) => {
      const chats = hub.chats()
      const current = chats.find((chat) => chat.id === callerId)
      try {
        if (!current) throw new Error('This chat no longer exists')
        const result = await run(current, chats)
        const text = typeof result === 'string' ? result : JSON.stringify(result)
        return { content: [{ type: 'text' as const, text }] }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        return { isError: true, content: [{ type: 'text' as const, text }] }
      }
    }
    for (const [name, tool] of Object.entries(TOOLS)) {
      if (!offers(caller, tool)) continue
      server.registerTool(name, { description: tool.description, inputSchema: tool.input }, (input: any) =>
        answer((caller, chats) => {
          const reachable = (chatId: string) => {
            const chat = chats.find((c) => c.id === chatId)
            if (!chat || !reaches(hub, caller, chat)) throw new Error(`No chat "${chatId}" this chat can reach`)
            return chat
          }
          return tool.run({ hub, caller, reachable }, input)
        }),
      )
    }
    for (const { tool, values, host } of modToolsFor(caller)) {
      const inputSchema = fromJsonSchema<Record<string, unknown>>(tool.inputSchema)
      server.registerTool(tool.name, { description: tool.description, inputSchema }, (input) =>
        answer((caller) => tool.run(input, { caller: summaryOf(caller), values, host })),
      )
    }
    return server
  }

  return {
    grant(chatId: string) {
      const chat = hub.chats().find((c) => c.id === chatId)
      const offered = chat && (Object.values(TOOLS).some((tool) => offers(chat, tool)) || modToolsFor(chat).length)
      if (!offered) return undefined
      const token = randomBytes(32).toString('base64url')
      callers.set(token, chatId)
      return token
    },
    revoke: (token: string) => callers.delete(token),
    async handle(request: IncomingMessage, response: ServerResponse) {
      const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1]
      const callerId = token === undefined ? undefined : callers.get(token)
      if (callerId === undefined) return response.writeHead(401).end()
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      await serverFor(callerId).connect(transport)
      await transport.handleRequest(request, response)
    },
  }
}
