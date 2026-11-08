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
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { Mod, ModHost, ModRun } from '@hotrod/mod-api'
import { openAccounts } from './accounts.ts'
import { CORE_TOOL_NAMES, openHotrodMcp, SUBAGENTS_MOD, summaryOf } from './hotrod-mcp.ts'
import {
  MEMORY_INSTRUCTIONS,
  continuationPrompt,
  memoryPrompt,
  memoryView,
  messagesOf,
  openCompactor,
  openSummaries,
  withAttachments,
  type Report,
  ZOOM_INSTRUCTIONS,
  type Summaries,
} from './memory.ts'
import { realPath } from './machine.ts'
import { valuesOf } from './mods.ts'
import {
  ASK_FIRST_COMMANDS,
  bySpaceOrder,
  CONTEXT_SECTIONS,
  editsAnywhere,
  GLOBAL_CONTEXT,
  IMAGE_TYPES,
  looksBinary,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  MODEL_ROLES,
  PERMISSION_SWITCHES,
  pickModel,
  pickThinking,
  settingProblem,
  switchedOn,
  type Adapter,
  type Answers,
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
  type ModInfo,
  type NewChat,
  type PermissionSwitch,
  type PermissionSwitches,
  type QueuedMessage,
  type Session,
  type SetupState,
  type Upload,
  type WorkFolder,
  type Worktree,
} from './shared.ts'

export const STOP_GRACE_MS = 60_000
const PARENT_VIEW_FILE = 'parent-view.md'
export const WRITE_RULES =
  'You can write files only in your work folder. Every other folder is read-only to you: writes there fail.'
const OUTSIDE_EDIT_ADVICE = 'Work there, or ask the user to allow edits outside the work folder for this chat.'
export const CHECKOUT_RULES =
  'Each git folder in your context is checked out in your work folder on a branch of its own, from its last ' +
  "commit, so changes the user hasn't committed aren't in it. Work and commit in the checkout:"
const GIT_TIMEOUT_MS = 120_000
const BRANCH_SLUG_MAX_CHARS = 40
// Enough of a repo's .git to commit, fetch and rebase in a worktree; hooks and config stay read-only.
const GIT_WRITABLE = ['objects', 'refs', 'logs', 'worktrees', 'packed-refs*', 'FETCH_HEAD']
// Moving a branch checked out in another worktree would show there as staged changes.
const PROTECT_CHECKED_OUT_BRANCHES = true
// Where the Machine can't sandbox (Linux, Windows for now), a chat runs only once the user allows edits anywhere.
const UNSANDBOXED_NEEDS_EDIT_ANYWHERE = true
const ASKS_FIRST = new RegExp(`\\b(?:${ASK_FIRST_COMMANDS.map((c) => c.replaceAll(' ', '\\s+')).join('|')})\\b`)

type Checkout = { folder: string; worktree: Worktree; writable: string[]; readOnly: string[] }

type Chat = {
  info: ChatInfo
  dir: string
  context: Record<string, boolean>
  entries: ChatEntry[]
  status: ChatStatus
  session?: Session
  unsavedText: string
  stopTimer?: ReturnType<typeof setTimeout>
  pendingRequests: Map<string, 'permission' | 'question'>
  mcpToken?: string
  queue: QueuedMessage[]
  summaries: Summaries
  turns: number
  // The account the running turn started on, and the limit it ran into, if any.
  account?: string
  limit?: { message: string; resetsAt?: string }
  // The engine wrote, thought or called a tool since the chat's last message; a continuation doesn't reset it.
  produced?: boolean
}

export type Core = ReturnType<typeof openCore>

