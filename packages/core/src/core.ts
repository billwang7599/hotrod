import { homedir } from 'node:os'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatDetail, Extension, ExtensionContext, SentTurn, SpaceDetail } from '@kothar/extension-api'
import { randomUUID } from 'node:crypto'
import { openAccounts } from './accounts.ts'
import { openChatSetups, openSetups } from './setups.ts'
import { openChatLifecycle } from './chat-lifecycle.ts'
import { openActivity } from './activity.ts'
import { openKotharMcp, summaryOf } from './kothar-mcp.ts'
import { agentStartsWorkers, openWorkers, workerInstructionsFor } from './workers.ts'
import { firstSentence, openCorePrompts, toolboxText, type ToolboxGroup } from './core-prompts.ts'
import { openInstructionParts, PARENT_VIEW_FILE } from './instruction-parts.ts'
import { windowView } from './memory.ts'
import { type Fetch, openMarketplace } from './marketplace.ts'
import { readApprovals } from './approvals.ts'
import { type CommunityExtension, type ExtensionHook, valuesOf } from './extensions.ts'
import { gatherExtensions } from './community-load.ts'
import {
  editsAnywhere,
  type Adapter,
  type ChatEntry,
  type ChatInfo,
  type ChatState,
  type CompletionRequest,
  type CoreMessage,
  type EngineInfo,
  type Machine,
  type MarketKind,
  type MemoryMessage,
  type ExtensionInfo,
  type Setup,
} from './shared.ts'
import { followModels as followChatModels, nameModels, openModels } from './models.ts'
import { moveExtensionsDir } from './vocab-move.ts'
import { openProtocol } from './protocol.ts'
import { openExtensionSwitches } from './extension-switches.ts'
import { migrateExtensionSettings, openExtensionSettings } from './extension-settings.ts'
import { openPrompts } from './prompts.ts'
import { sentTurnOf } from './sent.ts'
import type { SentInput } from './turn.ts'
import { openPanels } from './panels.ts'
import { openAppSettings } from './settings.ts'
import { openContext } from './context.ts'
import type { Chat } from './chat.ts'
import { pageOf } from './history.ts'
import { reaches } from './reach.ts'
import { lockGarage } from './garage-lock.ts'
import { openFolderAccess, realOr } from './folder-access.ts'
import { openFileLinks } from './file-links.ts'
import { openCheckouts } from './checkouts.ts'
import { openFolderCopies } from './folder-copies.ts'
import { placeAccess, placesOf } from './folder-modes.ts'
import { extensionPicture, extensionStorageDir } from './extension-files.ts'
import { openExtensionHosts } from './extension-host.ts'
import { appendEntry, openSettings, saveChatFile } from './chat-store.ts'
import { messageOf } from './util.ts'
import { openTurns, UNSANDBOXED_NEEDS_EDIT_ANYWHERE } from './turn.ts'

// Kept here too, for code that imports them from the core.
export { CHECKOUT_RULES, FOLDER_RULES, WRITE_RULES } from './instructions.ts'

export const STOP_GRACE_MS = 60_000
// A chat's own files, which extensions' chat storage can't touch.
const CHAT_OWN_FILES = ['chat.json', 'log.jsonl', 'AGENTS.md', PARENT_VIEW_FILE, 'attachments']


export type Core = ReturnType<typeof openCore>

type CoreOptions = Parameters<typeof assembleCore>[0]

