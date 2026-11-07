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
import { basename, dirname, join, resolve } from 'node:path'
import { openAccounts } from './accounts.ts'
import { openHotrodMcp } from './hotrod-mcp.ts'
import {
  CONTEXT_KINDS,
  DEFAULT_SUBAGENT_LIMIT,
  type Adapter,
  type ChatEntry,
  type ChatInfo,
  type ChatState,
  type ChatStatus,
  type ClientMessage,
  type ContextKind,
  type ContextLayer,
  type CoreMessage,
  type EngineEvent,
  type EngineInfo,
  type EngineStatus,
  type Machine,
  type Mods,
  type Project,
  type QueuedMessage,
  type Session,
} from './types.ts'

export const STOP_GRACE_MS = 60_000
export const TITLE_MAX_CHARS = 40
const NEW_CHAT_TITLE = 'New chat'

type Chat = {
  info: ChatInfo
  dir: string
  context: Partial<Record<ContextKind, boolean>>
  entries: ChatEntry[]
  status: ChatStatus
  session?: Session
  unsavedText: string
  stopTimer?: ReturnType<typeof setTimeout>
  pendingRequests: Set<string>
  mcpToken?: string
  queue: QueuedMessage[]
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
  const settingsFile = join(garage, 'settings.json')
  const settings: {
    engines: Record<string, boolean>
    context?: Partial<Record<ContextKind, boolean>>
    mods?: Partial<Mods>
  } = { engines: {}, ...readJson(settingsFile) }
  const saveSettings = () => writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n')
  const contextDefaults = (): Record<ContextKind, boolean> => ({
    workshop: true,
    repo: true,
    project: true,
    parent: true,
    own: true,
    ...settings.context,
  })
  const mods = (): Mods => ({
    subagents: { enabled: false, limit: DEFAULT_SUBAGENT_LIMIT, ...settings.mods?.subagents },
  })
  const detected = new Map<string, EngineStatus>()
  const isEnabled = (engine: string) => settings.engines[engine] === true
  const engineInfo = (id: string): EngineInfo => ({
    id,
    enabled: isEnabled(id),
    ...(detected.get(id) ?? { installed: false, signedIn: false }),
  })
  const checkEnabled = (engine: string) => {
    if (!isEnabled(engine)) throw new Error(`Engine "${engine}" is off. Turn it on in Settings.`)
  }
  const newChatEngine = () =>
    isEnabled(defaultEngine) ? defaultEngine : (adapters.find((a) => isEnabled(a.id))?.id ?? defaultEngine)
  const projectsDir = join(garage, 'projects')
  const homeChatsDir = join(garage, 'chats')
  const homeDir = join(garage, 'home')
  for (const dir of [projectsDir, homeChatsDir, homeDir]) mkdirSync(dir, { recursive: true })
  const projects = new Map<string, Project>()
  const chats = new Map<string, Chat>()
  const allStoppedWaiters: (() => void)[] = []
  let quitting = false
  let mcpUrl: string | undefined
  const listeners: ((message: CoreMessage) => void)[] = []

  const broadcast = (message: CoreMessage) => listeners.forEach((listener) => listener(message))
  const setEngineEnabled = (engine: string, enabled: boolean) => {
    checkEngine(engine)
    settings.engines = { ...settings.engines, [engine]: enabled }
    saveSettings()
    broadcast({ type: 'engine.updated', engine: engineInfo(engine) })
  }
  const setSubagents = (enabled: boolean, limit: unknown) => {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < -1) {
      throw new Error('The subagent limit must be a whole number, or -1 for no limit')
    }
    settings.mods = { ...settings.mods, subagents: { enabled, limit } }
    saveSettings()
    broadcast({ type: 'mods.updated', mods: mods() })
  }
  const saveProject = (project: Project) =>
    writeFileSync(join(projectsDir, project.id, 'project.json'), JSON.stringify(project, null, 2) + '\n')
  const saveChat = ({ info, dir, context }: Chat) => {
    const { id, title, engine, archived, createdAt, parentId } = info
    const saved = {
      id,
      title,
      engine,
      archived,
      createdAt,
      ...(parentId !== undefined && { parentId }),
      ...(Object.keys(context).length ? { context } : {}),
    }
    writeFileSync(join(dir, 'chat.json'), JSON.stringify(saved, null, 2) + '\n')
  }
  const state = (chat: Chat): ChatState => ({
    ...chat.info,
    status: chat.status,
    entries: chat.entries,
    draft: chat.unsavedText,
    queue: chat.queue,
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
    if (chat.mcpToken) mcp.revoke(chat.mcpToken)
    chat.mcpToken = undefined
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
    if (quitting) return
    const parent = parentOf(chat)
    if (parent) reportErrors(() => enqueue(parent, reportOf(chat, end.error)))
    if (chat.queue.length) reportErrors(() => sendQueue(chat))
  }

  const reportErrors = (run: () => void) => {
    try {
      run()
    } catch (error) {
      broadcast({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  const parentOf = (chat: Chat) => (chat.info.parentId === undefined ? undefined : chats.get(chat.info.parentId))

  const reportOf = (chat: Chat, error?: string) => {
    const asked = chat.entries.findLastIndex((e) => e.type === 'user.message')
    const reply = chat.entries.slice(asked + 1).findLast((e) => e.type === 'text.completed')
    const text = reply?.type === 'text.completed' ? reply.text : '(No reply)'
    const early = error ? ` (The turn ended early: ${error})` : ''
    return `[subagent "${chat.info.title}" (${chat.info.id})] ${text}${early}`
  }

  const forceStop = (chat: Chat) =>
    endTurn(chat, { at: new Date().toISOString(), type: 'turn.completed', error: 'Interrupted' })

  const loadChat = (dir: string, fallback: ChatInfo) => {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'chat.json')
    const { context = {}, ...saved } = readJson(file)
    const info: ChatInfo = { ...fallback, ...saved, id: fallback.id, main: fallback.main }
    if (fallback.main) info.title = fallback.title
    const logFile = join(dir, 'log.jsonl')
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    const entries: ChatEntry[] = log.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const chat: Chat = {
      info,
      dir,
      context,
      entries,
      status: 'idle',
      unsavedText: '',
      pendingRequests: new Set(),
      queue: [],
    }
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
    title: projectId ? 'Main' : 'Workshop',
    engine,
    archived: false,
    createdAt: new Date().toISOString(),
  })

  const loadSubchats = (chatsDir: string, projectId?: string) => {
    for (const id of readdirSync(chatsDir)) {
      if (id === 'main' || !existsSync(join(chatsDir, id, 'chat.json'))) continue
      const createdAt = new Date().toISOString()
      const fallback = { id, main: false, title: NEW_CHAT_TITLE, engine: newChatEngine(), archived: false, createdAt }
      loadChat(join(chatsDir, id), projectId ? { ...fallback, projectId } : fallback)
    }
  }

  loadChat(join(homeChatsDir, 'main'), mainChatInfo('main', newChatEngine()))
  loadSubchats(homeChatsDir)
  for (const id of readdirSync(projectsDir)) {
    const projectFile = join(projectsDir, id, 'project.json')
    if (!existsSync(projectFile)) continue
    const { engine = newChatEngine(), ...saved } = JSON.parse(readFileSync(projectFile, 'utf8'))
    const project: Project = { archived: false, ...saved, id }
    projects.set(id, project)
    loadChat(join(projectsDir, id, 'chats', 'main'), mainChatInfo(`${id}/main`, engine, id))
    loadSubchats(join(projectsDir, id, 'chats'), id)
  }

  const addProject = (rawPath: string, name?: string, reply?: (message: CoreMessage) => void): Project => {
    const expanded = rawPath.trim().replace(/^~(?=$|\/)/, homedir())
    const path = resolve(expanded)
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Not a folder: ${rawPath}`)
    const realPath = realpathSync(path)
    const existing = [...projects.values()].find((project) => project.path === realPath)
    if (existing) {
      const project = existing.archived ? archiveProject(existing, false) : existing
      reply?.({ type: 'project.added', project, chat: state(chatFor(`${existing.id}/main`)) })
      return project
    }

    const projectName = name?.trim() || basename(realPath) || 'root'
    const base = projectName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '') || 'project'
    // macOS folders are case-insensitive, so "App" and "app" would share a folder.
    const taken = new Set(readdirSync(projectsDir).map((id) => id.toLowerCase()))
    let id = base
    for (let n = 2; taken.has(id.toLowerCase()); n++) id = `${base}-${n}`

    const project: Project = { id, name: projectName, path: realPath, archived: false }
    mkdirSync(join(projectsDir, id), { recursive: true })
    saveProject(project)
    projects.set(id, project)
    const chat = loadChat(join(projectsDir, id, 'chats', 'main'), mainChatInfo(`${id}/main`, newChatEngine(), id))
    broadcast({ type: 'project.added', project, chat: state(chat) })
    return project
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

  const createChat = (projectId?: string, engine = newChatEngine(), parentId?: string) => {
    checkEngine(engine)
    checkEnabled(engine)
    if (projectId !== undefined && projectFor(projectId).archived) throw new Error('This project is archived')
    if (parentId !== undefined) {
      const parent = chatFor(parentId)
      if (parent.info.parentId !== undefined) throw new Error('A subagent cannot start subagents')
      if (parent.info.projectId !== projectId) throw new Error("A subagent stays in its parent chat's place")
    }
    let id = randomBytes(4).toString('hex')
    while (chats.has(id)) id = randomBytes(4).toString('hex')
    const dir = projectId ? join(projectsDir, projectId, 'chats', id) : join(homeChatsDir, id)
    const createdAt = new Date().toISOString()
    const info: ChatInfo = {
      id,
      ...(projectId !== undefined && { projectId }),
      main: false,
      title: NEW_CHAT_TITLE,
      engine,
      archived: false,
      createdAt,
      ...(parentId !== undefined && { parentId }),
    }
    const chat = loadChat(dir, info)
    broadcast({ type: 'chat.added', chat: state(chat) })
    return chat.info
  }

  const updateChat = (chat: Chat, change: Partial<ChatInfo>) => {
    chat.info = { ...chat.info, ...change }
    saveChat(chat)
    broadcast({ type: 'chat.updated', chat: chat.info })
  }

  const withSubagents = (chat: Chat) => {
    const family = [chat, ...[...chats.values()].filter((c) => c.info.parentId === chat.info.id)]
    family.forEach(checkRemovable)
    return family
  }

  const archiveChat = (chat: Chat, archived: boolean) =>
    withSubagents(chat).forEach((c) => updateChat(c, { archived }))

  const deleteChat = (chat: Chat) => {
    for (const c of withSubagents(chat)) {
      chats.delete(c.info.id)
      rmSync(c.dir, { recursive: true, force: true })
      broadcast({ type: 'chat.removed', chatId: c.info.id })
    }
  }

  const setEngine = (chat: Chat, engine: string) => {
    checkEngine(engine)
    checkEnabled(engine)
    if (chat.status !== 'idle') throw new Error('Wait for the turn to end before changing the engine')
    updateChat(chat, { engine })
  }

  const projectOf = (chat: Chat) => (chat.info.projectId === undefined ? undefined : projectFor(chat.info.projectId))

  const checkActive = (chat: Chat) => {
    if (chat.info.archived || projectOf(chat)?.archived) throw new Error('This chat is archived. Unarchive it first.')
  }

  const contextLayers = (chat: Chat): ContextLayer[] => {
    const project = projectOf(chat)
    const files: [ContextKind, string][] = [['workshop', join(garage, 'AGENTS.md')]]
    if (project) {
      files.push(['repo', join(project.path, 'AGENTS.md')], ['project', join(projectsDir, project.id, 'AGENTS.md')])
    }
    const parent = parentOf(chat)
    if (parent && !parent.info.main) files.push(['parent', join(parent.dir, 'AGENTS.md')])
    if (!chat.info.main) files.push(['own', join(chat.dir, 'AGENTS.md')])
    const inherited = (kind: ContextKind) => parent?.context[kind === 'parent' ? 'own' : kind]
    return files.map(([kind, path]) => ({
      kind,
      path,
      enabled: chat.context[kind] ?? inherited(kind) ?? contextDefaults()[kind],
      writable: kind !== 'repo',
      text: existsSync(path) ? readFileSync(path, 'utf8') : '',
    }))
  }

  const layerOf = (chat: Chat, kind: ContextKind) => {
    const layer = contextLayers(chat).find((l) => l.kind === kind)
    if (!layer) throw new Error(`This chat has no "${kind}" layer`)
    return layer
  }

  const checkKind = (kind: unknown): ContextKind => {
    if (!CONTEXT_KINDS.includes(kind as ContextKind)) throw new Error(`Unknown context layer "${kind}"`)
    return kind as ContextKind
  }

  const setContext = (chat: Chat, kind: ContextKind, enabled: boolean) => {
    checkActive(chat)
    layerOf(chat, kind)
    chat.context = { ...chat.context, [kind]: enabled }
    saveChat(chat)
    broadcast({ type: 'chat.context', chatId: chat.info.id, layers: contextLayers(chat) })
  }

  const writeContext = (chat: Chat, kind: ContextKind, text: string) => {
    checkActive(chat)
    const { path, writable } = layerOf(chat, kind)
    if (!writable) throw new Error('Hotrod never writes into a project folder. Edit this file in the repo.')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
    broadcast({ type: 'context.file', path, text })
  }

  const setContextDefault = (kind: ContextKind, enabled: boolean) => {
    settings.context = { ...settings.context, [kind]: enabled }
    saveSettings()
    broadcast({ type: 'context.defaults', defaults: contextDefaults() })
  }

  const send = (chat: Chat, text: string) => {
    if (quitting) throw new Error('Hotrod is quitting')
    if (chat.status !== 'idle') throw new Error('A turn is already running in this chat')
    const project = projectOf(chat)
    checkActive(chat)
    const adapter = adapterFor(chat.info.engine)
    if (!adapter) {
      throw new Error(`Engine "${chat.info.engine}" is not available. Pick another engine for this chat.`)
    }
    checkEnabled(adapter.id)
    const prompt = chat.entries.length ? `${transcript(chat.entries)}\n\nNew message from the user:\n\n${text}` : text
    if (!chat.info.main && !chat.entries.some((e) => e.type === 'user.message')) {
      const line = text.trim().replace(/\s+/g, ' ')
      updateChat(chat, {
        title: line.length > TITLE_MAX_CHARS ? `${line.slice(0, TITLE_MAX_CHARS).trimEnd()}…` : line,
      })
    }
    append(chat, { at: new Date().toISOString(), type: 'user.message', text })
    setStatus(chat, 'running')

    const instructions = contextLayers(chat)
      .filter((layer) => layer.enabled && layer.text.trim())
      .map((layer) => layer.text.trim())
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
      chat.mcpToken = mcpUrl === undefined ? undefined : mcp.grant(chat.info.id)
      const hotrodMcp = mcpUrl && chat.mcpToken ? { url: mcpUrl, token: chat.mcpToken } : undefined
      const options = {
        cwd: project?.path ?? homeDir,
        instructions,
        ...accounts.sessionFor(adapter.id),
        ...(hotrodMcp && { hotrodMcp }),
      }
      session = adapter.start(machine, options, emit)
      if (chat.status === 'idle') return session.close()
      chat.session = session
      session.prompt(prompt)
    } catch (error) {
      if (chat.status === 'idle') return
      endTurn(chat, { at: new Date().toISOString(), type: 'turn.completed', error: String(error) })
    }
  }

  const setQueue = (chat: Chat, queue: QueuedMessage[]) => {
    chat.queue = queue
    broadcast({ type: 'chat.queue', chatId: chat.info.id, queue })
  }

  const sendQueue = (chat: Chat, text?: string) => {
    const queue = chat.queue
    if (queue.length) setQueue(chat, [])
    try {
      send(chat, [...queue.map((q) => q.text), ...(text === undefined ? [] : [text])].join('\n\n'))
    } catch (error) {
      if (queue.length) setQueue(chat, queue)
      throw error
    }
  }

  const enqueue = (chat: Chat, text: string) => {
    if (quitting) throw new Error('Hotrod is quitting')
    checkActive(chat)
    if (chat.status === 'idle') return sendQueue(chat, text)
    setQueue(chat, [...chat.queue, { id: randomBytes(4).toString('hex'), text }])
  }

  const mcp = openHotrodMcp({
    chats: () => [...chats.values()].map(state),
    projects: () => [...projects.values()],
    addProject,
    createChat,
    send: (chatId, text) => send(chatFor(chatId), text),
    subagents: () => mods().subagents,
  })

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
    engines: () => adapters.map((adapter) => engineInfo(adapter.id)),
    async refreshEngines() {
      await Promise.all(
        adapters.map(async (adapter) => {
          try {
            detected.set(adapter.id, await adapter.detect(machine))
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            detected.set(adapter.id, { installed: false, signedIn: false, detail })
          }
          broadcast({ type: 'engine.updated', engine: engineInfo(adapter.id) })
        }),
      )
    },
    setEngineEnabled,
    contextDefaults,
    mods,
    projects: () => [...projects.values()],
    chats: () => [...chats.values()].map(state),
    accounts: accounts.list,
    refreshAccounts: accounts.refresh,
    onMessage: (listener: (message: CoreMessage) => void) => listeners.push(listener),
    serveMcp(url: string) {
      mcpUrl = url
      return mcp.handle
    },
    handle(message: ClientMessage, reply: (message: CoreMessage) => void) {
      switch (message.type) {
        case 'engine.setEnabled':
          return setEngineEnabled(String(message.engine), message.enabled === true)
        case 'project.add':
          return void addProject(String(message.path), undefined, reply)
        case 'project.archive':
          return archiveProject(projectFor(message.projectId), message.archived === true)
        case 'project.delete':
          return deleteProject(projectFor(message.projectId))
        case 'chat.create':
          return void createChat(message.projectId === undefined ? undefined : String(message.projectId))
        case 'chat.archive':
          return archiveChat(chatFor(message.chatId), message.archived === true)
        case 'chat.delete':
          return deleteChat(chatFor(message.chatId))
        case 'chat.setEngine':
          return setEngine(chatFor(message.chatId), String(message.engine))
        case 'chat.send':
          if (typeof message.text !== 'string' || !message.text.trim()) throw new Error('Message is empty')
          return enqueue(chatFor(message.chatId), message.text)
        case 'chat.unqueue': {
          const chat = chatFor(message.chatId)
          if (!chat.queue.some((q) => q.id === message.id)) return
          return setQueue(chat, chat.queue.filter((q) => q.id !== message.id))
        }
        case 'chat.interrupt':
          return interrupt(chatFor(message.chatId), message.force === true)
        case 'context.get': {
          const chat = chatFor(message.chatId)
          return reply({ type: 'chat.context', chatId: chat.info.id, layers: contextLayers(chat) })
        }
        case 'context.set':
          return setContext(chatFor(message.chatId), checkKind(message.kind), message.enabled === true)
        case 'context.write':
          if (typeof message.text !== 'string') throw new Error('Context text is missing')
          return writeContext(chatFor(message.chatId), checkKind(message.kind), message.text)
        case 'context.setDefault':
          return setContextDefault(checkKind(message.kind), message.enabled === true)
        case 'subagents.set':
          return setSubagents(message.enabled === true, message.limit)
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

const readJson = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {})

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
