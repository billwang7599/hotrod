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
  Mod,
  ModAction,
  ModContext,
  ModManifest,
  ModHost,
  ModPanel,
  ModRun,
  ModUse,
  PermissionRequest,
  PermissionVerdict,
  SpaceDetail,
  TurnSummary,
} from '@kothar/mod-api'
import { openAccounts } from './accounts.ts'
import { CORE_TOOL_NAMES, openKotharMcp, SUBAGENTS_MOD, summaryOf } from './kothar-mcp.ts'
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
import { type Fetch, installedMods, openMarketplace } from './marketplace.ts'
import { type CommunityMod, guardHost, valuesOf } from './mods.ts'
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
  PERMISSION_SWITCHES,
  isUnread,
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
  type CommandInfo,
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
  MOD_USES,
  type ModInfo,
  type NewChat,
  type PanelTab,
  type PermissionSwitch,
  type PermissionSwitches,
  type QueuedMessage,
  type RestartChange,
  type RestartState,
  type Session,
  type SetupState,
  type Upload,
  type WorkFolder,
  type Worktree,
} from './shared.ts'
import { openModels, type ModelSettings } from './models.ts'
import { searchChats } from './search.ts'
import { openTerminal } from './terminal.ts'

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
  // What the running turn has done so far, for onTurnCompleted.
  turn?: { text: string; tools: TurnSummary['tools'] }
  // The run the UI last got for this chat (JSON), so a change in Settings or an engine resends only the chats it moves.
  shownRun?: string
}

export type Core = ReturnType<typeof openCore>

