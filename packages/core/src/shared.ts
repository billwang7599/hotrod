import type {
  ModelRole as ApiModelRole,
  Answers,
  Attachment,
  ChatEntry,
  ChatStatus,
  CompletionRequest,
  EngineEvent,
  McpServer,
  ExtensionAction,
  ExtensionSetting,
  ExtensionUse,
  ExtensionValues,
  ExtensionView,
  ExtensionWait,
} from '@kothar/extension-api'

export type {
  Answers,
  ChatEntry,
  ChatStatus,
  CompletionRequest,
  EngineEvent,
  MemoryMessage,
  MessageKind,
  Question,
  ToolKind,
} from '@kothar/extension-api'

export interface EngineProcess {
  write(data: string): void
  closeStdin(): void
  kill(): void
  onStdout(listener: (chunk: string) => void): void
  onExit(listener: (code: number | null, stderrTail: string) => void): void
}

// Each path covers everything under it; one ending in * is a prefix (`auth.json.lock*`). readOnly wins over writable.
export type Sandbox = { writable: string[]; readOnly?: string[]; tmpDir?: string }

export type SpawnOptions = { cwd: string; env?: Record<string, string>; sandbox?: Sandbox }

export interface Machine {
  canSandbox: boolean
  spawn(command: string, args: string[], options: SpawnOptions): EngineProcess
  run(
    command: string,
    args: string[],
    options: SpawnOptions & {
      input?: string
      timeoutMs?: number
      onStdout?: (chunk: string) => void
      signal?: AbortSignal
    },
  ): Promise<{ code: number | null; stdout: string; stderr: string }>
  stopAll(): Promise<void>
}

// One set of thinking levels for every engine, cheapest first, named as Claude Code's --effort and pi's --thinking
// name them. Each adapter says which ones each of its models takes.
export const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

export const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
  THINKING_LEVELS.includes(value as ThinkingLevel)

// thinking: the levels this model takes, when they differ from its engine's list; empty when it takes none.
export type ModelOption = { id: string; label: string; thinking?: ThinkingLevel[] }

export type EngineStatus = {
  installed: boolean
  signedIn: boolean
  detail?: string
  models?: string[]
  thinking?: ThinkingLevel[]
  // Per model id, the levels a model takes when they differ from `thinking` ([] when it takes none).
  modelThinking?: Record<string, ThinkingLevel[]>
  // What the engine runs with no model or level given. Only used to fill in the Chat model list when it has nothing
  // that can run, so what runs is always a row the user can see.
  defaultModel?: string
  defaultThinking?: ThinkingLevel
}

export type EngineInfo = Omit<EngineStatus, 'models'> & {
  id: string
  // How the UI names the engine, e.g. "Claude Code"; the id when the adapter gives none.
  name?: string
  enabled: boolean
  models?: ModelOption[]
  steering?: boolean
}

export type SessionOptions = {
  cwd: string
  instructions: string
  accountDir?: string
  apiKey?: string
  kotharMcp?: { url: string; token: string }
  mcpServers?: McpServer[]
  extraDirs?: string[]
  readFiles?: string[]
  model?: string
  thinking?: ThinkingLevel
  sandbox?: Sandbox
}

export type ImageInput = { mimeType: string; base64: string }

export type CompleteOptions = CompletionRequest & {
  cwd: string
  model: string
  accountDir?: string
  apiKey?: string
  sandbox?: Sandbox
}

export interface Session {
  prompt(text: string, images?: ImageInput[]): void
  interrupt(): void
  respond(requestId: string, allow: boolean, message?: string): void
  answer?(requestId: string, answers?: Answers): void
  // Steering: hands the running turn a message to take in at its next tool boundary. The session later emits
  // steer.landed (where it entered the turn) or steer.returned (not taken in) for the id. Only engines that can.
  steer?(id: string, text: string, images?: ImageInput[]): void
  close(): void
}

// note: why a login the engine has can't be used by Kothar's sessions, shown on its account row.
export type AccountStatus = { signedIn: boolean; label?: string; note?: string }

// noCode: the sign-in finishes on its own once the browser redirects back, with no code for the user to paste.
// instructions: what the sign-in page will ask for, such as a device code to type in.
export type LoginEvent =
  | { type: 'url'; url: string; noCode?: boolean; instructions?: string }
  | { type: 'done' }
  | { type: 'failed'; error: string }

