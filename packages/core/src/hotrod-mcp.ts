import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ChatSummary, Mod, ModHost, ModTool, ModValues } from '@hotrod/mod-api'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import { dateOf, zoom, type MemoryMessage, type Summaries } from './memory.ts'
import type { ChatInfo, ChatState, ModelRole, NewChat } from './shared.ts'

export const READ_CHAT_DEFAULT_LAST = 20
export const SUBAGENT_NAME_MAX_CHARS = 40

export const SUBAGENT_INSTRUCTIONS =
  'Delegate by default. Any task that needs more than a few tool calls (exploring code, making a change, running ' +
  'tests, researching) goes to a subagent you start with spawn_subagent, not to you, so you stay free to keep ' +
  'talking with the user while it runs. Split the work into as many subagents as it needs, each with a whole task ' +
  "it can finish on its own, independent of the others. You can edit the same files, just ensure they're in " +
  'different worktrees, and make a stack PR so we have less merge conflicts. Do the work yourself only for quick ' +
  "answers and one-line changes. Each subagent's final reply comes back to you as a message, so don't wait for it " +
  'or poll it; tell the user what you started and carry on.'

export const SUBAGENTS_MOD: Mod = {
  id: 'subagents',
  name: 'Subagents',
  description: 'Chats can hand a task to a new chat that reports back when it ends.',
  enabledByDefault: true,
  settings: [
    {
      key: 'limit',
      label: 'Max running per chat',
      description: 'How many subagents one chat can run at once. -1 for no limit.',
      type: 'number',
      default: 4,
      min: -1,
      integer: true,
    },
    {
      key: 'instructions',
      label: 'Instructions',
      description: 'What every chat that can spawn subagents is told about them.',
      type: 'text',
      default: SUBAGENT_INSTRUCTIONS,
      rows: 6,
    },
  ],
}

type Hub = {
  chats(): ChatState[]
  seesAll(chatId: string): boolean
  createChat(spec: NewChat & { parentId?: string; subagent?: boolean; role?: ModelRole }): ChatInfo
  send(chatId: string, text: string): void
  subagents(): { enabled: boolean; limit: number }
  memory(chatId: string): { messages: MemoryMessage[]; summaries: Summaries }
  modTools(): { tool: ModTool; values: ModValues; host: ModHost }[]
}

const reaches = (hub: Hub, caller: ChatState, chat: ChatState) =>
  chat.subagent ? chat.parentId === caller.id : chat.id !== caller.id && hub.seesAll(caller.id)

export const summaryOf = ({ id, name, engine, parentId, subagent }: ChatInfo): ChatSummary => ({
  id,
  name,
  engine,
  ...(parentId !== undefined && { parentId }),
  ...(subagent && { subagent }),
})

const subagentName = (task: string) => {
  const line = task.trim().replace(/\s+/g, ' ')
  return line.length > SUBAGENT_NAME_MAX_CHARS ? `${line.slice(0, SUBAGENT_NAME_MAX_CHARS).trimEnd()}…` : line
}

function messages(chat: ChatState) {
  return chat.entries.flatMap((entry) => {
    if (entry.type === 'user.message') return [`User: ${entry.text}`]
    if (entry.type === 'subagent.report') return [`Subagent "${entry.name}" reported: ${entry.text || '(No reply)'}`]
    if (entry.type === 'text.completed') return [`Assistant: ${entry.text}`]
    if (entry.type === 'tool.started') return [`Tool ${entry.name}: ${entry.summary}`]
    if (entry.type === 'turn.completed' && entry.error) return [`[Turn ended early: ${entry.error}]`]
    return []
  })
}

type Context = { hub: Hub; caller: ChatState; reachable: (chatId: string) => ChatState }

const memoryOf = ({ hub, caller }: Context, parent = false) => {
  if (!parent) return hub.memory(caller.id)
  if (!caller.subagent || caller.parentId === undefined) {
    throw new Error("Only a subagent can read its parent chat's memory")
  }
  const { messages, summaries } = hub.memory(caller.parentId)
  return { messages: messages.slice(0, caller.parentMessages ?? 0), summaries }
}

const PARENT_INPUT = z.boolean().optional().describe("A subagent's parent chat, as it was at launch")

type Tool = {
  for: 'reach' | 'subagents' | 'memory'
  description: string
  input: z.ZodObject
  run(context: Context, input: any): unknown
}

const TOOLS: Record<string, Tool> = {
  zoom: {
    for: 'memory',
    description:
      'Open a line of your memory. zoom(id, n) gives the two lines of n/2 under line id+n; zoom(id, 1) gives ' +
      'message id whole, in pages (offset and limit pick a part).',
    input: z.object({
      id: z.number().int(),
      n: z.number().int().optional(),
      offset: z.number().int().optional(),
      limit: z.number().int().optional(),
      parent: PARENT_INPUT,
    }),
    run(context: Context, input: { id: number; n?: number; offset?: number; limit?: number; parent?: boolean }) {
      const { messages, summaries } = memoryOf(context, input.parent)
      return zoom(messages, summaries, input.id, input.n, input.offset, input.limit)
    },
  },
  date: {
    for: 'memory',
    description: 'The date and time of message id in your memory.',
    input: z.object({ id: z.number().int(), parent: PARENT_INPUT }),
    run(context: Context, { id, parent }: { id: number; parent?: boolean }) {
      return dateOf(memoryOf(context, parent).messages, id)
    },
  },
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
    description: 'Send a message to an idle chat this one can reach. It starts a turn there.',
    input: z.object({ chatId: z.string(), text: z.string().min(1) }),
    run({ hub, reachable }: Context, { chatId, text }: { chatId: string; text: string }) {
      const chat = reachable(chatId)
      if (chat.status !== 'idle') throw new Error(`Chat "${chatId}" is ${chat.status}; wait until it is idle`)
      hub.send(chatId, text)
      return { ok: true }
    },
  },
  spawn_subagent: {
    for: 'subagents',
    description:
      'Start a subagent: a new chat below this one that works on the task, in this folder, with this engine ' +
      'unless you name another. Its final reply comes back to you as a message when its turn ends, so ' +
      "don't poll it. Give a role to run it on that role's models. Returns its id.",
    input: z.object({
      task: z.string().min(1),
      engine: z.string().optional(),
      role: z.enum(['planning', 'searching']).optional(),
    }),
    run({ hub, caller }: Context, { task, engine, role }: { task: string; engine?: string; role?: ModelRole }) {
      const { limit } = hub.subagents()
      const running = hub.chats().filter((c) => c.parentId === caller.id && c.subagent && c.status !== 'idle').length
      if (limit !== -1 && running >= limit) {
        throw new Error(`This chat already has ${running} subagents running; the limit is ${limit}`)
      }
      const name = subagentName(task)
      const chat = hub.createChat({ parentId: caller.id, name, engine: engine ?? caller.engine, subagent: true, role })
      hub.send(chat.id, task)
      return { chatId: chat.id }
    },
  },
}

export const CORE_TOOL_NAMES = Object.keys(TOOLS)

export function openHotrodMcp(hub: Hub) {
  const callers = new Map<string, string>()

  const offers = (caller: ChatState, tool: Tool) => {
    const spawns = !caller.subagent && hub.subagents().enabled
    if (tool.for === 'subagents') return spawns
    if (tool.for === 'memory') return true
    return spawns || hub.seesAll(caller.id)
  }
  const modToolsFor = (caller: ChatState) => hub.modTools().filter(({ tool }) => tool.offered(summaryOf(caller)))

  const serverFor = (callerId: string) => {
    const server = new McpServer({ name: 'hotrod', version: '0.0.0' })
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
