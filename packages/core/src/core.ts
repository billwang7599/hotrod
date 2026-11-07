import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type {
  Adapter,
  ChatEntry,
  ChatStatus,
  ClientMessage,
  CoreMessage,
  EngineEvent,
  Machine,
  Project,
  ProjectState,
  Session,
} from './types.ts'

type Chat = {
  project: Project
  entries: ChatEntry[]
  status: ChatStatus
  session?: Session
  pendingRequests: Set<string>
}

export type Core = ReturnType<typeof openCore>

export function openCore(options: { garage: string; adapter: Adapter; machine: Machine }) {
  const { garage, adapter, machine } = options
  const projectsDir = join(garage, 'projects')
  mkdirSync(projectsDir, { recursive: true })
  const chats = new Map<string, Chat>()
  const listeners: ((message: CoreMessage) => void)[] = []

  const broadcast = (message: CoreMessage) => listeners.forEach((listener) => listener(message))
  const logPath = (id: string) => join(projectsDir, id, 'chats', 'main', 'log.jsonl')
  const state = (chat: Chat): ProjectState => ({ ...chat.project, status: chat.status, entries: chat.entries })

  const append = (chat: Chat, entry: ChatEntry) => {
    chat.entries.push(entry)
    appendFileSync(logPath(chat.project.id), JSON.stringify(entry) + '\n')
    broadcast({ type: 'chat.entry', projectId: chat.project.id, entry })
  }

  const setStatus = (chat: Chat, status: ChatStatus) => {
    if (chat.status === status) return
    chat.status = status
    broadcast({ type: 'chat.status', projectId: chat.project.id, status })
  }

  const chatFor = (projectId: string) => {
    const chat = chats.get(projectId)
    if (!chat) throw new Error(`Unknown project "${projectId}"`)
    return chat
  }

  const endTurn = (chat: Chat) => {
    chat.session?.close()
    chat.session = undefined
    chat.pendingRequests.clear()
    setStatus(chat, 'idle')
  }

  for (const id of readdirSync(projectsDir)) {
    const projectFile = join(projectsDir, id, 'project.json')
    if (!existsSync(projectFile)) continue
    const project: Project = JSON.parse(readFileSync(projectFile, 'utf8'))
    const log = existsSync(logPath(id)) ? readFileSync(logPath(id), 'utf8') : ''
    const entries: ChatEntry[] = log.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const chat: Chat = { project, entries, status: 'idle', pendingRequests: new Set() }
    chats.set(project.id, chat)
    const lastTurnEvent = entries.findLast((e) => ['turn.started', 'turn.completed', 'session.ended'].includes(e.type))
    if (lastTurnEvent?.type === 'turn.started' || entries.at(-1)?.type === 'user.message') {
      append(chat, { at: new Date().toISOString(), type: 'turn.completed', error: 'Hotrod quit during this turn' })
    }
  }

  const addProject = (rawPath: string, reply: (message: CoreMessage) => void) => {
    const expanded = rawPath.trim().replace(/^~(?=$|\/)/, homedir())
    const path = resolve(expanded)
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Not a folder: ${rawPath}`)
    const realPath = realpathSync(path)
    const existing = [...chats.values()].find((chat) => chat.project.path === realPath)
    if (existing) return reply({ type: 'project.added', project: state(existing) })

    const name = basename(realPath) || 'root'
    const base = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '') || 'project'
    // macOS folders are case-insensitive, so "App" and "app" would share a folder.
    const taken = new Set(readdirSync(projectsDir).map((id) => id.toLowerCase()))
    let id = base
    for (let n = 2; taken.has(id.toLowerCase()); n++) id = `${base}-${n}`

    const project: Project = { id, name, path: realPath }
    mkdirSync(join(projectsDir, id, 'chats', 'main'), { recursive: true })
    writeFileSync(join(projectsDir, id, 'project.json'), JSON.stringify(project, null, 2) + '\n')
    writeFileSync(logPath(id), '')
    const chat: Chat = { project, entries: [], status: 'idle', pendingRequests: new Set() }
    chats.set(id, chat)
    broadcast({ type: 'project.added', project: state(chat) })
  }

  const send = (chat: Chat, text: string) => {
    if (chat.status !== 'idle') throw new Error('A turn is already running in this chat')
    const prompt = chat.entries.length ? `${transcript(chat.entries)}\n\nNew message from the user:\n\n${text}` : text
    append(chat, { at: new Date().toISOString(), type: 'user.message', text })
    setStatus(chat, 'running')

    const instructions = [join(garage, 'AGENTS.md'), join(chat.project.path, 'AGENTS.md')]
      .filter((file) => existsSync(file))
      .map((file) => readFileSync(file, 'utf8').trim())
      .join('\n\n')

    let session: Session | undefined
    let unsavedText = ''
    const emit = (event: EngineEvent) => {
      if (session && chat.session !== session) return
      if (event.type === 'text.delta') {
        unsavedText += event.text
        broadcast({ type: 'chat.delta', projectId: chat.project.id, text: event.text })
        return
      }
      if (event.type === 'text.completed') unsavedText = ''
      if ((event.type === 'turn.completed' || event.type === 'session.ended') && unsavedText) {
        append(chat, { at: new Date().toISOString(), type: 'text.completed', text: unsavedText })
        unsavedText = ''
      }
      append(chat, { at: new Date().toISOString(), ...event })
      if (event.type === 'permission.requested') {
        chat.pendingRequests.add(event.requestId)
        setStatus(chat, 'waiting')
      }
      if (event.type === 'turn.completed' || event.type === 'session.ended') endTurn(chat)
    }

    try {
      session = adapter.start(machine, { cwd: chat.project.path, instructions }, emit)
      chat.session = session
      session.prompt(prompt)
    } catch (error) {
      append(chat, { at: new Date().toISOString(), type: 'turn.completed', error: String(error) })
      endTurn(chat)
    }
  }

  const respond = (chat: Chat, requestId: string, allow: boolean) => {
    if (!chat.session || !chat.pendingRequests.delete(requestId)) {
      throw new Error(`No pending permission request "${requestId}"`)
    }
    append(chat, { at: new Date().toISOString(), type: 'permission.resolved', requestId, allow })
    if (chat.pendingRequests.size === 0) setStatus(chat, 'running')
    chat.session.respond(requestId, allow)
  }

  return {
    projects: () => [...chats.values()].map(state),
    onMessage: (listener: (message: CoreMessage) => void) => listeners.push(listener),
    handle(message: ClientMessage, reply: (message: CoreMessage) => void) {
      switch (message.type) {
        case 'project.add':
          return addProject(String(message.path), reply)
        case 'chat.send':
          if (typeof message.text !== 'string' || !message.text.trim()) throw new Error('Message is empty')
          return send(chatFor(message.projectId), message.text)
        case 'chat.interrupt':
          return chatFor(message.projectId).session?.interrupt()
        case 'permission.respond':
          return respond(chatFor(message.projectId), message.requestId, message.allow === true)
        default:
          throw new Error(`Unknown message type "${(message as { type: unknown }).type}"`)
      }
    },
    close() {
      for (const chat of chats.values()) {
        chat.session?.close()
        chat.session = undefined
      }
    },
  }
}

function transcript(entries: ChatEntry[]) {
  const results = new Map<string, { output: string; isError: boolean }>()
  for (const entry of entries) {
    if (entry.type === 'tool.completed') results.set(entry.toolId, entry)
  }
  const lines: string[] = []
  for (const entry of entries) {
    if (entry.type === 'user.message') lines.push(`User: ${entry.text}`)
    if (entry.type === 'text.completed') lines.push(`Assistant: ${entry.text}`)
    if (entry.type === 'tool.started') {
      const call = `<tool_call name="${entry.name}">${JSON.stringify(entry.input) ?? ''}</tool_call>`
      const result = results.get(entry.toolId)
      if (!result) lines.push(`${call}\n<tool_result status="none" />`)
      else lines.push(`${call}\n<tool_result status="${result.isError ? 'error' : 'ok'}">\n${result.output}\n</tool_result>`)
    }
    if (entry.type === 'turn.completed' && entry.error) lines.push(`[Turn ended early: ${entry.error}]`)
  }
  return `This is the conversation so far:\n\n${lines.join('\n\n')}`
}
