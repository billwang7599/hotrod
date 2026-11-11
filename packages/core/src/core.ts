import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type {
  ChatDetail,
  Extension,
  ExtensionAction,
  ExtensionContext,
  ExtensionManifest,
  ExtensionInstructionsFor,
  ExtensionPanel,
  ExtensionView,
  ExtensionWait,
  ExtensionWaitAnswer,
  ExtensionRun,
  ExtensionUse,
  SpaceDetail,
} from '@kothar/extension-api'
import { openAccounts } from './accounts.ts'
import { openSetups } from './setups.ts'
import { CORE_TOOL_NAMES, openKotharMcp, WORKERS_EXTENSION, summaryOf } from './kothar-mcp.ts'
import { messagesOf, windowView } from './memory.ts'
import { type Fetch, installedExtensions, openMarketplace } from './marketplace.ts'
import { type Approval, approve, forget, logHistory, logInstall, readApprovals, reviewOf } from './approvals.ts'
import { type CommunityExtension, type ExtensionHook, panelTabOf, valuesOf } from './extensions.ts'
import {
  bySpaceOrder,
  editsAnywhere,
  GLOBAL_CONTEXT,
  looksBinary,
  PERMISSION_SWITCHES,
  settingProblem,
  type Adapter,
  type ChatEntry,
  type ChatInfo,
  type ChatState,
  type CommandInfo,
  type CompletionRequest,
  type ContextItem,
  type ContextSection,
  type CoreMessage,
  type EngineInfo,
  type EngineStatus,
  type Machine,
  type ModelRole,
  type InstalledItem,
  type MarketKind,
  type MemoryMessage,
  EXTENSION_USES,
  type ExtensionInfo,
  MODEL_ROLES,
  type NewChat,
  type PanelTab,
  type RestartChange,
  type RestartState,
  type Setup,
  type SetupState,
  type WorkFolder,
} from './shared.ts'
import { openModels } from './models.ts'
import { moveExtensionsDir } from './vocab-move.ts'
import { openProtocol } from './protocol.ts'
import type { Chat } from './chat.ts'
import { pageOf } from './history.ts'
import { reaches } from './reach.ts'
import { lockGarage } from './garage-lock.ts'
import { AUTOMATIC, MAC_TERMINALS, openTerminal } from './terminal.ts'
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
const WORKER_SETUP = "A worker uses its space's setup and can't have its own"
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
}) {
  const { adapters, defaultEngine, machine, stopGraceMs = STOP_GRACE_MS } = options
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
  const extensions = [...(options.extensions ?? []), WORKERS_EXTENSION]
  const extensionChats = extensions.flatMap((extension) => (extension.chats ?? []).map((chat) => ({ ...chat, extension })))
  const toolNames = [...CORE_TOOL_NAMES, ...extensions.flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name))]
  for (const [what, ids] of [
    ['extensions', extensions.map((extension) => extension.id)],
    ['extension chats', extensionChats.map((chat) => chat.id)],
    ['tools', toolNames],
  ] as const) {
    const twin = ids.find((id, i) => ids.indexOf(id) !== i)
    if (twin !== undefined) throw new Error(`Two ${what} have the id "${twin}"`)
  }
  // Community extensions come after the built-in ones. One that clashes with a built-in extension's id isn't listed;
  // one whose tool or chat is taken doesn't run. An extension that didn't load (off, or broken) is listed as a stub
  // with no hooks, so it can be turned on or off; it runs from the next start.
  const builtInIds = new Set(extensions.map((extension) => extension.id))
  const community = new Map<
    string,
    { manifest: ExtensionManifest; item: InstalledItem; running?: string; loadError?: string; held?: string }
  >()
  // The community extensions this run imported (whether or not they loaded), by id with their name, and those installed
  // again since; what's pending a restart is worked out from these and the settings.
  const imported = new Map<string, string>()
  const reinstalled = new Set<string>()
  const stubOf = ({ id, name, description }: ExtensionManifest): Extension => ({ id, name, description, enabledByDefault: false })
  for (const found of options.community ?? []) {
    const { manifest, item } = found
    if (builtInIds.has(manifest.id) || community.has(manifest.id)) {
      console.error(`Skipped the community extension "${manifest.id}": an extension already has that id`)
      continue
    }
    let { extension, loadError } = found
    if (extension || loadError) imported.set(manifest.id, manifest.name)
    const clash =
      extension &&
      ((extension.tools ?? []).map((tool) => tool.name).find((name) => toolNames.includes(name)) ??
        (extension.chats ?? []).map((chat) => chat.id).find((id) => extensionChats.some((chat) => chat.id === id)))
    if (clash) {
      loadError = `its tool or chat "${clash}" is already taken`
      extension = undefined
    }
    community.set(manifest.id, {
      manifest,
      item,
      ...(extension && { running: manifest.version }),
      ...(loadError && { loadError }),
      ...(found.held && { held: found.held }),
    })
    if (!extension) {
      extensions.push(stubOf(manifest))
      continue
    }
    extensions.push(extension)
    extensionChats.push(...(extension.chats ?? []).map((chat) => ({ ...chat, extension: extension! })))
    toolNames.push(...(extension.tools ?? []).map((tool) => tool.name))
  }
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
  let approvals: Record<string, Approval> = readApprovals(garage) ?? {}
  const heldOn = [...community].filter(([id, c]) => c.held && settings.extensions?.[id]?.enabled === true)
  for (const [id] of heldOn) settings.extensions = { ...settings.extensions, [id]: { ...settings.extensions?.[id], enabled: false } }
  if (heldOn.length) saveSettings()
  const contextDefaults = (): Record<ContextSection, boolean> => ({
    agents: settings.context?.agents ?? true,
    folders: settings.context?.folders ?? true,
    files: settings.context?.files ?? true,
  })
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
  const setups = new Map<string, Omit<SetupState, 'description'>>()
  const installs = new Map<string, AbortController>()
  const extensionInfo = (extension: Extension): ExtensionInfo => {
    const { id, name, description, settings: declared = [] } = extension
    const values = extensionValues(extension)
    const about = extension.setup?.description
    const setup = extension.setup && {
      description: typeof about === 'function' ? about(values) : about!,
      ...(setups.get(id) ?? { status: 'checking' }),
    }
    // A community extension shows its own switch; the master switch is beside it in the UI.
    const enabled = community.has(id) ? ownSwitch(extension) : isOn(extension)
    const settingsError = settingsErrors.get(id)
    const view = settingsViewOf(extension)
    const info = {
      id,
      name,
      description,
      enabled,
      settings: declared,
      values,
      ...(view && { settingsView: view }),
      ...(settingsError && { loadError: settingsError }),
      ...(extension.chats?.length && { ownsChat: true }),
    }
    const from = community.get(id)
    const { version, author, uses } = from?.manifest ?? {}
    const { source, repo, path, tag } = from?.item ?? {}
    const approval = approvals[id]
    const communityFields = from && {
      community: {
        version: version!,
        author: author!,
        uses: uses!,
        source: source === 'local' ? ('local' as const) : ('marketplace' as const),
        ...(repo && { repo }),
        ...(tag && { tag }),
        ...(path && { path }),
        ...(from.running && { running: from.running }),
        ...(approval && {
          approved: { version: approval.version, uses: approval.uses, ...(approval.tag && { tag: approval.tag }) },
        }),
        ...(from.held && { held: from.held }),
      },
      ...(from.loadError && { loadError: from.loadError }),
    }
    return { ...info, ...(setup && { setup }), ...communityFields }
  }
  // An extension's settings view, drawn now: a built-in extension's even while it's off, a community one's only while
  // it runs.
  const settingsViewOf = (extension: Extension): ExtensionInfo['settingsView'] => {
    if (!extension.settingsView || (community.has(extension.id) && !isOn(extension))) return undefined
    try {
      const view = extension.settingsView.render(contextOf(extension))
      if (view instanceof Promise) throw new Error('A settings view renders synchronously')
      return { view }
    } catch (error) {
      return { error: messageOf(error) }
    }
  }
  const settingsViewChanged = (extension: Extension) => {
    if (extension.settingsView) broadcast({ type: 'extension.updated', extension: extensionInfo(extension) })
  }
  const settingsViewAction = async (extension: Extension, action: ExtensionAction) => {
    if (!extension.settingsView || (community.has(extension.id) && !isOn(extension))) {
      throw new Error(`${extension.name} has no settings view`)
    }
    if (typeof action?.name !== 'string') throw new Error('A settings action needs a name')
    try {
      await extension.settingsView.onAction?.(action, contextOf(extension))
    } catch (error) {
      extensionError(extension, error)
    }
    settingsViewChanged(extension)
  }
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
  const defaultWorkFolder = join(garage, 'work')
  const workFolder = (): WorkFolder => ({
    ...(settings.workFolder && { path: settings.workFolder }),
    defaultPath: defaultWorkFolder,
    canSandbox: machine.canSandbox,
    ...(settings.terminal && settings.terminal !== AUTOMATIC && { terminal: settings.terminal }),
    ...(process.platform === 'darwin' && { terminals: MAC_TERMINALS.map(({ id, name }) => ({ id, name })) }),
    ...Object.fromEntries(
      PERMISSION_SWITCHES.flatMap((name) => (settings[name] === undefined ? [] : [[name, settings[name]]])),
    ),
  })
  const sandboxIn = (dir: string) => (machine.canSandbox ? { writable: [dir], tmpDir: join(dir, '.tmp') } : undefined)
  const chats = new Map<string, Chat>()
  let quitting = false
  let mcpUrl: string | undefined
  const setEngineEnabled = (engine: string, enabled: boolean) => {
    checkEngine(engine)
    settings.engines = { ...settings.engines, [engine]: enabled }
    saveSettings()
    broadcast({ type: 'engine.updated', engine: engineInfo(engine) })
    models.settle()
    followModels()
  }
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
  const saveExtension = (extension: Extension, change: Record<string, unknown>) => {
    settings.extensions = { ...settings.extensions, [extension.id]: { ...settings.extensions?.[extension.id], ...change } }
    saveSettings()
    broadcast({ type: 'extension.updated', extension: extensionInfo(extension) })
  }
  const setSetup = (extension: Extension, state: Omit<SetupState, 'description'>) => {
    setups.set(extension.id, state)
    broadcast({ type: 'extension.updated', extension: extensionInfo(extension) })
  }
  const runFor =
    (signal?: AbortSignal): ExtensionRun =>
    (command, args, options) =>
      // A setup that runs several commands stops at its next one once cancelled.
      signal?.aborted
        ? Promise.reject(new Error('Cancelled'))
        : machine.run(command, args, { cwd: '/', ...options, ...(signal && { signal }) })
  const checkSetup = async (extension: Extension, installError?: string) => {
    if (!extension.setup || installs.has(extension.id)) return
    const { message } = setups.get(extension.id) ?? {}
    setSetup(extension, { status: 'checking', ...(message && { message }) })
    let checked: Omit<SetupState, 'description'>
    try {
      const result = await extension.setup.check(runFor(), extensionValues(extension))
      checked = { status: result.ready ? 'ready' : 'missing', ...(result.message && { message: result.message }) }
    } catch (error) {
      checked = { status: 'missing', error: messageOf(error) }
    }
    if (checked.status === 'missing' && installError) checked.error = installError
    if (!installs.has(extension.id)) setSetup(extension, checked)
  }
  const install = (extension: Extension) => {
    if (!extension.setup) throw new Error(`${extension.name} has nothing to install`)
    if (installs.has(extension.id)) throw new Error(`${extension.name} is already installing`)
    if (setups.get(extension.id)?.status === 'ready') throw new Error(`${extension.name} is already installed`)
    const controller = new AbortController()
    installs.set(extension.id, controller)
    const { message } = setups.get(extension.id) ?? {}
    setSetup(extension, { status: 'installing', ...(message && { message }) })
    const report = ({ text, progress }: { text?: string; progress?: number }) => {
      if (installs.get(extension.id) !== controller) return
      const update = { ...(text && { progressText: text }), ...(progress !== undefined && { progress }) }
      setSetup(extension, { ...setups.get(extension.id)!, ...update })
    }
    void extension.setup.install(runFor(controller.signal), report, extensionValues(extension)).then(
      () => {
        installs.delete(extension.id)
        return checkSetup(extension)
      },
      (error) => {
        installs.delete(extension.id)
        return checkSetup(extension, controller.signal.aborted ? undefined : messageOf(error))
      },
    )
  }
  const setExtensionValue = (extension: Extension, key: string, value: unknown) => {
    const setting = extension.settings?.find((s) => s.key === key)
    if (!setting) throw new Error(`${extension.name} has no setting "${key}"`)
    const problem = settingProblem(setting, value)
    if (problem) throw new Error(`${setting.label} ${problem}`)
    const previous = extensionValues(extension)[key]
    saveExtension(extension, { [key]: value })
    if (isOn(extension)) void checkSetup(extension)
    // An extension with background work hears of it only once that work has started; onStart reads the values itself.
    const running = isOn(extension) && (!extension.onStart || startedExtensions.has(extension.id))
    if (running && previous !== value && extension.onSettingsChanged) {
      callExtension(extension, () => extension.onSettingsChanged!({ key, value, previous }, contextOf(extension)))
      settingsViewChanged(extension)
    }
  }
  // A space's own values for an extension's spaceSettings: the space a worker is in, else the chat itself.
  const spaceChat = (chat: Chat) => chainOf(chat)[0]!
  const spaceValuesOf = (extension: Extension, chat: Chat) =>
    valuesOf(extension, spaceChat(chat).info.extensionValues?.[extension.id], extension.spaceSettings)
  const setSpaceValue = (extension: Extension, chat: Chat, key: string, value: unknown) => {
    const setting = extension.spaceSettings?.find((s) => s.key === key)
    if (!setting) throw new Error(`${extension.name} has no space setting "${key}"`)
    const problem = settingProblem(setting, value)
    if (problem) throw new Error(`${setting.label} ${problem}`)
    const space = spaceChat(chat)
    const extensionValues = { ...space.info.extensionValues, [extension.id]: { ...space.info.extensionValues?.[extension.id], [key]: value } }
    updateChat(space, { extensionValues })
    refreshExtension(extension)
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
      throw new Error(`${path} can't be the work folder: pick a folder of its own, outside Kothar's`)
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
    startExtensions()
  }
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
      .filter((extension) => isOnFor(extension, chat) && (!extension.setup || setups.get(extension.id)?.status === 'ready'))
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
    (options.openTerminal ?? ((dir, choice) => openTerminal(dir, { choice })))(path, settings.terminal)
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
  type Offered = { shown?(chat: ChatDetail, context: ExtensionContext): boolean }
  const offeredBy = (extension: Extension, item: Offered, chat: Chat) => {
    if (!item.shown) return true
    try {
      return item.shown(detailOf(chat), contextOf(extension)) === true
    } catch (error) {
      extensionError(extension, error)
      return false
    }
  }
  // Only the extensions on for this chat (isOnFor): one its setup leaves out shows no panels or commands there.
  const extensionsOf = (chat: Chat): Extract<CoreMessage, { type: 'chat.extensions' }> => {
    const on = extensions.filter((extension) => isOnFor(extension, chat))
    const panels = on.flatMap((extension) =>
      (extension.panels ?? []).flatMap((p): PanelTab[] =>
        offeredBy(extension, p, chat) ? [panelTabOf(extension.id, p)] : [],
      ),
    )
    const commands = on.flatMap((extension) =>
      (extension.commands ?? []).flatMap((c): CommandInfo[] =>
        offeredBy(extension, c, chat) ? [{ extension: extension.id, id: c.id, label: c.label, ...(c.hint && { hint: c.hint }) }] : [],
      ),
    )
    return { type: 'chat.extensions', chatId: chat.info.id, panels, commands }
  }
  const openPanels = new Map<string, Set<string>>()
  const renders = new Map<string, number>()
  const panelOf = (chat: Chat, extensionId: unknown, panelId: unknown) => {
    const extension = extensionFor(String(extensionId))
    if (!isOn(extension)) throw new Error(`${extension.name} is off`)
    if (!isOnFor(extension, chat)) throw new Error(`${extension.name} is left out of this chat by its setup`)
    const panel = extension.panels?.find((p) => p.id === panelId)
    if (!panel) throw new Error(`${extension.name} has no panel "${panelId}"`)
    return { extension, panel }
  }
  // Fills in a panel's switches and pickers from the space's values and the settings they're for.
  const withControls = (extension: Extension, chat: Chat, view: ExtensionView): ExtensionView => {
    if (view.type === 'stack' || view.type === 'row' || view.type === 'card') {
      return { ...view, children: view.children.map((child) => withControls(extension, chat, child)) }
    }
    if (view.type === 'split') {
      return { ...view, side: withControls(extension, chat, view.side), main: withControls(extension, chat, view.main) }
    }
    if (view.type !== 'switch' && view.type !== 'picker') return view
    const setting = extension.spaceSettings?.find((s) => s.key === view.setting)
    const kind = view.type === 'switch' ? 'boolean' : 'select'
    if (setting?.type !== kind) throw new Error(`${extension.name} has no ${kind} space setting "${view.setting}"`)
    const value = spaceValuesOf(extension, chat)[setting.key]!
    const label = view.label ?? setting.label
    if (view.type === 'switch') return { ...view, label, value: value === true }
    const options = setting.type === 'select' ? setting.options : []
    return { ...view, label, value: value as string | number, options }
  }
  const renderPanel = async (chat: Chat, extension: Extension, panel: ExtensionPanel) => {
    const key = `${chat.info.id}\n${extension.id}\n${panel.id}`
    const turn = (renders.get(key) ?? 0) + 1
    renders.set(key, turn)
    const base = { type: 'extension.panel' as const, chatId: chat.info.id, extension: extension.id, panel: panel.id }
    let shownView: Extract<CoreMessage, { type: 'extension.panel' }>
    try {
      shownView = { ...base, view: withControls(extension, chat, await panel.render(detailOf(chat), contextOf(extension))) }
    } catch (error) {
      shownView = { ...base, error: messageOf(error) }
    }
    // An older render that finishes late doesn't replace a newer one.
    if (renders.get(key) === turn && chats.has(chat.info.id)) broadcast(shownView)
  }
  const openPanel = (chat: Chat, extensionId: unknown, panelId: unknown) => {
    const { extension, panel } = panelOf(chat, extensionId, panelId)
    const open = openPanels.get(chat.info.id) ?? new Set()
    open.add(`${extension.id}\n${panel.id}`)
    openPanels.set(chat.info.id, open)
    void renderPanel(chat, extension, panel)
  }
  const refreshExtension = (extension: Extension, chatId?: string) => {
    if (chatId === undefined) settingsViewChanged(extension)
    if (!isOn(extension)) return
    const targets = chatId === undefined ? shownChats() : [chatFor(chatId)]
    for (const chat of targets) {
      broadcast(extensionsOf(chat))
      if (!isOnFor(extension, chat)) continue
      for (const panel of extension.panels ?? []) {
        if (openPanels.get(chat.info.id)?.has(`${extension.id}\n${panel.id}`)) void renderPanel(chat, extension, panel)
      }
    }
  }
  const panelAction = async (chat: Chat, extensionId: unknown, panelId: unknown, action: ExtensionAction) => {
    const { extension, panel } = panelOf(chat, extensionId, panelId)
    if (typeof action?.name !== 'string') throw new Error('A panel action needs a name')
    try {
      await panel.onAction?.(action, detailOf(chat), contextOf(extension))
    } catch (error) {
      extensionError(extension, error)
    }
    if (chats.has(chat.info.id)) await renderPanel(chat, extension, panel)
  }
  const answerWait = (chat: Chat, extensionId: string, answer: ExtensionWaitAnswer) => {
    const wait = chat.waits.get(extensionId)
    if (!wait) throw new Error('Nothing is waiting there any more')
    if ('button' in answer && !wait.buttons.some((b) => b.id === answer.button)) {
      throw new Error(`No button "${answer.button}"`)
    }
    const extension = extensionFor(extensionId)
    callExtension(extension, () => extension.onWaitAction?.(detailOf(chat), answer, contextOf(extension)))
  }
  const checkWait = (wait: ExtensionWait): ExtensionWait => {
    if (typeof wait?.text !== 'string' || !Array.isArray(wait.buttons)) throw new Error('A wait needs text and buttons')
    for (const b of wait.buttons) {
      if (typeof b?.id !== 'string' || typeof b.label !== 'string') throw new Error('Each button needs an id and a label')
    }
    return { text: wait.text, buttons: wait.buttons.map(({ id, label, primary, hint }) => ({ id, label, ...(primary && { primary }), ...(hint && { hint }) })) }
  }
  const runCommand = (chat: Chat, extensionId: unknown, commandId: unknown) => {
    const extension = extensionFor(String(extensionId))
    if (!isOn(extension)) throw new Error(`${extension.name} is off`)
    if (!isOnFor(extension, chat)) throw new Error(`${extension.name} is left out of this chat by its setup`)
    const command = extension.commands?.find((c) => c.id === commandId)
    if (!command || !offeredBy(extension, command, chat)) throw new Error(`${extension.name} has no command "${commandId}" here`)
    callExtension(extension, () => command.run(detailOf(chat), contextOf(extension)))
  }

  const removeChats = (family: Chat[]) => {
    for (const c of family) {
      stopSession(c)
      const detail = detailOf(c)
      chats.delete(c.info.id)
      openPanels.delete(c.info.id)
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
      append(chat, { at: new Date().toISOString(), type: 'turn.completed', error: 'Kothar quit during this turn' })
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
    createdAt: new Date().toISOString(),
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
    const folders = [...new Set((spec.folders ?? []).map((path) => checkPath(path, 'folders')))]
    const files = [...new Set((spec.files ?? []).map((path) => checkPath(path, 'files')))]
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
      createdAt: new Date().toISOString(),
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

  // A setup by id or name, for a spawn or a picker.
  const setupNamed = (name: unknown) => {
    const setup = typeof name === 'string' ? jobSetups.find(name) : undefined
    if (setup) return setup
    const names = jobSetups.list().map((s) => `"${s.name}"`)
    throw new Error(`Unknown setup "${name}". ${names.length ? `The setups are ${names.join(', ')}.` : 'There are no setups.'}`)
  }

  // The setup a chat uses from its next message, or none.
  const setChatSetup = (chat: Chat, name: unknown) => {
    if (chat.info.worker) throw new Error(WORKER_SETUP)
    const setup = name === undefined || name === '' ? undefined : setupNamed(name)
    updateChat(chat, { setup: setup?.id })
    followModels()
    familyOf(chat).forEach((c) => broadcast(extensionsOf(c)))
  }

  const saveSetup = (input: unknown) => {
    const setup = jobSetups.save(input)
    followModels()
    setupChanged(setup.id)
    return setup
  }

  // Chats that used a removed setup go back to Settings.
  const removeSetup = (id: unknown) => {
    jobSetups.remove(id)
    const using = [...chats.values()].filter((chat) => chat.info.setup === id)
    for (const chat of using) updateChat(chat, { setup: undefined })
    followModels()
    using.flatMap(familyOf).forEach((chat) => broadcast(extensionsOf(chat)))
  }

  // A setup's extensions changed: the chats using it get their panels and commands again.
  const setupChanged = (id: string) => {
    for (const chat of chats.values()) if (setupOf(chat)?.id === id) broadcast(extensionsOf(chat))
  }

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

  const setExtensionEnabled = (extension: Extension, enabled: boolean) => {
    if (community.has(extension.id) && !communityOn() && enabled) {
      throw new Error(`Turn on community extensions before turning on ${extension.name}`)
    }
    const family = (extension.chats ?? []).flatMap(({ id }) => {
      const chat = chats.get(id)
      return chat ? familyOf(chat) : []
    })
    const busy = family.find((chat) => chat.status !== 'idle')
    if (busy && !enabled) throw new Error(`Stop "${busy.info.name}" before turning ${extension.name} off`)
    const changed = isOn(extension) !== enabled
    const from = community.get(extension.id)
    if (from && enabled) {
      // Turning it on approves these exact files; the loader runs nothing else.
      const install = installedExtensions(garage).find((m) => m.manifest.id === extension.id)
      if (install) approvals = { ...approvals, [extension.id]: approve(garage, install) }
      delete from.held
    }
    saveExtension(extension, { enabled })
    if (from) restartChanged()
    if (enabled) void checkSetup(extension)
    if (changed) extensionSwitched(extension, enabled, family)
  }

  // What follows an extension starting or stopping to run: its chats show or hide, spawned processes stop, panels
  // update.
  const extensionSwitched = (extension: Extension, enabled: boolean, family = familyOfExtension(extension)) => {
    if (!enabled) stopSpawned(extension)
    if (!enabled) chats.forEach((chat) => setWait(chat, extension.id, undefined))
    if (enabled) startExtension(extension)
    else stopExtension(extension)
    if (enabled) family.toReversed().forEach((chat) => broadcast({ type: 'chat.added', chat: shownState(chat) }))
    else family.forEach((chat) => broadcast({ type: 'chat.removed', chatId: chat.info.id }))
    if (extension.panels?.length || extension.commands?.length) shownChats().forEach((chat) => broadcast(extensionsOf(chat)))
  }
  const familyOfExtension = (extension: Extension) =>
    (extension.chats ?? []).flatMap(({ id }) => {
      const chat = chats.get(id)
      return chat ? familyOf(chat) : []
    })

  // The master switch. Off stops every community extension's hooks at once (its code stays loaded until a restart); on
  // lets the ones whose own switch is on run, from the next start for any not loaded yet.
  const setCommunityExtensions = (enabled: boolean) => {
    if (communityOn() === enabled) return
    const running = extensions.filter((extension) => community.has(extension.id) && ownSwitch(extension))
    if (!enabled) {
      const busy = running.flatMap((extension) => familyOfExtension(extension)).find((chat) => chat.status !== 'idle')
      if (busy) throw new Error(`Stop "${busy.info.name}" before turning community extensions off`)
    }
    settings.communityExtensions = enabled
    saveSettings()
    broadcast({ type: 'communityExtensions.updated', enabled })
    for (const extension of running) {
      if (enabled) void checkSetup(extension)
      extensionSwitched(extension, enabled)
    }
    restartChanged()
  }

  // Community extension code this run doesn't match the settings: what a restart would start, update or stop.
  const restartState = (): RestartState => {
    const changes: RestartChange[] = []
    for (const [id, { manifest }] of community) {
      const extension = extensions.find((m) => m.id === id)
      const wanted = !!extension && isOn(extension)
      const loaded = imported.has(id)
      const change = wanted ? (!loaded ? 'start' : reinstalled.has(id) ? 'update' : undefined) : loaded ? 'stop' : undefined
      if (change) changes.push({ id, name: manifest.name, change })
    }
    for (const [id, name] of imported) if (!community.has(id)) changes.push({ id, name, change: 'stop' })
    return { changes, canRestart: options.restart !== undefined }
  }
  let lastRestart = JSON.stringify(restartState())
  const restartChanged = () => {
    const restart = restartState()
    const text = JSON.stringify(restart)
    if (text === lastRestart) return
    lastRestart = text
    broadcast({ type: 'restart.updated', restart })
  }

  // A community extension was installed or updated. It runs from the next start, and only as the files the user turned
  // on: an update (any change to its files) turns it off until they review it and turn it on again.
  const communityChanged = (id: string, added: ExtensionUse[]) => {
    const install = installedExtensions(garage).find((m) => m.manifest.id === id)
    if (!install) return
    const known = community.get(id)
    logInstall(garage, install, !!known)
    community.set(id, { ...known, manifest: install.manifest, item: install.item })
    if (imported.has(id)) reinstalled.add(id)
    const at = extensions.findIndex((m) => m.id === id)
    if (at < 0) extensions.push(stubOf(install.manifest))
    else if (!known?.running) extensions[at] = stubOf(install.manifest)
    const extension = extensions.find((m) => m.id === id)!
    if (ownSwitch(extension) && reviewOf(approvals[id], install)) {
      setExtensionEnabled(extension, false)
      const more = added.map((use) => EXTENSION_USES[use].toLowerCase()).join('; ')
      broadcast({
        type: 'error',
        message: added.length
          ? `${extension.name} was turned off: its update also ${more}. Turn it on again in Community hub to allow that.`
          : `${extension.name} was turned off: ${install.manifest.version} isn't the version you turned on. ` +
            'Read the changes, then turn it on again in Community hub.',
      })
    }
    broadcast({ type: 'extension.updated', extension: extensionInfo(extension) })
    restartChanged()
  }

  // Turns the extension off and deletes its files. Its storage in <garage>/extensions/<id>/ stays, as a built-in
  // extension's does.
  const uninstallExtension = (id: string) => {
    const extension = extensions.find((m) => m.id === id)
    if (!community.has(id) || !extension) return marketplace.uninstall('extension', id)
    if (ownSwitch(extension)) setExtensionEnabled(extension, false)
    const version = community.get(id)?.manifest.version
    marketplace.uninstall('extension', id)
    forget(garage, id)
    const { [id]: _gone, ...rest } = approvals
    approvals = rest
    logHistory(garage, { id, event: 'uninstalled', ...(version && { version }) })
    const { enabled: _, ...kept } = settings.extensions?.[id] ?? {}
    settings.extensions = { ...settings.extensions, [id]: kept }
    saveSettings()
    community.delete(id)
    forgetHost(id)
    extensions.splice(extensions.indexOf(extension), 1)
    broadcast({ type: 'extension.removed', extensionId: id })
    restartChanged()
  }

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

  const globalAgentsFile = join(garage, 'AGENTS.md')

  const switchOf = (chat: Chat, item: Pick<ContextItem, 'section' | 'path' | 'from'>): boolean => {
    const pinned = chat.context[item.path]
    if (pinned !== undefined) return pinned
    if (item.from === chat.info.id) return true
    const parent = parentOf(chat)
    return chat.info.worker && parent ? switchOf(parent, item) : contextDefaults()[item.section]
  }

  const contextItems = (chat: Chat): ContextItem[] => {
    const owned = chainOf(chat).flatMap(({ info, dir }) =>
      info.extension
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
    familyOf(chat).forEach((c) => {
      broadcast({ type: 'chat.context', chatId: c.info.id, items: contextItems(c) })
      broadcast(extensionsOf(c))
    })

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
    if (chat.info.extension) throw new Error(`${chat.info.name} keeps no folders, files or AGENTS.md of its own`)
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
    settings,
    saveSettings,
    broadcast,
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
    writeInstructions: (text) => writeAgentsFile(globalAgentsFile, text),
    setContextDefault,
    setEngineEnabled,
    setWorkFolder,
    workFolder,
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
    cancelInstall: (extension) => installs.get(extension.id)?.abort(),
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

const checkPath = (rawPath: unknown, section: 'folders' | 'files') => {
  const path = String(rawPath).trim().replace(/^~(?=$|\/)/, homedir())
  if (!isAbsolute(path)) throw new Error(`The path must be absolute: ${rawPath}`)
  const stat = existsSync(path) ? statSync(path) : undefined
  if (section === 'folders' ? !stat?.isDirectory() : !stat?.isFile()) {
    throw new Error(`Not a ${section === 'folders' ? 'folder' : 'file'}: ${rawPath}`)
  }
  return realpathSync(path)
}