// The core holds its garage from before it reads anything until it closes (garage-lock.ts), so a second core on the
// same garage fails here and changes nothing.
export function openCore(options: CoreOptions) {
  mkdirSync(options.garage, { recursive: true })
  const release = lockGarage(realpathSync(options.garage))
  let core: ReturnType<typeof assembleCore>
  try {
    core = assembleCore(options)
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

// Builds the core over a garage this process already holds (openCore locks it first): opens each module, wires them
// together with plain functions, loads the chats, and returns what the server and main.ts use. Each module says what it
// does at its top; this function only connects them. A function passed as `(x) => f(x)` refers to something opened
// further down, which runs only after everything is open.
function assembleCore(options: {
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
    options.extensions ?? [],
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
  const switchedOn = (extension: Extension) => {
    const saved = settings.extensions?.[extension.id]?.enabled
    if (community.has(extension.id)) return communityOn() && saved === true
    return typeof saved === 'boolean' ? saved : extension.enabledByDefault
  }
  // Whether an extension runs: its switch is on (switchedOn), and so is every extension it requires, all the way down.
  // A loop of requires runs none of them.
  const runs = (extension: Extension, seen: ReadonlySet<string>): boolean => {
    if (!switchedOn(extension)) return false
    if (!extension.requires?.length) return true
    if (seen.has(extension.id)) return false
    const next = new Set([...seen, extension.id])
    return extension.requires.every((id) => {
      const needed = extensions.find((m) => m.id === id)
      return needed !== undefined && runs(needed, next)
    })
  }
  const isOn = (extension: Extension) => runs(extension, new Set())
  const isOnById = (id: string) => {
    const extension = extensions.find((m) => m.id === id)
    return extension !== undefined && isOn(extension)
  }
  // Why something that needs the extension with this id can't be used now, or undefined while it runs.
  const neededBy = (id: string) => {
    if (isOnById(id)) return undefined
    const name = extensions.find((m) => m.id === id)?.name ?? brokenExtensions.find((m) => m.id === id)?.id ?? id
    return `Needs the ${name} extension`
  }
  const extensionValues = (extension: Extension) =>
    valuesOf(extension, settings.extensions?.[extension.id], extension.settings, isOnById)
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
  const { workFolder, setWorkFolder, setEngineEnabled, setMemory, setPermissionDefault, setTerminal, setEditor } = openAppSettings({
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
  // See models.ts followModels.
  const followModels = () =>
    followChatModels(chats.values(), {
      runOf: (chat) => models.runOf(choosesOf(chat)),
      setEngine: (chat, engine) => updateChat(chat, { engine }),
      showRun: (chat) => broadcast({ type: 'chat.updated', chat: withRun(chat) }),
    })
  // Kothar's own named prompts, edited in Settings → Prompts (core-prompts.ts).
  const corePrompts = openCorePrompts({ settings, saveSettings, broadcast })
  // Settings → Workers: part of the core (workers.ts).
  const workers = openWorkers({ settings, saveSettings, broadcast, changed: () => startWaitingWorkers() })
  const prompts = openPrompts({
    settings,
    saveSettings,
    changed: (extension) => broadcast({ type: 'extension.updated', extension: extensionInfo(extension) }),
  })
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
    promptsOf: prompts.infoOf,
    needs: neededBy,
    switchedOn,
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
  // Each call is listed in the Activity (activity.ts) under request.chatId, with what was sent and the reply.
  const completeFor = async (request: CompletionRequest, from?: Extension) => {
    const { engine, model } = models.memory()
    const chatId = typeof request.chatId === 'string' && chats.has(request.chatId) ? request.chatId : undefined
    const { chatId: _chatId, ...call } = request
    const started = Date.now()
    const record = (outcome: { result?: string; error?: unknown }) =>
      activity.emit(chatId, () => ({
        kind: 'model',
        ...(from && { by: from }),
        title: `Called ${model ?? 'a model'}${engine ? ` on ${adapterFor(engine)?.name ?? engine}` : ''}`,
        ...(model && { model }),
        detail: `${((Date.now() - started) / 1000).toFixed(1)} s${request.schema ? ', asked for JSON' : ''}`,
        sections: [
          { label: 'Instructions (system)', text: request.system },
          { label: 'Prompt', text: request.prompt },
        ],
        ...(outcome.result !== undefined && { result: outcome.result }),
        ...(outcome.error !== undefined && { error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) }),
      }))
    try {
      const adapter = engine === undefined ? undefined : adapterFor(engine)
      if (!adapter?.complete || model === undefined) throw new Error('No engine that is on can write summaries')
      checkEnabled(adapter.id)
      const cwd = join(chosenWorkFolder(), 'home')
      mkdirSync(cwd, { recursive: true })
      const sandbox = sandboxIn(cwd)
      const options = { ...call, cwd, model, ...accounts.sessionFor(adapter.id), ...(sandbox && { sandbox }) }
      const result = await adapter.complete(machine, options)
      record({ result })
      return result
    } catch (error) {
      record({ error })
      throw error
    }
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
    // What it shared with host.provide goes, and those that use it hear.
    dropProvided(extension)
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
  // What Kothar and its extensions do on their own, for extensions that watch (onActivity), such as the Inspector.
  const activity = openActivity<Chat>({
    now,
    chat: (chatId) => chats.get(chatId),
    watchers: (chat) => (quitting ? [] : watchersOf('onActivity', chat)),
    deliver: (extension, event) => callExtension(extension, () => extension.onActivity!(event, contextOf(extension))),
  })
  const callExtensions = (hook: ExtensionHook, run: (extension: Extension, context: ExtensionContext) => unknown) => {
    if (quitting) return
    for (const extension of watchersOf(hook)) callExtension(extension, () => run(extension, contextOf(extension)))
  }

  const { terminalRoots, openTerminalAt, terminalFor, reveal } = openFolderAccess({
    garage,
    home,
    machine,
    workFolder: () => settings.workFolder,
    terminal: () => settings.terminal,
    chainOf,
    shownChats,
    ...(options.openTerminal && { openTerminal: options.openTerminal }),
    ...(options.reveal && { reveal: options.reveal }),
  })
  const fileLinks = openFileLinks({
    home,
    machine,
    now,
    chainOf,
    terminalRoots,
    openTerminalAt,
    editor: () => ({ choice: settings.editor, command: settings.editorCommand }),
  })

  const seesAll = (chatId: string) => extensionChats.some((chat) => chat.id === chatId && chat.seesAll)
  // Whether caller may reach chat, by the rule the core's own reach tools use; both must be chats the user can see.
  const reachable = (callerId: string, chat: Chat) => {
    const caller = chats.get(callerId)
    return !!caller && shown(caller) && shown(chat) && reaches(caller.info, chat.info, seesAll(callerId))
  }

  const { instructionPartsOf } = openInstructionParts({
    contextItems: (chat) => contextItems(chat),
    setupOf,
    // The user's edit of the chat's role prompt (ExtensionChat.prompt), else its instructions.
    roleOf: (chat) => {
      const declared = extensionChatOf(chat)
      if (!declared?.prompt) return declared?.instructions
      try {
        return prompts.textOf(declared.extension, declared.prompt)
      } catch {
        return declared.instructions
      }
    },
    roleOwnerOf: (chat) => extensionChatOf(chat)?.extension.id,
    workerInstructions: (chat) => workerInstructionsFor(chat, workers, setupOf(chat)),
    toolbox: (chat) => toolboxOf(chat),
    detailOf: (chat) => detailOf(chat),
    memoryExtension,
    watchersOf: (hook, chat) => watchersOf(hook, chat),
    contextOf: (extension) => contextOf(extension),
    extensionError: (extension, error) => extensionError(extension, error),
  })

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
    requestPermission,
    startWaitingWorkers,
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
    copyOf: (space, folder, workDir) =>
      copies.copyOf(space, folder, workDir).finally(() => broadcastContext(space)),
    viewOf,
    instructionPartsOf,
    turnSent: (chat, input) => turnSent(chat, input),
    activity,
    workerLimit: () => workers.limit(),
  })

  const { hostFor, contextOf, forgetHost, stopSpawned, toolsOf, dropProvided } = openExtensionHosts<Chat>({
    garage,
    home,
    now,
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
    allChats: () => [...chats.values()],
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
    updateChat: (chat, change) => updateChat(chat, change),
    isOnFor: (extension, chat) => isOnFor(extension, chat),
    commandPlaceOf: (chat) => commandPlaceOf(chat),
    requestPermission: (chat, request, changes) => requestPermission(chat, request, changes),
    addContextFile: (chat, path) => addContext(chat, 'files', path),
    accounts,
    run: () => runFor(),
    complete: completeFor,
    activity,
    promptText: prompts.textOf,
    broadcast,
    terminalRoots,
    openTerminalAt,
    reveal,
    realOr,
  })

  // Extension panels and commands: which a chat gets, and the views of panels the UI has asked for.
  const { extensionsOf, panelOf, openPanel, panelAction, refreshExtension, answerWait, checkWait, runCommand, runMessageAction, renderDetail, renderNoteView, noteViewAction, flipToggle, forgetChat } =
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
      setWait,
      updateChat: (chat, change) => updateChat(chat, change),
    })

  const { loadAll, createChat, createChild, renameChat, archiveChat, moveChat, removeChats, deleteChat } = openChatLifecycle({
    chats,
    chatsDir,
    home,
    now,
    broadcast,
    extensionChats,
    models,
    checkEngine,
    checkEnabled,
    chatFor,
    parentOf,
    familyOf,
    checkActive: (chat) => checkActive(chat),
    setupOf,
    setupNamed: (name) => setupNamed(name),
    saveChat,
    updateChat: (chat, change) => updateChat(chat, change),
    append,
    shownState,
    detailOf,
    spaceOf,
    viewOf,
    takesMcp,
    callExtensions,
    stopSession,
    forgetChat,
    removeWorkDir: (chat) => removeWorkDir(chat),
  })
  loadAll()

  migrateExtensionSettings({ extensions, settings, saveSettings, chats: () => chats.values(), saveChat, settingsErrors, extensionError })

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
      needs: neededBy,
      callExtension,
      contextOf,
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

  const copies = openFolderCopies<Chat>({ now })
  const {
    contextDefaults,
    contextItems,
    addContext,
    removeContext,
    setContext,
    setFolderMode,
    copyChanges,
    copyBack,
    broadcastContext,
    writeContext,
    setContextDefault,
    writeInstructions,
  } = openContext({
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
    copies,
  })


  const attachmentsDirOf = (chat: Chat) => join(chat.dir, 'attachments')

  // A space keeps the folder it got first, so changing the setting moves only new spaces.
  const workDirOf = (chat: Chat) => {
    const space = chainOf(chat)[0]!
    if (space.info.extension) return join(chosenWorkFolder(), 'home')
    if (!space.info.workDir) updateChat(space, { workDir: join(chosenWorkFolder(), space.info.id) })
    return space.info.workDir!
  }

  const { checkoutOf, gitAccess, removeWorkDir } = openCheckouts<Chat>({
    machine,
    saveWorktrees: (space, worktrees) => updateChat(space, { worktrees }),
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
    const folders = placeAccess(placesOf(contextItems(chat)), home, garage)
    const readOnly = [...access.flatMap((a) => a.readOnly), ...folders.readOnly]
    const jail = {
      ...sandbox,
      writable: [...sandbox.writable, ...access.flatMap((a) => a.writable), ...folders.writable],
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
    workers: (chatId: string) => {
      const chat = chats.get(chatId)
      return { enabled: !!chat && agentStartsWorkers(chat, workers, setupOf(chat)), limit: workers.limit() }
    },
    extensionTools: (chatId: string) =>
      extensions
        .filter((extension) => isOnFor(extension, chats.get(chatId)))
        .flatMap((extension) =>
          toolsOf(extension, chatFor(chatId)).map((tool) => ({
            tool: prompts.toolAsSent(extension, tool),
            values: extensionValues(extension),
            host: hostFor(extension),
            extension: extension.id,
          })),
        ),
  })

  // "What you can use" (core-prompts.ts): the tools the chat's session is offered over Kothar's MCP server, grouped by
  // Kothar's own and each extension's, with what each extension is for, after the nudge to combine them. Made from
  // extensions' names and descriptions, so a community extension is listed like a built-in one.
  const toolboxOf = (chat: Chat) => {
    const offered: { name: string; extension?: string }[] = mcp.toolsFor(chat.info.id)
    const own = offered.filter((tool) => !tool.extension).map((tool) => tool.name)
    const groups: ToolboxGroup[] = []
    const starts = own.includes('spawn_worker')
    if (starts) {
      groups.push({
        name: 'Workers',
        about: 'hand a whole task to a new chat below this one, which works while you talk and reports back.',
        tools: ['spawn_worker', ...(own.includes('stop_chat') ? ['stop_chat'] : [])],
      })
    }
    const reach = ['list_chats', 'read_chat', 'send_message', ...(starts ? [] : ['stop_chat'])].filter((name) => own.includes(name))
    if (reach.length) groups.push({ name: 'Chats', about: 'read and message the chats this one can reach.', tools: reach })
    for (const extension of extensions) {
      const tools = offered.filter((tool) => tool.extension === extension.id).map((tool) => tool.name)
      if (tools.length) groups.push({ name: extension.name, about: firstSentence(extension.description), tools })
    }
    return groups.length ? toolboxText(corePrompts.textOf('combine'), groups) : undefined
  }

  // What a turn's session was sent, labelled (sent.ts), for each extension that watches (onTurnSent). Built only when
  // one does, so a turn costs nothing extra otherwise.
  const turnSent = (chat: Chat, input: SentInput) => {
    const watchers = watchersOf('onTurnSent', chat)
    if (!watchers.length) return
    let sent: SentTurn
    try {
      sent = sentTurnOf(summaryOf(chat.info), now().toISOString(), randomUUID(), input, {
        extension: (id) => extensions.find((extension) => extension.id === id),
        promptsOf: prompts.infoOf,
        engineName: (engine) => adapterFor(engine)?.name ?? engine,
        memoryOf: () => memoryExtension(chat)?.id,
        toolsOf: (chatId) => mcp.toolsFor(chatId),
      })
    } catch (error) {
      console.error('Kothar could not label what a turn was sent:', error)
      return
    }
    for (const extension of watchers) callExtension(extension, () => extension.onTurnSent!(sent, contextOf(extension)))
  }

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
    setFolderMode,
    copyChanges,
    copyBack,
    writeContext,
    writeInstructions,
    setContextDefault,
    setEngineEnabled,
    setWorkFolder,
    setPermissionDefault,
    setTerminal,
    setMemory,
    workers,
    corePrompts,
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
    runMessageAction,
    renderDetail,
    renderNoteView,
    noteViewAction,
    flipToggle,
    answerWait,
    setExtensionEnabled,
    setExtensionValue,
    setPrompt: prompts.set,
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
    fileLinks,
    setEditor,
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
    workers: workers.info,
    corePrompts: corePrompts.info,
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
    // A picture in one of an extension's own folders, for the window to show (extension-files.ts); undefined if it may
    // not be served, or the extension is unknown or off.
    extensionFile(extensionId: string, path: string) {
      const extension = extensions.find((e) => e.id === extensionId)
      if (!extension || !isOn(extension)) return undefined
      const found = extensionPicture(path, {
        storage: extensionStorageDir(garage, extension.id),
        chatDirs: [...chats.values()].map((chat) => chat.dir),
        chatOwnFiles: CHAT_OWN_FILES,
      })
      return 'error' in found ? undefined : found
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