// How an engine that signs in to more than one provider (model vendor) adds an account: per provider, each way it
// takes, a browser sign-in or an API key. Engines with one provider offer none.
export type AccountMethod = { id: string; label: string; kind: 'login' | 'apiKey' }
export type AccountProvider = { id: string; name: string; group?: string; methods: AccountMethod[] }
export type AccountChoice = { provider: string; method: string }

export interface LoginFlow {
  submitCode(code: string): void
  cancel(): void
}

export interface Adapter {
  id: string
  name?: string
  detect(machine: Machine): Promise<EngineStatus>
  start(machine: Machine, options: SessionOptions, emit: (event: EngineEvent) => void): Session
  complete?(machine: Machine, options: CompleteOptions): Promise<string>
  imageInput?: boolean
  kotharMcp?: boolean
  // Its sessions have steer, so the UI can say Enter steers.
  steering?: boolean
  accounts?: {
    status(machine: Machine, accountDir?: string): Promise<AccountStatus>
    login(machine: Machine, accountDir: string, emit: (event: LoginEvent) => void, choice?: AccountChoice): LoginFlow
    logout(machine: Machine, accountDir: string): Promise<void>
    apiKeys?: boolean
    // The providers an account can be for. Adding one then takes a provider and one of its methods.
    providers?(machine: Machine): Promise<AccountProvider[]>
    // Saves an API key in the account's folder the engine's own way. Without it, the core keeps the key and hands it
    // to sessions as apiKey.
    addApiKey?(machine: Machine, accountDir: string, key: string, choice?: AccountChoice): Promise<void>
  }
}

export type Account = {
  id: string
  name: string
  kind: 'login' | 'apiKey'
  label?: string
  signedIn?: boolean
  note?: string
  // The provider it's for, on engines that offer providers.
  provider?: string
}

export type EngineAccounts = {
  engine: string
  active: string
  apiKeys: boolean
  accounts: Account[]
  // instructions: what the sign-in page asks for, such as a device code. adding: a key being saved, with no link.
  login?: { name: string; url?: string; noCode?: boolean; instructions?: string; error?: string; adding?: boolean }
  providers?: AccountProvider[]
}

export const PERMISSION_DEFAULTS = {
  editAnywhere: false,
  autoRunCommands: true,
  autoNetworkCommands: false,
  autoEnvCommands: false,
  autoFetch: true,
  autoRead: true,
}

export type PermissionSwitch = keyof typeof PERMISSION_DEFAULTS

export const PERMISSION_SWITCHES = Object.keys(PERMISSION_DEFAULTS) as PermissionSwitch[]

export type PermissionSwitches = Partial<Record<PermissionSwitch, boolean>>

export const switchedOn = (name: PermissionSwitch, ...layers: PermissionSwitches[]) =>
  layers.find((layer) => layer[name] !== undefined)?.[name] ?? PERMISSION_DEFAULTS[name]

export const ASK_FIRST_COMMANDS = ['git push', 'npm publish', 'gh', 'curl', 'wget', 'ssh', 'scp', 'rsync']

export type ChatInfo = PermissionSwitches & {
  id: string
  name: string
  extension?: string
  parentId?: string
  worker?: boolean
  parentMessages?: number
  folders: string[]
  files: string[]
  // The engine the chat runs on. With `model` set, the two are the chat's own pick and stay put; without it, the core
  // keeps `engine` on whatever the chat's model list picks.
  engine: string
  archived: boolean
  // Spaces only: pinned ones sit in their own group at the top; `order` is the place within its group, set when the
  // user moves or pins one. A space without it (a new one) sits above the ordered ones, newest first.
  pinned?: boolean
  order?: number
  createdAt: string
  role?: ModelRole
  model?: string
  thinking?: ThinkingLevel
  workDir?: string
  worktrees?: Record<string, Worktree>
  // The mode the user picked for a folder that isn't a git repo, by path: a folder of this chat's or one it inherits.
  // A folder without one takes the nearest chat above's, else DEFAULT_FOLDER_MODE (folder-modes.ts).
  folderModes?: Record<string, FolderMode>
  // When its last turn ended, and when the user last saw it (core clock, ISO). Unread: a turn ended since it was seen.
  doneAt?: string
  readAt?: string
  // Spaces only: each extension's spaceSettings as saved, by extension id.
  extensionValues?: Record<string, Record<string, unknown>>
  // The id of the setup the chat uses (Settings → Setups). A worker uses one only when its spawn names it.
  setup?: string
}

