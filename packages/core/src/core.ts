import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type {
  ChatDetail,
  Extension,
  ExtensionContext,
  ExtensionInstructionsFor,
  SpaceDetail,
} from '@kothar/extension-api'
import { openAccounts } from './accounts.ts'
import { openChatSetups, openSetups, WORKER_SETUP } from './setups.ts'
import { openKotharMcp, WORKERS_EXTENSION, summaryOf } from './kothar-mcp.ts'
import { messagesOf, windowView } from './memory.ts'
import { type Fetch, openMarketplace } from './marketplace.ts'
import { readApprovals } from './approvals.ts'
import { type CommunityExtension, type ExtensionHook, valuesOf } from './extensions.ts'
import { gatherExtensions } from './community-load.ts'
import {
  bySpaceOrder,
  editsAnywhere,
  type Adapter,
  type ChatEntry,
  type ChatInfo,
  type ChatState,
  type CompletionRequest,
  type CoreMessage,
  type EngineInfo,
  type EngineStatus,
  type Machine,
  type ModelRole,
  type MarketKind,
  type MemoryMessage,
  type ExtensionInfo,
  MODEL_ROLES,
  type NewChat,
  type Setup,
} from './shared.ts'
import { openModels } from './models.ts'
import { moveExtensionsDir } from './vocab-move.ts'
import { openProtocol } from './protocol.ts'
import { openExtensionSwitches } from './extension-switches.ts'
import { openExtensionSettings } from './extension-settings.ts'
import { openPanels } from './panels.ts'
import { openAppSettings } from './settings.ts'
import { checkPath, openContext } from './context.ts'
import type { Chat } from './chat.ts'
import { pageOf } from './history.ts'
import { reaches } from './reach.ts'
import { lockGarage } from './garage-lock.ts'
import { openTerminal } from './terminal.ts'
import { openCheckouts } from './checkouts.ts'
import { openExtensionHosts } from './extension-host.ts'
import { appendEntry, openSettings, quitMidTurn, readChat, saveChatFile, storedChatIds } from './chat-store.ts'
import { within, messageOf, readBytes } from './util.ts'
import { openTurns, type SessionParts, UNSANDBOXED_NEEDS_EDIT_ANYWHERE } from './turn.ts'

// Kept here too, for code that imports them from the core.
export { CHECKOUT_RULES, WRITE_RULES } from './instructions.ts'

export const STOP_GRACE_MS = 60_000
const PARENT_VIEW_FILE = 'parent-view.md'
// A chat's own files, which extensions' chat storage can't touch.
const CHAT_OWN_FILES = ['chat.json', 'log.jsonl', 'AGENTS.md', PARENT_VIEW_FILE, 'attachments']
const REVEAL_TIMEOUT_MS = 10_000


export type Core = ReturnType<typeof openCore>

type CoreOptions = Parameters<typeof openLockedCore>[0]

// The core holds its garage from before it reads anything until it closes (garage-lock.ts), so a second core on the
// same garage fails here and changes nothing.
export function openCore(options: CoreOptions) {
  mkdirSync(options.garage, { recursive: true })
  const release = lockGarage(realpathSync(options.garage))
  let core: ReturnType<typeof openLockedCore>
  try {
    core = openLockedCore(options)
  } catch (error) {
    release()
    throw error
  }
  const close = core.close
  core.close = async (force = false) => {
    try {
      await close(force)
    } finally {
      release()
    }
  }
  return core
}