export function openCore(options: {
  garage: string
  adapters: Adapter[]
  defaultEngine: string
  machine: Machine
  mods?: Mod[]
  brokenMods?: { id: string; loadError: string }[]
  // Mods installed in the garage from the marketplace or a folder; see loadCommunityMods.
  community?: CommunityMod[]
  stopGraceMs?: number
  compactDebounceMs?: number
  marketplaceUrl?: string
  githubToken?: string
  fetch?: Fetch
  // Restarts Kothar (the desktop app relaunches; npm run dev's core starts again in its process). Without it, the user
  // restarts Kothar themselves.
  restart?: () => void
  // Opens the user's terminal app at a folder; choice is settings.json's terminal. Tests pass a stub.
  openTerminal?: (dir: string, choice?: string) => Promise<void>
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
  // Community mods come after the stock ones. One that clashes with a stock mod's id isn't listed; one whose tool or chat
  // is taken doesn't run. A mod that didn't load (off, or broken) is listed as a stub with no hooks, so it can be turned
  // on or off; it runs from the next start.
  const stockIds = new Set(mods.map((mod) => mod.id))
  const community = new Map<string, { manifest: ModManifest; item: InstalledItem; running?: string; loadError?: string }>()
  // The community mods this run imported (whether or not they loaded), by id with their name, and those installed again
  // since; what's pending a restart is worked out from these and the settings.
  const imported = new Map<string, string>()
  const reinstalled = new Set<string>()
  const stubOf = ({ id, name, description }: ModManifest): Mod => ({ id, name, description, enabledByDefault: false })
  for (const found of options.community ?? []) {
    const { manifest, item } = found
    if (stockIds.has(manifest.id) || community.has(manifest.id)) {
      console.error(`Skipped the community mod "${manifest.id}": a mod already has that id`)
      continue
    }
    let { mod, loadError } = found
    if (mod || loadError) imported.set(manifest.id, manifest.name)
    const clash =
      mod &&
      ((mod.tools ?? []).map((tool) => tool.name).find((name) => toolNames.includes(name)) ??
        (mod.chats ?? []).map((chat) => chat.id).find((id) => modChats.some((chat) => chat.id === id)))
    if (clash) {
      loadError = `its tool or chat "${clash}" is already taken`
      mod = undefined
    }
    community.set(manifest.id, { manifest, item, ...(mod && { running: manifest.version }), ...(loadError && { loadError }) })
    if (!mod) {
      mods.push(stubOf(manifest))
      continue
    }
    mods.push(mod)
    modChats.push(...(mod.chats ?? []).map((chat) => ({ ...chat, mod: mod! })))
    toolNames.push(...(mod.tools ?? []).map((tool) => tool.name))
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
      mods?: Record<string, Record<string, unknown>>
      workFolder?: string
      // The master switch for community mods; off unless the user turned it on.
      communityMods?: boolean
      // The terminal Open in Terminal uses: 'auto' or absent for the system's, else one of MAC_TERMINALS by id.
      terminal?: string
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
  const communityOn = () => settings.communityMods === true
  // A community mod's own switch: off until the user turns it on, whatever it says.
  const ownSwitch = (mod: Mod) => settings.mods?.[mod.id]?.enabled === true
  // Whether a mod runs: a community mod only while community mods are on too.
  const isOn = (mod: Mod) => {
    const saved = settings.mods?.[mod.id]?.enabled
    if (community.has(mod.id)) return communityOn() && saved === true
    return typeof saved === 'boolean' ? saved : mod.enabledByDefault
  }
  const modValues = (mod: Mod) => valuesOf(mod, settings.mods?.[mod.id])
  const setups = new Map<string, Omit<SetupState, 'description'>>()
  const installs = new Map<string, AbortController>()
  const modInfo = (mod: Mod): ModInfo => {
    const { id, name, description, settings: declared = [] } = mod
    const values = modValues(mod)
    const about = mod.setup?.description
    const setup = mod.setup && {
      description: typeof about === 'function' ? about(values) : about!,
      ...(setups.get(id) ?? { status: 'checking' }),
    }
    // A community mod shows its own switch; the master switch is beside it in the UI.
    const enabled = community.has(id) ? ownSwitch(mod) : isOn(mod)
    const info = { id, name, description, enabled, settings: declared, values }
    const from = community.get(id)
    const { version, author, uses } = from?.manifest ?? {}
    const { source, repo, path } = from?.item ?? {}
    const aftermarket = from && {
      community: {
        version: version!,
        author: author!,
        uses: uses!,
        source: source === 'local' ? ('local' as const) : ('marketplace' as const),
        ...(repo && { repo }),
        ...(path && { path }),
        ...(from.running && { running: from.running }),
      },
      ...(from.loadError && { loadError: from.loadError }),
    }
    return { ...info, ...(setup && { setup }), ...aftermarket }
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
      const run = models.runOf(chat.info)
      const follows = chat.info.model === undefined && chat.status === 'idle'
      if (follows && run && run.engine !== chat.info.engine) updateChat(chat, { engine: run.engine })
      else if (JSON.stringify(run) !== chat.shownRun) broadcast({ type: 'chat.updated', chat: withRun(chat) })
    }
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
      // A setup that runs several commands stops at its next one once cancelled.
      signal?.aborted
        ? Promise.reject(new Error('Cancelled'))
        : machine.run(command, args, { cwd: '/', ...options, ...(signal && { signal }) })
  const checkSetup = async (mod: Mod, installError?: string) => {
    if (!mod.setup || installs.has(mod.id)) return
    const { message } = setups.get(mod.id) ?? {}
    setSetup(mod, { status: 'checking', ...(message && { message }) })
    let checked: Omit<SetupState, 'description'>
    try {
      const result = await mod.setup.check(runFor(), modValues(mod))
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
    void mod.setup.install(runFor(controller.signal), report, modValues(mod)).then(
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
    if (isOn(mod)) void checkSetup(mod)
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
    compactBacklog()
  }
  const saveChat = ({ info, dir, context }: Chat) => {
    const file = { ...info, ...(Object.keys(context).length ? { context } : {}) }
    writeFileSync(join(dir, 'chat.json'), JSON.stringify(file, null, 2) + '\n')
  }
  // A chat as the UI gets it: its saved info plus what it runs now, which the core alone works out.
  const withRun = (chat: Chat) => {
    const run = models.runOf(chat.info)
    chat.shownRun = JSON.stringify(run)
    return { ...chat.info, ...(run && { run }) }
  }
  const state = (chat: Chat): ChatState => ({
    ...withRun(chat),
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

  const compactor = openCompactor({
    chat: (chatId) => {
      const chat = chats.get(chatId)
      return chat && memoryOf(chat)
    },
    async complete(request) {
      const { engine, model } = models.memory()
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
    callMods('onStatusChanged', (mod, context) => mod.onStatusChanged!(detailOf(chat), status, context))
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
    if (chat.unsavedText) completeText(chat, end.at, chat.unsavedText)
    chat.unsavedText = ''
    append(chat, end)
    stopSession(chat)
    unsteer(chat)
    chat.pendingRequests.clear()
    setStatus(chat, 'idle')
    // Only spaces and Home show unread; a subagent is removed once it reports, so it keeps no read state.
    if (!chat.info.subagent) updateChat(chat, { doneAt: end.at })
    if (allStopped()) allStoppedWaiters.splice(0).forEach((resolve) => resolve())
    if (quitting) return
    compactor.touch(chat.info.id)
    const turn = chat.turn ?? { text: '', tools: [] }
    chat.turn = undefined
    const detail = detailOf(chat)
    const files = [...new Set(turn.tools.flatMap((t) => (t.kind === 'edit' && t.path ? [t.path] : [])))]
    const summary = { chat: detail, ...(end.error && { error: end.error }), ...turn, files }
    const sessionError = end.type === 'session.ended' ? end.error : undefined
    callMods('onSessionEnded', (mod, context) =>
      mod.onSessionEnded!({ chat: detail, ...(sessionError && { error: sessionError }) }, context),
    )
    callMods('onTurnCompleted', (mod, context) => mod.onTurnCompleted!(summary, context))
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
      callMod(mod, () => mod.onLimitReached!(limit, contextOf(mod)))
    }
  }

  // A turn's input is the subagent reports and the message it started with, logged together at its start.
  const retry = (chat: Chat) => {
    // A message steered into the turn isn't what started it.
    const isInput = (e: ChatEntry) => (e.type === 'user.message' && !e.midTurn) || e.type === 'subagent.report'
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

  const detailOf = (chat: Chat): ChatDetail => ({
    ...summaryOf(chat.info),
    status: chat.status,
    archived: chat.info.archived,
    ...(chat.info.mod && { mod: chat.info.mod }),
    folders: chat.info.folders,
    files: chat.info.files,
    createdAt: chat.info.createdAt,
  })

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

  const modError = (mod: Mod, error: unknown) =>
    broadcast({ type: 'error', message: `${mod.name}: ${messageOf(error)}` })

  // Runs one of a mod's hooks; a throw or a rejection shows as an error and goes no further.
  const callMod = (mod: Mod, run: () => unknown) => {
    try {
      const result = run()
      if (result instanceof Promise) result.catch((error) => modError(mod, error))
    } catch (error) {
      modError(mod, error)
    }
  }

  type Hook = { [K in keyof Mod]-?: NonNullable<Mod[K]> extends (...args: never[]) => unknown ? K : never }[keyof Mod]
  const watchersOf = (hook: Hook) => mods.filter((mod) => isOn(mod) && mod[hook])
  const callMods = (hook: Hook, run: (mod: Mod, context: ModContext) => unknown) => {
    if (quitting) return
    for (const mod of watchersOf(hook)) callMod(mod, () => run(mod, contextOf(mod)))
  }

  // Each mod's text transform in turn; one that throws leaves the text as it was.
  const transformed = (hook: 'transformMessage' | 'transformOutput', chat: Chat, text: string) =>
    watchersOf(hook).reduce((current, mod) => {
      try {
        const next = mod[hook]!(current, detailOf(chat), contextOf(mod))
        if (typeof next !== 'string') throw new Error(`${hook} must return text`)
        return next
      } catch (error) {
        modError(mod, error)
        return current
      }
    }, text)

  const completeText = (chat: Chat, at: string, text: string) => {
    const done = transformed('transformOutput', chat, text)
    if (chat.turn) chat.turn.text = done
    append(chat, { at, type: 'text.completed', text: done })
  }

  // The first mod with a verdict answers; a mod's promise is waited for before asking the next.
  const modVerdict = (
    request: PermissionRequest,
    chat: Chat,
  ): PermissionVerdict | undefined | Promise<PermissionVerdict | undefined> => {
    const watchers = watchersOf('onPermissionRequested')
    const checked = (mod: Mod, verdict: PermissionVerdict | undefined) => {
      if (verdict === undefined || verdict === null) return undefined
      if (typeof verdict.allow === 'boolean') return verdict
      modError(mod, new Error('A permission verdict needs allow: true or false'))
      return undefined
    }
    const ask = (from: number): PermissionVerdict | undefined | Promise<PermissionVerdict | undefined> => {
      for (let i = from; i < watchers.length; i++) {
        const mod = watchers[i]!
        let answer: ReturnType<NonNullable<Mod['onPermissionRequested']>>
        try {
          answer = mod.onPermissionRequested!(request, detailOf(chat), contextOf(mod))
        } catch (error) {
          modError(mod, error)
          continue
        }
        if (answer instanceof Promise) {
          return answer.then(
            (verdict) => checked(mod, verdict) ?? ask(i + 1),
            (error) => (modError(mod, error), ask(i + 1)),
          )
        }
        const verdict = checked(mod, answer)
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
      info.mod
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

  const hosts = new Map<string, ModHost>()
  const contextOf = (mod: Mod): ModContext => ({ values: modValues(mod), host: hostFor(mod) })
  const hostFor = (mod: Mod): ModHost => {
    const known = hosts.get(mod.id)
    if (known) return known
    const dir = join(garage, 'mods', mod.id)
    const fileOf = (name: string) => {
      const path = resolve(dir, String(name))
      if (path === dir || !within(path, dir)) throw new Error(`"${name}" is outside ${mod.name}'s storage`)
      return path
    }
    const host: ModHost = {
      createChat: ({ name, folders, files, engine }) => createChat({ name, folders, files, engine }),
      send: (chatId, text) => enqueue(chatFor(chatId), { text }),
      chats: () => shownChats().map(detailOf),
      chat(chatId) {
        const chat = chats.get(chatId)
        return chat && shown(chat) ? detailOf(chat) : undefined
      },
      read(chatId, options) {
        const { entries } = chatFor(chatId)
        const last = options?.last
        return last === undefined ? [...entries] : last > 0 ? entries.slice(-last) : []
      },
      space(chatId) {
        const chat = chats.get(chatId)
        return chat && shown(chat) ? spaceOf(chat) : undefined
      },
      interrupt: (chatId) => interrupt(chatFor(chatId), false),
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
      note(chatId, text, options) {
        const panel = options?.panel
        if (panel !== undefined && !mod.panels?.some((p) => p.id === panel)) {
          throw new Error(`${mod.name} has no panel "${panel}"`)
        }
        const at = new Date().toISOString()
        append(chatFor(chatId), { at, type: 'mod.note', text, ...(panel !== undefined && { mod: mod.id, panel }) })
      },
      run: runFor(),
      // Lazily: hosts can be made before the spawning code below is set up.
      spawn: (command, args, options) => spawnFor(mod)(command, args, options),
      storage: {
        dir,
        read(name) {
          try {
            return readFileSync(fileOf(name), 'utf8')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
            throw error
          }
        },
        write(name, text) {
          const path = fileOf(name)
          mkdirSync(dirname(path), { recursive: true })
          writeFileSync(path, text)
        },
        remove: (name) => rmSync(fileOf(name), { force: true }),
      },
      refresh: (chatId) => refreshMod(mod, chatId),
      // Only inside a folder some chat could open: a mod can't open a terminal anywhere it likes.
      async openTerminal(path) {
        const real = realOr(String(path))
        const roots = shownChats().flatMap(terminalRoots).map(realOr)
        if (!isAbsolute(String(path)) || !roots.some((root) => within(real, root))) {
          throw new Error(`${path} isn't inside a space's folders, work folder or checkouts`)
        }
        await openTerminalAt(real)
      },
    }
    const uses = community.get(mod.id)?.manifest.uses
    const given = uses ? guardHost(host, mod, uses) : host
    hosts.set(mod.id, given)
    return given
  }

  // Mod panels and commands: which a chat gets, and the views of panels the UI has asked for.
  type Offered = { shown?(chat: ChatDetail, context: ModContext): boolean }
  const offeredBy = (mod: Mod, item: Offered, chat: Chat) => {
    if (!item.shown) return true
    try {
      return item.shown(detailOf(chat), contextOf(mod)) === true
    } catch (error) {
      modError(mod, error)
      return false
    }
  }
  const modsOf = (chat: Chat): Extract<CoreMessage, { type: 'chat.mods' }> => {
    const on = mods.filter(isOn)
    const panels = on.flatMap((mod) =>
      (mod.panels ?? []).flatMap((p): PanelTab[] =>
        offeredBy(mod, p, chat) ? [{ mod: mod.id, id: p.id, title: p.title }] : [],
      ),
    )
    const commands = on.flatMap((mod) =>
      (mod.commands ?? []).flatMap((c): CommandInfo[] =>
        offeredBy(mod, c, chat) ? [{ mod: mod.id, id: c.id, label: c.label, ...(c.hint && { hint: c.hint }) }] : [],
      ),
    )
    return { type: 'chat.mods', chatId: chat.info.id, panels, commands }
  }
  const openPanels = new Map<string, Set<string>>()
  const renders = new Map<string, number>()
  const panelOf = (modId: unknown, panelId: unknown) => {
    const mod = modFor(String(modId))
    if (!isOn(mod)) throw new Error(`${mod.name} is off`)
    const panel = mod.panels?.find((p) => p.id === panelId)
    if (!panel) throw new Error(`${mod.name} has no panel "${panelId}"`)
    return { mod, panel }
  }
  const renderPanel = async (chat: Chat, mod: Mod, panel: ModPanel) => {
    const key = `${chat.info.id}\n${mod.id}\n${panel.id}`
    const turn = (renders.get(key) ?? 0) + 1
    renders.set(key, turn)
    const base = { type: 'mod.panel' as const, chatId: chat.info.id, mod: mod.id, panel: panel.id }
    let shownView: Extract<CoreMessage, { type: 'mod.panel' }>
    try {
      shownView = { ...base, view: await panel.render(detailOf(chat), contextOf(mod)) }
    } catch (error) {
      shownView = { ...base, error: messageOf(error) }
    }
    // An older render that finishes late doesn't replace a newer one.
    if (renders.get(key) === turn && chats.has(chat.info.id)) broadcast(shownView)
  }
  const openPanel = (chat: Chat, modId: unknown, panelId: unknown) => {
    const { mod, panel } = panelOf(modId, panelId)
    const open = openPanels.get(chat.info.id) ?? new Set()
    open.add(`${mod.id}\n${panel.id}`)
    openPanels.set(chat.info.id, open)
    void renderPanel(chat, mod, panel)
  }
  const refreshMod = (mod: Mod, chatId?: string) => {
    if (!isOn(mod)) return
    const targets = chatId === undefined ? shownChats() : [chatFor(chatId)]
    for (const chat of targets) {
      broadcast(modsOf(chat))
      for (const panel of mod.panels ?? []) {
        if (openPanels.get(chat.info.id)?.has(`${mod.id}\n${panel.id}`)) void renderPanel(chat, mod, panel)
      }
    }
  }
  const panelAction = async (chat: Chat, modId: unknown, panelId: unknown, action: ModAction) => {
    const { mod, panel } = panelOf(modId, panelId)
    if (typeof action?.name !== 'string') throw new Error('A panel action needs a name')
    try {
      await panel.onAction?.(action, detailOf(chat), contextOf(mod))
    } catch (error) {
      modError(mod, error)
    }
    if (chats.has(chat.info.id)) await renderPanel(chat, mod, panel)
  }
  const runCommand = (chat: Chat, modId: unknown, commandId: unknown) => {
    const mod = modFor(String(modId))
    if (!isOn(mod)) throw new Error(`${mod.name} is off`)
    const command = mod.commands?.find((c) => c.id === commandId)
    if (!command || !offeredBy(mod, command, chat)) throw new Error(`${mod.name} has no command "${commandId}" here`)
    callMod(mod, () => command.run(detailOf(chat), contextOf(mod)))
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
      callMods('onChatRemoved', (mod, context) => mod.onChatRemoved!(detail, context))
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

  for (const { id, name } of modChats) loadChat(join(chatsDir, id), freshInfo(id, name))
  for (const id of readdirSync(chatsDir)) {
    if (chats.has(id) || !existsSync(join(chatsDir, id, 'chat.json'))) continue
    loadChat(join(chatsDir, id), freshInfo(id, id))
  }
  // Nothing runs yet, so a subagent that has worked and is still here (Kothar quit or crashed mid-task, or an older
  // Kothar kept it) goes now.
  for (const chat of chats.values()) {
    if (!chat.info.subagent || !chat.entries.length) continue
    chats.delete(chat.info.id)
    rmSync(chat.dir, { recursive: true, force: true })
  }

  const createChat = (spec: NewChat & { parentId?: string; subagent?: boolean; role?: ModelRole }) => {
    const name = checkName(spec.name)
    if (spec.engine !== undefined) {
      checkEngine(spec.engine)
      checkEnabled(spec.engine)
    }
    const parent = spec.subagent ? chatFor(spec.parentId ?? '') : undefined
    const role = parent ? (spec.role ?? 'subagents') : undefined
    // Named engine: the chat's own pick of that engine's first model in its list, else the engine's default model.
    // Otherwise it follows its list (a subagent: its role's, else Subagents', else Chat's).
    const pin = spec.engine === undefined ? undefined : models.pinOn(spec.engine, role)
    const engine = spec.engine ?? models.engineFor(role)
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
        role,
        parentMessages: parentMemory.messages.length,
      }),
      folders,
      files,
      engine,
      archived: false,
      createdAt: new Date().toISOString(),
      ...pin,
    }
    const chat = loadChat(join(chatsDir, id), info)
    if (parentMemory?.messages.length) {
      const view = memoryView(parentMemory.messages, parentMemory.summaries, { zoom: takesMcp(engine) })
      writeFileSync(join(chat.dir, PARENT_VIEW_FILE), view)
    }
    broadcast({ type: 'chat.added', chat: state(chat) })
    callMods('onChatCreated', (mod, context) => mod.onChatCreated!(detailOf(chat), context))
    return chat.info
  }

  const updateChat = (chat: Chat, change: Partial<ChatInfo>) => {
    const merged = Object.entries({ ...chat.info, ...change }).filter(([, value]) => value !== undefined)
    chat.info = Object.fromEntries(merged) as ChatInfo
    saveChat(chat)
    broadcast({ type: 'chat.updated', chat: withRun(chat) })
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
    for (const c of family) {
      callMods('onChatArchived', (mod, context) => mod.onChatArchived!(detailOf(c), archived, context))
    }
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
    if (community.has(mod.id) && !communityOn() && enabled) {
      throw new Error(`Turn on community mods before turning on ${mod.name}`)
    }
    const family = (mod.chats ?? []).flatMap(({ id }) => {
      const chat = chats.get(id)
      return chat ? familyOf(chat) : []
    })
    const busy = family.find((chat) => chat.status !== 'idle')
    if (busy && !enabled) throw new Error(`Stop "${busy.info.name}" before turning ${mod.name} off`)
    const changed = isOn(mod) !== enabled
    saveMod(mod, { enabled })
    if (community.has(mod.id)) restartChanged()
    if (enabled) void checkSetup(mod)
    if (changed) modSwitched(mod, enabled, family)
  }

  // What follows a mod starting or stopping to run: its chats show or hide, spawned processes stop, panels update.
  const modSwitched = (mod: Mod, enabled: boolean, family = familyOfMod(mod)) => {
    if (!enabled) stopSpawned(mod)
    if (enabled) family.toReversed().forEach((chat) => broadcast({ type: 'chat.added', chat: state(chat) }))
    else family.forEach((chat) => broadcast({ type: 'chat.removed', chatId: chat.info.id }))
    if (mod.panels?.length || mod.commands?.length) shownChats().forEach((chat) => broadcast(modsOf(chat)))
  }
  const familyOfMod = (mod: Mod) =>
    (mod.chats ?? []).flatMap(({ id }) => {
      const chat = chats.get(id)
      return chat ? familyOf(chat) : []
    })

  // The master switch. Off stops every community mod's hooks at once (its code stays loaded until a restart); on lets
  // the ones whose own switch is on run, from the next start for any not loaded yet.
  const setCommunityMods = (enabled: boolean) => {
    if (communityOn() === enabled) return
    const running = mods.filter((mod) => community.has(mod.id) && ownSwitch(mod))
    if (!enabled) {
      const busy = running.flatMap((mod) => familyOfMod(mod)).find((chat) => chat.status !== 'idle')
      if (busy) throw new Error(`Stop "${busy.info.name}" before turning community mods off`)
    }
    settings.communityMods = enabled
    saveSettings()
    broadcast({ type: 'communityMods.updated', enabled })
    for (const mod of running) {
      if (enabled) void checkSetup(mod)
      modSwitched(mod, enabled)
    }
    restartChanged()
  }

  // Community mod code this run doesn't match the settings: what a restart would start, update or stop.
  const restartState = (): RestartState => {
    const changes: RestartChange[] = []
    for (const [id, { manifest }] of community) {
      const mod = mods.find((m) => m.id === id)
      const wanted = !!mod && isOn(mod)
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

  // A community mod was installed or updated. It runs from the next start; an update that uses more than the version
  // the user turned on is turned off until they turn it on again.
  const communityChanged = (id: string, added: ModUse[]) => {
    const install = installedMods(garage).find((m) => m.manifest.id === id)
    if (!install) return
    const known = community.get(id)
    community.set(id, { ...known, manifest: install.manifest, item: install.item })
    if (imported.has(id)) reinstalled.add(id)
    const at = mods.findIndex((m) => m.id === id)
    if (at < 0) mods.push(stubOf(install.manifest))
    else if (!known?.running) mods[at] = stubOf(install.manifest)
    const mod = mods.find((m) => m.id === id)!
    if (added.length && ownSwitch(mod)) {
      setModEnabled(mod, false)
      const more = added.map((use) => MOD_USES[use].toLowerCase()).join('; ')
      broadcast({
        type: 'error',
        message: `${mod.name} was turned off: its update also ${more}. Turn it on again in Community mods to allow that.`,
      })
    }
    broadcast({ type: 'mod.updated', mod: modInfo(mod) })
    restartChanged()
  }

  // Turns the mod off and deletes its files. Its storage in <garage>/mods/<id>/ stays, as a stock mod's does.
  const uninstallMod = (id: string) => {
    const mod = mods.find((m) => m.id === id)
    if (!community.has(id) || !mod) return marketplace.uninstall('mod', id)
    if (ownSwitch(mod)) setModEnabled(mod, false)
    marketplace.uninstall('mod', id)
    const { enabled: _, ...kept } = settings.mods?.[id] ?? {}
    settings.mods = { ...settings.mods, [id]: kept }
    saveSettings()
    community.delete(id)
    hosts.delete(id)
    mods.splice(mods.indexOf(mod), 1)
    broadcast({ type: 'mod.removed', modId: id })
    restartChanged()
  }

  const setModel = (chat: Chat, engine?: string, model?: string, thinking?: string) => {
    if (chat.status !== 'idle') throw new Error('Wait for the turn to end before changing the model')
    if (model !== undefined) {
      checkEngine(engine ?? chat.info.engine)
      checkEnabled(engine ?? chat.info.engine)
    }
    updateChat(chat, models.choose(chat.info, engine, model, thinking))
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
    familyOf(chat).forEach((c) => {
      broadcast({ type: 'chat.context', chatId: c.info.id, items: contextItems(c) })
      broadcast(modsOf(c))
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
      const branch = freeName(`kothar/${slug.replace(/^-|-$/g, '') || 'space'}`, (b) => branches.includes(b))
      const taken = Object.values(space.info.worktrees ?? {}).map((w) => w.path)
      const path = freeName(join(workDir, basename(folder)), (p) => taken.includes(p) || existsSync(p))
      const from = await git(folder, 'rev-parse', '--abbrev-ref', 'HEAD').catch(() => '')
      await git(folder, 'worktree', 'add', '--no-track', '-b', branch, path, 'HEAD')
      worktree = { path, branch, ...(from && from !== 'HEAD' && { from }) }
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

  // What a sandboxed chat may write in a git folder's repository to use its checkout, and the branches checked out
  // elsewhere that it may not move.
  const gitAccess = async (folder: string, workDir: string) => {
    const gitDir = await git(folder, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    const listed = PROTECT_CHECKED_OUT_BRANCHES ? await git(folder, 'worktree', 'list', '--porcelain') : ''
    const readOnly = listed.split('\n\n').flatMap((entry) => {
      const path = entry.match(/^worktree (.+)$/m)?.[1]
      const ref = entry.match(/^branch (.+)$/m)?.[1]
      return path && ref && !within(path, workDir) ? [join(gitDir, ref), `${join(gitDir, ref)}.lock`] : []
    })
    return { writable: GIT_WRITABLE.map((path) => join(gitDir, path)), readOnly }
  }

  const checkoutOf = async (space: Chat, folder: string, workDir: string, sandboxed: boolean): Promise<Checkout> => {
    try {
      const worktree = await worktreeOf(space, folder, workDir)
      if (!sandboxed) return { folder, worktree, writable: [], readOnly: [] }
      return { folder, worktree, ...(await gitAccess(folder, workDir)) }
    } catch (error) {
      throw new Error(`Couldn't check out ${folder} in the work folder: ${messageOf(error)}`)
    }
  }

  // Where a command a mod starts for a chat runs, and its sandbox: the chat's own, over the space's work folder and the
  // checkouts it has now. Nothing is checked out for it.
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

  // What each mod has running from host.spawn, so turning the mod off stops it.
  const spawned = new Map<string, Set<{ kill(): void }>>()
  const stopSpawned = (mod: Mod) => {
    for (const proc of spawned.get(mod.id) ?? []) proc.kill()
  }
  const spawnFor =
    (mod: Mod): ModHost['spawn'] =>
    async (command, args, options = {}) => {
      if (quitting) throw new Error('Kothar is quitting')
      if (!isOn(mod)) throw new Error(`${mod.name} is off`)
      const chat = options.chat === undefined ? undefined : chatFor(options.chat)
      const place = chat ? await commandPlaceOf(chat) : undefined
      const cwd = options.cwd ?? place?.workDir ?? '/'
      const proc = machine.spawn(command, args, {
        cwd,
        ...(options.env && { env: options.env }),
        ...(place?.sandbox && { sandbox: place.sandbox }),
      })
      const running = spawned.get(mod.id) ?? new Set()
      spawned.set(mod.id, running)
      running.add(proc)
      proc.onExit(() => running.delete(proc))
      // Nothing reads its stdin, but some watchers stop when it closes, so it stays open.
      return {
        onOutput: (listener) => proc.onStdout(listener),
        onExit: (listener) => proc.onExit(listener),
        stop: () => proc.kill(),
      }
    }

  // Only a folder Kothar made for this space, whatever chat.json says.
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
    const run = models.runOf(chat.info)
    if (run && run.engine !== chat.info.engine) updateChat(chat, { engine: run.engine })
    const cant = run ? undefined : models.whyNot(chat.info)
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
    chat.turn = { text: '', tools: [] }
    setStatus(chat, 'running')
    const started = { chat: detailOf(chat), text: continuation ?? text, continued: continuation !== undefined }
    callMods('onTurnStarted', (mod, context) => mod.onTurnStarted!(started, context))

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
    const forSession = { chat: detailOf(chat), tools: zoomable }
    const modInstructions = watchersOf('instructions').flatMap((mod) => {
      try {
        const text = mod.instructions!(forSession, contextOf(mod))
        if (text === undefined || text === null) return []
        if (typeof text !== 'string') throw new Error('instructions must return text')
        return text.trim() ? [text.trim()] : []
      } catch (error) {
        modError(mod, error)
        return []
      }
    })
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
      const parts = [...(role ? [role] : []), ...rules, ...modInstructions, ...memory, ...contextText]
      const instructions = parts.join('\n\n')
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
          const message = `Kothar lets this chat edit only inside ${workDir}. ${OUTSIDE_EDIT_ADVICE}`
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
      // Where each tool sits in chat.turn.tools, counting from 1.
      const toolIds = new Map<string, number>()
      const emit = (event: EngineEvent) => {
        if (chat.session !== session) return
        const at = new Date().toISOString()
        for (const mod of watchersOf('onEvent')) callMod(mod, () => mod.onEvent!(detailOf(chat), event, contextOf(mod)))
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
          // An engine may wait out the limit; a mod that reacts to it gets the chat idle.
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
        const own = verdictOf(event)
        // The core's denials stand; otherwise a mod's policy goes first.
        if (own?.allow === false) return settle(own)
        const fromMods = modVerdict(event, chat)
        if (!(fromMods instanceof Promise)) return settle(fromMods ?? own)
        // Pending, so the user can still answer it while a mod decides; whoever answers first wins.
        chat.pendingRequests.set(requestId, 'permission')
        void fromMods.then((verdict) => {
          if (chat.session !== session || chat.pendingRequests.get(requestId) !== 'permission') return
          settle(verdict ?? own)
        })
      }

      try {
        chat.mcpToken = zoomable ? mcp.grant(chat.info.id) : undefined
        const kotharMcp = mcpUrl && chat.mcpToken ? { url: mcpUrl, token: chat.mcpToken } : undefined
        const { model, thinking } = run ?? {}
        const mcpServers = adapter.kotharMcp ? modServers(chat, workDir, jail !== undefined) : []
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
    seesAll: (chatId) => modChats.some((chat) => chat.id === chatId && chat.seesAll),
    createChat,
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
    subagents: () => {
      const { enabled, values } = modInfo(SUBAGENTS_MOD)
      return { enabled, limit: Number(values.limit) }
    },
    memory: (chatId) => memoryOf(chatFor(chatId)),
    modTools: () =>
      mods
        .filter(isOn)
        .flatMap((mod) => (mod.tools ?? []).map((tool) => ({ tool, values: modValues(mod), host: hostFor(mod) }))),
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
      models.settle()
      followModels()
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
    modelLists: models.lists,
    memory: () => settings.memory ?? {},
    chats: () => shownChats().map(state),
    workFolder,
    setWorkFolder,
    themes: marketplace.themes,
    installed: marketplace.installed,
    communityMods: communityOn,
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
          return reply(modsOf(chat))
        }
        case 'mod.panel.get':
          return openPanel(chatFor(message.chatId), message.mod, message.panel)
        case 'mod.panel.action': {
          const chat = chatFor(message.chatId)
          panelOf(message.mod, message.panel)
          return void panelAction(chat, message.mod, message.panel, message.action).catch((error) =>
            broadcast({ type: 'error', message: messageOf(error) }),
          )
        }
        case 'mod.command':
          return runCommand(chatFor(message.chatId), message.mod, message.command)
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
        case 'communityMods.setEnabled':
          return setCommunityMods(message.enabled === true)
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
          if (kind === 'mod' && stockIds.has(id)) {
            return reply({ type: 'market.installFailed', kind, id, error: `A built-in mod is already called "${id}"` })
          }
          return void marketplace.install(kind, id).then(
            ({ added }) => {
              if (kind === 'mod') communityChanged(id, added)
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
            if (typeof id === 'string' && stockIds.has(id)) throw new Error(`A built-in mod is already called "${id}"`)
            result = marketplace.installLocal(path)
          } catch (error) {
            return reply({ type: 'market.localFailed', path, error: messageOf(error) })
          }
          const { kind, ids, added } = result
          if (kind === 'mod') communityChanged(ids[0]!, added)
          marketChanged(kind)
          return reply({ type: 'market.localInstalled', path, kind, ids })
        }
        case 'market.uninstall':
          if (message.kind === 'mod') uninstallMod(String(message.id))
          else marketplace.uninstall(message.kind, message.id)
          return marketChanged(message.kind)
        case 'search': {
          const spaces = shownChats().filter((c) => !c.info.subagent)
          const hits = searchChats(
            spaces.map((c) => ({ id: c.info.id, name: c.info.name, entries: c.entries })),
            String(message.query ?? ''),
          )
          return reply({ type: 'search.results', id: Number(message.id), query: String(message.query ?? ''), hits })
        }
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
