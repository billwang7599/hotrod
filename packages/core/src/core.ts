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
import { basename, dirname, isAbsolute, join } from 'node:path'
import { openAccounts } from './accounts.ts'
import { openHotrodMcp } from './hotrod-mcp.ts'
import {
  MEMORY_INSTRUCTIONS,
  memoryPrompt,
  memoryView,
  messagesOf,
  openCompactor,
  openSummaries,
  withAttachments,
  ZOOM_INSTRUCTIONS,
  type Summaries,
} from './memory.ts'
import {
  CONTEXT_SECTIONS,
  DEFAULT_SUBAGENT_LIMIT,
  IMAGE_TYPES,
  looksBinary,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  MODEL_ROLES,
  pickModel,
  pickThinking,
  WORKSHOP_ID,
  WORKSHOP_NAME,
  type Adapter,
  type Attachment,
  type ChatEntry,
  type ChatInfo,
  type ChatState,
  type ChatStatus,
  type ClientMessage,
  type ContextItem,
  type ContextSection,
  type CoreMessage,
  type EngineEvent,
  type EngineInfo,
  type EngineStatus,
  type Machine,
  type MemorySettings,
  type ModelLists,
  type ModelRole,
  type Mods,
  type NewChat,
  type QueuedMessage,
  type Session,
  type Upload,
} from './shared.ts'

export const STOP_GRACE_MS = 60_000
const PARENT_VIEW_FILE = 'parent-view.md'
export const MAX_CHAT_DEPTH = 1
export const HOME_INSTRUCTIONS =
  `You are the user's personal assistant in Hotrod, running in its main chat, ${WORKSHOP_NAME}. Answer general ` +
  'questions, help with personal tasks and use your MCP tools. You may work in any directory the user names in this ' +
  `chat: read, edit and run commands there. No folder stays attached to ${WORKSHOP_NAME}; each message starts in a ` +
  'scratch folder. For ongoing work in a folder, offer to make a space for it: a chat below you with that folder, ' +
  'made with the hotrod create_chat tool. list_chats, read_chat and send_message reach the spaces that exist.'

type Chat = {
  info: ChatInfo
  dir: string
  context: Record<string, boolean>
  entries: ChatEntry[]
  status: ChatStatus
  session?: Session
  unsavedText: string
  stopTimer?: ReturnType<typeof setTimeout>
  pendingRequests: Set<string>
  mcpToken?: string
  queue: QueuedMessage[]
  summaries: Summaries
}

export type Core = ReturnType<typeof openCore>