export function openCore(options: {
  garage: string
  adapters: Adapter[]
  defaultEngine: string
  machine: Machine
  mods?: Mod[]
  brokenMods?: { id: string; loadError: string }[]
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
  const mods = [...(options.mods ?? []), SUBAGENTS_MOD]
  const modChats = mods.flatMap((mod) => (mod.chats ?? []).map((chat) => ({ ...chat, mod })))
  const toolNames = [...CORE_TOOL_NAMES, ...mods.flatMap((mod) => (mod.tools ?? []).map((tool) => tool.name))]
  for (const [what, ids] of [
    ['mods', mods.map((mod) => mod.id)],
    ['mod chats', modChats.map((chat) => chat.id)],
    ['tools', toolNames],
  ] as const) {
    const twin = ids.find((id, i) => ids.indexOf(id) !== i)
    if (twin !== undefined) throw new Error(`Two ${what} have the id "${twin}"`)
  }
  const settingsFile = join(garage, 'settings.json')
  const settings: PermissionSwitches & {
    engines: Record<string, boolean>
    context?: Partial<Record<ContextSection, boolean>>
    mods?: Record<string, Record<string, unknown>>
    models?: Record<string, Partial<ModelLists>>
    defaultThinking?: Record<string, string>
    memory?: MemorySettings
    workFolder?: string
  } = { engines: {}, ...readJson(settingsFile) }
  const saveSettings = () => writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n')
  const contextDefaults = (): Record<ContextSection, boolean> => ({
    agents: settings.context?.agents ?? true,
    folders: settings.context?.folders ?? true,
    files: settings.context?.files ?? true,
  })
  const brokenMods = options.brokenMods ?? []
  const modFor = (id: string) => {
    const mod = mods.find((m) => m.id === id)
    if (mod) return mod
    const broken = brokenMods.find((m) => m.id === id)
    throw new Error(broken ? `The mod ${id} couldn't load: ${broken.loadError}` : `Unknown mod "${id}"`)
  }
  const isOn = (mod: Mod) => {
    const saved = settings.mods?.[mod.id]?.enabled
    return typeof saved === 'boolean' ? saved : mod.enabledByDefault
  }
  const modValues = (mod: Mod) => valuesOf(mod, settings.mods?.[mod.id])
  const setups = new Map<string, Omit<SetupState, 'description'>>()
  const installs = new Map<string, AbortController>()
  const modInfo = (mod: Mod): ModInfo => {
    const { id, name, description, settings: declared = [] } = mod
    const setup = mod.setup && { description: mod.setup.description, ...(setups.get(id) ?? { status: 'checking' }) }
    const info = { id, name, description, enabled: isOn(mod), settings: declared, values: modValues(mod) }
    return { ...info, ...(setup && { setup }) }
  }
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
  mkdirSync(chatsDir, { recursive: true })
  const defaultWorkFolder = join(garage, 'work')
  const workFolder = (): WorkFolder => ({
    ...(settings.workFolder && { path: settings.workFolder }),
    defaultPath: defaultWorkFolder,
    canSandbox: machine.canSandbox,
    ...Object.fromEntries(
      PERMISSION_SWITCHES.flatMap((name) => (settings[name] === undefined ? [] : [[name, settings[name]]])),
    ),
  })
  const sandboxIn = (dir: string) => (machine.canSandbox ? { writable: [dir], tmpDir: join(dir, '.tmp') } : undefined)
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
  const saveMod = (mod: Mod, change: Record<string, unknown>) => {
    settings.mods = { ...settings.mods, [mod.id]: { ...settings.mods?.[mod.id], ...change } }
    saveSettings()
    broadcast({ type: 'mod.updated', mod: modInfo(mod) })
  }
  const setSetup = (mod: Mod, state: Omit<SetupState, 'description'>) => {
    setups.set(mod.id, state)
    broadcast({ type: 'mod.updated', mod: modInfo(mod) })
  }
  const runFor =
    (signal?: AbortSignal): ModRun =>
    (command, args, options) =>
      machine.run(command, args, { cwd: '/', ...options, ...(signal && { signal }) })
  const checkSetup = async (mod: Mod, installError?: string) => {
    if (!mod.setup || installs.has(mod.id)) return
    const { message } = setups.get(mod.id) ?? {}
    setSetup(mod, { status: 'checking', ...(message && { message }) })
    let checked: Omit<SetupState, 'description'>
    try {
      const result = await mod.setup.check(runFor())
      checked = { status: result.ready ? 'ready' : 'missing', ...(result.message && { message: result.message }) }
    } catch (error) {
      checked = { status: 'missing', error: messageOf(error) }
    }
    if (checked.status === 'missing' && installError) checked.error = installError
    if (!installs.has(mod.id)) setSetup(mod, checked)
  }
  const install = (mod: Mod) => {
    if (!mod.setup) throw new Error(`${mod.name} has nothing to install`)
    if (installs.has(mod.id)) throw new Error(`${mod.name} is already installing`)
    if (setups.get(mod.id)?.status === 'ready') throw new Error(`${mod.name} is already installed`)
    const controller = new AbortController()
    installs.set(mod.id, controller)
    const { message } = setups.get(mod.id) ?? {}
    setSetup(mod, { status: 'installing', ...(message && { message }) })
    const report = ({ text, progress }: { text?: string; progress?: number }) => {
      if (installs.get(mod.id) !== controller) return
      const update = { ...(text && { progressText: text }), ...(progress !== undefined && { progress }) }
      setSetup(mod, { ...setups.get(mod.id)!, ...update })
    }
    void mod.setup.install(runFor(controller.signal), report).then(
      () => {
        installs.delete(mod.id)
        return checkSetup(mod)
      },
      (error) => {
        installs.delete(mod.id)
        return checkSetup(mod, controller.signal.aborted ? undefined : messageOf(error))
      },
    )
  }
  const setModValue = (mod: Mod, key: string, value: unknown) => {
    const setting = mod.settings?.find((s) => s.key === key)
    if (!setting) throw new Error(`${mod.name} has no setting "${key}"`)
    const problem = settingProblem(setting, value)
    if (problem) throw new Error(`${setting.label} ${problem}`)
    saveMod(mod, { [key]: value })
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
  // A work folder holding the garage would let an agent write chat.json, settings and accounts.
  const checkWorkFolder = (path: string) => {
    const reachesGarage = within(garage, path) || (within(path, garage) && path !== defaultWorkFolder)
    if (reachesGarage || [homedir(), realpathSync(homedir())].includes(path)) {
      throw new Error(`${path} can't be the work folder: pick a folder of its own, outside Hotrod's`)
    }
  }
  const setWorkFolder = (rawPath: unknown) => {
    const typed = String(rawPath ?? '').trim().replace(/^~(?=$|\/)/, homedir())
    if (!isAbsolute(typed)) throw new Error(`The path must be absolute: ${rawPath}`)
    checkWorkFolder(resolve(typed))
    if (existsSync(typed) && !statSync(typed).isDirectory()) throw new Error(`Not a folder: ${rawPath}`)
    mkdirSync(typed, { recursive: true })
    const path = realpathSync(typed)
    checkWorkFolder(path)
    settings.workFolder = path
    saveSettings()
    broadcast({ type: 'workFolder.updated', workFolder: workFolder() })
    compactBacklog()
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
  const modServers = (chat: Chat, workDir: string, sandboxed: boolean) => {
    const session = { chat: summaryOf(chat.info), workDir, sandboxed }
    const servers = mods
      .filter((mod) => isOn(mod) && (!mod.setup || setups.get(mod.id)?.status === 'ready'))
      .flatMap((mod) => mod.mcpServers?.({ ...session, values: modValues(mod) }) ?? [])
    const names = ['hotrod', ...servers.map((server) => server.name)]
    const twin = names.find((name, i) => names.indexOf(name) !== i)
    if (twin !== undefined) throw new Error(`Two MCP servers are named "${twin}"`)
    return servers
  }
  const takesMcp = (engine: string) => adapterFor(engine)?.hotrodMcp === true && mcpUrl !== undefined
  const chosenWorkFolder = () => {
    if (!settings.workFolder) throw new Error('Choose a work folder first, in Settings → Work folder')
    return settings.workFolder
  }

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
      const cwd = join(chosenWorkFolder(), 'home')
      mkdirSync(cwd, { recursive: true })
      const sandbox = sandboxIn(cwd)
      const options = { ...request, cwd, model, ...accounts.sessionFor(adapter.id), ...(sandbox && { sandbox }) }
      return adapter.complete(machine, options)
    },
    onFailure: (reason) => broadcast({ type: 'error', message: `Memory summaries are failing: ${reason}. Retrying.` }),
    ...(compactDebounceMs !== undefined && { debounceMs: compactDebounceMs }),
  })
  let enginesDetected = false
  // Summaries need a detected engine and a work folder to run in, so the backlog waits for both.
  const compactBacklog = () => {
    if (!enginesDetected || !settings.workFolder) return
    const lastAt = (chat: Chat) => chat.entries.at(-1)?.at ?? ''
    const byActivity = [...chats.values()].sort((a, b) => lastAt(a).localeCompare(lastAt(b)))
    for (const chat of byActivity) compactor.touch(chat.info.id)
  }

  const setStatus = (chat: Chat, status: ChatStatus) => {
    if (chat.status === status || (chat.status === 'stopping' && status !== 'idle')) return
    chat.status = status
    broadcast({ type: 'chat.status', chatId: chat.info.id, status })
  }

  const chatFor = (chatId: string) => {
    const chat = chats.get(chatId)
    if (!chat || !shown(chat)) throw new Error(`Unknown chat "${chatId}"`)
    return chat
  }

  const modChatOf = (chat: Chat) => modChats.find((declared) => declared.id === chat.info.id)

  const shown = (chat: Chat) => {
    const owner = modChatOf(chainOf(chat)[0]!)?.mod
    return !owner || isOn(owner)
  }

  const shownChats = () => [...chats.values()].filter(shown)

  const parentOf = (chat: Chat) => (chat.info.parentId === undefined ? undefined : chats.get(chat.info.parentId))

  const chainOf = (chat: Chat): Chat[] => {
    const parent = parentOf(chat)
    return parent ? [...chainOf(parent), chat] : [chat]
  }

  // A chat's permission switches, nearest first: its own, then each chat above it (a subagent follows its space live),
  // then the defaults in settings.
  const switchesOf = (chat: Chat) => [...chainOf(chat).reverse().map((c) => c.info), settings]

  const familyOf = (chat: Chat): Chat[] => [
    chat,
    ...[...chats.values()].filter((c) => c.info.parentId === chat.info.id).flatMap(familyOf),
  ]

  const checkRemovable = (chat: Chat) => {
    if (chat.info.mod) throw new Error(`${chat.info.name} cannot be archived or deleted`)
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

  const endTurn = (chat: Chat, ended: Extract<ChatEntry, { type: 'turn.completed' | 'session.ended' }>) => {
    const { limit, account } = chat
    chat.limit = undefined
    // A turn the core stopped for its limit shows the limit, not "Interrupted".
    const end = limit && ended.error ? { ...ended, error: limit.message } : ended
    if (chat.unsavedText) append(chat, { at: end.at, type: 'text.completed', text: chat.unsavedText })
    chat.unsavedText = ''
    append(chat, end)
    stopSession(chat)
    chat.pendingRequests.clear()
    setStatus(chat, 'idle')
    if (allStopped()) allStoppedWaiters.splice(0).forEach((resolve) => resolve())
    if (quitting) return
    compactor.touch(chat.info.id)
    if (limit) reportLimit(chat, account, limit)
    // A mod sent the message again, so the turn goes on.
    if (chat.status !== 'idle') return
    const parent = chat.info.subagent ? parentOf(chat) : undefined
    if (parent) reportErrors(() => enqueue(parent, reportOf(chat, end.error)))
    if (chat.queue.length) reportErrors(() => sendQueue(chat))
    // Subagents are workers for one task: once the lead has their reply, they go. The reply lives on in the lead's log.
    if (chat.info.subagent && chat.status === 'idle') removeChats(familyOf(chat))
    sweepMergedWorktrees(chainOf(chat)[0]!)
  }

  const reportErrors = (run: () => void) => {
    try {
      run()
    } catch (error) {
      broadcast({ type: 'error', message: messageOf(error) })
    }
  }

  const reportOf = (chat: Chat, error?: string) => {
    const asked = chat.entries.findLastIndex((e) => e.type === 'user.message')
    const reply = chat.entries.slice(asked + 1).findLast((e) => e.type === 'text.completed')
    const text = reply?.type === 'text.completed' ? reply.text : ''
    return { text, report: { chatId: chat.info.id, name: chat.info.name, ...(error && { error }) } }
  }

  const limitWatchers = () => mods.filter((mod) => isOn(mod) && mod.onLimitReached)

  const reportLimit = (chat: Chat, account: string | undefined, { message, resetsAt }: NonNullable<Chat['limit']>) => {
    const { engine } = chat.info
    const limit = {
      chat: summaryOf(chat.info),
      engine,
      ...(account !== undefined && { account }),
      message,
      output: chat.produced === true,
      ...(resetsAt && { resetsAt }),
    }
    for (const mod of limitWatchers()) {
      reportErrors(() => mod.onLimitReached!(limit, { values: modValues(mod), host: modHost }))
    }
  }

  // A turn's input is the subagent reports and the message it started with, logged together at its start.
  const retry = (chat: Chat) => {
    const isInput = (e: ChatEntry) => e.type === 'user.message' || e.type === 'subagent.report'
    const end = chat.entries.findLastIndex(isInput)
    if (end < 0) throw new Error(`${chat.info.name} has no message to send again`)
    const together = (e?: ChatEntry) => e !== undefined && isInput(e) && e.at === chat.entries[end]!.at
    let start = end
    while (together(chat.entries[start - 1])) start--
    const again = chat.entries.slice(start, end + 1).map((e): QueuedMessage => {
      const id = randomBytes(4).toString('hex')
      if (e.type === 'subagent.report') {
        const { chatId, name, error } = e
        return { id, text: e.text, report: { chatId, name, ...(error !== undefined && { error }) } }
      }
      const { text, attachments } = e as Extract<ChatEntry, { type: 'user.message' }>
      return { id, text, ...(attachments && { attachments }) }
    })
    setQueue(chat, [...again, ...chat.queue])
    if (chat.status === 'idle') sendQueue(chat)
  }

  // Carries on a turn that stopped part way, as a turn of its own; queued messages wait for it.
  const continueTurn = (chat: Chat, text: string) => {
    if (!text.trim()) throw new Error('A continuation needs a prompt')
    if (chat.status !== 'idle') throw new Error(`${chat.info.name} is still running`)
    send(chat, '', [], [], text)
  }

  const modHost: ModHost = {
    createChat: ({ name, folders, files, engine }) => createChat({ name, folders, files, engine }),
    send: (chatId, text) => send(chatFor(chatId), text),
    accounts(engine) {
      const found = accounts.list().find((state) => state.engine === engine)
      if (!found) return undefined
      const list = found.accounts.map(({ id, name, signedIn }) => ({
        id,
        name,
        ...(signedIn !== undefined && { signedIn }),
      }))
      return { engine, active: found.active, accounts: list }
    },
    useAccount: (engine, accountId) => accounts.use(engine, accountId, true),
    retry: (chatId) => retry(chatFor(chatId)),
    continue: (chatId, text) => continueTurn(chatFor(chatId), text),
    note: (chatId, text) => append(chatFor(chatId), { at: new Date().toISOString(), type: 'mod.note', text }),
  }

  const removeChats = (family: Chat[]) => {
    for (const c of family) {
      stopSession(c)
      chats.delete(c.info.id)
      rmSync(c.dir, { recursive: true, force: true })
      broadcast({ type: 'chat.removed', chatId: c.info.id })
      removeWorkDir(c).catch((error) => broadcast({ type: 'error', message: String(error) }))
    }
  }

  const forceStop = (chat: Chat) =>
    endTurn(chat, { at: new Date().toISOString(), type: 'turn.completed', error: 'Interrupted' })

  const loadChat = (dir: string, fallback: ChatInfo) => {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'chat.json')
    const { context = {}, title, parentId, mod, ...saved } = readJson(file)
    const declared = modChats.find((chat) => chat.id === fallback.id)
    const info: ChatInfo = {
      ...fallback,
      ...(title !== undefined && { name: title }),
      ...saved,
      id: fallback.id,
      ...(saved.subagent && parentId !== undefined && { parentId }),
      ...(declared && { name: declared.name, mod: declared.mod.id, folders: [], files: [] }),
    }
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
      pendingRequests: new Map(),
      queue: [],
      summaries: openSummaries(join(dir, 'summaries.jsonl')),
      turns: 0,
    }
    if (!existsSync(file) || declared || (parentId !== undefined && !info.parentId)) saveChat(chat)
    chats.set(info.id, chat)
    const lastTurnEvent = entries.findLast((e) => ['turn.started', 'turn.completed', 'session.ended'].includes(e.type))
    const lastType = entries.at(-1)?.type
    if (lastTurnEvent?.type === 'turn.started' || lastType === 'user.message' || lastType === 'subagent.report') {
      append(chat, { at: new Date().toISOString(), type: 'turn.completed', error: 'Hotrod quit during this turn' })
    }
    return chat
  }

  const freshInfo = (id: string, name: string): ChatInfo => ({
    id,
    name,
    folders: [],
    files: [],
    engine: newChatEngine(),
    archived: false,
    createdAt: new Date().toISOString(),
  })

  for (const { id, name } of modChats) loadChat(join(chatsDir, id), freshInfo(id, name))
  for (const id of readdirSync(chatsDir)) {
    if (chats.has(id) || !existsSync(join(chatsDir, id, 'chat.json'))) continue
    loadChat(join(chatsDir, id), freshInfo(id, id))
  }
  // Nothing runs yet, so a subagent that has worked and is still here (Hotrod quit or crashed mid-task, or an older
  // Hotrod kept it) goes now.
  for (const chat of chats.values()) {
    if (!chat.info.subagent || !chat.entries.length) continue
    chats.delete(chat.info.id)
    rmSync(chat.dir, { recursive: true, force: true })
  }

  const createChat = (spec: NewChat & { parentId?: string; subagent?: boolean; role?: ModelRole }) => {
    const name = checkName(spec.name)
    const engine = spec.engine ?? newChatEngine()
    checkEngine(engine)
    if (spec.engine !== undefined) checkEnabled(engine)
    const parent = spec.subagent ? chatFor(spec.parentId ?? '') : undefined
    if (parent) checkActive(parent)
    if (parent?.info.subagent) throw new Error('A subagent cannot start chats')
    const folders = [...new Set((spec.folders ?? []).map((path) => checkPath(path, 'folders')))]
    const files = [...new Set((spec.files ?? []).map((path) => checkPath(path, 'files')))]
    let id = randomBytes(4).toString('hex')
    while (chats.has(id)) id = randomBytes(4).toString('hex')
    const parentMemory = parent && memoryOf(parent)
    const info: ChatInfo = {
      id,
      name,
      ...(parent && parentMemory && {
        parentId: parent.info.id,
        subagent: true,
        role: spec.role ?? 'subagents',
        parentMessages: parentMemory.messages.length,
      }),
      folders,
      files,
      engine,
      archived: false,
      createdAt: new Date().toISOString(),
      // A subagent on its parent's engine takes its thinking level, and its model unless a role picks one: the role
      // the tool call names, or the Subagents model list once the user has filled it in.
      ...(parent?.info.engine === engine && {
        thinking: parent.info.thinking,
        ...(spec.role === undefined && !listsOf(engine).subagents.length && { model: parent.info.model }),
      }),
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
    if (chat.info.mod) throw new Error(`${chat.info.name} cannot be renamed`)
    updateChat(chat, { name: checkName(name) })
  }

  const archiveChat = (chat: Chat, archived: boolean) => {
    const parent = parentOf(chat)
    if (!archived && parent?.info.archived) throw new Error(`Unarchive "${parent.info.name}" first`)
    const family = familyOf(chat)
    family.forEach(checkRemovable)
    family.forEach((c) => updateChat(c, { archived }))
  }

  const moveChat = (chat: Chat, pinned: boolean, index: unknown) => {
    if (chat.info.mod || chat.info.parentId) throw new Error('Only spaces can be moved or pinned')
    if (chat.info.archived) throw new Error('This chat is archived. Unarchive it first.')
    if (typeof index !== 'number' || !Number.isInteger(index)) throw new Error('The place to move to must be a number')
    const group = [...chats.values()]
      .map((c) => c.info)
      .filter((c) => !c.mod && !c.parentId && !c.archived && !!c.pinned === pinned && c.id !== chat.info.id)
      .sort(bySpaceOrder)
    group.splice(Math.max(0, Math.min(index, group.length)), 0, chat.info)
    group.forEach((info, order) => {
      const c = chats.get(info.id)!
      if (c.info.order !== order || !!c.info.pinned !== pinned) updateChat(c, { order, pinned: pinned || undefined })
    })
  }

  const deleteChat = (chat: Chat) => {
    const family = familyOf(chat)
    family.forEach(checkRemovable)
    removeChats(family)
  }

  const setModEnabled = (mod: Mod, enabled: boolean) => {
    const family = (mod.chats ?? []).flatMap(({ id }) => {
      const chat = chats.get(id)
      return chat ? familyOf(chat) : []
    })
    const busy = family.find((chat) => chat.status !== 'idle')
    if (busy && !enabled) throw new Error(`Stop "${busy.info.name}" before turning ${mod.name} off`)
    const changed = isOn(mod) !== enabled
    saveMod(mod, { enabled })
    if (enabled) void checkSetup(mod)
    if (!changed) return
    if (enabled) family.toReversed().forEach((chat) => broadcast({ type: 'chat.added', chat: state(chat) }))
    else family.forEach((chat) => broadcast({ type: 'chat.removed', chatId: chat.info.id }))
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

  const globalAgentsFile = join(garage, 'AGENTS.md')

  const switchOf = (chat: Chat, item: Pick<ContextItem, 'section' | 'path' | 'from'>): boolean => {
    const pinned = chat.context[item.path]
    if (pinned !== undefined) return pinned
    if (item.from === chat.info.id) return true
    const parent = parentOf(chat)
    return chat.info.subagent && parent ? switchOf(parent, item) : contextDefaults()[item.section]
  }

  const contextItems = (chat: Chat): ContextItem[] => {
    const owned = chainOf(chat).flatMap(({ info, dir }) =>
      info.mod
        ? []
        : [
            ...info.folders.map((path) => ({ section: 'folders' as const, path, from: info.id })),
            { section: 'agents' as const, path: join(dir, 'AGENTS.md'), from: info.id },
            ...info.files.map((path) => ({ section: 'files' as const, path, from: info.id })),
          ],
    )
    const seen = new Set<string>()
    return [{ section: 'agents' as const, path: globalAgentsFile, from: GLOBAL_CONTEXT }, ...owned].flatMap((item) => {
      if (seen.has(item.path)) return []
      seen.add(item.path)
      const bytes = readBytes(item.section === 'folders' ? join(item.path, 'AGENTS.md') : item.path)
      const binary = item.section === 'files' && looksBinary(bytes)
      const text = binary ? '' : bytes.toString('utf8')
      return [{ ...item, enabled: switchOf(chat, item), text, ...(binary && { binary }) }]
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

  const checkOwnsContext = (chat: Chat) => {
    if (chat.info.mod) throw new Error(`${chat.info.name} keeps no folders, files or AGENTS.md of its own`)
  }

  const addContext = (chat: Chat, section: 'folders' | 'files', rawPath: unknown) => {
    checkActive(chat)
    checkOwnsContext(chat)
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

  const writeAgentsFile = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
    broadcast({ type: 'context.file', path, text })
  }

  const writeContext = (chat: Chat, text: string) => {
    checkActive(chat)
    checkOwnsContext(chat)
    writeAgentsFile(join(chat.dir, 'AGENTS.md'), text)
  }

  const setContextDefault = (section: ContextSection, enabled: boolean) => {
    settings.context = { ...settings.context, [section]: enabled }
    saveSettings()
    broadcast({ type: 'context.defaults', defaults: contextDefaults() })
  }

  const attachmentsDirOf = (chat: Chat) => join(chat.dir, 'attachments')

  // A space keeps the folder it got first, so changing the setting moves only new spaces.
  const workDirOf = (chat: Chat) => {
    const space = chainOf(chat)[0]!
    if (space.info.mod) return join(chosenWorkFolder(), 'home')
    if (!space.info.workDir) updateChat(space, { workDir: join(chosenWorkFolder(), space.info.id) })
    return space.info.workDir!
  }

  const git = async (folder: string, ...args: string[]) => {
    const options = { cwd: folder, timeoutMs: GIT_TIMEOUT_MS }
    const { code, stdout, stderr } = await machine.run('git', ['-C', folder, ...args], options)
    if (code !== 0) throw new Error(stderr.trim() || `git ${args[0]} exited with code ${code}`)
    return stdout.trim()
  }

  const makeWorktree = async (space: Chat, folder: string, workDir: string): Promise<Worktree> => {
    const saved = space.info.worktrees?.[folder]
    const branches = (await git(folder, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/')).split('\n')
    let worktree: Worktree
    if (saved && branches.includes(saved.branch)) {
      await git(folder, 'worktree', 'prune')
      await git(folder, 'worktree', 'add', saved.path, saved.branch)
      worktree = saved
    } else {
      const slug = space.info.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, BRANCH_SLUG_MAX_CHARS)
      const branch = freeName(`hotrod/${slug.replace(/^-|-$/g, '') || 'space'}`, (b) => branches.includes(b))
      const taken = Object.values(space.info.worktrees ?? {}).map((w) => w.path)
      const path = freeName(join(workDir, basename(folder)), (p) => taken.includes(p) || existsSync(p))
      await git(folder, 'worktree', 'add', '--no-track', '-b', branch, path, 'HEAD')
      worktree = { path, branch }
    }
    updateChat(space, { worktrees: { ...space.info.worktrees, [folder]: worktree } })
    return worktree
  }

  const making = new Map<string, Promise<Worktree>>()
  const worktreeOf = (space: Chat, folder: string, workDir: string) => {
    const saved = space.info.worktrees?.[folder]
    if (saved && existsSync(saved.path)) return saved
    const key = `${space.info.id}\n${folder}`
    const made = making.get(key) ?? makeWorktree(space, folder, workDir).finally(() => making.delete(key))
    making.set(key, made)
    return made
  }

  const checkoutOf = async (space: Chat, folder: string, workDir: string, sandboxed: boolean): Promise<Checkout> => {
    try {
      const worktree = await worktreeOf(space, folder, workDir)
      if (!sandboxed) return { folder, worktree, writable: [], readOnly: [] }
      const gitDir = await git(folder, 'rev-parse', '--path-format=absolute', '--git-common-dir')
      const listed = PROTECT_CHECKED_OUT_BRANCHES ? await git(folder, 'worktree', 'list', '--porcelain') : ''
      const readOnly = listed.split('\n\n').flatMap((entry) => {
        const path = entry.match(/^worktree (.+)$/m)?.[1]
        const ref = entry.match(/^branch (.+)$/m)?.[1]
        return path && ref && !within(path, workDir) ? [join(gitDir, ref), `${join(gitDir, ref)}.lock`] : []
      })
      return { folder, worktree, writable: GIT_WRITABLE.map((path) => join(gitDir, path)), readOnly }
    } catch (error) {
      throw new Error(`Couldn't check out ${folder} in the work folder: ${messageOf(error)}`)
    }
  }

  // Only a folder Hotrod made for this space, whatever chat.json says.
  const ownWorkDirOf = ({ info }: Chat) =>
    info.workDir && basename(info.workDir) === info.id ? info.workDir : undefined

  const removeWorkDir = async (space: Chat) => {
    const workDir = ownWorkDirOf(space)
    if (!workDir) return
    for (const [folder, { path }] of Object.entries(space.info.worktrees ?? {})) {
      await git(folder, 'worktree', 'remove', '--force', path).catch(() => {})
    }
    rmSync(workDir, { recursive: true, force: true })
  }

  const sweeps = new Map<string, Promise<void>>()
  const sweepMergedWorktrees = (space: Chat) => {
    const idle = () => familyOf(space).every((c) => c.status === 'idle')
    const workDir = ownWorkDirOf(space)
    if (!workDir || !idle()) return
    const own = Object.values(space.info.worktrees ?? {}).map((w) => realPath(w.path))
    const sweepRepo = async (folder: string) => {
      await git(folder, 'fetch', '--prune', '--quiet').catch(() => {})
      const listed = await git(folder, 'worktree', 'list', '--porcelain')
      for (const entry of listed.split('\n\n')) {
        const path = entry.match(/^worktree (.+)$/m)?.[1]
        const branch = entry.match(/^branch refs\/heads\/(.+)$/m)?.[1]
        if (!path || !branch || !existsSync(path)) continue
        if (own.includes(realPath(path)) || !within(realPath(path), realPath(workDir))) continue
        try {
          const ref = `refs/heads/${branch}`
          if ((await git(folder, 'for-each-ref', '--format=%(upstream:track)', ref)) !== '[gone]') continue
          if (!(await git(folder, 'for-each-ref', '--contains', ref, '--format=%(refname)', 'refs/remotes/'))) continue
          if (await git(path, 'status', '--porcelain')) continue
          if (!idle()) return
          await git(folder, 'worktree', 'remove', path)
          await git(folder, 'branch', '-D', branch)
        } catch (error) {
          console.error(`Couldn't clean up the worktree ${path}: ${messageOf(error)}`)
        }
      }
    }
    for (const folder of Object.keys(space.info.worktrees ?? {})) {
      const swept = (sweeps.get(folder) ?? Promise.resolve())
        .then(() => sweepRepo(folder))
        .catch((error) => console.error(`Couldn't clean up the worktrees of ${folder}: ${messageOf(error)}`))
        .finally(() => sweeps.get(folder) === swept && sweeps.delete(folder))
      sweeps.set(folder, swept)
    }
  }

  // A continuation is a prompt from Hotrod, not the user: it isn't logged, and the turn it starts carries on the last.
  const send = (
    chat: Chat,
    text: string,
    attachments: Attachment[] = [],
    reports: Report[] = [],
    continuation?: string,
  ) => {
    if (quitting) throw new Error('Hotrod is quitting')
    if (chat.status !== 'idle') throw new Error('A turn is already running in this chat')
    checkActive(chat)
    const adapter = adapterFor(chat.info.engine)
    if (!adapter) {
      throw new Error(`Engine "${chat.info.engine}" is not available. Pick another engine for this chat.`)
    }
    checkEnabled(adapter.id)
    const editAnywhere = editsAnywhere(...switchesOf(chat))
    if (!machine.canSandbox && !editAnywhere && UNSANDBOXED_NEEDS_EDIT_ANYWHERE) {
      throw new Error("Hotrod can't sandbox engines on this system yet. Turn on Edits anywhere in this chat's Context panel, or as the default in Settings → Work folder, to run it unsandboxed.")
    }
    const workDir = workDirOf(chat)
    mkdirSync(workDir, { recursive: true })
    const message = withAttachments(text, attachments)
    const zoomable = takesMcp(adapter.id)
    const prompt = continuation
      ? continuationPrompt(messagesOf(chat.entries), chat.summaries, continuation, { zoom: zoomable })
      : memoryPrompt(messagesOf(chat.entries), chat.summaries, message, { zoom: zoomable }, reports)
    const at = new Date().toISOString()
    if (!continuation) {
      chat.produced = false
      for (const { text, report } of reports) append(chat, { at, type: 'subagent.report', text, ...report })
      if (text || attachments.length || !reports.length) {
        append(chat, { at, type: 'user.message', text, ...(attachments.length && { attachments }) })
      }
    }
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
    const role = modChatOf(chat)?.instructions
    const parentView = readBytes(join(chat.dir, PARENT_VIEW_FILE)).toString('utf8')
    const zoomParent = zoomable ? ' (zoom and date read it with parent: true)' : ''
    const parentIntro = `Your parent chat's memory when it started you${zoomParent}:`
    const spawns = zoomable && !chat.info.subagent && isOn(SUBAGENTS_MOD)
    const memory = [
      ...(spawns ? [String(modValues(SUBAGENTS_MOD).instructions)] : []),
      MEMORY_INSTRUCTIONS,
      ...(zoomable ? [ZOOM_INSTRUCTIONS] : []),
      ...(parentView ? [`${parentIntro}\n\n${parentView}`] : []),
    ]
    const attachmentsDir = attachmentsDirOf(chat)
    const folders = items.flatMap((item) => (item.section === 'folders' ? [item.path] : []))
    const repos = folders.filter((folder) => existsSync(join(folder, '.git')))
    const sandbox = editAnywhere ? undefined : sandboxIn(workDir)

    const start = (checkouts: Checkout[]) => {
      const cwd = checkouts[0]?.worktree.path ?? workDir
      const rules = [
        ...(sandbox ? [`${WRITE_RULES}\nYour work folder: ${workDir}`] : []),
        ...(checkouts.length
          ? [
              [CHECKOUT_RULES, ...checkouts.map((c) => `- ${c.folder}: ${c.worktree.path} (branch ${c.worktree.branch})`)]
                .join('\n'),
            ]
          : []),
      ]
      const instructions = [...(role ? [role] : []), ...rules, ...memory, ...contextText].join('\n\n')
      const extraDirs = [
        ...(cwd === workDir ? [] : [workDir]),
        ...checkouts.slice(1).map((c) => c.worktree.path),
        ...folders.filter((folder) => !repos.includes(folder)),
        ...(existsSync(attachmentsDir) ? [attachmentsDir] : []),
      ]
      const readOnly = checkouts.flatMap((c) => c.readOnly)
      const jail = sandbox && {
        ...sandbox,
        writable: [...sandbox.writable, ...checkouts.flatMap((c) => c.writable)],
        ...(readOnly.length && { readOnly }),
      }
      const verdictOf = (request: Extract<EngineEvent, { type: 'permission.requested' }>) => {
        if (request.kind === 'edit' && request.path !== undefined) {
          // Edits in the work folder need no asking; outside it the sandbox would fail them anyway.
          if (within(realPath(resolve(cwd, request.path)), workDir)) return { allow: true }
          if (!jail) return undefined
          const message = `Hotrod lets this chat edit only inside ${workDir}. ${OUTSIDE_EDIT_ADVICE}`
          return { allow: false, message }
        }
        const on = (name: PermissionSwitch) => switchedOn(name, ...switchesOf(chat))
        // Fetching writes nothing, so it needs no sandbox.
        if (request.kind === 'fetch') return on('autoFetch') ? { allow: true } : undefined
        if (request.kind !== 'shell' || request.command === undefined || !jail || !on('autoRunCommands')) return
        if (on('askNetworkCommands') && ASKS_FIRST.test(request.command)) return
        return { allow: true }
      }

      let session: Session | undefined
      const emit = (event: EngineEvent) => {
        if (chat.session !== session) return
        const at = new Date().toISOString()
        if (event.type === 'turn.completed' || event.type === 'session.ended') return endTurn(chat, { at, ...event })
        if (['text.delta', 'text.completed', 'thinking.delta', 'tool.started'].includes(event.type)) chat.produced = true
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
        if (event.type === 'limit.reached') {
          const { message, resetsAt } = event
          chat.limit ??= { message, ...(resetsAt && { resetsAt }) }
          // An engine may wait out the limit; a mod that reacts to it gets the chat idle.
          if (limitWatchers().length) interrupt(chat, false)
          return
        }
        if (event.type === 'question.asked') {
          chat.pendingRequests.set(event.requestId, 'question')
          return setStatus(chat, 'waiting')
        }
        if (event.type !== 'permission.requested') return
        const verdict = verdictOf(event)
        if (!verdict) {
          chat.pendingRequests.set(event.requestId, 'permission')
          return setStatus(chat, 'waiting')
        }
        const { requestId } = event
        append(chat, { at, type: 'permission.resolved', requestId, allow: verdict.allow, auto: true })
        session?.respond(requestId, verdict.allow, verdict.message)
      }

      try {
        chat.mcpToken = zoomable ? mcp.grant(chat.info.id) : undefined
        const hotrodMcp = mcpUrl && chat.mcpToken ? { url: mcpUrl, token: chat.mcpToken } : undefined
        const engine = engineInfo(adapter.id)
        const model = pickModel(engine, listsOf(adapter.id), chat.info)
        const thinking = pickThinking(engine, chat.info)
        const mcpServers = adapter.hotrodMcp ? modServers(chat, workDir, jail !== undefined) : []
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
          ...(mcpServers.length && { mcpServers }),
          ...(model && { model }),
          ...(thinking && { thinking }),
          ...(jail && { sandbox: jail }),
        }
        chat.account = accounts.activeOf(adapter.id)
        session = adapter.start(machine, options, emit)
        if (chat.status === 'idle') return session.close()
        chat.session = session
        session.prompt(prompt, images)
      } catch (error) {
        if (chat.status === 'idle') return
        endTurn(chat, { at: new Date().toISOString(), type: 'turn.completed', error: String(error) })
      }
    }

    const turn = ++chat.turns
    if (!repos.length) return start([])
    const space = chainOf(chat)[0]!
    const stillStarting = () => chat.turns === turn && chat.status === 'running' && !chat.session && !quitting
    const checkOut = async () => {
      const checkouts: Checkout[] = []
      for (const folder of repos) checkouts.push(await checkoutOf(space, folder, workDir, sandbox !== undefined))
      return checkouts
    }
    checkOut().then(
      (checkouts) => stillStarting() && start(checkouts),
      (error) => {
        if (!stillStarting()) return
        endTurn(chat, { at: new Date().toISOString(), type: 'turn.completed', error: messageOf(error) })
      },
    )
  }

  const setQueue = (chat: Chat, queue: QueuedMessage[]) => {
    chat.queue = queue
    broadcast({ type: 'chat.queue', chatId: chat.info.id, queue })
  }

  const sendQueue = (chat: Chat, message?: Omit<QueuedMessage, 'id'>) => {
    const queue = chat.queue
    if (queue.length) setQueue(chat, [])
    const parts = message ? [...queue, message] : queue
    const reports = parts.flatMap(({ text, report }) => (report ? [{ text, report }] : []))
    const typed = parts.filter((part) => !part.report)
    try {
      const text = typed.flatMap((part) => (part.text ? [part.text] : [])).join('\n\n')
      send(chat, text, typed.flatMap((part) => part.attachments ?? []), reports)
    } catch (error) {
      if (queue.length) setQueue(chat, queue)
      throw error
    }
  }

  const enqueue = (chat: Chat, message: Omit<QueuedMessage, 'id'>) => {
    if (quitting) throw new Error('Hotrod is quitting')
    checkActive(chat)
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
      enqueue(chat, { text, ...(attachments.length && { attachments }) })
    } catch (error) {
      for (const { path } of attachments) rmSync(path, { force: true })
      throw error
    }
  }

  const mcp = openHotrodMcp({
    host: modHost,
    chats: () => shownChats().map(state),
    seesAll: (chatId) => modChats.some((chat) => chat.id === chatId && chat.seesAll),
    createChat,
    send: (chatId, text) => send(chatFor(chatId), text),
    subagents: () => {
      const { enabled, values } = modInfo(SUBAGENTS_MOD)
      return { enabled, limit: Number(values.limit) }
    },
    memory: (chatId) => memoryOf(chatFor(chatId)),
    modTools: () =>
      mods.filter(isOn).flatMap((mod) => (mod.tools ?? []).map((tool) => ({ tool, values: modValues(mod) }))),
  })

  const interrupt = (chat: Chat, force: boolean) => {
    if (!chat.session && chat.status === 'running') return forceStop(chat)
    if (!chat.session) return
    if (force) return forceStop(chat)
    if (chat.status === 'stopping') return
    setStatus(chat, 'stopping')
    chat.stopTimer = setTimeout(() => forceStop(chat), stopGraceMs)
    chat.session.interrupt()
  }

  const settle = (chat: Chat, entry: Extract<ChatEntry, { type: 'permission.resolved' | 'question.resolved' }>) => {
    const kind = entry.type === 'question.resolved' ? 'question' : 'permission'
    if (!chat.session || chat.pendingRequests.get(entry.requestId) !== kind) {
      throw new Error(`No pending ${kind === 'question' ? kind : 'permission request'} "${entry.requestId}"`)
    }
    chat.pendingRequests.delete(entry.requestId)
    append(chat, entry)
    if (chat.pendingRequests.size === 0) setStatus(chat, 'running')
    return chat.session
  }

  const respond = (chat: Chat, requestId: string, allow: boolean) => {
    const entry = { at: new Date().toISOString(), type: 'permission.resolved' as const, requestId, allow }
    settle(chat, entry).respond(requestId, allow)
  }

  const answer = (chat: Chat, requestId: string, answers: unknown) => {
    const valid = (list: unknown) => Array.isArray(list) && list.every((text) => typeof text === 'string')
    const isObject = typeof answers === 'object' && answers !== null && !Array.isArray(answers)
    if (answers !== undefined && !(isObject && Object.values(answers).every(valid))) {
      throw new Error('Answers must give each question a list of choices')
    }
    const given = answers as Answers | undefined
    const entry = { at: new Date().toISOString(), type: 'question.resolved' as const, requestId }
    settle(chat, { ...entry, ...(given && { answers: given }) }).answer?.(requestId, given)
  }

  for (const mod of mods.filter(isOn)) void checkSetup(mod)

  return {
    engines: engineInfos,
    async refreshEngines() {
      await Promise.all(
        adapters.map(async (adapter) => {
          try {
            detected.set(adapter.id, nameModels(await adapter.detect(machine)))
          } catch (error) {
            detected.set(adapter.id, { installed: false, signedIn: false, detail: messageOf(error) })
          }
          broadcast({ type: 'engine.updated', engine: engineInfo(adapter.id) })
        }),
      )
      enginesDetected = true
      compactBacklog()
    },
    setEngineEnabled,
    contextDefaults,
    mods: (): ModInfo[] => [
      ...mods.map(modInfo),
      ...brokenMods.map(({ id, loadError }) => ({
        id,
        name: id,
        description: '',
        enabled: false,
        settings: [],
        values: {},
        loadError,
      })),
    ],
    modelLists: () => Object.fromEntries(adapters.map((adapter) => [adapter.id, listsOf(adapter.id)])),
    memory: () => settings.memory ?? {},
    chats: () => shownChats().map(state),
    workFolder,
    setWorkFolder,
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
            name: message.name,
            engine: optionalText(message.engine),
            folders: message.folders,
            files: message.files,
          })
        case 'chat.rename':
          return renameChat(chatFor(message.chatId), message.name)
        case 'chat.archive':
          return archiveChat(chatFor(message.chatId), message.archived === true)
        case 'chat.move':
          return moveChat(chatFor(message.chatId), message.pinned === true, message.index)
        case 'chat.delete':
          return deleteChat(chatFor(message.chatId))
        case 'chat.setEngine':
          return setEngine(chatFor(message.chatId), String(message.engine))
        case 'chat.setModel':
          return setModel(chatFor(message.chatId), optionalText(message.model), optionalText(message.thinking))
        case 'chat.setPermission': {
          const chat = chatFor(message.chatId)
          const name = checkSwitch(message.name)
          checkActive(chat)
          return updateChat(chat, { [name]: typeof message.enabled === 'boolean' ? message.enabled : undefined })
        }
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
        case 'instructions.write':
          if (typeof message.text !== 'string') throw new Error('Instructions text is missing')
          return writeAgentsFile(globalAgentsFile, message.text)
        case 'workFolder.set':
          return setWorkFolder(message.path)
        case 'permission.setDefault':
          settings[checkSwitch(message.name)] = message.enabled === true
          saveSettings()
          return broadcast({ type: 'workFolder.updated', workFolder: workFolder() })
        case 'context.setDefault':
          if (!CONTEXT_SECTIONS.includes(message.section)) {
            throw new Error(`Unknown context section "${message.section}"`)
          }
          return setContextDefault(message.section, message.enabled === true)
        case 'mod.setEnabled':
          return setModEnabled(modFor(String(message.modId)), message.enabled === true)
        case 'mod.setValue':
          return setModValue(modFor(String(message.modId)), String(message.key), message.value)
        case 'mod.install':
          return install(modFor(String(message.modId)))
        case 'mod.cancelInstall':
          return installs.get(modFor(String(message.modId)).id)?.abort()
        case 'memory.set':
          return setMemory(optionalText(message.engine), optionalText(message.model))
        case 'models.setList':
          return setModelList(String(message.engine), message.role, message.models)
        case 'permission.respond':
          return respond(chatFor(message.chatId), message.requestId, message.allow === true)
        case 'question.respond':
          return answer(chatFor(message.chatId), message.requestId, message.answers)
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

const within = (inner: string, outer: string) => inner === outer || inner.startsWith(outer.replace(/\/?$/, sep))

const freeName = (base: string, taken: (name: string) => boolean) => {
  let name = base
  for (let copy = 2; taken(name); copy++) name = `${base}-${copy}`
  return name
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

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

const checkSwitch = (name: unknown) => {
  if (!PERMISSION_SWITCHES.includes(name as PermissionSwitch)) throw new Error(`Unknown permission switch "${name}"`)
  return name as PermissionSwitch
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
