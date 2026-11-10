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
  PermissionRequest,
  PermissionVerdict,
  SpaceDetail,
  TurnSummary,
} from '@kothar/extension-api'
import { openAccounts } from './accounts.ts'
import { openSetups } from './setups.ts'
import { CORE_TOOL_NAMES, openKotharMcp, WORKERS_EXTENSION, summaryOf } from './kothar-mcp.ts'
import { continuationPrompt, messagesOf, seededPrompt, windowView, withAttachments, type Report } from './memory.ts'
import { type Fetch, installedExtensions, openMarketplace } from './marketplace.ts'
import { type Approval, approve, forget, logHistory, logInstall, readApprovals, reviewOf } from './approvals.ts'
import { type CommunityExtension, valuesOf } from './extensions.ts'
import {
  bySpaceOrder,
  CONTEXT_SECTIONS,
  editsAnywhere,
  GLOBAL_CONTEXT,
  IMAGE_TYPES,
  looksBinary,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  PERMISSION_SWITCHES,
  isUnread,
  settingProblem,
  type Adapter,
  type Answers,
  type Attachment,
  type ChatEntry,
  type ChatInfo,
  type ChatState,
  type ChatWait,
  type ChatStatus,
  type ClientMessage,
  type CommandInfo,
  type CompletionRequest,
  type ContextItem,
  type ContextSection,
  type CoreMessage,
  type EngineEvent,
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
  type PermissionSwitch,
  type PermissionSwitches,
  type QueuedMessage,
  type RestartChange,
  type RestartState,
  type Session,
  type Setup,
  type SetupState,
  type Upload,
  type WorkFolder,
} from './shared.ts'
import { openModels, type ModelSettings } from './models.ts'
import { moveExtensionsDir, renameChatFile, renameEntry, renameSettings } from './vocab-move.ts'
import { searchChats } from './search.ts'
import { pageOf } from './history.ts'
import { reaches } from './reach.ts'
import { lockGarage } from './garage-lock.ts'
import { AUTOMATIC, MAC_TERMINALS, openTerminal } from './terminal.ts'
import { verdictOf } from './permissions.ts'
import { buildInstructions } from './instructions.ts'
import { type Checkout, openCheckouts } from './checkouts.ts'
import { openExtensionHosts } from './extension-host.ts'

// Kept here too, for code that imports them from the core.
export { CHECKOUT_RULES, WRITE_RULES } from './instructions.ts'