export function openCore(options: {
  garage: string
  adapters: Adapter[]
  defaultEngine: string
  machine: Machine
  stopGraceMs?: number
  compactDebounceMs?: number
}) {
  const { adapters, defaultEngine, machine, stopGraceMs = STOP_GRACE_MS, compactDebounceMs } = options
  mkdirSync(options.garage, { recursive: true })
  // Context paths are saved resolved, so attachment paths must be too for a pin to match its file.
  const garage = realpathSync(options.garage)
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
    context?: Partial<Record<ContextSection, boolean>>
    mods?: Partial<Mods>
    models?: Record<string, Partial<ModelLists>>
    defaultThinking?: Record<string, string>
    memory?: MemorySettings
  } = { engines: {}, ...readJson(settingsFile) }
  const saveSettings = () => writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n')
  const contextDefaults = (): Record<ContextSection, boolean> => ({
    agents: settings.context?.agents ?? true,
    folders: settings.context?.folders ?? true,
    files: settings.context?.files ?? true,
  })
  const mods = (): Mods => ({
    subagents: { enabled: false, limit: DEFAULT_SUBAGENT_LIMIT, ...settings.mods?.subagents },
  })
  const listsOf = (engine: string): ModelLists => ({
    chat: [],
    planning: [],
    searching: [],
    subagents: [],
    ...settings.models?.[engine],
  })
  const detected = new Map<string, Omit<EngineInfo, 'id' | 'enabled'>>()
  const isEnabled = (engine: string) => settings.engines[engine] === true
  const engineInfo = (id: string): EngineInfo => {
    const status = detected.get(id) ?? { installed: false, signedIn: false }
    const chosen = settings.defaultThinking?.[id]
    const offersChosen = chosen !== undefined && status.thinking?.includes(chosen)
    return { id, enabled: isEnabled(id), ...status, ...(offersChosen && { defaultThinking: chosen }) }
  }
  const engineInfos = () => adapters.map((adapter) => engineInfo(adapter.id))
  const offered = (engine: string) => {
    const { models = [], thinking = [] } = detected.get(engine) ?? {}
    return { models, thinking }
  }
  const offersModel = (engine: string, model?: string) => offered(engine).models.some((m) => m.id === model)
  const checkEnabled = (engine: string) => {
    if (!isEnabled(engine)) throw new Error(`Engine "${engine}" is off. Turn it on in Settings.`)
  }
  const newChatEngine = () =>
    isEnabled(defaultEngine) ? defaultEngine : (adapters.find((a) => isEnabled(a.id))?.id ?? defaultEngine)
  const chatsDir = join(garage, 'chats')
  const homeDir = join(garage, 'home')
  for (const dir of [chatsDir, homeDir]) mkdirSync(dir, { recursive: true })
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
  const setModelList = (engine: string, role: unknown, models: unknown) => {
    checkEngine(engine)
    if (!MODEL_ROLES.includes(role as ModelRole)) throw new Error(`Unknown model role "${role}"`)
    if (!Array.isArray(models) || !models.every((id) => typeof id === 'string' && id)) {
      throw new Error('A model list must be a list of model ids')
    }
    settings.models = { ...settings.models, [engine]: { ...settings.models?.[engine], [role as ModelRole]: models } }
    saveSettings()
    broadcast({ type: 'models.updated', engine, lists: listsOf(engine) })
  }
  const setDefaultThinking = (engine: string, thinking: string) => {
    checkEngine(engine)
    if (!offered(engine).thinking.includes(thinking)) {
      throw new Error(`Engine "${engine}" offers no thinking level "${thinking}"`)
    }
    settings.defaultThinking = { ...settings.defaultThinking, [engine]: thinking }
    saveSettings()
    broadcast({ type: 'engine.updated', engine: engineInfo(engine) })
  }
  const setMemory = (engine?: string, model?: string) => {
    if (engine === undefined && model !== undefined) throw new Error('Pick the engine for summaries with its model')
    if (engine !== undefined) {
      checkEngine(engine)
      if (!adapterFor(engine)?.complete) throw new Error(`Engine "${engine}" can't write summaries`)
      checkEnabled(engine)
      if (model !== undefined && !offersModel(engine, model)) {
        throw new Error(`Engine "${engine}" offers no model "${model}"`)
      }
    }
    settings.memory = { ...(engine && { engine }), ...(model && { model }) }
    saveSettings()
    broadcast({ type: 'memory.updated', memory: settings.memory })
  }
  const saveChat = ({ info, dir, context }: Chat) => {
    const file = { ...info, ...(Object.keys(context).length ? { context } : {}) }
    writeFileSync(join(dir, 'chat.json'), JSON.stringify(file, null, 2) + '\n')
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

  const memoryOf = (chat: Chat) => ({ messages: messagesOf(chat.entries), summaries: chat.summaries })
  const takesMcp = (engine: string) => adapterFor(engine)?.hotrodMcp === true && mcpUrl !== undefined

  const compactor = openCompactor({
    chat: (chatId) => {
      const chat = chats.get(chatId)
      return chat && memoryOf(chat)
    },
    async complete(request) {
      const { engine, model } = pickMemory(engineInfos(), settings.memory ?? {})
      const adapter = engine === undefined ? undefined : adapterFor(engine)
      if (!adapter?.complete || model === undefined) throw new Error('No engine that is on can write summaries')
      checkEnabled(adapter.id)
      return adapter.complete(machine, { ...request, cwd: homeDir, model, ...accounts.sessionFor(adapter.id) })
    },
    onFailure: (reason) => broadcast({ type: 'error', message: `Memory summaries are failing: ${reason}. Retrying.` }),
    ...(compactDebounceMs !== undefined && { debounceMs: compactDebounceMs }),
  })

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

  const isWorkshop = (chat: Chat) => chat.info.id === WORKSHOP_ID

  const parentOf = (chat: Chat) => (chat.info.parentId === undefined ? undefined : chats.get(chat.info.parentId))

  const chainOf = (chat: Chat): Chat[] => {
    const parent = parentOf(chat)
    return parent ? [...chainOf(parent), chat] : [chat]
  }

  const familyOf = (chat: Chat): Chat[] => [
    chat,
    ...[...chats.values()].filter((c) => c.info.parentId === chat.info.id).flatMap(familyOf),
  ]

  const canNest = (chat: Chat) => !chat.info.subagent && chainOf(chat).length - 1 < MAX_CHAT_DEPTH

  const checkRemovable = (chat: Chat) => {
    if (isWorkshop(chat)) throw new Error(`${WORKSHOP_NAME} cannot be archived or deleted`)
    if (chat.status !== 'idle') throw new Error('Stop the running chat first')
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
    compactor.touch(chat.info.id)
    const parent = chat.info.subagent ? parentOf(chat) : undefined
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

  const reportOf = (chat: Chat, error?: string) => {
    const asked = chat.entries.findLastIndex((e) => e.type === 'user.message')
    const reply = chat.entries.slice(asked + 1).findLast((e) => e.type === 'text.completed')
    const text = reply?.type === 'text.completed' ? reply.text : '(No reply)'
    const early = error ? ` (The turn ended early: ${error})` : ''
    return `[subagent "${chat.info.name}" (${chat.info.id})] ${text}${early}`
  }

  const forceStop = (chat: Chat) =>
    endTurn(chat, { at: new Date().toISOString(), type: 'turn.completed', error: 'Interrupted' })

  const loadChat = (dir: string, fallback: ChatInfo) => {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'chat.json')
    const { context = {}, title, ...saved } = readJson(file)
    const info: ChatInfo = { ...fallback, ...(title !== undefined && { name: title }), ...saved, id: fallback.id }
    if (info.id === WORKSHOP_ID) Object.assign(info, { name: WORKSHOP_NAME, folders: [], files: [] })
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
      summaries: openSummaries(join(dir, 'summaries.jsonl')),
    }
    if (!existsSync(file) || info.id === WORKSHOP_ID) saveChat(chat)
    chats.set(info.id, chat)
    const lastTurnEvent = entries.findLast((e) => ['turn.started', 'turn.completed', 'session.ended'].includes(e.type))
    if (lastTurnEvent?.type === 'turn.started' || entries.at(-1)?.type === 'user.message') {
      append(chat, { at: new Date().toISOString(), type: 'turn.completed', error: 'Hotrod quit during this turn' })
    }
    return chat
  }

  const freshInfo = (id: string, name: string, parentId?: string): ChatInfo => ({
    id,
    name,
    ...(parentId !== undefined && { parentId }),
    folders: [],
    files: [],
    engine: newChatEngine(),
    archived: false,
    createdAt: new Date().toISOString(),
  })

  loadChat(join(chatsDir, WORKSHOP_ID), freshInfo(WORKSHOP_ID, WORKSHOP_NAME))
  for (const id of readdirSync(chatsDir)) {
    if (id === WORKSHOP_ID || !existsSync(join(chatsDir, id, 'chat.json'))) continue
    loadChat(join(chatsDir, id), freshInfo(id, id, WORKSHOP_ID))
  }

  const createChat = (spec: NewChat & { subagent?: boolean; role?: ModelRole }) => {
    const name = checkName(spec.name)
    const engine = spec.engine ?? newChatEngine()
    checkEngine(engine)
    if (spec.engine !== undefined) checkEnabled(engine)
    const parent = chatFor(spec.parentId ?? WORKSHOP_ID)
    checkActive(parent)
    if (parent.info.subagent) throw new Error('A subagent cannot start chats')
    if (!spec.subagent && !canNest(parent)) {
      throw new Error(`Chats nest at most ${MAX_CHAT_DEPTH} deep below ${WORKSHOP_NAME}`)
    }
    const folders = [...new Set((spec.folders ?? []).map((path) => checkPath(path, 'folders')))]
    const files = [...new Set((spec.files ?? []).map((path) => checkPath(path, 'files')))]
    let id = randomBytes(4).toString('hex')
    while (chats.has(id)) id = randomBytes(4).toString('hex')
    const parentMemory = spec.subagent ? memoryOf(parent) : undefined
    const info: ChatInfo = {
      id,
      name,
      parentId: parent.info.id,
      ...(parentMemory && {
        subagent: true,
        role: spec.role ?? 'subagents',
        parentMessages: parentMemory.messages.length,
      }),
      folders,
      files,
      engine,
      archived: false,
      createdAt: new Date().toISOString(),
      ...(spec.subagent && parent.info.engine === engine && { thinking: parent.info.thinking }),
    }
    const chat = loadChat(join(chatsDir, id), info)
    if (parentMemory?.messages.length) {
      const view = memoryView(parentMemory.messages, parentMemory.summaries, { zoom: takesMcp(engine) })
      writeFileSync(join(chat.dir, PARENT_VIEW_FILE), view)
    }
    broadcast({ type: 'chat.added', chat: state(chat) })
    return chat.info
  }

  const updateChat = (chat: Chat, change: Partial<ChatInfo>) => {
    const merged = Object.entries({ ...chat.info, ...change }).filter(([, value]) => value !== undefined)
    chat.info = Object.fromEntries(merged) as ChatInfo
    saveChat(chat)
    broadcast({ type: 'chat.updated', chat: chat.info })
  }

  const renameChat = (chat: Chat, name: unknown) => {
    if (isWorkshop(chat)) throw new Error(`${WORKSHOP_NAME} cannot be renamed`)
    updateChat(chat, { name: checkName(name) })
  }

  const archiveChat = (chat: Chat, archived: boolean) => {
    const parent = parentOf(chat)
    if (!archived && parent?.info.archived) throw new Error(`Unarchive "${parent.info.name}" first`)
    const family = familyOf(chat)
    family.forEach(checkRemovable)
    family.forEach((c) => updateChat(c, { archived }))
  }

  const deleteChat = (chat: Chat) => {
    const family = familyOf(chat)
    family.forEach(checkRemovable)
    for (const c of family) {
      chats.delete(c.info.id)
      rmSync(c.dir, { recursive: true, force: true })
      broadcast({ type: 'chat.removed', chatId: c.info.id })
    }
  }

  const setEngine = (chat: Chat, engine: string) => {
    checkEngine(engine)
    checkEnabled(engine)
    if (chat.status !== 'idle') throw new Error('Wait for the turn to end before changing the engine')
    const { model, thinking } = chat.info
    updateChat(chat, {
      engine,
      model: offersModel(engine, model) ? model : undefined,
      thinking: thinking && offered(engine).thinking.includes(thinking) ? thinking : undefined,
    })
  }

  const setModel = (chat: Chat, model?: string, thinking?: string) => {
    if (chat.status !== 'idle') throw new Error('Wait for the turn to end before changing the model')
    const { engine } = chat.info
    const offers = offered(engine)
    if (model && !offersModel(engine, model)) throw new Error(`Engine "${engine}" offers no model "${model}"`)
    if (thinking && !offers.thinking.includes(thinking)) {
      throw new Error(`Engine "${engine}" offers no thinking level "${thinking}"`)
    }
    const info = engineInfo(engine)
    const unpinned = pickModel(info, listsOf(engine), { role: chat.info.role })
    updateChat(chat, {
      model: model === unpinned ? undefined : model,
      thinking: thinking === info.defaultThinking ? undefined : thinking,
    })
  }

  const checkActive = (chat: Chat) => {
    if (chat.info.archived) throw new Error('This chat is archived. Unarchive it first.')
  }

  const agentsFileOf = (chat: Chat) => join(isWorkshop(chat) ? garage : chat.dir, 'AGENTS.md')

  const switchOf = (chat: Chat, item: Pick<ContextItem, 'section' | 'path' | 'from'>): boolean => {
    const pinned = chat.context[item.path]
    if (pinned !== undefined) return pinned
    if (item.from === chat.info.id) return true
    const parent = parentOf(chat)
    return chat.info.subagent && parent ? switchOf(parent, item) : contextDefaults()[item.section]
  }

  const contextItems = (chat: Chat): ContextItem[] => {
    const seen = new Set<string>()
    return chainOf(chat).flatMap((owner) => {
      const owned = [
        ...owner.info.folders.map((path) => ({ section: 'folders' as const, path })),
        { section: 'agents' as const, path: agentsFileOf(owner) },
        ...owner.info.files.map((path) => ({ section: 'files' as const, path })),
      ]
      return owned.flatMap(({ section, path }) => {
        if (seen.has(path)) return []
        seen.add(path)
        const item = { section, path, from: owner.info.id }
        const bytes = readBytes(section === 'folders' ? join(path, 'AGENTS.md') : path)
        const binary = section === 'files' && looksBinary(bytes)
        const text = binary ? '' : bytes.toString('utf8')
        return [{ ...item, enabled: switchOf(chat, item), text, ...(binary && { binary }) }]
      })
    })
  }

  const broadcastContext = (chat: Chat) =>
    familyOf(chat).forEach((c) => broadcast({ type: 'chat.context', chatId: c.info.id, items: contextItems(c) }))

  const setContext = (chat: Chat, path: unknown, enabled: boolean) => {
    checkActive(chat)
    if (!contextItems(chat).some((item) => item.path === path)) {
      throw new Error(`This chat has no context item "${path}"`)
    }
    chat.context = { ...chat.context, [String(path)]: enabled }
    saveChat(chat)
    broadcastContext(chat)
  }

  const addContext = (chat: Chat, section: 'folders' | 'files', rawPath: unknown) => {
    checkActive(chat)
    if (isWorkshop(chat)) {
      throw new Error(`${WORKSHOP_NAME} keeps no folders or files. Name a folder in its chat, or make a space for it.`)
    }
    const path = checkPath(rawPath, section)
    if (contextItems(chat).some((item) => item.path === path)) {
      throw new Error(`${path} is already in this chat's context`)
    }
    updateChat(chat, { [section]: [...chat.info[section], path] })
    broadcastContext(chat)
  }

  const removeContext = (chat: Chat, section: 'folders' | 'files', path: unknown) => {
    checkActive(chat)
    if (!chat.info[section].includes(String(path))) throw new Error(`${path} is not one of this chat's ${section}`)
    delete chat.context[String(path)]
    updateChat(chat, { [section]: chat.info[section].filter((p) => p !== path) })
    broadcastContext(chat)
  }

  const writeContext = (chat: Chat, text: string) => {
    checkActive(chat)
    const path = agentsFileOf(chat)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
    broadcast({ type: 'context.file', path, text })
  }

  const setContextDefault = (section: ContextSection, enabled: boolean) => {
    settings.context = { ...settings.context, [section]: enabled }
    saveSettings()
    broadcast({ type: 'context.defaults', defaults: contextDefaults() })
  }

  const attachmentsDirOf = (chat: Chat) => join(chat.dir, 'attachments')

  const send = (chat: Chat, text: string, attachments: Attachment[] = []) => {
    if (quitting) throw new Error('Hotrod is quitting')
    if (chat.status !== 'idle') throw new Error('A turn is already running in this chat')
    checkActive(chat)
    const adapter = adapterFor(chat.info.engine)
    if (!adapter) {
      throw new Error(`Engine "${chat.info.engine}" is not available. Pick another engine for this chat.`)
    }
    checkEnabled(adapter.id)
    const message = withAttachments(text, attachments)
    const zoomable = takesMcp(adapter.id)
    const prompt = memoryPrompt(messagesOf(chat.entries), chat.summaries, message, { zoom: zoomable })
    const sent = { type: 'user.message' as const, text, ...(attachments.length && { attachments }) }
    append(chat, { at: new Date().toISOString(), ...sent })
    setStatus(chat, 'running')

    const items = contextItems(chat).filter((item) => item.enabled)
    const contextText = items.flatMap(({ section, path, text, binary }) => {
      if (binary) {
        return [`The file ${path} is not text, so it isn't pasted here. Open it with your tools when you need it.`]
      }
      if (!text.trim()) return []
      return [section === 'files' ? `<file path="${path}">\n${text.trimEnd()}\n</file>` : text.trim()]
    })
    const readFiles = items.flatMap((item) => (item.binary ? [item.path] : []))
    const role = isWorkshop(chat) ? [HOME_INSTRUCTIONS] : []
    const parentView = readBytes(join(chat.dir, PARENT_VIEW_FILE)).toString('utf8')
    const zoomParent = zoomable ? ' (zoom and date read it with parent: true)' : ''
    const parentIntro = `Your parent chat's memory when it started you${zoomParent}:`
    const memory = [
      MEMORY_INSTRUCTIONS,
      ...(zoomable ? [ZOOM_INSTRUCTIONS] : []),
      ...(parentView ? [`${parentIntro}\n\n${parentView}`] : []),
    ]
    const instructions = [...role, ...memory, ...contextText].join('\n\n')
    const folders = items.filter((item) => item.section === 'folders')
    const nearest = folders.at(-1)?.from
    const cwd = folders.find((folder) => folder.from === nearest)?.path ?? homeDir
    const attachmentsDir = attachmentsDirOf(chat)
    const extraDirs = [
      ...folders.map((folder) => folder.path).filter((path) => path !== cwd),
      ...(existsSync(attachmentsDir) ? [attachmentsDir] : []),
    ]

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
      chat.mcpToken = zoomable ? mcp.grant(chat.info.id) : undefined
      const hotrodMcp = mcpUrl && chat.mcpToken ? { url: mcpUrl, token: chat.mcpToken } : undefined
      const engine = engineInfo(adapter.id)
      const model = pickModel(engine, listsOf(adapter.id), chat.info)
      const thinking = pickThinking(engine, chat.info)
      const images = adapter.imageInput
        ? attachments
            .filter((a) => IMAGE_TYPES.includes(a.mimeType))
            .map((a) => ({ mimeType: a.mimeType, base64: readFileSync(a.path).toString('base64') }))
        : []
      const options = {
        cwd,
        instructions,
        ...(extraDirs.length && { extraDirs }),
        ...(readFiles.length && { readFiles }),
        ...accounts.sessionFor(adapter.id),
        ...(hotrodMcp && { hotrodMcp }),
        ...(model && { model }),
        ...(thinking && { thinking }),
      }
      session = adapter.start(machine, options, emit)
      if (chat.status === 'idle') return session.close()
      chat.session = session
      session.prompt(prompt, images)
    } catch (error) {
      if (chat.status === 'idle') return
      endTurn(chat, { at: new Date().toISOString(), type: 'turn.completed', error: String(error) })
    }
  }

  const setQueue = (chat: Chat, queue: QueuedMessage[]) => {
    chat.queue = queue
    broadcast({ type: 'chat.queue', chatId: chat.info.id, queue })
  }

  const sendQueue = (chat: Chat, message?: Omit<QueuedMessage, 'id'>) => {
    const queue = chat.queue
    if (queue.length) setQueue(chat, [])
    const parts = message ? [...queue, message] : queue
    try {
      const text = parts.flatMap((part) => (part.text ? [part.text] : [])).join('\n\n')
      send(chat, text, parts.flatMap((part) => part.attachments ?? []))
    } catch (error) {
      if (queue.length) setQueue(chat, queue)
      throw error
    }
  }

  const enqueue = (chat: Chat, text: string, attachments: Attachment[] = []) => {
    if (quitting) throw new Error('Hotrod is quitting')
    checkActive(chat)
    const message = { text, ...(attachments.length && { attachments }) }
    if (chat.status === 'idle') return sendQueue(chat, message)
    setQueue(chat, [...chat.queue, { id: randomBytes(4).toString('hex'), ...message }])
  }

  const sendMessage = (chat: Chat, rawText: unknown, uploads: unknown) => {
    if (uploads !== undefined && !Array.isArray(uploads)) throw new Error('Attachments must be a list')
    const files = (uploads ?? []).map((upload: Partial<Upload>) => {
      const { name, mimeType, base64 } = upload ?? {}
      if (typeof name !== 'string' || typeof mimeType !== 'string' || typeof base64 !== 'string') {
        throw new Error('Each attachment needs a name, a type and its contents')
      }
      const bytes = Buffer.from(base64, 'base64')
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        throw new Error(`${name} is larger than ${MAX_ATTACHMENT_BYTES / 1_000_000} MB, the most one attachment can be`)
      }
      return { name, mimeType: mimeType || 'application/octet-stream', bytes }
    })
    if (files.reduce((total, file) => total + file.bytes.length, 0) > MAX_ATTACHMENTS_TOTAL_BYTES) {
      throw new Error(`One message can carry at most ${MAX_ATTACHMENTS_TOTAL_BYTES / 1_000_000} MB of attachments`)
    }
    const text = typeof rawText === 'string' && rawText.trim() ? rawText : ''
    if (!text && !files.length) throw new Error('Message is empty')

    const dir = attachmentsDirOf(chat)
    if (files.length) mkdirSync(dir, { recursive: true })
    const attachments = files.map(({ name, mimeType, bytes }): Attachment => {
      const clean = basename(name).replace(/[\x00-\x1f\x7f\\]/g, '').replace(/^[.\s]+/, '').trim() || 'attachment'
      const dot = clean.lastIndexOf('.')
      const [stem, extension] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, '']
      for (let copy = 1; ; copy++) {
        const path = join(dir, copy === 1 ? clean : `${stem}-${copy}${extension}`)
        try {
          writeFileSync(path, bytes, { flag: 'wx' })
          return { name, path, mimeType, size: bytes.length }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
    })
    try {
      enqueue(chat, text, attachments)
    } catch (error) {
      for (const { path } of attachments) rmSync(path, { force: true })
      throw error
    }
  }

  const mcp = openHotrodMcp({
    chats: () => [...chats.values()].map(state),
    canNest: (chatId) => {
      const chat = chats.get(chatId)
      return chat !== undefined && canNest(chat)
    },
    createChat,
    send: (chatId, text) => send(chatFor(chatId), text),
    subagents: () => mods().subagents,
    memory: (chatId) => memoryOf(chatFor(chatId)),
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
    engines: engineInfos,
    async refreshEngines() {
      await Promise.all(
        adapters.map(async (adapter) => {
          try {
            detected.set(adapter.id, nameModels(await adapter.detect(machine)))
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            detected.set(adapter.id, { installed: false, signedIn: false, detail })
          }
          broadcast({ type: 'engine.updated', engine: engineInfo(adapter.id) })
        }),
      )
      const lastAt = (chat: Chat) => chat.entries.at(-1)?.at ?? ''
      // Summaries need a detected engine, so the backlog waits for this.
      const byActivity = [...chats.values()].sort((a, b) => lastAt(a).localeCompare(lastAt(b)))
      for (const chat of byActivity) compactor.touch(chat.info.id)
    },
    setEngineEnabled,
    contextDefaults,
    mods,
    modelLists: () => Object.fromEntries(adapters.map((adapter) => [adapter.id, listsOf(adapter.id)])),
    memory: () => settings.memory ?? {},
    chats: () => [...chats.values()].map(state),
    accounts: accounts.list,
    refreshAccounts: accounts.refresh,
    onMessage: (listener: (message: CoreMessage) => void) => listeners.push(listener),
    attachment(chatId: string, file: string) {
      const chat = chats.get(chatId)
      if (!chat) return undefined
      const path = join(attachmentsDirOf(chat), file)
      const sent = chat.entries.flatMap((e) => (e.type === 'user.message' ? (e.attachments ?? []) : []))
      return [...sent, ...chat.queue.flatMap((q) => q.attachments ?? [])].find((a) => a.path === path)
    },
    serveMcp(url: string) {
      mcpUrl = url
      return mcp.handle
    },
    handle(message: ClientMessage, reply: (message: CoreMessage) => void) {
      switch (message.type) {
        case 'engine.setEnabled':
          return setEngineEnabled(String(message.engine), message.enabled === true)
        case 'engine.setDefaultThinking':
          return setDefaultThinking(String(message.engine), String(message.thinking))
        case 'chat.create':
          return void createChat({
            parentId: optionalText(message.parentId),
            name: message.name,
            engine: optionalText(message.engine),
            folders: message.folders,
            files: message.files,
          })
        case 'chat.rename':
          return renameChat(chatFor(message.chatId), message.name)
        case 'chat.archive':
          return archiveChat(chatFor(message.chatId), message.archived === true)
        case 'chat.delete':
          return deleteChat(chatFor(message.chatId))
        case 'chat.setEngine':
          return setEngine(chatFor(message.chatId), String(message.engine))
        case 'chat.setModel':
          return setModel(chatFor(message.chatId), optionalText(message.model), optionalText(message.thinking))
        case 'chat.send':
          return sendMessage(chatFor(message.chatId), message.text, message.attachments)
        case 'chat.unqueue': {
          const chat = chatFor(message.chatId)
          const removed = chat.queue.find((q) => q.id === message.id)
          if (!removed) return
          for (const { path } of removed.attachments ?? []) rmSync(path, { force: true })
          return setQueue(chat, chat.queue.filter((q) => q !== removed))
        }
        case 'chat.interrupt':
          return interrupt(chatFor(message.chatId), message.force === true)
        case 'context.get': {
          const chat = chatFor(message.chatId)
          return reply({ type: 'chat.context', chatId: chat.info.id, items: contextItems(chat) })
        }
        case 'context.add':
          return addContext(chatFor(message.chatId), addable(message.section), message.path)
        case 'context.remove':
          return removeContext(chatFor(message.chatId), addable(message.section), message.path)
        case 'context.set':
          return setContext(chatFor(message.chatId), message.path, message.enabled === true)
        case 'context.write':
          if (typeof message.text !== 'string') throw new Error('Context text is missing')
          return writeContext(chatFor(message.chatId), message.text)
        case 'context.setDefault':
          if (!CONTEXT_SECTIONS.includes(message.section)) {
            throw new Error(`Unknown context section "${message.section}"`)
          }
          return setContextDefault(message.section, message.enabled === true)
        case 'subagents.set':
          return setSubagents(message.enabled === true, message.limit)
        case 'memory.set':
          return setMemory(optionalText(message.engine), optionalText(message.model))
        case 'models.setList':
          return setModelList(String(message.engine), message.role, message.models)
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
      compactor.close()
      for (const chat of chats.values()) {
        if (chat.status === 'idle') stopSession(chat)
        else interrupt(chat, force)
      }
      if (!allStopped()) await new Promise<void>((resolve) => allStoppedWaiters.push(resolve))
      await machine.stopAll()
    },
  }
}

export const SUMMARY_MODELS = ['claude-haiku-5-5', 'claude-haiku-4-5']

const summaryModelOf = (engine?: EngineInfo) =>
  SUMMARY_MODELS.map((id) => engine?.models?.find((m) => m.id === id || m.id.endsWith(`/${id}`))?.id).find(Boolean)

function pickMemory(engines: EngineInfo[], saved: MemorySettings) {
  const engine = saved.engine
    ? engines.find((e) => e.id === saved.engine)
    : engines.find((e) => e.enabled && summaryModelOf(e))
  return { engine: engine?.id, model: saved.model ?? summaryModelOf(engine) }
}

const CLAUDE_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku']
const CLAUDE_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/
// A dated snapshot like claude-haiku-4-5-20251001 repeats the model its alias names.
const SNAPSHOT_ID = /-\d{8}$/

const providerOf = (id: string) => id.slice(0, id.lastIndexOf('/') + 1)

function describeModel(id: string) {
  const [, family = '', major = '', minor] = id.slice(providerOf(id).length).match(CLAUDE_ID) ?? []
  const known = CLAUDE_FAMILIES.indexOf(family)
  const rank = known < 0 ? CLAUDE_FAMILIES.length : known
  if (!family) return { label: id, rank, version: 0 }
  const label = `${family[0]!.toUpperCase()}${family.slice(1)} ${major}${minor === undefined ? '' : `.${minor}`}`
  return { label, rank, version: Number(major) * 100 + Number(minor ?? 0) }
}

function nameModels({ models, defaultModel, ...status }: EngineStatus): Omit<EngineInfo, 'id' | 'enabled'> {
  if (!models) return { ...status, ...(defaultModel && { defaultModel }) }
  const providers = [...new Set(models.map(providerOf))]
  const named = models
    .filter((id) => !SNAPSHOT_ID.test(id))
    .map((id) => ({ id, provider: providers.indexOf(providerOf(id)), ...describeModel(id) }))
    .sort((a, b) => a.provider - b.provider || a.rank - b.rank || b.version - a.version)
  const shown = defaultModel && (named.some((m) => m.id === defaultModel) ? defaultModel : named[0]?.id)
  return { ...status, models: named.map(({ id, label }) => ({ id, label })), ...(shown && { defaultModel: shown }) }
}

const optionalText = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

const readJson = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {})

const readBytes = (file: string) => {
  try {
    return readFileSync(file)
  } catch {
    return Buffer.alloc(0)
  }
}

const checkName = (name: unknown) => {
  const trimmed = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : ''
  if (!trimmed) throw new Error('A chat needs a name')
  return trimmed
}

const addable = (section: unknown) => {
  if (section !== 'folders' && section !== 'files') {
    throw new Error(`Only folders and files can be added, not "${section}"`)
  }
  return section
}

const checkPath = (rawPath: unknown, section: 'folders' | 'files') => {
  const path = String(rawPath).trim().replace(/^~(?=$|\/)/, homedir())
  if (!isAbsolute(path)) throw new Error(`The path must be absolute: ${rawPath}`)
  const stat = existsSync(path) ? statSync(path) : undefined
  if (section === 'folders' ? !stat?.isDirectory() : !stat?.isFile()) {
    throw new Error(`Not a ${section === 'folders' ? 'folder' : 'file'}: ${rawPath}`)
  }
  return realpathSync(path)
}