/**
 * A saved setup for a kind of job (Settings → Setups), kept as `<garage>/setups/<id>.json`. Everything but the name is
 * optional; what a setup leaves out follows Settings. A chat's own model and thinking picks win over the setup's.
 * `extensionsOff`: extensions that are on in Settings but left out of this setup's sessions (their tools, MCP
 * servers, instructions, message and output transforms, permission answers, memory and workers). A setup can't turn on an
 * extension that's off in Settings, since it hasn't started. `instructions` join each session's instructions just
 * before the context items.
 */
export type Setup = {
  id: string
  name: string
  engine?: string
  model?: string
  thinking?: ThinkingLevel
  extensionsOff?: string[]
  instructions?: string
}

export const MAX_SETUP_INSTRUCTIONS = 20_000

/** Finished since the user last saw it; chats from before read state existed have no doneAt until their next turn. */
export const isUnread = (chat: Pick<ChatInfo, 'doneAt' | 'readAt'>) =>
  chat.doneAt !== undefined && (chat.readAt === undefined || chat.doneAt > chat.readAt)

// from: the branch the folder was on when it was checked out.
export type Worktree = { path: string; branch: string; from?: string }

/** How spaces sort in the sidebar: pinned first, then unordered (newest first), then by `order`. */
export function bySpaceOrder(a: Pick<ChatInfo, 'pinned' | 'order' | 'createdAt'>, b: typeof a): number {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
  if ((a.order === undefined) !== (b.order === undefined)) return a.order === undefined ? -1 : 1
  return (a.order ?? 0) - (b.order ?? 0) || b.createdAt.localeCompare(a.createdAt)
}

// terminal: the app Open in Terminal uses, absent for automatic; terminals: the ones the user can pick, only where
// there's a choice (macOS). editor: what a file link opens with, absent for the system's default app ('custom' runs
// editorCommand); editors: the installed editors Kothar knows.
export type WorkFolder = PermissionSwitches & {
  path?: string
  defaultPath: string
  canSandbox: boolean
  terminal?: string
  terminals?: { id: string; name: string }[]
  editor?: string
  editorCommand?: string
  editors?: { id: string; name: string }[]
}

// Layers nearest first: a chat, the chats above it, then the work folder's defaults.
export const editsAnywhere = (...layers: PermissionSwitches[]) => switchedOn('editAnywhere', ...layers)

export const MODEL_ROLES = ['chat', 'planning', 'searching', 'workers'] as const

export type ModelRole = (typeof MODEL_ROLES)[number]
// The extension API names the same roles; this fails to compile if the two lists drift apart.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
export const ROLES_MATCH_EXTENSION_API: Same<ModelRole, ApiModelRole> = true

export const ROLE_NAMES: Record<ModelRole, string> = {
  chat: 'Chat',
  planning: 'Planning',
  searching: 'Searching',
  workers: 'Workers',
}

// One entry in a role's model list: a model on an engine, and the thinking level it runs at there. `thinking` is left
// out only for a model that takes no levels, or until its engine has said which it takes.
export type ModelRow = { engine: string; model: string; thinking?: ThinkingLevel }

// One list per role, shared by every engine; a list can mix engines.
export type ModelLists = Record<ModelRole, ModelRow[]>

export const NO_LISTS: ModelLists = { chat: [], planning: [], searching: [], workers: [] }

/** The thinking levels a model takes: its own list if its engine gives one, else the engine's. */
export const levelsOf = (engine: EngineInfo | undefined, model?: string): ThinkingLevel[] =>
  engine?.models?.find((m) => m.id === model)?.thinking ?? engine?.thinking ?? []

// What a chat runs now: the engine, model and thinking level the core picked for it (models.ts). The core sends it
// with every chat and never saves it; it's absent when nothing can run.
export type Run = { engine: string; model: string; thinking?: ThinkingLevel }