function openLockedCore(options: {
  garage: string
  adapters: Adapter[]
  defaultEngine: string
  machine: Machine
  extensions?: Extension[]
  brokenExtensions?: { id: string; loadError: string }[]
  // Extensions installed in the garage from the marketplace or a folder; see loadCommunityExtensions.
  community?: CommunityExtension[]
  stopGraceMs?: number
  marketplaceUrl?: string
  githubToken?: string
  fetch?: Fetch
  // Restarts Kothar (the desktop app relaunches; npm run dev's core starts again in its process). Without it, the user
  // restarts Kothar themselves.
  restart?: () => void
  // Opens the user's terminal app at a folder; choice is settings.json's terminal. Tests pass a stub.
  openTerminal?: (dir: string, choice?: string) => Promise<void>
  // Shows a file or folder in Finder (the desktop app: Electron's shell). Without it, `open -R` through the Machine.
  // Tests pass a stub.
  reveal?: (path: string) => Promise<void>
  // The user's home folder and the clock. Core modules get them from here instead of asking the OS, so tests can
  // pass their own.
  home?: string
  now?: () => Date
}) {
  const { adapters, defaultEngine, machine, stopGraceMs = STOP_GRACE_MS, home = homedir(), now = () => new Date() } = options
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
  const { extensions, extensionChats, builtInIds, community, imported, reinstalled } = gatherExtensions(
    [...(options.extensions ?? []), WORKERS_EXTENSION],
    options.community ?? [],
  )
  const marketplace = openMarketplace({
    garage,
    url: options.marketplaceUrl,
    token: options.githubToken,
    fetch: options.fetch,
  })
  const { settings, save: saveSettings } = openSettings(garage)
  moveExtensionsDir(garage)
  // What the user turned on, per community extension (approvals.ts). One whose files aren't those didn't start; its
  // switch goes off, so turning it on again is the user reviewing the new files.
  const savedApprovals = readApprovals(garage) ?? {}
  const heldOn = [...community].filter(([id, c]) => c.held && settings.extensions?.[id]?.enabled === true)
  for (const [id] of heldOn) settings.extensions = { ...settings.extensions, [id]: { ...settings.extensions?.[id], enabled: false } }
  if (heldOn.length) saveSettings()
  const brokenExtensions = options.brokenExtensions ?? []
  // Extensions whose saved settings failed to migrate at load, and why; shown on the extension like a load error.
  const settingsErrors = new Map<string, string>()
  const extensionFor = (id: string) => {
    const extension = extensions.find((m) => m.id === id)
    if (extension) return extension
    const broken = brokenExtensions.find((m) => m.id === id)
    throw new Error(broken ? `The extension ${id} couldn't load: ${broken.loadError}` : `Unknown extension "${id}"`)
  }
  const communityOn = () => settings.communityExtensions === true
  // A community extension's own switch: off until the user turns it on, whatever it says.
  const ownSwitch = (extension: Extension) => settings.extensions?.[extension.id]?.enabled === true
  // Whether an extension runs: a community extension only while community extensions are on too.
  const isOn = (extension: Extension) => {
    const saved = settings.extensions?.[extension.id]?.enabled
    if (community.has(extension.id)) return communityOn() && saved === true
    return typeof saved === 'boolean' ? saved : extension.enabledByDefault
  }
  const extensionValues = (extension: Extension) => valuesOf(extension, settings.extensions?.[extension.id])
  const detected = new Map<string, Omit<EngineInfo, 'id' | 'enabled'>>()
  const isEnabled = (engine: string) => settings.engines[engine] === true
  const engineInfo = (id: string): EngineInfo => {
    const status = detected.get(id) ?? { installed: false, signedIn: false }
    const { name, steering } = adapterFor(id) ?? {}
    return { id, ...(name && { name }), enabled: isEnabled(id), ...status, ...(steering && { steering }) }
  }
  const engineInfos = () => adapters.map((adapter) => engineInfo(adapter.id))
  const listeners: ((message: CoreMessage) => void)[] = []
  const broadcast = (message: CoreMessage) => listeners.forEach((listener) => listener(message))
  // Every window hears what's installed now, and the themes it can show.
  const marketChanged = (kind: MarketKind) => {
    if (kind === 'theme') broadcast({ type: 'themes.updated', themes: marketplace.themes() })
    broadcast({ type: 'market.installed', items: marketplace.installed() })
  }
  // Everything about which engine, model and thinking level runs lives here.
  const models = openModels({ settings, save: saveSettings, engines: engineInfos, defaultEngine, broadcast })
  const offersModel = (engine: string, model?: string) => detected.get(engine)?.models?.some((m) => m.id === model) === true
  const checkEnabled = (engine: string) => {
    if (!isEnabled(engine)) throw new Error(`Engine "${engine}" is off. Turn it on in Settings.`)
  }
  // Saved setups, read from their files each time so a hand edit applies on the next message too.
  const jobSetups = openSetups({
    garage,
    broadcast,
    check(setup) {
      if (setup.engine !== undefined) checkEngine(setup.engine)
      const offered = setup.engine === undefined ? undefined : detected.get(setup.engine)?.models
      if (setup.model !== undefined && offered?.length && !offered.some((m) => m.id === setup.model)) {
        throw new Error(`Engine "${setup.engine}" offers no model "${setup.model}"`)
      }
      const known = [...extensions.map((e) => e.id), ...(options.brokenExtensions ?? []).map((e) => e.id)]
      const unknown = setup.extensionsOff?.find((id) => !known.includes(id))
      if (unknown !== undefined) throw new Error(`Unknown extension "${unknown}"`)
    },
  })
  // A worker always uses its closest parent's setup, which is its space's: a worker can't pick one of its own, and one
  // saved by an older Kothar is ignored. It follows the space live, from its next message.
  const setupOf = (chat: Chat): Setup | undefined => {
    const parent = parentOf(chat)
    return parent ? setupOf(parent) : jobSetups.get(chat.info.setup)
  }
  // What model choice needs about a chat: its own picks, its role and its setup's.
  const choosesOf = (chat: Chat) => ({ ...chat.info, setup: setupOf(chat) })
  // Whether an extension shapes this chat's sessions: on in Settings, and not left out by the chat's setup. An
  // extension's own chat (Home) always gets it: its role instructions need its tools.
  const ownsChat = (extension: Extension, chat: Chat) =>
    extensionChats.some((declared) => declared.id === chat.info.id && declared.extension === extension)
  const isOnFor = (extension: Extension, chat: Chat | undefined) =>
    isOn(extension) &&
    !(chat && setupOf(chat)?.extensionsOff?.includes(extension.id) && !ownsChat(extension, chat))
  const chatsDir = join(garage, 'chats')
  mkdirSync(chatsDir, { recursive: true })
  const { workFolder, setWorkFolder, setEngineEnabled, setMemory, setPermissionDefault, setTerminal } = openAppSettings({
    garage,
    home,
    settings,
    saveSettings,
    broadcast,
    canSandbox: machine.canSandbox,
    adapterFor,
    checkEngine,
    checkEnabled,
    offersModel,
    engineInfo,
    models,
    followModels: () => followModels(),
    startExtensions: () => startExtensions(),
  })
  const sandboxIn = (dir: string) => (machine.canSandbox ? { writable: [dir], tmpDir: join(dir, '.tmp') } : undefined)
  const chats = new Map<string, Chat>()
  let quitting = false
  let mcpUrl: string | undefined
  // A chat that follows its model list sits on the engine the list picks, so its engine, accounts and notes are right;
  // any chat whose run changed shows it.
  const followModels = () => {
    for (const chat of chats.values()) {
      const run = models.runOf(choosesOf(chat))
      const follows = chat.info.model === undefined && chat.status === 'idle'
      if (follows && run && run.engine !== chat.info.engine) updateChat(chat, { engine: run.engine })
      else if (JSON.stringify(run) !== chat.shownRun) broadcast({ type: 'chat.updated', chat: withRun(chat) })
    }
  }
  const {
    extensionInfo,
    settingsViewChanged,
    settingsViewAction,
    saveExtension,
    runFor,
    checkSetup,
    install,
    cancelInstall,
    setupReady,
    setExtensionValue,
    spaceValuesOf,
    setSpaceValue,
  } = openExtensionSettings({
    settings,
    saveSettings,
    broadcast,
    machine,
    community,
    approvalOf: (id) => approvalOf(id),
    settingsErrors,
    isOn,
    ownSwitch,
    extensionValues,
    isStarted: (extension) => startedExtensions.has(extension.id),
    contextOf: (extension) => contextOf(extension),
    extensionError: (extension, error) => extensionError(extension, error),
    callExtension: (extension, run) => callExtension(extension, run),
    refreshExtension: (extension, chatId) => refreshExtension(extension, chatId),
    chainOf: (chat) => chainOf(chat),
    updateChat: (chat, change) => updateChat(chat, change),
  })
  const saveChat = ({ info, dir, context }: Chat) => saveChatFile(dir, info, context)
  // A chat as the UI gets it: its saved info plus what it runs now, which the core alone works out.
  const withRun = (chat: Chat) => {
    const run = models.runOf(choosesOf(chat))
    chat.shownRun = JSON.stringify(run)
    return { ...chat.info, ...(run && { run }) }
  }
  const state = (chat: Chat): ChatState => ({
    ...withRun(chat),
    status: chat.status,
    entries: chat.entries,
    draft: chat.unsavedText,
    queue: chat.queue,
    ...(chat.waits.size && { waits: waitsOf(chat) }),
  })
  // A chat as the UI's views get it: only the latest page of its log, which the UI pages back through (chat.history).
  const shownState = (chat: Chat): ChatState => {
    const { from, entries } = pageOf(chat.entries)
    return { ...state(chat), entries, ...(from > 0 && { from }) }
  }

  const append = (chat: Chat, entry: ChatEntry) => {
    chat.entries.push(entry)
    appendEntry(chat.dir, entry)
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

  const extensionServers = (chat: Chat, workDir: string, sandboxed: boolean) => {
    const session = { chat: summaryOf(chat.info), workDir, sandboxed }
    const servers = extensions
      .filter((extension) => isOnFor(extension, chat) && (!extension.setup || setupReady(extension)))
      .flatMap((extension) => extension.mcpServers?.({ ...session, values: extensionValues(extension) }) ?? [])
    const names = ['kothar', ...servers.map((server) => server.name)]
    const twin = names.find((name, i) => names.indexOf(name) !== i)
    if (twin !== undefined) throw new Error(`Two MCP servers are named "${twin}"`)
    return servers
  }
  const takesMcp = (engine: string) => adapterFor(engine)?.kotharMcp === true && mcpUrl !== undefined
  const chosenWorkFolder = () => {
    if (!settings.workFolder) throw new Error('Choose a work folder first, in Settings → Work folder')
    return settings.workFolder
  }

  // A one-shot call on the model picked for summaries, for extensions (host.complete), run in Home's scratch folder.
  const completeFor = async (request: CompletionRequest) => {
    const { engine, model } = models.memory()
    const adapter = engine === undefined ? undefined : adapterFor(engine)
    if (!adapter?.complete || model === undefined) throw new Error('No engine that is on can write summaries')
    checkEnabled(adapter.id)
    const cwd = join(chosenWorkFolder(), 'home')
    mkdirSync(cwd, { recursive: true })
    const sandbox = sandboxIn(cwd)
    const options = { ...request, cwd, model, ...accounts.sessionFor(adapter.id), ...(sandbox && { sandbox }) }
    return adapter.complete(machine, options)
  }
  let enginesDetected = false
  // Extensions' background work (onStart) waits until model calls can run: engines detected and a work folder chosen.
  const startedExtensions = new Set<string>()
  const startExtension = (extension: Extension) => {
    if (quitting || !enginesDetected || !settings.workFolder || !isOn(extension) || startedExtensions.has(extension.id)) return
    if (!extension.onStart) return
    startedExtensions.add(extension.id)
    callExtension(extension, () => extension.onStart!(contextOf(extension)))
  }
  const startExtensions = () => extensions.forEach(startExtension)
  const stopExtension = (extension: Extension) => {
    if (!startedExtensions.delete(extension.id)) return
    callExtension(extension, () => extension.onStop?.(contextOf(extension)))
  }
  // The extension that provides memory: the first that's on with one. Without it, the core's window.
  const memoryExtension = (chat?: Chat) => extensions.find((extension) => isOnFor(extension, chat) && extension.memory)
  const viewOf = (chat: Chat, messages: MemoryMessage[], tools: boolean) => {
    if (!messages.length) return ''
    const extension = memoryExtension(chat)
    if (extension) {
      try {
        const view = extension.memory!.view({ chat: detailOf(chat), messages, tools }, contextOf(extension))
        if (typeof view !== 'string') throw new Error('memory.view must return text')
        return view
      } catch (error) {
        extensionError(extension, error)
      }
    }
    return windowView(messages)
  }
  const memoryInstructions = (forSession: ExtensionInstructionsFor, chat: Chat) => {
    const extension = memoryExtension(chat)
    if (!extension?.memory?.instructions) return []
    try {
      const text = extension.memory.instructions(forSession, contextOf(extension))
      if (text === undefined || text === null) return []
      if (typeof text !== 'string') throw new Error('memory.instructions must return text')
      return text.trim() ? [text.trim()] : []
    } catch (error) {
      extensionError(extension, error)
      return []
    }
  }

  const chatFor = (chatId: string) => {
    const chat = chats.get(chatId)
    if (!chat || !shown(chat)) throw new Error(`Unknown chat "${chatId}"`)
    return chat
  }

  const extensionChatOf = (chat: Chat) => extensionChats.find((declared) => declared.id === chat.info.id)

  const shown = (chat: Chat) => {
    const owner = extensionChatOf(chainOf(chat)[0]!)?.extension
    return !owner || isOn(owner)
  }

  const shownChats = () => [...chats.values()].filter(shown)

  const parentOf = (chat: Chat) => (chat.info.parentId === undefined ? undefined : chats.get(chat.info.parentId))

  const chainOf = (chat: Chat): Chat[] => {
    const parent = parentOf(chat)
    return parent ? [...chainOf(parent), chat] : [chat]
  }

  // A chat's permission switches, nearest first: its own, then each chat above it (a worker follows its space live),
  // then the defaults in settings.
  const switchesOf = (chat: Chat) => [...chainOf(chat).reverse().map((c) => c.info), settings]

  const familyOf = (chat: Chat): Chat[] => [
    chat,
    ...[...chats.values()].filter((c) => c.info.parentId === chat.info.id).flatMap(familyOf),
  ]

  const checkRemovable = (chat: Chat) => {
    if (chat.info.extension) throw new Error(`${chat.info.name} cannot be archived or deleted`)
    if (chat.status !== 'idle') throw new Error('Stop the running chat first')
  }

  // model: what its next message runs on, as model choice works it out (models.runOf), while that's on its engine.
  // A chat busy with a turn when its model list moves to another engine stays on its engine until its next message
  // starts (send), so for that while model is left out rather than given next to an engine it doesn't run on.
  const detailOf = (chat: Chat): ChatDetail => {
    const run = models.runOf(choosesOf(chat))
    return {
      ...summaryOf(chat.info),
      ...(run && run.engine === chat.info.engine && { model: run.model }),
      status: chat.status,
      archived: chat.info.archived,
      ...(chat.info.extension && { extension: chat.info.extension, mod: chat.info.extension }),
      folders: chat.info.folders,
      files: chat.info.files,
      createdAt: chat.info.createdAt,
      ...(chat.info.parentMessages !== undefined && { parentMessages: chat.info.parentMessages }),
    }
  }

  const spaceOf = (chat: Chat): SpaceDetail => {
    const { id, name, workDir, folders, worktrees = {} } = chainOf(chat)[0]!.info
    return {
      id,
      name,
      ...(workDir && { workDir }),
      folders: folders.map((path) => ({ path, git: existsSync(join(path, '.git')) })),
      checkouts: Object.entries(worktrees).map(([folder, { path, branch, from }]) => ({
        folder,
        path,
        branch,
        ...(from && { from }),
      })),
    }
  }

  const extensionError = (extension: Extension, error: unknown) =>
    broadcast({ type: 'error', message: `${extension.name}: ${messageOf(error)}` })

  // Runs one of an extension's hooks; a throw or a rejection shows as an error and goes no further.
  const callExtension = (extension: Extension, run: () => unknown) => {
    try {
      const result = run()
      if (result instanceof Promise) result.catch((error) => extensionError(extension, error))
    } catch (error) {
      extensionError(extension, error)
    }
  }

  // With a chat: only the extensions that shape its sessions (see isOnFor).
  const watchersOf = (hook: ExtensionHook, chat?: Chat) => extensions.filter((extension) => isOnFor(extension, chat) && extension[hook])
  const callExtensions = (hook: ExtensionHook, run: (extension: Extension, context: ExtensionContext) => unknown) => {
    if (quitting) return
    for (const extension of watchersOf(hook)) callExtension(extension, () => run(extension, contextOf(extension)))
  }

  // Every folder a chat's Open in Terminal may open: its context folders, its space's work folder, and the checkouts
  // of its space and the chats above it.
  const terminalRoots = (chat: Chat) => {
    return chainOf(chat).flatMap(({ info }) =>
      info.extension
        ? []
        : [
            ...info.folders,
            ...(info.workDir ? [info.workDir] : []),
            ...Object.values(info.worktrees ?? {}).map((w) => w.path),
          ],
    )
  }
  const realOr = (path: string) => {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path)
    }
  }
  const openTerminalAt = (path: string) =>
    (options.openTerminal ?? ((dir, choice) => openTerminal(dir, { choice, home })))(path, settings.terminal)
  const terminalFor = async (chat: Chat, rawPath: unknown) => {
    const path = typeof rawPath === 'string' ? rawPath : ''
    if (!isAbsolute(path) || !terminalRoots(chat).some((root) => realOr(root) === realOr(path))) {
      throw new Error(`${path || 'That'} isn't one of this chat's folders`)
    }
    await openTerminalAt(path)
  }

  // Show in Finder reaches only Kothar's own folders: the garage, the work folder, and each chat's folders, files, work
  // folder and checkouts. Anything else is refused, so an extension can't point Finder anywhere it likes.
  const revealRoots = () => [
    garage,
    ...(settings.workFolder ? [settings.workFolder] : []),
    ...shownChats().flatMap((chat) => [...terminalRoots(chat), ...chat.info.files]),
  ]
  const reveal = async (rawPath: unknown) => {
    const path = typeof rawPath === 'string' ? rawPath : ''
    const real = realOr(path)
    if (!isAbsolute(path) || !revealRoots().map(realOr).some((root) => within(real, root))) {
      throw new Error(`${path || 'That'} isn't in Kothar's data folder, the work folder or a space's folders`)
    }
    if (!existsSync(real)) throw new Error(`${path} doesn't exist`)
    if (options.reveal) return options.reveal(real)
    const { code, stderr } = await machine.run('open', ['-R', real], { cwd: '/', timeoutMs: REVEAL_TIMEOUT_MS })
    if (code !== 0) throw new Error(stderr.trim() || `Couldn't show ${path} in Finder`)
  }

  const seesAll = (chatId: string) => extensionChats.some((chat) => chat.id === chatId && chat.seesAll)
  // Whether caller may reach chat, by the rule the core's own reach tools use; both must be chats the user can see.
  const reachable = (callerId: string, chat: Chat) => {
    const caller = chats.get(callerId)
    return !!caller && shown(caller) && shown(chat) && reaches(caller.info, chat.info, seesAll(callerId))
  }

  // What a session is told, worked out as its turn starts: context items, then role, parent view, setup, workers,
  // memory and each extension's instructions.
  const instructionPartsOf = (chat: Chat, zoomable: boolean): SessionParts => {
    const items = contextItems(chat).filter((item) => item.enabled)
    const setup = setupOf(chat)
    const role = extensionChatOf(chat)?.instructions
    const parentView = readBytes(join(chat.dir, PARENT_VIEW_FILE)).toString('utf8')
    const spawns = zoomable && !chat.info.worker && isOnFor(WORKERS_EXTENSION, chat)
    const forSession = { chat: detailOf(chat), tools: zoomable }
    const workers = spawns ? String(extensionValues(WORKERS_EXTENSION).instructions) : undefined
    const memory = memoryInstructions(forSession, chat)
    const extensionInstructions = watchersOf('instructions', chat).flatMap((extension) => {
      try {
        const text = extension.instructions!(forSession, contextOf(extension))
        if (text === undefined || text === null) return []
        if (typeof text !== 'string') throw new Error('instructions must return text')
        return text.trim() ? [text.trim()] : []
      } catch (error) {
        extensionError(extension, error)
        return []
      }
    })
    return { role, extensions: extensionInstructions, workers, memory, parentView, setup, items }
  }

  const {
    send,
    sendMessage,
    enqueue,
    setQueue,
    canSteer,
    interrupt,
    respond,
    answer,
    retry,
    continueTurn,
    setWait,
    waitsOf,
    stopSession,
    whenAllStopped,
  } = openTurns({
    garage,
    home,
    now,
    machine,
    stopGraceMs,
    isQuitting: () => quitting,
    chats,
    broadcast,
    append,
    detailOf,
    parentOf,
    chainOf,
    familyOf,
    switchesOf,
    checkActive: (chat) => checkActive(chat),
    updateChat: (chat, change) => updateChat(chat, change),
    removeChats: (family) => removeChats(family),
    extensions,
    isOn,
    isOnFor,
    contextOf: (extension) => contextOf(extension),
    callExtension,
    callExtensions,
    watchersOf,
    extensionError,
    answerWait: (chat, extensionId, answer) => answerWait(chat, extensionId, answer),
    adapterFor,
    models,
    choosesOf,
    accounts,
    takesMcp,
    mcpUrl: () => mcpUrl,
    grantMcp: (chatId) => mcp.grant(chatId),
    revokeMcp: (token) => mcp.revoke(token),
    extensionServers,
    workDirOf: (chat) => workDirOf(chat),
    sandboxIn,
    attachmentsDirOf: (chat) => attachmentsDirOf(chat),
    checkoutOf: (space, folder, workDir, sandboxed) => checkoutOf(space, folder, workDir, sandboxed),
    sweepMergedWorktrees: (space) => sweepMergedWorktrees(space),
    viewOf,
    instructionPartsOf: (chat, zoomable) => instructionPartsOf(chat, zoomable),
  })

  const { hostFor, contextOf, forgetHost, stopSpawned } = openExtensionHosts<Chat>({
    garage,
    machine,
    chatOwnFiles: CHAT_OWN_FILES,
    isQuitting: () => quitting,
    extensions,
    extensionFor,
    isOn,
    valuesOf: extensionValues,
    usesOf: (extension) => community.get(extension.id)?.manifest.uses,
    extensionError,
    processesChanged: (from, spaceId) =>
      callExtensions('onProcessesChanged', (other, context) =>
        other === from ? undefined : other.onProcessesChanged!(spaceId, context),
      ),
    refresh: (extension, chatId) => refreshExtension(extension, chatId),
    chat: (chatId) => chats.get(chatId),
    chatFor,
    shown,
    shownChats,
    detailOf,
    spaceOf,
    reachable,
    createChat: (spec) => createChat(spec),
    createChild: (parentId, spec) => createChild(parentId, spec),
    enqueue: (chat, message) => enqueue(chat, message),
    interrupt: (chat) => interrupt(chat, false),
    retry,
    continueTurn,
    append,
    setWait,
    checkWait: (wait) => checkWait(wait),
    spaceValuesOf,
    setSpaceValue,
    commandPlaceOf: (chat) => commandPlaceOf(chat),
    addContextFile: (chat, path) => addContext(chat, 'files', path),
    accounts,
    run: () => runFor(),
    complete: completeFor,
    broadcast,
    terminalRoots,
    openTerminalAt,
    reveal,
    realOr,
  })

  // Extension panels and commands: which a chat gets, and the views of panels the UI has asked for.
  const { extensionsOf, panelOf, openPanel, panelAction, refreshExtension, answerWait, checkWait, runCommand, forgetChat } =
    openPanels({
      extensions,
      extensionFor,
      isOn,
      isOnFor,
      contextOf,
      extensionError,
      callExtension,
      settingsViewChanged,
      spaceValuesOf,
      chats,
      chatFor,
      shownChats,
      detailOf,
      broadcast,
    })

  const removeChats = (family: Chat[]) => {
    for (const c of family) {
      stopSession(c)
      const detail = detailOf(c)
      chats.delete(c.info.id)
      forgetChat(c.info.id)
      rmSync(c.dir, { recursive: true, force: true })
      broadcast({ type: 'chat.removed', chatId: c.info.id })
      removeWorkDir(c).catch((error) => broadcast({ type: 'error', message: String(error) }))
      callExtensions('onChatRemoved', (extension, context) => extension.onChatRemoved!(detail, context))
    }
  }

  const loadChat = (dir: string, fallback: ChatInfo) => {
    const declared = extensionChats.find((chat) => chat.id === fallback.id)
    const { info, context, entries, resave } = readChat(
      dir,
      fallback,
      declared && { name: declared.name, extension: declared.extension.id },
    )
    const chat: Chat = {
      info,
      dir,
      context,
      entries,
      status: 'idle',
      unsavedText: '',
      pendingRequests: new Map(),
      waits: new Map(),
      queue: [],
      turns: 0,
    }
    if (resave) saveChat(chat)
    chats.set(info.id, chat)
    if (quitMidTurn(entries)) {
      append(chat, { at: now().toISOString(), type: 'turn.completed', error: 'Kothar quit during this turn' })
    }
    return chat
  }

  const freshInfo = (id: string, name: string): ChatInfo => ({
    id,
    name,
    folders: [],
    files: [],
    engine: models.engineFor(),
    archived: false,
    createdAt: now().toISOString(),
  })

  for (const { id, name } of extensionChats) loadChat(join(chatsDir, id), freshInfo(id, name))
  for (const id of storedChatIds(chatsDir)) {
    if (chats.has(id)) continue
    loadChat(join(chatsDir, id), freshInfo(id, id))
  }
  // Nothing runs yet, so a worker that has worked and is still here (Kothar quit or crashed mid-task, or an older
  // Kothar kept it) goes now.
  for (const chat of chats.values()) {
    if (!chat.info.worker || !chat.entries.length) continue
    chats.delete(chat.info.id)
    rmSync(chat.dir, { recursive: true, force: true })
  }

  // Once at load: each extension whose settings are saved at an older version than its settingsVersion migrates them,
  // the global values and every space's together, and they're saved with the new version. A throw saves nothing.
  for (const extension of extensions) {
    const version = extension.settingsVersion
    const from = settings.extensionVersions?.[extension.id] ?? 0
    if (!version || from >= version) continue
    try {
      if (!extension.migrateSettings) throw new Error(`settingsVersion ${version} needs a migrateSettings`)
      const global = settings.extensions?.[extension.id]
      const migratedGlobal = global && extension.migrateSettings({ ...global }, from, {})
      const spaces = [...chats.values()].flatMap((chat) => {
        const saved = chat.info.extensionValues?.[extension.id]
        return saved ? [{ chat, values: extension.migrateSettings!({ ...saved }, from, { spaceId: chat.info.id }) }] : []
      })
      for (const { chat, values } of spaces) {
        chat.info = { ...chat.info, extensionValues: { ...chat.info.extensionValues, [extension.id]: values } }
        saveChat(chat)
      }
      if (migratedGlobal) settings.extensions = { ...settings.extensions, [extension.id]: migratedGlobal }
      settings.extensionVersions = { ...settings.extensionVersions, [extension.id]: version }
      saveSettings()
    } catch (error) {
      settingsErrors.set(extension.id, `Its saved settings couldn't be updated: ${messageOf(error)}`)
      extensionError(extension, error)
    }
  }

  const createChat = (spec: NewChat & { parentId?: string; worker?: boolean; role?: ModelRole; setup?: string }) => {
    const name = checkName(spec.name)
    const parent = spec.worker ? chatFor(spec.parentId ?? '') : undefined
    if (parent && spec.setup !== undefined) throw new Error(WORKER_SETUP)
    const setup = parent ? setupOf(parent) : spec.setup === undefined ? undefined : setupNamed(spec.setup)
    if (spec.engine !== undefined) {
      checkEngine(spec.engine)
      checkEnabled(spec.engine)
    }
    const role = parent ? (spec.role ?? 'workers') : undefined
    // Named engine: the chat's own pick of that engine's first model in its list, else the engine's default model.
    // Otherwise it follows its list (a worker: its role's, else Workers', else Chat's).
    const pin = spec.engine === undefined ? undefined : models.pinOn(spec.engine, role)
    const engine = spec.engine ?? models.engineFor(role, setup)
    if (parent) checkActive(parent)
    if (parent?.info.worker) throw new Error('A worker cannot start chats')
    const folders = [...new Set((spec.folders ?? []).map((path) => checkPath(path, 'folders', home)))]
    const files = [...new Set((spec.files ?? []).map((path) => checkPath(path, 'files', home)))]
    let id = randomBytes(4).toString('hex')
    while (chats.has(id)) id = randomBytes(4).toString('hex')
    const parentMessages = parent && messagesOf(parent.entries)
    const info: ChatInfo = {
      id,
      name,
      ...(parent && parentMessages && {
        parentId: parent.info.id,
        worker: true,
        role,
        parentMessages: parentMessages.length,
      }),
      folders,
      files,
      engine,
      archived: false,
      createdAt: now().toISOString(),
      ...pin,
      ...(!parent && setup && { setup: setup.id }),
    }
    const chat = loadChat(join(chatsDir, id), info)
    if (parent && parentMessages?.length) {
      writeFileSync(join(chat.dir, PARENT_VIEW_FILE), viewOf(parent, parentMessages, takesMcp(engine)))
    }
    broadcast({ type: 'chat.added', chat: shownState(chat) })
    callExtensions('onChatCreated', (extension, context) => extension.onChatCreated!(detailOf(chat), context))
    return chat.info
  }

  // A chat below another, for one task: what spawn_worker and an extension's host.createChat with a parentId both make.
  const createChild = (parentId: string, spec: NewChat & { role?: ModelRole }) => {
    if (spec.folders?.length || spec.files?.length) throw new Error('A child chat takes its folders from its space')
    if (spec.role !== undefined && !MODEL_ROLES.includes(spec.role)) throw new Error(`Unknown role "${spec.role}"`)
    return createChat({ name: spec.name, engine: spec.engine, parentId, worker: true, role: spec.role })
  }

  const { setupNamed, setChatSetup, saveSetup, removeSetup } = openChatSetups({
    setups: jobSetups,
    chats,
    broadcast,
    updateChat: (chat, change) => updateChat(chat, change),
    familyOf,
    setupOf,
    followModels,
    extensionsOf,
  })

  const updateChat = (chat: Chat, change: Partial<ChatInfo>) => {
    const merged = Object.entries({ ...chat.info, ...change }).filter(([, value]) => value !== undefined)
    chat.info = Object.fromEntries(merged) as ChatInfo
    saveChat(chat)
    broadcast({ type: 'chat.updated', chat: withRun(chat) })
  }

  const renameChat = (chat: Chat, name: unknown) => {
    if (chat.info.extension) throw new Error(`${chat.info.name} cannot be renamed`)
    updateChat(chat, { name: checkName(name) })
  }

  const archiveChat = (chat: Chat, archived: boolean) => {
    const parent = parentOf(chat)
    if (!archived && parent?.info.archived) throw new Error(`Unarchive "${parent.info.name}" first`)
    const family = familyOf(chat)
    family.forEach(checkRemovable)
    family.forEach((c) => updateChat(c, { archived }))
    for (const c of family) {
      callExtensions('onChatArchived', (extension, context) => extension.onChatArchived!(detailOf(c), archived, context))
    }
  }

  const moveChat = (chat: Chat, pinned: boolean, index: unknown) => {
    if (chat.info.extension || chat.info.parentId) throw new Error('Only spaces can be moved or pinned')
    if (chat.info.archived) throw new Error('This chat is archived. Unarchive it first.')
    if (typeof index !== 'number' || !Number.isInteger(index)) throw new Error('The place to move to must be a number')
    const group = [...chats.values()]
      .map((c) => c.info)
      .filter((c) => !c.extension && !c.parentId && !c.archived && !!c.pinned === pinned && c.id !== chat.info.id)
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

  const { setExtensionEnabled, setCommunityExtensions, restartState, communityChanged, uninstallExtension, approvalOf } =
    openExtensionSwitches({
      garage,
      now,
      settings,
      saveSettings,
      broadcast,
      extensions,
      community,
      imported,
      reinstalled,
      approvals: savedApprovals,
      canRestart: options.restart !== undefined,
      communityOn,
      ownSwitch,
      isOn,
      extensionInfo,
      saveExtension,
      checkSetup,
      startExtension,
      stopExtension,
      stopSpawned,
      forgetHost,
      marketplace,
      chats,
      familyOf,
      shownChats,
      shownState,
      setWait,
      extensionsOf,
    })

  const setModel = (chat: Chat, engine?: string, model?: string, thinking?: string) => {
    if (chat.status !== 'idle') throw new Error('Wait for the turn to end before changing the model')
    if (model !== undefined) {
      checkEngine(engine ?? chat.info.engine)
      checkEnabled(engine ?? chat.info.engine)
    }
    updateChat(chat, models.choose(choosesOf(chat), engine, model, thinking))
  }

  const checkActive = (chat: Chat) => {
    if (chat.info.archived) throw new Error('This chat is archived. Unarchive it first.')
  }

  const { contextDefaults, contextItems, addContext, removeContext, setContext, writeContext, setContextDefault, writeInstructions } =
    openContext({
      garage,
      home,
      settings,
      saveSettings,
      broadcast,
      parentOf,
      chainOf,
      familyOf,
      checkActive,
      saveChat,
      updateChat,
      extensionsOf,
    })


  const attachmentsDirOf = (chat: Chat) => join(chat.dir, 'attachments')

  // A space keeps the folder it got first, so changing the setting moves only new spaces.
  const workDirOf = (chat: Chat) => {
    const space = chainOf(chat)[0]!
    if (space.info.extension) return join(chosenWorkFolder(), 'home')
    if (!space.info.workDir) updateChat(space, { workDir: join(chosenWorkFolder(), space.info.id) })
    return space.info.workDir!
  }

  const { checkoutOf, gitAccess, removeWorkDir, sweepMergedWorktrees } = openCheckouts<Chat>({
    machine,
    saveWorktrees: (space, worktrees) => updateChat(space, { worktrees }),
    isIdle: (space) => familyOf(space).every((c) => c.status === 'idle'),
  })

  // Where a command an extension starts for a chat runs, and its sandbox: the chat's own, over the space's work folder
  // and the checkouts it has now. Nothing is checked out for it.
  const commandPlaceOf = async (chat: Chat) => {
    const editAnywhere = editsAnywhere(...switchesOf(chat))
    if (!machine.canSandbox && !editAnywhere && UNSANDBOXED_NEEDS_EDIT_ANYWHERE) {
      throw new Error("Kothar can't sandbox commands on this system yet. Turn on Edits anywhere for this chat first.")
    }
    const workDir = workDirOf(chat)
    mkdirSync(workDir, { recursive: true })
    const sandbox = editAnywhere ? undefined : sandboxIn(workDir)
    if (!sandbox) return { workDir }
    const worktrees = Object.entries(chainOf(chat)[0]!.info.worktrees ?? {})
    const access = await Promise.all(
      worktrees
        .filter(([folder, { path }]) => existsSync(folder) && existsSync(path))
        .map(([folder]) => gitAccess(folder, workDir).catch(() => ({ writable: [], readOnly: [] }))),
    )
    const readOnly = access.flatMap((a) => a.readOnly)
    const jail = {
      ...sandbox,
      writable: [...sandbox.writable, ...access.flatMap((a) => a.writable)],
      ...(readOnly.length && { readOnly }),
    }
    return { workDir, sandbox: jail }
  }

  const mcp = openKotharMcp({
    chats: () => shownChats().map(state),
    seesAll,
    createChild,
    send: (chatId, text) => send(chatFor(chatId), text),
    deliver: (chatId, text) => {
      const chat = chatFor(chatId)
      const idle = chat.status === 'idle'
      // Steered only while the turn runs; while it waits for an approval or is stopping, it's queued.
      const steers = chat.status === 'running' && canSteer(chat)
      sendMessage(chat, text, undefined, steers)
      return idle ? 'sent' : steers ? 'steered' : 'queued'
    },
    stop: (chatId) => interrupt(chatFor(chatId), false),
    workers: (chatId?: string) => {
      const { enabled, values } = extensionInfo(WORKERS_EXTENSION)
      const chat = chatId === undefined ? undefined : chats.get(chatId)
      return { enabled: enabled && isOnFor(WORKERS_EXTENSION, chat), limit: Number(values.limit) }
    },
    extensionTools: (chatId: string) =>
      extensions
        .filter((extension) => isOnFor(extension, chats.get(chatId)))
        .flatMap((extension) => (extension.tools ?? []).map((tool) => ({ tool, values: extensionValues(extension), host: hostFor(extension) }))),
  })

  const handle = openProtocol({
    broadcast,
    now,
    isQuitting: () => quitting,
    restart: options.restart,
    chatFor,
    shownChats,
    createChat,
    renameChat,
    archiveChat,
    moveChat,
    deleteChat,
    updateChat,
    checkActive,
    setModel,
    sendMessage,
    setQueue,
    interrupt,
    respond,
    answer,
    contextItems,
    addContext,
    removeContext,
    setContext,
    writeContext,
    writeInstructions,
    setContextDefault,
    setEngineEnabled,
    setWorkFolder,
    setPermissionDefault,
    setTerminal,
    setMemory,
    models,
    followModels,
    saveSetup,
    removeSetup,
    setChatSetup,
    accounts,
    extensionFor,
    extensionsOf,
    openPanel,
    panelOf,
    panelAction,
    setSpaceValue,
    runCommand,
    answerWait,
    setExtensionEnabled,
    setExtensionValue,
    install,
    cancelInstall,
    settingsViewChanged,
    settingsViewAction,
    setCommunityExtensions,
    marketplace,
    builtInIds,
    communityChanged,
    marketChanged,
    uninstallExtension,
    reveal,
    terminalFor,
  })

  for (const extension of extensions.filter(isOn)) void checkSetup(extension)

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
      models.settle()
      followModels()
      startExtensions()
    },
    setEngineEnabled,
    contextDefaults,
    extensions: (): ExtensionInfo[] => [
      ...extensions.map(extensionInfo),
      ...brokenExtensions.map(({ id, loadError }) => ({
        id,
        name: id,
        description: '',
        enabled: false,
        settings: [],
        values: {},
        loadError,
      })),
    ],
    modelLists: models.lists,
    setups: jobSetups.list,
    memory: () => settings.memory ?? {},
    chats: () => shownChats().map(shownState),
    workFolder,
    setWorkFolder,
    themes: marketplace.themes,
    installed: marketplace.installed,
    communityExtensions: communityOn,
    restart: restartState,
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
    handle,
    async close(force = false) {
      quitting = true
      for (const extension of extensions) stopExtension(extension)
      for (const chat of chats.values()) {
        if (chat.status === 'idle') stopSession(chat)
        else interrupt(chat, force)
      }
      await whenAllStopped()
      await machine.stopAll()
    },
  }
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

function nameModels(status: EngineStatus): Omit<EngineInfo, 'id' | 'enabled'> {
  const { models, defaultModel, modelThinking, ...rest } = status
  if (!models) return { ...rest, ...(defaultModel && { defaultModel }) }
  const providers = [...new Set(models.map(providerOf))]
  const named = models
    .filter((id) => !SNAPSHOT_ID.test(id))
    .map((id) => ({ id, provider: providers.indexOf(providerOf(id)), ...describeModel(id) }))
    .sort((a, b) => a.provider - b.provider || a.rank - b.rank || b.version - a.version)
  const shown = defaultModel && (named.some((m) => m.id === defaultModel) ? defaultModel : named[0]?.id)
  const options = named.map(({ id, label }) => ({ id, label, ...(modelThinking?.[id] && { thinking: modelThinking[id] }) }))
  return { ...rest, models: options, ...(shown && { defaultModel: shown }) }
}


const checkName = (name: unknown) => {
  const trimmed = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : ''
  if (!trimmed) throw new Error('A chat needs a name')
  return trimmed
}
