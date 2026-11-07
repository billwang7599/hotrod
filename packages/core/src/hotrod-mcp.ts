import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute } from 'node:path'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import type { ChatInfo, ChatState, ModelRole, Project } from './types.ts'

export const READ_CHAT_DEFAULT_LAST = 20

type Hub = {
  chats(): ChatState[]
  projects(): Project[]
  addProject(path: string, name?: string): Project
  createChat(projectId?: string, engine?: string, parentId?: string, role?: ModelRole): ChatInfo
  send(chatId: string, text: string): void
  subagents(): { enabled: boolean; limit: number }
}

const isWorkshop = (chat: ChatState) => chat.main && chat.projectId === undefined

const isBelow = (caller: ChatState, chat: ChatState) =>
  chat.parentId !== undefined
    ? chat.parentId === caller.id
    : chat.id !== caller.id && (isWorkshop(caller) || (caller.main && chat.projectId === caller.projectId))

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

type Tool = {
  for: 'workshop' | 'main' | 'below' | 'subagents'
  description: string
  input: z.ZodObject
  run(context: Context, input: any): unknown
}

const TOOLS: Record<string, Tool> = {
  list_chats: {
    for: 'below',
    description: 'List the chats below this one, with their status.',
    input: z.object({}),
    run({ hub, caller }: Context) {
      const projects = new Map(hub.projects().map((p) => [p.id, p]))
      return hub
        .chats()
        .filter((chat) => isBelow(caller, chat))
        .map(({ id, title, projectId, status, engine, archived }) => {
          const project = projectId === undefined ? undefined : projects.get(projectId)
          return {
            id,
            title,
            ...(project && { project: { id: project.id, name: project.name, path: project.path } }),
            status,
            engine,
            archived,
          }
        })
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
    for: 'main',
    description:
      'Start a new subchat below this one with a first message. The Workshop may put it in a project. ' +
      'Returns its id.',
    input: z.object({ prompt: z.string().min(1), projectId: z.string().optional(), engine: z.string().optional() }),
    run({ hub, caller }: Context, input: { prompt: string; projectId?: string; engine?: string }) {
      const projectId = isWorkshop(caller) ? input.projectId : (input.projectId ?? caller.projectId)
      if (projectId !== undefined && !hub.chats().some((c) => c.projectId === projectId && isBelow(caller, c))) {
        throw new Error(`No project "${projectId}" below this chat`)
      }
      const chat = hub.createChat(projectId, input.engine)
      hub.send(chat.id, input.prompt)
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
      const running = hub.chats().filter((c) => c.parentId === caller.id && c.status !== 'idle').length
      if (limit !== -1 && running >= limit) {
        throw new Error(`This chat already has ${running} subagents running; the limit is ${limit}`)
      }
      const chat = hub.createChat(caller.projectId, engine ?? caller.engine, caller.id, role)
      hub.send(chat.id, task)
      return { chatId: chat.id }
    },
  },
  create_project: {
    for: 'workshop',
    description:
      'Add a folder as a project, making it if missing; its contents are never touched. Returns the project ' +
      'and its main chat id.',
    input: z.object({ path: z.string(), name: z.string().optional() }),
    run({ hub }: Context, { path, name }: { path: string; name?: string }) {
      if (!isAbsolute(path)) throw new Error(`The path must be absolute: ${path}`)
      mkdirSync(path, { recursive: true })
      const project = hub.addProject(path, name)
      return { project: { id: project.id, name: project.name, path: project.path }, chatId: `${project.id}/main` }
    },
  },
}

export function openHotrodMcp(hub: Hub) {
  const callers = new Map<string, string>()

  const offers = (caller: ChatState, tool: Tool) => {
    const spawns = caller.parentId === undefined && hub.subagents().enabled
    if (tool.for === 'workshop') return isWorkshop(caller)
    if (tool.for === 'main') return caller.main
    if (tool.for === 'subagents') return spawns
    return caller.main || spawns
  }

  const serverFor = (callerId: string) => {
    const server = new McpServer({ name: 'hotrod', version: '0.0.0' })
    for (const [name, tool] of Object.entries(TOOLS)) {
      const caller = hub.chats().find((chat) => chat.id === callerId)
      if (!caller || !offers(caller, tool)) continue
      server.registerTool(name, { description: tool.description, inputSchema: tool.input }, async (input: any) => {
        const caller = hub.chats().find((chat) => chat.id === callerId)
        try {
          if (!caller) throw new Error('This chat no longer exists')
          const below = (chatId: string) => {
            const chat = hub.chats().find((c) => c.id === chatId)
            if (!chat || !isBelow(caller, chat)) throw new Error(`No chat "${chatId}" below this one`)
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