export type ExtensionInfo = {
  id: string
  name: string
  description: string
  enabled: boolean
  settings: ExtensionSetting[]
  values: ExtensionValues
  setup?: SetupState
  // The extension's own part of its Settings page (Extension.settingsView), as drawn now, or why it couldn't be.
  settingsView?: { view?: ExtensionView; error?: string }
  loadError?: string
  // It has a chat of its own (Home). A setup can't leave it out of that chat, so setup forms don't list it.
  ownsChat?: boolean
  // A community extension: installed in the garage from the marketplace or a folder, and what it says it uses. running:
  // the version this run of Kothar loaded, if any; extensions load only at startup.
  community?: {
    version: string
    author: string
    uses: ExtensionUse[]
    source: 'marketplace' | 'local'
    repo?: string
    // The release installed (marketplace).
    tag?: string
    path?: string
    running?: string
    // The version the user last turned on, as Kothar recorded it; an extension runs only as those exact files.
    approved?: { version: string; uses: ExtensionUse[]; tag?: string }
    // Why it was turned off at startup: its files aren't the ones the user turned on.
    held?: string
  }
}

// A community extension whose code this run of Kothar doesn't match what the settings ask for, so it changes only when
// Kothar restarts: start (on, never loaded), update (loaded, then updated or reinstalled), stop (loaded, now off or
// uninstalled).
export type RestartChange = { id: string; name: string; change: 'start' | 'update' | 'stop' }

// What waits for a restart, and whether this Kothar can restart itself (the desktop app, or npm run dev's core).
export type RestartState = { changes: RestartChange[]; canRestart: boolean }

export type SetupState = {
  description: string
  status: 'checking' | 'missing' | 'installing' | 'ready'
  message?: string
  progressText?: string
  progress?: number
  error?: string
}

export function settingProblem(setting: ExtensionSetting, value: unknown) {
  if (setting.type === 'select') {
    if (setting.options.some((option) => option.value === value)) return undefined
    return `must be one of: ${setting.options.map((option) => option.label).join(', ')}`
  }
  if (setting.type === 'boolean') return typeof value === 'boolean' ? undefined : 'must be on or off'
  if (setting.type === 'text') return typeof value === 'string' ? undefined : 'must be text'
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number'
  if (setting.integer && !Number.isInteger(value)) return 'must be a whole number'
  if (setting.min !== undefined && value < setting.min) return `must be at least ${setting.min}`
  if (setting.max !== undefined && value > setting.max) return `must be at most ${setting.max}`
}

export type MemorySettings = { engine?: string; model?: string }

export const CONTEXT_SECTIONS = ['agents', 'folders', 'files'] as const

export type ContextSection = (typeof CONTEXT_SECTIONS)[number]

export const GLOBAL_CONTEXT = 'global'

export type ContextItem = {
  section: ContextSection
  path: string
  from: string
  enabled: boolean
  text: string
  binary?: boolean
  // Folders only: a git repo, checked out in the work folder whatever its mode.
  git?: true
  // Folders that aren't git repos: how agents may write in it, and why they can't when Kothar refuses the mode.
  mode?: FolderMode
  blocked?: string
  // Set to Work on a copy, once the copy is made: its path in the work folder.
  copy?: string
}

/** A file the agents changed in a folder's copy. conflict: the original changed since the copy was made. */
export type CopyChange = { path: string; kind: 'added' | 'changed' | 'deleted'; conflict?: true }

/**
 * How agents may write in an attached folder that isn't a git repo. edit: in the folder itself, inside the sandbox.
 * copy: in a copy the core makes in the work folder, which the user copies back. readOnly: nowhere. Git folders are
 * checked out in the work folder instead (design rule 10).
 */
export const FOLDER_MODES = ['edit', 'copy', 'readOnly'] as const
export type FolderMode = (typeof FOLDER_MODES)[number]
export const DEFAULT_FOLDER_MODE: FolderMode = 'edit'

const BINARY_SNIFF_BYTES = 8192

export const looksBinary = (bytes: Uint8Array) => bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)

export type NewChat = { name: string; engine?: string; folders?: string[]; files?: string[] }

export const MAX_ATTACHMENT_BYTES = 20_000_000
// Base64 grows by a third, which keeps 75 MB of files under the WebSocket's 100 MiB message limit.
export const MAX_ATTACHMENTS_TOTAL_BYTES = 75_000_000
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

export type { Attachment } from '@kothar/extension-api'

export type Upload = { name: string; mimeType: string; base64: string }

// A worker's final reply to its lead: which worker, and why its turn ended early, if it did.
export type WorkerReport = { chatId: string; name: string; error?: string }

// steering: handed to the running turn, waiting for its next tool boundary; it can't be taken back.
export type QueuedMessage = {
  id: string
  text: string
  attachments?: Attachment[]
  report?: WorkerReport
  steering?: true
}

