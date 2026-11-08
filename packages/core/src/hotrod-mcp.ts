import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute } from 'node:path'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { McpServer } from '@modelcontextprotocol/server'
import type { Mod } from '@hotrod/mod-api'
import * as z from 'zod'
import { dateOf, zoom, type MemoryMessage, type Summaries } from './memory.ts'
import type { ChatInfo, ChatState, ModelRole, NewChat } from './shared.ts'

export const READ_CHAT_DEFAULT_LAST = 20
export const SUBAGENT_NAME_MAX_CHARS = 40

export const SUBAGENTS_MOD: Mod = {
  id: 'subagents',
  name: 'Subagents',
  description: 'Chats can hand a task to a new chat that reports back when it ends. Claude Code only.',
  enabledByDefault: false,
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
  ],
}

type Hub = {
  chats(): ChatState[]
  canNest(chatId: string): boolean
  createChat(spec: NewChat & { subagent?: boolean; role?: ModelRole }): ChatInfo
  send(chatId: string, text: string): void
  subagents(): { enabled: boolean; limit: number }
  memory(chatId: string): { messages: MemoryMessage[]; summaries: Summaries }
}

const isBelow = (chats: ChatState[], caller: ChatState, chat: ChatState) => {
  if (chat.subagent) return chat.parentId === caller.id
  for (let id = chat.parentId; id !== undefined; id = chats.find((c) => c.id === id)?.parentId) {
    if (id === caller.id) return true
  }
  return false
}

const subagentName = (task: string) => {
  const line = task.trim().replace(/\s+/g, ' ')
  return line.length > SUBAGENT_NAME_MAX_CHARS ? `${line.slice(0, SUBAGENT_NAME_MAX_CHARS).trimEnd()}…` : line
}

function messages(chat: ChatState) {
  return chat.entries.flatMap((entry) => {
    if (entry.type === 'user.message') return [`User: ${entry.text}`]
    if (entry.type === 'text.completed') return [`Assistant: ${entry.text}`]
    if (entry.type === 'tool.started') return [`Tool ${entry.name}: ${entry.summary}`]
    if (entry.type === 'turn.completed' && entry.error) return [`[Turn ended early: ${entry.error}]`]
    return []
  })
}

type Context = { hub: Hub; caller: ChatState; below: (chatId: string) => ChatState }

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
  for: 'nest' | 'below' | 'subagents' | 'memory'
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
    for: 'below',
    description: 'List the chats below this one, with their status.',
    input: z.object({}),
    run({ hub, caller }: Context) {
      const chats = hub.chats()
      return chats
        .filter((chat) => isBelow(chats, caller, chat))
        .map(({ id, name, folders, status, engine, archived }) => ({ id, name, folders, status, engine, archived }))
    },
  },
  read_chat: {
    for: 'below',
    description: `Read a chat below this one: its last messages (${READ_CHAT_DEFAULT_LAST} by default).`,
    input: z.object({ chatId: z.string(), last: z.number().int().positive().optional() }),
    run({ below }: Context, { chatId, last = READ_CHAT_DEFAULT_LAST }: { chatId: string; last?: number }) {
      return messages(below(chatId)).slice(-last).join('\n\n')
    },
  },
  send_message: {
    for: 'below',
    description: 'Send a message to an idle chat below this one. It starts a turn there.',
    input: z.object({ chatId: z.string(), text: z.string().min(1) }),
    run({ hub, below }: Context, { chatId, text }: { chatId: string; text: string }) {
      const chat = below(chatId)
      if (chat.status !== 'idle') throw new Error(`Chat "${chatId}" is ${chat.status}; wait until it is idle`)
      hub.send(chatId, text)
      return { ok: true }
    },
  },
  create_chat: {
    for: 'nest',
    description:
      'Make a named chat below this one. Its folders (absolute paths; missing ones are made) and files go into its ' +
      'context; it runs in its first folder. Give a prompt to start it. Returns its id.',
    input: z.object({
      name: z.string().min(1),
      prompt: z.string().min(1).optional(),
      folders: z.array(z.string()).optional(),
      files: z.array(z.string()).optional(),
      engine: z.string().optional(),
    }),
    run({ hub, caller }: Context, { prompt, ...spec }: Omit<NewChat, 'parentId'> & { prompt?: string }) {
      const relative = spec.folders?.find((folder) => !isAbsolute(folder))
      if (relative !== undefined) throw new Error(`The path must be absolute: ${relative}`)
      for (const folder of spec.folders ?? []) mkdirSync(folder, { recursive: true })
      const chat = hub.createChat({ parentId: caller.id, ...spec })
      if (prompt) hub.send(chat.id, prompt)
      return { chatId: chat.id }
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

export function openHotrodMcp(hub: Hub) {
  const callers = new Map<string, string>()

  const offers = (caller: ChatState, tool: Tool) => {
    const nests = hub.canNest(caller.id)
    const spawns = !caller.subagent && hub.subagents().enabled
    if (tool.for === 'nest') return nests
    if (tool.for === 'subagents') return spawns
    if (tool.for === 'memory') return true
    return nests || spawns
  }

  const serverFor = (callerId: string) => {
    const server = new McpServer({ name: 'hotrod', version: '0.0.0' })
    for (const [name, tool] of Object.entries(TOOLS)) {
      const caller = hub.chats().find((chat) => chat.id === callerId)
      if (!caller || !offers(caller, tool)) continue
      server.registerTool(name, { description: tool.description, inputSchema: tool.input }, async (input: any) => {
        const chats = hub.chats()
        const caller = chats.find((chat) => chat.id === callerId)
        try {
          if (!caller) throw new Error('This chat no longer exists')
          const below = (chatId: string) => {
            const chat = chats.find((c) => c.id === chatId)
            if (!chat || !isBelow(chats, caller, chat)) throw new Error(`No chat "${chatId}" below this one`)
            return chat
          }
          const result = tool.run({ hub, caller, below }, input)
          return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] }
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error)
          return { isError: true, content: [{ type: 'text', text }] }
        }
      })
    }
    return server
  }

  return {
    grant(chatId: string) {
      const chat = hub.chats().find((c) => c.id === chatId)
      if (!chat || !Object.values(TOOLS).some((tool) => offers(chat, tool))) return undefined
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