export const STOP_GRACE_MS = 60_000
const PARENT_VIEW_FILE = 'parent-view.md'
// A chat's own files, which extensions' chat storage can't touch.
const CHAT_OWN_FILES = ['chat.json', 'log.jsonl', 'AGENTS.md', PARENT_VIEW_FILE, 'attachments']
const WORKER_SETUP = "A worker uses its space's setup and can't have its own"
const REVEAL_TIMEOUT_MS = 10_000
// Where the Machine can't sandbox (Linux, Windows for now), a chat runs only once the user allows edits anywhere.
const UNSANDBOXED_NEEDS_EDIT_ANYWHERE = true

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
  // What extensions wait on the user for while the turn runs (ExtensionHost.wait), by extension id.
  waits: Map<string, ExtensionWait>
  // The turn has ended and extensions hear of it (onSessionEnded, onTurnCompleted): a wait now holds the chat.
  ending?: boolean
  // An extension's wait holds the chat after its turn ended: it shows waiting, a worker hasn't reported and queued
  // messages wait, until the wait ends. error is the turn's, for the report.
  held?: { error?: string }
  mcpToken?: string
  queue: QueuedMessage[]
  turns: number
  // The account and model the running turn started on, and the limit it ran into, if any.
  account?: string
  runModel?: string
  limit?: { message: string; resetsAt?: string }
  // The engine wrote, thought or called a tool since the chat's last message; a continuation doesn't reset it.
  produced?: boolean
  // What the running turn has done so far, for onTurnCompleted.
  turn?: { text: string; tools: TurnSummary['tools'] }
  // The run the UI last got for this chat (JSON), so a change in Settings or an engine resends only the chats it moves.
  shownRun?: string
}

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
  const settingsFile = join(garage, 'settings.json')
  const settings: PermissionSwitches &
    ModelSettings & {
      context?: Partial<Record<ContextSection, boolean>>
      extensions?: Record<string, Record<string, unknown>>
      // The version of each extension's saved settings (Extension.settingsVersion), once one has been migrated.
      extensionVersions?: Record<string, number>
      workFolder?: string
      // The master switch for community extensions; off unless the user turned it on.
      communityExtensions?: boolean
      // The terminal Open in Terminal uses: 'auto' or absent for the system's, else one of MAC_TERMINALS by id.
      terminal?: string
    } = { engines: {}, ...readJson(settingsFile) }
  const saveSettings = () => writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n')
  if (renameSettings(settings)) saveSettings()
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
  const allStoppedWaiters: (() => void)[] = []
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
  const saveChat = ({ info, dir, context }: Chat) => {
    const file = { ...info, ...(Object.keys(context).length ? { context } : {}) }
    writeFileSync(join(dir, 'chat.json'), JSON.stringify(file, null, 2) + '\n')
  }
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

  const waitsOf = (chat: Chat): ChatWait[] => [...chat.waits].map(([extension, wait]) => ({ extension, ...wait }))
  // An extension's wait, or none: the chat waits while any extension or request does, and runs again once none does.
  const setWait = (chat: Chat, extensionId: string, wait: ExtensionWait | undefined) => {
    if (!wait && !chat.waits.has(extensionId)) return
    if (wait) chat.waits.set(extensionId, wait)
    else chat.waits.delete(extensionId)
    broadcast({ type: 'chat.waits', chatId: chat.info.id, waits: waitsOf(chat) })
    if (wait && chat.ending && !chat.held) {
      chat.held = {}
      setStatus(chat, 'waiting')
    }
    if (wait && chat.status === 'running') setStatus(chat, 'waiting')
    if (!wait && chat.held && !chat.waits.size) return release(chat, true)
    if (!wait && chat.status === 'waiting' && !chat.pendingRequests.size && !chat.waits.size) setStatus(chat, 'running')
  }

  // A chat held after its turn goes idle. finish: it ends as the turn would have (a worker reports and goes, queued
  // messages run); otherwise an extension carries the turn on (continue, retry) and that turn ends it.
  const release = (chat: Chat, finish: boolean) => {
    const held = chat.held
    if (!held) return
    chat.held = undefined
    setStatus(chat, 'idle')
    if (finish && !quitting) finishTurn(chat, held.error)
  }

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

  const setStatus = (chat: Chat, status: ChatStatus) => {
    if (chat.status === status || (chat.status === 'stopping' && status !== 'idle')) return
    chat.status = status
    if (status === 'idle' && chat.waits.size) {
      chat.waits.clear()
      broadcast({ type: 'chat.waits', chatId: chat.info.id, waits: [] })
    }
    broadcast({ type: 'chat.status', chatId: chat.info.id, status })
    callExtensions('onStatusChanged', (extension, context) => extension.onStatusChanged!(detailOf(chat), status, context))
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
    const { limit, account, runModel } = chat
    chat.limit = undefined
    // A turn the core stopped for its limit shows the limit, not "Interrupted".
    const end = limit && ended.error ? { ...ended, error: limit.message } : ended
    if (chat.unsavedText) completeText(chat, end.at, chat.unsavedText)
    chat.unsavedText = ''
    append(chat, end)
    stopSession(chat)
    unsteer(chat)
    chat.pendingRequests.clear()
    setStatus(chat, 'idle')
    // Only spaces and Home show unread; a worker is removed once it reports, so it keeps no read state.
    if (!chat.info.worker) updateChat(chat, { doneAt: end.at })
    if (allStopped()) allStoppedWaiters.splice(0).forEach((resolve) => resolve())
    if (quitting) return
    const turn = chat.turn ?? { text: '', tools: [] }
    chat.turn = undefined
    const detail = detailOf(chat)
    const files = [...new Set(turn.tools.flatMap((t) => (t.kind === 'edit' && t.path ? [t.path] : [])))]
    const summary = { chat: detail, ...(end.error && { error: end.error }), ...turn, files }
    const sessionError = end.type === 'session.ended' ? end.error : undefined
    chat.ending = true
    try {
      callExtensions('onSessionEnded', (extension, context) =>
        extension.onSessionEnded!({ chat: detail, ...(sessionError && { error: sessionError }) }, context),
      )
      callExtensions('onTurnCompleted', (extension, context) => extension.onTurnCompleted!(summary, context))
    } finally {
      chat.ending = false
    }
    if (chat.held) chat.held.error = end.error
    if (limit) reportLimit(chat, account, runModel, limit)
    // An extension sent the message again, so the turn goes on, or holds the chat until it does or lets go.
    if (chat.status !== 'idle') return
    finishTurn(chat, end.error)
  }

  // What follows a turn that's over: a worker reports and goes, queued messages run.
  const finishTurn = (chat: Chat, error?: string) => {
    const parent = chat.info.worker ? parentOf(chat) : undefined
    if (parent) reportErrors(() => enqueue(parent, reportOf(chat, error)))
    if (chat.queue.length) reportErrors(() => sendQueue(chat))
    // Workers are there for one task: once the lead has their reply, they go. The reply lives on in the lead's log.
    if (chat.info.worker && chat.status === 'idle') removeChats(familyOf(chat))
    sweepMergedWorktrees(chainOf(chat)[0]!)
  }

  // A write for an engine event failed. If the chat's folder is gone, its session stops and it goes idle; either way
  // the user sees why, and the core runs on. A worker with no folder can do nothing more, so it leaves the way a
  // finished one does, with its lead told why. A space or Home stays listed, idle, so the user decides what to do.
  const lostChat = (chat: Chat, error: unknown) => {
    const gone = !existsSync(chat.dir)
    broadcast({
      type: 'error',
      message: gone
        ? `"${chat.info.name}" stopped: its folder ${chat.dir} is gone (${messageOf(error)})`
        : `"${chat.info.name}": ${messageOf(error)}`,
    })
    if (!gone) return
    stopSession(chat)
    chat.pendingRequests.clear()
    chat.turn = undefined
    setStatus(chat, 'idle')
    if (allStopped()) allStoppedWaiters.splice(0).forEach((resolve) => resolve())
    if (!chat.info.worker || !chats.has(chat.info.id)) return
    const parent = parentOf(chat)
    if (parent) reportErrors(() => enqueue(parent, reportOf(chat, `its folder ${chat.dir} is gone`)))
    removeChats(familyOf(chat))
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

  const limitWatchers = () => extensions.filter((extension) => isOn(extension) && extension.onLimitReached)

  const reportLimit = (
    chat: Chat,
    account: string | undefined,
    model: string | undefined,
    { message, resetsAt }: NonNullable<Chat['limit']>,
  ) => {
    const { engine } = chat.info
    const limit = {
      chat: summaryOf(chat.info),
      engine,
      ...(account !== undefined && { account }),
      ...(model !== undefined && { model }),
      message,
      output: chat.produced === true,
      ...(resetsAt && { resetsAt }),
    }
    for (const extension of limitWatchers()) {
      callExtension(extension, () => extension.onLimitReached!(limit, contextOf(extension)))
    }
  }

  // A turn's input is the worker reports and the message it started with, logged together at its start.
  const retry = (chat: Chat) => {
    // A message steered into the turn isn't what started it.
    const isInput = (e: ChatEntry) => (e.type === 'user.message' && !e.midTurn) || e.type === 'worker.report'
    const end = chat.entries.findLastIndex(isInput)
    if (end < 0) throw new Error(`${chat.info.name} has no message to send again`)
    const together = (e?: ChatEntry) => e !== undefined && isInput(e) && e.at === chat.entries[end]!.at
    let start = end
    while (together(chat.entries[start - 1])) start--
    const again = chat.entries.slice(start, end + 1).map((e): QueuedMessage => {
      const id = randomBytes(4).toString('hex')
      if (e.type === 'worker.report') {
        const { chatId, name, error } = e
        return { id, text: e.text, report: { chatId, name, ...(error !== undefined && { error }) } }
      }
      const { text, attachments } = e as Extract<ChatEntry, { type: 'user.message' }>
      return { id, text, ...(attachments && { attachments }) }
    })
    setQueue(chat, [...again, ...chat.queue])
    release(chat, false)
    if (chat.status === 'idle') sendQueue(chat)
  }

  // Carries on a turn that stopped part way, as a turn of its own; queued messages wait for it.
  const continueTurn = (chat: Chat, text: string) => {
    if (!text.trim()) throw new Error('A continuation needs a prompt')
    release(chat, false)
    if (chat.status !== 'idle') throw new Error(`${chat.info.name} is still running`)
    send(chat, '', [], [], text)
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

  type Hook = { [K in keyof Extension]-?: NonNullable<Extension[K]> extends (...args: never[]) => unknown ? K : never }[keyof Extension]
  // With a chat: only the extensions that shape its sessions (see isOnFor).
  const watchersOf = (hook: Hook, chat?: Chat) => extensions.filter((extension) => isOnFor(extension, chat) && extension[hook])
  const callExtensions = (hook: Hook, run: (extension: Extension, context: ExtensionContext) => unknown) => {
    if (quitting) return
    for (const extension of watchersOf(hook)) callExtension(extension, () => run(extension, contextOf(extension)))
  }

  // Each extension's text transform in turn; one that throws leaves the text as it was.
  const transformed = (hook: 'transformMessage' | 'transformOutput', chat: Chat, text: string) =>
    watchersOf(hook, chat).reduce((current, extension) => {
      try {
        const next = extension[hook]!(current, detailOf(chat), contextOf(extension))
        if (typeof next !== 'string') throw new Error(`${hook} must return text`)
        return next
      } catch (error) {
        extensionError(extension, error)
        return current
      }
    }, text)

  const completeText = (chat: Chat, at: string, text: string) => {
    const done = transformed('transformOutput', chat, text)
    if (chat.turn) chat.turn.text = done
    append(chat, { at, type: 'text.completed', text: done })
  }

  // The first extension with a verdict answers; an extension's promise is waited for before asking the next.
  const extensionVerdict = (
    request: PermissionRequest,
    chat: Chat,
  ): PermissionVerdict | undefined | Promise<PermissionVerdict | undefined> => {
    const watchers = watchersOf('onPermissionRequested', chat)
    const checked = (extension: Extension, verdict: PermissionVerdict | undefined) => {
      if (verdict === undefined || verdict === null) return undefined
      if (typeof verdict.allow === 'boolean') return verdict
      extensionError(extension, new Error('A permission verdict needs allow: true or false'))
      return undefined
    }
    const ask = (from: number): PermissionVerdict | undefined | Promise<PermissionVerdict | undefined> => {
      for (let i = from; i < watchers.length; i++) {
        const extension = watchers[i]!
        let answer: ReturnType<NonNullable<Extension['onPermissionRequested']>>
        try {
          answer = extension.onPermissionRequested!(request, detailOf(chat), contextOf(extension))
        } catch (error) {
          extensionError(extension, error)
          continue
        }
        if (answer instanceof Promise) {
          return answer.then(
            (verdict) => checked(extension, verdict) ?? ask(i + 1),
            (error) => (extensionError(extension, error), ask(i + 1)),
          )
        }
        const verdict = checked(extension, answer)
        if (verdict) return verdict
      }
      return undefined
    }
    return ask(0)
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
        offeredBy(extension, p, chat) ? [{ extension: extension.id, id: p.id, title: p.title }] : [],
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

  // Runs from Stop's grace timer too, where a throw would leave the chat stopping for good: a chat whose folder is
  // gone goes the way lostChat sends it.
  const forceStop = (chat: Chat) => {
    try {
      endTurn(chat, { at: new Date().toISOString(), type: 'turn.completed', error: 'Interrupted' })
    } catch (error) {
      lostChat(chat, error)
    }
  }

  const loadChat = (dir: string, fallback: ChatInfo) => {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'chat.json')
    const raw = readJson(file)
    const { context = {}, title, parentId, extension, ...saved } = renameChatFile(raw)
    const declared = extensionChats.find((chat) => chat.id === fallback.id)
    const info: ChatInfo = {
      ...fallback,
      ...(title !== undefined && { name: title }),
      ...saved,
      id: fallback.id,
      ...(saved.worker && parentId !== undefined && { parentId }),
      ...(declared && { name: declared.name, extension: declared.extension.id, folders: [], files: [] }),
    }
    const logFile = join(dir, 'log.jsonl')
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    const entries: ChatEntry[] = log
      .split('\n')
      .filter(Boolean)
      .map((line) => renameEntry(JSON.parse(line)))
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
    const flipped = 'askNetworkCommands' in raw
    if (!existsSync(file) || declared || flipped || (parentId !== undefined && !info.parentId)) saveChat(chat)
    chats.set(info.id, chat)
    const lastTurnEvent = entries.findLast((e) => ['turn.started', 'turn.completed', 'session.ended'].includes(e.type))
    const lastType = entries.at(-1)?.type
    if (lastTurnEvent?.type === 'turn.started' || lastType === 'user.message' || lastType === 'worker.report') {
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
  for (const id of readdirSync(chatsDir)) {
    if (chats.has(id) || !existsSync(join(chatsDir, id, 'chat.json'))) continue
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

  // A continuation is a prompt from Kothar, not the user: it isn't logged, and the turn it starts carries on the last.
  const send = (
    chat: Chat,
    text: string,
    attachments: Attachment[] = [],
    reports: Report[] = [],
    continuation?: string,
  ) => {
    if (quitting) throw new Error('Kothar is quitting')
    if (chat.status !== 'idle') throw new Error('A turn is already running in this chat')
    checkActive(chat)
    const run = models.runOf(choosesOf(chat))
    if (run && run.engine !== chat.info.engine) updateChat(chat, { engine: run.engine })
    const cant = run ? undefined : models.whyNot(choosesOf(chat))
    if (cant) throw new Error(cant)
    const adapter = adapterFor(chat.info.engine)!
    const editAnywhere = editsAnywhere(...switchesOf(chat))
    if (!machine.canSandbox && !editAnywhere && UNSANDBOXED_NEEDS_EDIT_ANYWHERE) {
      throw new Error("Kothar can't sandbox engines on this system yet. Turn on Edits anywhere in this chat's Context panel, or as the default in Settings → Work folder, to run it unsandboxed.")
    }
    const workDir = workDirOf(chat)
    mkdirSync(workDir, { recursive: true })
    const message = withAttachments(text ? transformed('transformMessage', chat, text) : text, attachments)
    const zoomable = takesMcp(adapter.id)
    const view = viewOf(chat, messagesOf(chat.entries), zoomable)
    const prompt = continuation ? continuationPrompt(view, continuation) : seededPrompt(view, message, reports)
    const at = new Date().toISOString()
    if (!continuation) {
      chat.produced = false
      for (const { text, report } of reports) append(chat, { at, type: 'worker.report', text, ...report })
      if (text || attachments.length || !reports.length) {
        append(chat, { at, type: 'user.message', text, ...(attachments.length && { attachments }) })
      }
    }
    chat.turn = { text: '', tools: [] }
    setStatus(chat, 'running')
    const started = { chat: detailOf(chat), text: continuation ?? text, continued: continuation !== undefined }
    callExtensions('onTurnStarted', (extension, context) => extension.onTurnStarted!(started, context))

    const items = contextItems(chat).filter((item) => item.enabled)
    const readFiles = items.flatMap((item) => (item.binary ? [item.path] : []))
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
    const attachmentsDir = attachmentsDirOf(chat)
    const folders = items.flatMap((item) => (item.section === 'folders' ? [item.path] : []))
    const repos = folders.filter((folder) => existsSync(join(folder, '.git')))
    const sandbox = editAnywhere ? undefined : sandboxIn(workDir)

    const start = (checkouts: Checkout[]) => {
      const cwd = checkouts[0]?.worktree.path ?? workDir
      const instructions = buildInstructions({
        role,
        ...(sandbox && { workDir }),
        checkouts: checkouts.map(({ folder, worktree }) => ({ folder, path: worktree.path, branch: worktree.branch })),
        extensions: extensionInstructions,
        workers,
        memory,
        parentView,
        setup,
        items,
      })
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
      // Read at each request, so a switch flipped mid-turn counts at once.
      const permissionsOf = () => ({ cwd, workDir, sandboxed: !!jail, switches: switchesOf(chat), home: homedir(), garage })

      let session: Session | undefined
      // Where each tool sits in chat.turn.tools, counting from 1.
      const toolIds = new Map<string, number>()
      // Engine events arrive from an adapter's stdout handler, where a throw would take the whole app down. A write
      // that fails (the chat's folder was deleted under it, say) is reported instead; with the folder gone, the chat's
      // session stops.
      const guarded = (run: () => void) => {
        try {
          run()
        } catch (error) {
          lostChat(chat, error)
        }
      }
      const emit = (event: EngineEvent) => guarded(() => handleEvent(event))
      const handleEvent = (event: EngineEvent) => {
        if (chat.session !== session) return
        const at = new Date().toISOString()
        for (const extension of watchersOf('onEvent')) callExtension(extension, () => extension.onEvent!(detailOf(chat), event, contextOf(extension)))
        if (event.type === 'tool.started') {
          const { name, kind, summary, path } = event
          chat.turn?.tools.push({ name, kind, summary, ...(path !== undefined && { path }) })
          toolIds.set(event.toolId, chat.turn?.tools.length ?? 0)
        }
        if (event.type === 'tool.completed' && event.isError) {
          const tool = chat.turn?.tools[(toolIds.get(event.toolId) ?? 0) - 1]
          if (tool) tool.isError = true
        }
        if (event.type === 'turn.completed' || event.type === 'session.ended') return endTurn(chat, { at, ...event })
        if (event.type === 'steer.landed') return landSteer(chat, event.id, at)
        if (event.type === 'steer.returned') return unsteer(chat, event.id)
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
        if (event.type === 'text.completed') {
          chat.unsavedText = ''
          return completeText(chat, at, event.text)
        }
        append(chat, { at, ...event })
        if (event.type === 'limit.reached') {
          const { message, resetsAt } = event
          chat.limit ??= { message, ...(resetsAt && { resetsAt }) }
          // An engine may wait out the limit; an extension that reacts to it gets the chat idle.
          if (limitWatchers().length) interrupt(chat, false)
          return
        }
        if (event.type === 'question.asked') {
          chat.pendingRequests.set(event.requestId, 'question')
          return setStatus(chat, 'waiting')
        }
        if (event.type !== 'permission.requested') return
        if (event.kind === 'edit' && event.path !== undefined) {
          const tool = chat.turn?.tools[(toolIds.get(event.toolId ?? '') ?? 0) - 1]
          if (tool && tool.path === undefined) tool.path = event.path
        }
        const { requestId } = event
        const settle = (verdict: PermissionVerdict | undefined) => {
          if (!verdict) {
            chat.pendingRequests.set(requestId, 'permission')
            return setStatus(chat, 'waiting')
          }
          chat.pendingRequests.delete(requestId)
          const resolvedAt = new Date().toISOString()
          append(chat, { at: resolvedAt, type: 'permission.resolved', requestId, allow: verdict.allow, auto: true })
          session?.respond(requestId, verdict.allow, verdict.message)
        }
        const own = verdictOf(event, permissionsOf())
        // The core's denials stand; otherwise an extension's policy goes first.
        if (own?.allow === false) return settle(own)
        const fromExtensions = extensionVerdict(event, chat)
        if (!(fromExtensions instanceof Promise)) return settle(fromExtensions ?? own)
        // Pending, so the user can still answer it while an extension decides; whoever answers first wins.
        chat.pendingRequests.set(requestId, 'permission')
        void fromExtensions.then((verdict) => {
          if (chat.session !== session || chat.pendingRequests.get(requestId) !== 'permission') return
          guarded(() => settle(verdict ?? own))
        })
      }

      try {
        chat.mcpToken = zoomable ? mcp.grant(chat.info.id) : undefined
        const kotharMcp = mcpUrl && chat.mcpToken ? { url: mcpUrl, token: chat.mcpToken } : undefined
        const { model, thinking } = run ?? {}
        const mcpServers = adapter.kotharMcp ? extensionServers(chat, workDir, jail !== undefined) : []
        const images = imagesFor(adapter, attachments)
        const options = {
          cwd,
          instructions,
          ...(extraDirs.length && { extraDirs }),
          ...(readFiles.length && { readFiles }),
          ...accounts.sessionFor(adapter.id),
          ...(kotharMcp && { kotharMcp }),
          ...(mcpServers.length && { mcpServers }),
          ...(model && { model }),
          ...(thinking && { thinking }),
          ...(jail && { sandbox: jail }),
        }
        chat.account = accounts.activeOf(adapter.id)
        chat.runModel = model
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

  const imagesFor = (adapter: Adapter, attachments: Attachment[]) =>
    adapter.imageInput
      ? attachments
          .filter((a) => IMAGE_TYPES.includes(a.mimeType))
          .map((a) => ({ mimeType: a.mimeType, base64: readFileSync(a.path).toString('base64') }))
      : []

  // Steering: the message waits in the queue, marked, until the turn takes it in at its next tool boundary.
  const canSteer = (chat: Chat) => chat.session?.steer !== undefined && ['running', 'waiting'].includes(chat.status)

  const steer = (chat: Chat, message: Omit<QueuedMessage, 'id'>) => {
    const session = chat.session!
    const adapter = adapterFor(chat.info.engine)!
    const { text, attachments = [] } = message
    const id = randomBytes(4).toString('hex')
    const sent = withAttachments(text ? transformed('transformMessage', chat, text) : text, attachments)
    const images = imagesFor(adapter, attachments)
    setQueue(chat, [...chat.queue, { id, ...message, steering: true }])
    session.steer!(id, sent, images)
  }

  // Logged where the engine took it in, between a tool's result and the rest of the turn.
  const landSteer = (chat: Chat, id: string, at: string) => {
    const landed = chat.queue.find((q) => q.id === id && q.steering)
    if (!landed) return
    setQueue(chat, chat.queue.filter((q) => q !== landed))
    const { text, attachments } = landed
    append(chat, { at, type: 'user.message', text, ...(attachments && { attachments }), midTurn: true })
  }

  // A steered message the turn didn't take in goes back to the front of the queue, as typed. Without an id, every one.
  const unsteer = (chat: Chat, id?: string) => {
    const back = chat.queue.filter((q) => q.steering && (id === undefined || q.id === id))
    if (!back.length) return
    const plain = back.map(({ steering, ...q }) => q)
    setQueue(chat, [...plain, ...chat.queue.filter((q) => !back.includes(q))])
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
    if (quitting) throw new Error('Kothar is quitting')
    checkActive(chat)
    if (chat.status === 'idle') return sendQueue(chat, message)
    setQueue(chat, [...chat.queue, { id: randomBytes(4).toString('hex'), ...message }])
  }

  const sendMessage = (chat: Chat, rawText: unknown, uploads: unknown, steering = false) => {
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
      // oxlint-disable-next-line no-control-regex -- strips control characters from file names on purpose
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
      const message = { text, ...(attachments.length && { attachments }) }
      // A chat held after its turn queues the message first, so it runs once the extension lets go.
      if (chat.held) {
        enqueue(chat, message)
        for (const extensionId of [...chat.waits.keys()]) answerWait(chat, extensionId, { message: text })
        return
      }
      // A message sent while extensions wait on the user answers them too; it still goes to the agent.
      for (const extensionId of chat.waits.keys()) answerWait(chat, extensionId, { message: text })
      if (steering && canSteer(chat)) {
        checkActive(chat)
        steer(chat, message)
      } else enqueue(chat, message)
    } catch (error) {
      for (const { path } of attachments) rmSync(path, { force: true })
      throw error
    }
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

  const interrupt = (chat: Chat, force: boolean) => {
    // Stop on a chat an extension holds after its turn: nothing runs, so it ends now.
    if (chat.held && !chat.session) return release(chat, true)
    if (!chat.session && (chat.status === 'running' || chat.status === 'stopping')) return forceStop(chat)
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
    if (chat.pendingRequests.size === 0 && chat.waits.size === 0) setStatus(chat, 'running')
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
    handle(message: ClientMessage, reply: (message: CoreMessage) => void) {
      switch (message.type) {
        case 'engine.setEnabled':
          return setEngineEnabled(String(message.engine), message.enabled === true)
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
        case 'chat.read': {
          const chat = chatFor(message.chatId)
          return isUnread(chat.info) ? updateChat(chat, { readAt: new Date().toISOString() }) : undefined
        }
        case 'chat.history': {
          const { chatId, before, to } = message
          const page = pageOf(chatFor(chatId).entries, Number(before), to === undefined ? undefined : Number(to))
          return reply({ type: 'chat.history', chatId, before: page.from + page.entries.length, ...page })
        }
        case 'setup.save': {
          let answer: CoreMessage
          try {
            answer = { type: 'setup.saved', setup: saveSetup(message.setup) }
          } catch (error) {
            answer = { type: 'setup.refused', error: messageOf(error) }
          }
          return reply(answer)
        }
        case 'setup.remove':
          return removeSetup(message.id)
        case 'chat.setSetup':
          return setChatSetup(chatFor(message.chatId), message.setup)
        case 'chat.setModel':
          return setModel(
            chatFor(message.chatId),
            optionalText(message.engine),
            optionalText(message.model),
            optionalText(message.thinking),
          )
        case 'chat.setPermission': {
          const chat = chatFor(message.chatId)
          const name = checkSwitch(message.name)
          checkActive(chat)
          return updateChat(chat, { [name]: typeof message.enabled === 'boolean' ? message.enabled : undefined })
        }
        case 'chat.send':
          return sendMessage(chatFor(message.chatId), message.text, message.attachments, message.steer === true)
        case 'chat.unqueue': {
          const chat = chatFor(message.chatId)
          const removed = chat.queue.find((q) => q.id === message.id)
          if (!removed) return
          if (removed.steering) throw new Error('That message is already with the engine, so it can no longer be taken back')
          for (const { path } of removed.attachments ?? []) rmSync(path, { force: true })
          return setQueue(chat, chat.queue.filter((q) => q !== removed))
        }
        case 'chat.interrupt':
          return interrupt(chatFor(message.chatId), message.force === true)
        case 'context.get': {
          const chat = chatFor(message.chatId)
          reply({ type: 'chat.context', chatId: chat.info.id, items: contextItems(chat) })
          return reply(extensionsOf(chat))
        }
        case 'extension.panel.get':
          return openPanel(chatFor(message.chatId), message.extension, message.panel)
        case 'extension.panel.action': {
          const chat = chatFor(message.chatId)
          panelOf(chat, message.extension, message.panel)
          return void panelAction(chat, message.extension, message.panel, message.action).catch((error) =>
            broadcast({ type: 'error', message: messageOf(error) }),
          )
        }
        case 'extension.space.set':
          return setSpaceValue(extensionFor(String(message.extension)), chatFor(message.chatId), String(message.key), message.value)
        case 'extension.command':
          return runCommand(chatFor(message.chatId), message.extension, message.command)
        case 'extension.wait.answer':
          return answerWait(chatFor(message.chatId), String(message.extension), { button: String(message.button) })
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
        case 'extension.setEnabled':
          return setExtensionEnabled(extensionFor(String(message.extensionId)), message.enabled === true)
        case 'extension.setValue':
          return setExtensionValue(extensionFor(String(message.extensionId)), String(message.key), message.value)
        case 'extension.install':
          return install(extensionFor(String(message.extensionId)))
        case 'extension.settingsView.get':
          return settingsViewChanged(extensionFor(String(message.extensionId)))
        case 'extension.settingsView.action':
          return settingsViewAction(extensionFor(String(message.extensionId)), message.action)
        case 'extension.cancelInstall':
          return installs.get(extensionFor(String(message.extensionId)).id)?.abort()
        case 'communityExtensions.setEnabled':
          return setCommunityExtensions(message.enabled === true)
        case 'app.restart':
          if (!options.restart) throw new Error('This Kothar can\'t restart itself. Stop it and start it again.')
          if (quitting) return
          return options.restart()
        case 'memory.set':
          return setMemory(optionalText(message.engine), optionalText(message.model))
        case 'models.setList':
          models.setList(message.role, message.models)
          return followModels()
        case 'permission.respond':
          return respond(chatFor(message.chatId), message.requestId, message.allow === true)
        case 'question.respond':
          return answer(chatFor(message.chatId), message.requestId, message.answers)
        case 'account.login':
          return accounts.login(
            String(message.engine),
            String(message.name ?? ''),
            optionalText(message.provider),
            optionalText(message.method),
          )
        case 'account.addApiKey':
          return accounts.addApiKey(
            String(message.engine),
            String(message.name ?? ''),
            String(message.key ?? ''),
            optionalText(message.provider),
            optionalText(message.method),
          )
        case 'account.code':
          return accounts.submitCode(String(message.engine), String(message.code ?? ''))
        case 'account.cancelLogin':
          return accounts.cancelLogin(String(message.engine))
        case 'account.use':
          return accounts.use(String(message.engine), String(message.accountId))
        case 'account.remove':
          return accounts.remove(String(message.engine), String(message.accountId), reply)
        case 'marketplace.list':
          return void marketplace.listing().then(
            (entries) => reply({ type: 'marketplace.catalog', entries }),
            (error) => reply({ type: 'marketplace.catalog', error: messageOf(error) }),
          )
        case 'themes.get':
          return reply({ type: 'themes.updated', themes: marketplace.themes() })
        case 'market.install': {
          const { kind } = message
          const id = String(message.id)
          if (kind === 'extension' && builtInIds.has(id)) {
            return reply({ type: 'market.installFailed', kind, id, error: `A built-in extension is already called "${id}"` })
          }
          return void marketplace.install(kind, id).then(
            ({ added }) => {
              if (kind === 'extension') communityChanged(id, added)
              marketChanged(kind)
            },
            (error) => reply({ type: 'market.installFailed', kind, id, error: messageOf(error) }),
          )
        }
        case 'market.installLocal': {
          const path = String(message.path ?? '')
          let result: ReturnType<typeof marketplace.installLocal>
          try {
            // A broken manifest is the marketplace's to explain.
            const id = (() => {
              try {
                return (readJson(join(path.trim(), 'manifest.json')) as { id?: unknown }).id
              } catch {
                return undefined
              }
            })()
            if (typeof id === 'string' && builtInIds.has(id)) throw new Error(`A built-in extension is already called "${id}"`)
            result = marketplace.installLocal(path)
          } catch (error) {
            return reply({ type: 'market.localFailed', path, error: messageOf(error) })
          }
          const { kind, ids, added } = result
          if (kind === 'extension') communityChanged(ids[0]!, added)
          marketChanged(kind)
          return reply({ type: 'market.localInstalled', path, kind, ids })
        }
        case 'market.uninstall':
          if (message.kind === 'extension') uninstallExtension(String(message.id))
          else marketplace.uninstall(message.kind, message.id)
          return marketChanged(message.kind)
        case 'search': {
          const spaces = shownChats().filter((c) => !c.info.worker)
          const hits = searchChats(
            spaces.map((c) => ({ id: c.info.id, name: c.info.name, entries: c.entries })),
            String(message.query ?? ''),
          )
          return reply({ type: 'search.results', id: Number(message.id), query: String(message.query ?? ''), hits })
        }
        case 'terminal.set': {
          const terminal = String(message.terminal ?? '')
          if (terminal !== AUTOMATIC && !MAC_TERMINALS.some((t) => t.id === terminal)) {
            throw new Error(`Unknown terminal "${terminal}"`)
          }
          if (terminal === AUTOMATIC) delete settings.terminal
          else settings.terminal = terminal
          saveSettings()
          return broadcast({ type: 'workFolder.updated', workFolder: workFolder() })
        }
        // Show in Finder, from an extension's view (a text with reveal). Refused paths come back as an error.
        case 'reveal':
          return void reveal(message.path).catch((error) => reply({ type: 'error', message: messageOf(error) }))
        case 'terminal.open': {
          const chat = chatFor(message.chatId)
          const path = String(message.path ?? '')
          return void terminalFor(chat, message.path).then(
            () => reply({ type: 'terminal.result', chatId: chat.info.id, path }),
            (error) => reply({ type: 'terminal.result', chatId: chat.info.id, path, error: messageOf(error) }),
          )
        }
        default:
          throw new Error(`Unknown message type "${(message as { type: unknown }).type}"`)
      }
    },
    async close(force = false) {
      quitting = true
      for (const extension of extensions) stopExtension(extension)
      for (const chat of chats.values()) {
        if (chat.status === 'idle') stopSession(chat)
        else interrupt(chat, force)
      }
      if (!allStopped()) await new Promise<void>((resolve) => allStoppedWaiters.push(resolve))
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

const within = (inner: string, outer: string) => inner === outer || inner.startsWith(outer.replace(/\/?$/, sep))

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