// An extension's tab in the right sidebar, and an extension's action in the General tab, for one chat.
// placement, shortcut and launcher as the panel declares them (ExtensionPanel).
export type PanelTab = {
  extension: string
  id: string
  title: string
  placement?: 'tab' | 'popup' | 'dock'
  shortcut?: string
  launcher?: boolean
}
export type CommandInfo = { extension: string; id: string; label: string; hint?: string }
// An extension's button on the chat's messages (ExtensionMessageAction), and the entries it marks.
export type MessageActionInfo = {
  extension: string
  id: string
  label: string
  activeLabel?: string
  icon: 'pin' | 'bookmark' | 'star'
  hint?: string
  activeHint?: string
  kinds: ('user' | 'work' | 'talk')[]
  marked: number[]
}

export type ChatState = ChatInfo & {
  run?: Run
  status: ChatStatus
  entries: ChatEntry[]
  // Where entries starts in the chat's log: the UI gets the latest page, and asks for older ones (chat.history).
  // Absent: from the start.
  from?: number
  draft: string
  queue: QueuedMessage[]
  // What extensions are waiting on the user for, while the turn runs (ExtensionHost.wait).
  waits?: ChatWait[]
}

export type ChatWait = ExtensionWait & { extension: string }

export type ClientMessage =
  | { type: 'engine.setEnabled'; engine: string; enabled: boolean }
  | ({ type: 'chat.create' } & NewChat)
  | { type: 'chat.rename'; chatId: string; name: string }
  | { type: 'chat.archive'; chatId: string; archived: boolean }
  // Moves a space to `index` among the active spaces that are (un)pinned like `pinned`, pinning or unpinning it.
  | { type: 'chat.move'; chatId: string; pinned: boolean; index: number }
  | { type: 'chat.delete'; chatId: string }
  // The user has seen the chat's latest turn.
  | { type: 'chat.read'; chatId: string }
  // The page of the chat's log before entry `before`, reaching back to entry `to` if given.
  | { type: 'chat.history'; chatId: string; before: number; to?: number }
  // A model of the chat's own (on `engine`, else its current one), or none to follow its model list again; and a
  // thinking level of its own, or none to take the list's.
  | { type: 'chat.setModel'; chatId: string; engine?: string; model?: string; thinking?: ThinkingLevel }
  | { type: 'chat.setPermission'; chatId: string; name: PermissionSwitch; enabled?: boolean }
  // steer: hand it to the running turn if its engine can steer; otherwise, or without it, it waits for the turn to end.
  | { type: 'chat.send'; chatId: string; text: string; attachments?: Upload[]; steer?: boolean }
  | { type: 'chat.unqueue'; chatId: string; id: string }
  | { type: 'chat.interrupt'; chatId: string; force?: boolean }
  | { type: 'permission.respond'; chatId: string; requestId: string; allow: boolean }
  | { type: 'question.respond'; chatId: string; requestId: string; answers?: Answers }
  // Replies with chat.context and chat.extensions.
  | { type: 'context.get'; chatId: string }
  | { type: 'extension.panel.get'; chatId: string; extension: string; panel: string }
  | { type: 'extension.panel.action'; chatId: string; extension: string; panel: string; action: ExtensionAction }
  | { type: 'extension.space.set'; chatId: string; extension: string; key: string; value: string | number | boolean }
  | { type: 'extension.command'; chatId: string; extension: string; command: string }
  // One of an extension's message actions, on the message at entry in the chat's log.
  | { type: 'extension.message.action'; chatId: string; extension: string; action: string; entry: number }
  | { type: 'extension.wait.answer'; chatId: string; extension: string; button: string }
  | { type: 'context.add'; chatId: string; section: 'folders' | 'files'; path: string }
  | { type: 'context.remove'; chatId: string; section: 'folders' | 'files'; path: string }
  | { type: 'context.set'; chatId: string; path: string; enabled: boolean }
  | { type: 'context.folderMode'; chatId: string; path: string; mode: FolderMode }
  // A folder set to Work on a copy: what changed in its copy (replies context.copyChanges), and copying the picked
  // files back into the folder (replies context.copyChanges again, or with error). overwrite: the user confirmed
  // overwriting originals that changed since the copy was made.
  | { type: 'context.copyChanges'; chatId: string; path: string }
  | { type: 'context.copyBack'; chatId: string; path: string; files: string[]; overwrite?: boolean }
  | { type: 'context.write'; chatId: string; text: string }
  | { type: 'context.setDefault'; section: ContextSection; enabled: boolean }
  | { type: 'instructions.write'; text: string }
  | { type: 'workFolder.set'; path: string }
  | { type: 'permission.setDefault'; name: PermissionSwitch; enabled: boolean }
  | { type: 'extension.setEnabled'; extensionId: string; enabled: boolean }
  | { type: 'extension.setValue'; extensionId: string; key: string; value: string | number | boolean }
  | { type: 'extension.install'; extensionId: string }
  | { type: 'extension.cancelInstall'; extensionId: string }
  // Draws the extension's settings view again (the page opened), answered with extension.updated.
  | { type: 'extension.settingsView.get'; extensionId: string }
  | { type: 'extension.settingsView.action'; extensionId: string; action: ExtensionAction }
  // The master switch for community extensions (off by default): while it's off, none loads, whatever its own switch
  // says.
  | { type: 'communityExtensions.setEnabled'; enabled: boolean }
  // Stops every chat as quitting does, then starts Kothar again, so community extension changes apply.
  | { type: 'app.restart' }
  | { type: 'models.setList'; role: ModelRole; models: ModelRow[] }
  // Saves a setup: a new one without an id, else replaces the one with that id. Everyone gets setups.updated.
  | { type: 'setup.save'; setup: Omit<Setup, 'id'> & { id?: string } }
  // Removes a setup; chats that used it go back to Settings.
  | { type: 'setup.remove'; id: string }
  // The setup a chat uses, or none; applies from its next message.
  | { type: 'chat.setSetup'; chatId: string; setup?: string }
  | { type: 'memory.set'; engine?: string; model?: string }
  | { type: 'account.login'; engine: string; name: string; provider?: string; method?: string }
  | { type: 'account.code'; engine: string; code: string }
  | { type: 'account.addApiKey'; engine: string; name: string; key: string; provider?: string; method?: string }
  | { type: 'account.cancelLogin'; engine: string }
  | { type: 'account.use'; engine: string; accountId: string }
  | { type: 'account.remove'; engine: string; accountId: string }
  // Replies with marketplace.catalog.
  | { type: 'marketplace.list' }
  // Replies with themes.updated.
  | { type: 'themes.get' }
  // Installs the catalog entry from its repo's latest release, or updates it, then sends everyone market.installed (and
  // themes.updated for a theme); replies market.installFailed if it can't.
  | { type: 'market.install'; kind: MarketKind; id: string }
  | { type: 'market.uninstall'; kind: MarketKind; id: string }
  // Copies a folder on this computer (an extension or themes) as a local install; replies market.localInstalled or
  // market.localFailed.
  | { type: 'market.installLocal'; path: string }
  // Searches the message text of Home (while its extension is on) and every space, not workers. Replies search.results
  // with the same id, so a reply to an older query can be told apart.
  | { type: 'search'; id: number; query: string }
  // Opens the user's terminal app at one of the chat's folders: a context folder, its space's work folder or a
  // checkout. Replies terminal.result.
  | { type: 'terminal.open'; chatId: string; path: string }
  // 'auto' for the system's default terminal, or one of WorkFolder.terminals by id.
  | { type: 'terminal.set'; terminal: string }
  // Show in Finder, for an extension view's text with reveal: only inside Kothar's own folders (host.reveal's rule).
  | { type: 'reveal'; path: string }
  // Which of the paths a chat's messages mention exist in its folders, checkouts, work folder or garage folder, as
  // written (relative or absolute, without :line). Replies files.checked.
  | { type: 'files.check'; chatId: string; paths: string[] }
  // Opens a path files.checked found: with the editor in settings (at line and col where it can), or a terminal at
  // its folder. Errors come back as an error toast.
  | { type: 'file.open'; chatId: string; path: string; line?: number; col?: number; in?: 'editor' | 'terminal' }
  // 'system' for the system's default app, 'custom' for command, or one of WorkFolder.editors by id.
  | { type: 'editor.set'; editor: string; command?: string }

