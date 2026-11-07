import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { openAccounts } from './accounts.ts'
import type {
  Adapter,
  ChatEntry,
  ChatInfo,
  ChatState,
  ChatStatus,
  ClientMessage,
  CoreMessage,
  EngineEvent,
  Machine,
  Project,
  Session,
} from './types.ts'

export const STOP_GRACE_MS = 60_000
export const TITLE_MAX_CHARS = 40
const NEW_CHAT_TITLE = 'New chat'

type Chat = {
  info: ChatInfo
  dir: string
  entries: ChatEntry[]
  status: ChatStatus
  session?: Session
  unsavedText: string
  stopTimer?: ReturnType<typeof setTimeout>
  pendingRequests: Set<string>
}

export type Core = ReturnType<typeof openCore>

export function openCore(options: {
  garage: string
  adapters: Adapter[]
  defaultEngine: string
  machine: Machine
  stopGraceMs?: number
}) {
  const { garage, adapters, defaultEngine, machine, stopGraceMs = STOP_GRACE_MS } = options
  const adapterFor = (engine: string) => adapters.find((adapter) => adapter.id === engine)
  const checkEngine = (engine: string) => {
    if (!adapterFor(engine)) {
      throw new Error(`Unknown engine "${engine}". Pick one of: ${adapters.map((a) => a.id).join(', ')}`)
    }
  }
  checkEngine(defaultEngine)
  const projectsDir = join(garage, 'projects')
  const homeChatsDir = join(garage, 'chats')
  const homeDir = join(garage, 'home')
  for (const dir of [projectsDir, homeChatsDir, homeDir]) mkdirSync(dir, { recursive: true })
  const projects = new Map<string, Project>()
  const chats = new Map<string, Chat>()
  const allStoppedWaiters: (() => void)[] = []
  let quitting = false
  const listeners: ((message: CoreMessage) => void)[] = []

  const broadcast = (message: CoreMessage) => listeners.forEach((listener) => listener(message))
  const saveProject = (project: Project) =>
    writeFileSync(join(projectsDir, project.id, 'project.json'), JSON.stringify(project, null, 2) + '\n')
  const saveChat = ({ info, dir }: Chat) => {
    const { id, title, engine, archived, createdAt } = info
    writeFileSync(join(dir, 'chat.json'), JSON.stringify({ id, title, engine, archived, createdAt }, null, 2) + '\n')
  }
  const state = (chat: Chat): ChatState => ({
    ...chat.info,
    status: chat.status,
    entries: chat.entries,
    draft: chat.unsavedText,
  })

  const append = (chat: Chat, entry: ChatEntry) => {
    chat.entries.push(entry)
    appendFileSync(join(chat.dir, 'log.jsonl'), JSON.stringify(entry) + '\n')
    broadcast({ type: 'chat.entry', chatId: chat.info.id, entry })
  }

  const accounts = openAccounts({
    garage,
    adapters,
    machine,
    broadcast,
    isBusy: (engine) => [...chats.values()].some((chat) => chat.info.engine === engine && chat.status !== 'idle'),
  })
  void accounts.refresh()

  const setStatus = (chat: Chat, status: ChatStatus) => {
    if (chat.status === status || (chat.status === 'stopping' && status !== 'idle')) return
    chat.status = status
    broadcast({ type: 'chat.status', chatId: chat.info.id, status })
  }

  const chatFor = (chatId: string) => {
    const chat = chats.get(chatId)
    if (!chat) throw new Error(`Unknown chat "${chatId}"`)
    return chat
  }

  const projectFor = (projectId: string) => {
    const project = projects.get(projectId)
    if (!project) throw new Error(`Unknown project "${projectId}"`)
    return project
  }

  const chatsOf = (projectId?: string) => [...chats.values()].filter((chat) => chat.info.projectId === projectId)

  const checkIdle = (list: Chat[]) => {
    if (list.some((chat) => chat.status !== 'idle')) throw new Error('Stop the running chat first')
  }

  const checkRemovable = (chat: Chat) => {
    if (chat.info.main) throw new Error('A main chat cannot be archived or deleted')
    checkIdle([chat])
  }

  const stopSession = (chat: Chat) => {
    clearTimeout(chat.stopTimer)
    chat.stopTimer = undefined
    const session = chat.session
    chat.session = undefined
    session?.close()
  }

  const allStopped = () => [...chats.values()].every((chat) => !chat.session)

  const endTurn = (chat: Chat, end: Extract<ChatEntry, { type: 'turn.completed' | 'session.ended' }>) => {
    if (chat.unsavedText) append(chat, { at: end.at, type: 'text.completed', text: chat.unsavedText })
    chat.unsavedText = ''
    append(chat, end)
    stopSession(chat)
    chat.pendingRequests.clear()
    setStatus(chat, 'idle')
    if (allStopped()) allStoppedWaiters.splice(0).forEach((resolve) => resolve())
  }

  const forceStop = (chat: Chat) =>
    endTurn(chat, { at: new Date().toISOString(), type: 'turn.completed', error: 'Interrupted' })

  const loadChat = (dir: string, fallback: ChatInfo) => {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'chat.json')
    const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
    const info: ChatInfo = { ...fallback, ...saved, id: fallback.id, main: fallback.main }
    const logFile = join(dir, 'log.jsonl')
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    const entries: ChatEntry[] = log.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const chat: Chat = { info, dir, entries, status: 'idle', unsavedText: '', pendingRequests: new Set() }
    if (!existsSync(file)) saveChat(chat)
    chats.set(info.id, chat)
    const lastTurnEvent = entries.findLast((e) => ['turn.started', 'turn.completed', 'session.ended'].includes(e.type))
    if (lastTurnEvent?.type === 'turn.started' || entries.at(-1)?.type === 'user.message') {
      append(chat, { at: new Date().toISOString(), type: 'turn.completed', error: 'Hotrod quit during this turn' })
    }
    return chat
  }

  const mainChatInfo = (id: string, engine: string, projectId?: string): ChatInfo => ({
    id,
    ...(projectId ? { projectId } : {}),
    main: true,
    title: 'Main',
    engine,
    archived: false,
    createdAt: new Date().toISOString(),
  })

  const loadSubchats = (chatsDir: string, projectId?: string) => {
    for (const id of readdirSync(chatsDir)) {
      if (id === 'main' || !existsSync(join(chatsDir, id, 'chat.json'))) continue
      const createdAt = new Date().toISOString()
      const fallback = { id, main: false, title: NEW_CHAT_TITLE, engine: defaultEngine, archived: false, createdAt }
      loadChat(join(chatsDir, id), projectId ? { ...fallback, projectId } : fallback)
    }
  }

  loadChat(join(homeChatsDir, 'main'), mainChatInfo('main', defaultEngine))
  loadSubchats(homeChatsDir)
  for (const id of readdirSync(projectsDir)) {
    const projectFile = join(projectsDir, id, 'project.json')
    if (!existsSync(projectFile)) continue
    const { engine = defaultEngine, ...saved } = JSON.parse(readFileSync(projectFile, 'utf8'))
    const project: Project = { archived: false, ...saved, id }
    projects.set(id, project)
    loadChat(join(projectsDir, id, 'chats', 'main'), mainChatInfo(`${id}/main`, engine, id))
    loadSubchats(join(projectsDir, id, 'chats'), id)
  }

  const addProject = (rawPath: string, reply: (message: CoreMessage) => void) => {
    const expanded = rawPath.trim().replace(/^~(?=$|\/)/, homedir())
    const path = resolve(expanded)
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Not a folder: ${rawPath}`)
    const realPath = realpathSync(path)
    const existing = [...projects.values()].find((project) => project.path === realPath)
    if (existing) {
      const project = existing.archived ? archiveProject(existing, false) : existing
      return reply({ type: 'project.added', project, chat: state(chatFor(`${existing.id}/main`)) })
    }

    const name = basename(realPath) || 'root'
    const base = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '') || 'project'
    // macOS folders are case-insensitive, so "App" and "app" would share a folder.
    const taken = new Set(readdirSync(projectsDir).map((id) => id.toLowerCase()))
    let id = base
    for (let n = 2; taken.has(id.toLowerCase()); n++) id = `${base}-${n}`

    const project: Project = { id, name, path: realPath, archived: false }
    mkdirSync(join(projectsDir, id), { recursive: true })
    saveProject(project)
    projects.set(id, project)
    const chat = loadChat(join(projectsDir, id, 'chats', 'main'), mainChatInfo(`${id}/main`, defaultEngine, id))
    broadcast({ type: 'project.added', project, chat: state(chat) })
  }

  const archiveProject = (project: Project, archived: boolean) => {
    checkIdle(chatsOf(project.id))
    const updated = { ...project, archived }
    projects.set(project.id, updated)
    saveProject(updated)
    broadcast({ type: 'project.updated', project: updated })
    return updated
  }

  const deleteProject = (project: Project) => {
    checkIdle(chatsOf(project.id))
    for (const chat of chatsOf(project.id)) chats.delete(chat.info.id)
    projects.delete(project.id)
    rmSync(join(projectsDir, project.id), { recursive: true, force: true })
    broadcast({ type: 'project.removed', projectId: project.id })
  }

  const createChat = (projectId?: string) => {
    if (projectId !== undefined && projectFor(projectId).archived) throw new Error('This project is archived')
    let id = randomBytes(4).toString('hex')
    while (chats.has(id)) id = randomBytes(4).toString('hex')
    const dir = projectId ? join(projectsDir, projectId, 'chats', id) : join(homeChatsDir, id)
    const createdAt = new Date().toISOString()
    const info = { id, main: false, title: NEW_CHAT_TITLE, engine: defaultEngine, archived: false, createdAt }
    const chat = loadChat(dir, projectId ? { ...info, projectId } : info)
    broadcast({ type: 'chat.added', chat: state(chat) })
  }

  const updateChat = (chat: Chat, change: Partial<ChatInfo>) => {
    chat.info = { ...chat.info, ...change }
    saveChat(chat)
    broadcast({ type: 'chat.updated', chat: chat.info })
  }

  const deleteChat = (chat: Chat) => {
    checkRemovable(chat)
    chats.delete(chat.info.id)
    rmSync(chat.dir, { recursive: true, force: true })
    broadcast({ type: 'chat.removed', chatId: chat.info.id })
  }

  const setEngine = (chat: Chat, engine: string) => {
    checkEngine(engine)
    if (chat.status !== 'idle') throw new Error('Wait for the turn to end before changing the engine')
    updateChat(chat, { engine })
  }

  const send = (chat: Chat, text: string) => {
    if (quitting) throw new Error('Hotrod is quitting')
    if (chat.status !== 'idle') throw new Error('A turn is already running in this chat')
    const project = chat.info.projectId === undefined ? undefined : projectFor(chat.info.projectId)
    if (chat.info.archived || project?.archived) throw new Error('This chat is archived. Unarchive it first.')
    const adapter = adapterFor(chat.info.engine)
    if (!adapter) {
      throw new Error(`Engine "${chat.info.engine}" is not available. Pick another engine for this chat.`)
    }
    const prompt = chat.entries.length ? `${transcript(chat.entries)}\n\nNew message from the user:\n\n${text}` : text
    if (!chat.info.main && !chat.entries.some((e) => e.type === 'user.message')) {
      const line = text.trim().replace(/\s+/g, ' ')
      updateChat(chat, {
        title: line.length > TITLE_MAX_CHARS ? `${line.slice(0, TITLE_MAX_CHARS).trimEnd()}…` : line,
      })
    }
    append(chat, { at: new Date().toISOString(), type: 'user.message', text })
    setStatus(chat, 'running')

    const instructionFiles = project
      ? [join(garage, 'AGENTS.md'), join(project.path, 'AGENTS.md'), join(projectsDir, project.id, 'AGENTS.md')]
      : [join(garage, 'AGENTS.md')]
    const instructions = instructionFiles
      .filter((file) => existsSync(file))
      .map((file) => readFileSync(file, 'utf8').trim())
      .join('\n\n')

    let session: Session | undefined
    const emit = (event: EngineEvent) => {
      if (chat.session !== session) return
      const at = new Date().toISOString()
      if (event.type === 'turn.completed' || event.type === 'session.ended') return endTurn(chat, { at, ...event })
      if (event.type === 'text.delta') {
        chat.unsavedText += event.text
        broadcast({ type: 'chat.delta', chatId: chat.info.id, text: event.text })
        return
      }
      if (event.type === 'thinking.delta') {
        broadcast({ type: 'chat.thinking', chatId: chat.info.id, text: event.text })
        return
      }
      if (event.type === 'text.completed') chat.unsavedText = ''
      append(chat, { at, ...event })
      if (event.type === 'permission.requested') {
        chat.pendingRequests.add(event.requestId)
        setStatus(chat, 'waiting')
      }
    }

    try {
      const options = { cwd: project?.path ?? homeDir, instructions, ...accounts.sessionFor(adapter.id) }
      session = adapter.start(machine, options, emit)
      if (chat.status === 'idle') return session.close()
      chat.session = session
      session.prompt(prompt)
    } catch (error) {
      if (chat.status === 'idle') return
      endTurn(chat, { at: new Date().toISOString(), type: 'turn.completed', error: String(error) })
    }
  }

  const interrupt = (chat: Chat, force: boolean) => {
    if (!chat.session) return
    if (force) return forceStop(chat)
    if (chat.status === 'stopping') return
    setStatus(chat, 'stopping')
    chat.stopTimer = setTimeout(() => forceStop(chat), stopGraceMs)
    chat.session.interrupt()
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
    projects: () => [...projects.values()],
    chats: () => [...chats.values()].map(state),
    accounts: accounts.list,
    refreshAccounts: accounts.refresh,
    onMessage: (listener: (message: CoreMessage) => void) => listeners.push(listener),
    handle(message: ClientMessage, reply: (message: CoreMessage) => void) {
      switch (message.type) {
        case 'project.add':
          return addProject(String(message.path), reply)
        case 'project.archive':
          return archiveProject(projectFor(message.projectId), message.archived === true)
        case 'project.delete':
          return deleteProject(projectFor(message.projectId))
        case 'chat.create':
          return createChat(message.projectId === undefined ? undefined : String(message.projectId))
        case 'chat.archive': {
          const chat = chatFor(message.chatId)
          checkRemovable(chat)
          return updateChat(chat, { archived: message.archived === true })
        }
        case 'chat.delete':
          return deleteChat(chatFor(message.chatId))
        case 'chat.setEngine':
          return setEngine(chatFor(message.chatId), String(message.engine))
        case 'chat.send':
          if (typeof message.text !== 'string' || !message.text.trim()) throw new Error('Message is empty')
          return send(chatFor(message.chatId), message.text)
        case 'chat.interrupt':
          return interrupt(chatFor(message.chatId), message.force === true)
        case 'permission.respond':
          return respond(chatFor(message.chatId), message.requestId, message.allow === true)
        case 'account.login':
          return accounts.login(String(message.engine), String(message.name ?? ''))
        case 'account.addApiKey':
          return accounts.addApiKey(String(message.engine), String(message.name ?? ''), String(message.key ?? ''))
        case 'account.code':
          return accounts.submitCode(String(message.engine), String(message.code ?? ''))
        case 'account.cancelLogin':
          return accounts.cancelLogin(String(message.engine))
        case 'account.use':
          return accounts.use(String(message.engine), String(message.accountId))
        case 'account.remove':
          return accounts.remove(String(message.engine), String(message.accountId), reply)
        default:
          throw new Error(`Unknown message type "${(message as { type: unknown }).type}"`)
      }
    },
    async close(force = false) {
      quitting = true
      for (const chat of chats.values()) {
        if (chat.status === 'idle') stopSession(chat)
        else interrupt(chat, force)
      }
      if (!allStopped()) await new Promise<void>((resolve) => allStoppedWaiters.push(resolve))
      await machine.stopAll()
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
      const call = `<tool_call name="${entry.name}">${escapeClosingTags(JSON.stringify(entry.input) ?? '')}</tool_call>`
      const result = results.get(entry.toolId)
      if (!result) lines.push(`${call}\n<tool_result status="none" />`)
      else {
        const status = result.isError ? 'error' : 'ok'
        lines.push(`${call}\n<tool_result status="${status}">\n${escapeClosingTags(result.output)}\n</tool_result>`)
      }
    }
    if (entry.type === 'turn.completed' && entry.error) lines.push(`[Turn ended early: ${entry.error}]`)
  }
  return `This is the conversation so far:\n\n${lines.join('\n\n')}`
}

const escapeClosingTags = (text: string) => text.replace(/<\/(tool_call|tool_result)/gi, '<\\/$1')