// One message matching a search. snippet is one line around the match, which sits at match.start; nth counts the
// earlier messages in the same chat that match too.
export type SearchHit = {
  chatId: string
  at: string
  kind: 'user' | 'text' | 'report'
  snippet: string
  match: { start: number; length: number }
  nth: number
  // Where the message is in the chat's log.
  entry: number
}

export const BAD_TOKEN_CLOSE_CODE = 4401

export type CoreMessage =
  | {
      type: 'snapshot'
      engines: EngineInfo[]
      chats: ChatState[]
      accounts: EngineAccounts[]
      contextDefaults: Record<ContextSection, boolean>
      extensions: ExtensionInfo[]
      modelLists: ModelLists
      setups: Setup[]
      memory: MemorySettings
      workFolder: WorkFolder
      themes: ThemeFile[]
      installed: InstalledItem[]
      communityExtensions: boolean
      restart: RestartState
    }
  | { type: 'engine.updated'; engine: EngineInfo }
  | { type: 'accounts.updated'; accounts: EngineAccounts }
  | { type: 'chat.added'; chat: ChatState }
  | { type: 'chat.updated'; chat: ChatInfo & { run?: Run } }
  | { type: 'chat.removed'; chatId: string }
  | { type: 'chat.entry'; chatId: string; entry: ChatEntry }
  // The answer to chat.history: the log's entries from `from` up to `before`.
  | { type: 'chat.history'; chatId: string; before: number; from: number; entries: ChatEntry[] }
  | { type: 'chat.delta'; chatId: string; text: string }
  | { type: 'chat.thinking'; chatId: string; text: string }
  | { type: 'chat.status'; chatId: string; status: ChatStatus }
  | { type: 'chat.queue'; chatId: string; queue: QueuedMessage[] }
  | { type: 'chat.waits'; chatId: string; waits: ChatWait[] }
  | { type: 'chat.context'; chatId: string; items: ContextItem[] }
  | {
      type: 'chat.extensions'
      chatId: string
      panels: PanelTab[]
      commands: CommandInfo[]
      // Absent: none.
      messageActions?: MessageActionInfo[]
    }
  | { type: 'extension.panel'; chatId: string; extension: string; panel: string; view?: ExtensionView; error?: string }
  | { type: 'context.file'; path: string; text: string }
  | { type: 'context.defaults'; defaults: Record<ContextSection, boolean> }
  // An extension that's new to the list (a community extension just installed) is added.
  | { type: 'extension.updated'; extension: ExtensionInfo }
  | { type: 'extension.removed'; extensionId: string }
  | { type: 'communityExtensions.updated'; enabled: boolean }
  | { type: 'restart.updated'; restart: RestartState }
  | { type: 'models.updated'; lists: ModelLists }
  | { type: 'setups.updated'; setups: Setup[] }
  // The answer to setup.save, to its sender only: the setup as saved, or why it was refused.
  | { type: 'setup.saved'; setup: Setup }
  | { type: 'setup.refused'; error: string }
  | { type: 'memory.updated'; memory: MemorySettings }
  | { type: 'workFolder.updated'; workFolder: WorkFolder }
  // The marketplace's entries, or why they couldn't be fetched (offline, say).
  | { type: 'marketplace.catalog'; entries?: MarketEntry[]; error?: string }
  // Every installed theme.
  | { type: 'themes.updated'; themes: ThemeFile[] }
  // Everything installed from the marketplace or a folder, and where each came from.
  | { type: 'market.installed'; items: InstalledItem[] }
  | { type: 'market.installFailed'; kind: MarketKind; id: string; error: string }
  | { type: 'market.localInstalled'; path: string; kind: MarketKind; ids: string[] }
  | { type: 'market.localFailed'; path: string; error: string }
  | { type: 'search.results'; id: number; query: string; hits: SearchHit[] }
  | { type: 'error'; message: string }
  // An extension's notification (host.notify); chatId: clicking it opens that chat.
  | { type: 'notify'; extension: string; title: string; body: string; chatId?: string }
  // An extension asks the UI to open one of its panels for the chat (host.showPanel), without taking focus.
  | { type: 'extension.panel.show'; chatId: string; extension: string; panel: string; placement: 'dock' | 'tab' }
  // The answer to terminal.open: error if no terminal opened.
  | { type: 'terminal.result'; chatId: string; path: string; error?: string }
  // copied: how many files the last copyBack copied back.
  | { type: 'context.copyChanges'; chatId: string; path: string; changes: CopyChange[]; copied?: number; error?: string }
  // The answer to files.check: each path asked about, to its absolute path or null if it isn't there.
  | { type: 'files.checked'; chatId: string; paths: Record<string, string | null> }

// Themes: Default and Glass are built into the UI; any other comes from the marketplace as a plain JSON file, checked
// strictly so a theme is only ever colours and can never carry CSS.
export const THEME_TOKENS = [
  'bg',
  'panel',
  'raised',
  'hover',
  'border',
  'text',
  'muted',
  'faint',
  'accent',
  'on-accent',
  'green',
  'amber',
  'red',
] as const

export type ThemeToken = (typeof THEME_TOKENS)[number]
export type ThemePalette = Record<ThemeToken, string>

// variants: what the theme calls its dark and light palettes, such as Mocha and Latte.
export type ThemeFile = {
  id: string
  name: string
  version: string
  author: string
  description: string
  variants?: { dark: string; light: string }
  dark: ThemePalette
  light: ThemePalette
}

// The colours a catalog entry shows before it's installed.
export const PREVIEW_TOKENS = ['accent', 'bg', 'panel', 'text'] as const satisfies readonly ThemeToken[]
export type ThemePreview = Record<'dark' | 'light', Record<(typeof PREVIEW_TOKENS)[number], string>>

export type MarketKind = 'theme' | 'extension'

// One entry of the marketplace's catalog.json: a pointer to the author's own GitHub repo, whose latest release carries
// what installs (a theme: <id>.json; an extension: manifest.json and main.mjs).
export type CatalogEntry = {
  id: string
  kind: MarketKind
  name: string
  author: string
  description: string
  repo: string
}

// A catalog entry with what its repo's latest release carries, or why that couldn't be read (problem). notes: the start of
// the release's notes, if it has any.
export type MarketEntry = CatalogEntry & {
  latest?: { tag: string; version: string; notes?: string; preview?: ThemePreview; uses?: ExtensionUse[] }
  problem?: string
}

// Something installed: from the marketplace (repo and tag), from a folder on this computer (path), or by an older Kothar
// that kept themes as single files (legacy).
export type InstalledItem = {
  kind: MarketKind
  id: string
  name: string
  version: string
  source: 'marketplace' | 'local' | 'legacy'
  repo?: string
  tag?: string
  path?: string
}

// GitHub's compare view from the installed release's tag to the latest one, to read before updating. None for an item
// installed from a folder or by an older Kothar (no tag), from another repo than the catalog's now, or already current.
export function changesUrl(item: InstalledItem, repo: string, latestTag: string): string | undefined {
  if (item.source !== 'marketplace' || !item.tag || item.repo !== repo || item.tag === latestTag) return undefined
  return `https://github.com/${repo}/compare/${encodeURIComponent(item.tag)}...${encodeURIComponent(latestTag)}`
}

// What a community extension can say it uses, as the user reads it before install. The keys are ExtensionUse, in this
// order.
export const EXTENSION_USES: Record<ExtensionUse, string> = {
  run: 'Runs programs on your computer',
  network: 'Reaches the internet',
  files: 'Reads or writes your files',
  setup: 'Installs software it needs',
  mcpServers: 'Starts MCP servers for agents',
  permissions: 'Approves or denies agents\' requests for you',
  sendMessages: 'Sends messages and starts chats as you',
  accounts: 'Sees and switches your engine accounts',
  models: 'Makes model calls on your accounts',
  memory: 'Decides what agents remember of each chat',
  readChats: 'Reads your chats',
  transforms: 'Rewrites your messages or agents\' replies',
  instructions: 'Adds to every agent\'s instructions',
  tools: 'Gives agents tools',
  events: 'Watches chats as they run',
  chats: 'Adds chats of its own',
  panels: 'Adds panels',
  commands: 'Adds commands',
  settings: 'Has settings',
}

export const isExtensionUse = (use: unknown): use is ExtensionUse => typeof use === 'string' && Object.hasOwn(EXTENSION_USES, use)

// In EXTENSION_USES order, so lists read the same everywhere.
export const sortUses = (uses: Iterable<ExtensionUse>) => {
  const set = new Set(uses)
  return (Object.keys(EXTENSION_USES) as ExtensionUse[]).filter((use) => set.has(use))
}

export const previewOf = (theme: ThemeFile): ThemePreview => ({
  dark: Object.fromEntries(PREVIEW_TOKENS.map((token) => [token, theme.dark[token]])) as ThemePreview['dark'],
  light: Object.fromEntries(PREVIEW_TOKENS.map((token) => [token, theme.light[token]])) as ThemePreview['light'],
})
