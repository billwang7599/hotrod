import type {
  Answers,
  Attachment,
  ChatEntry,
  ChatStatus,
  EngineEvent,
  McpServer,
  ModAction,
  ModSetting,
  ModValues,
  ModView,
} from '@kotharhq/mod-api'

export type { Answers, ChatEntry, ChatStatus, EngineEvent, Question, ToolKind } from '@kotharhq/mod-api'

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

export type CompletionRequest = { system: string; prompt: string; schema?: object; timeoutMs: number }

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

export type AccountStatus = { signedIn: boolean; label?: string }

export type LoginEvent = { type: 'url'; url: string } | { type: 'done' } | { type: 'failed'; error: string }

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
    login(machine: Machine, accountDir: string, emit: (event: LoginEvent) => void): LoginFlow
    logout(machine: Machine, accountDir: string): Promise<void>
    apiKeys?: boolean
  }
}

export type Account = { id: string; name: string; kind: 'login' | 'apiKey'; label?: string; signedIn?: boolean }

export type EngineAccounts = {
  engine: string
  active: string
  apiKeys: boolean
  accounts: Account[]
  login?: { name: string; url?: string; error?: string }
}

export const PERMISSION_DEFAULTS = { editAnywhere: false, autoRunCommands: true, askNetworkCommands: true, autoFetch: true }

export type PermissionSwitch = keyof typeof PERMISSION_DEFAULTS

export const PERMISSION_SWITCHES = Object.keys(PERMISSION_DEFAULTS) as PermissionSwitch[]

export type PermissionSwitches = Partial<Record<PermissionSwitch, boolean>>

export const switchedOn = (name: PermissionSwitch, ...layers: PermissionSwitches[]) =>
  layers.find((layer) => layer[name] !== undefined)?.[name] ?? PERMISSION_DEFAULTS[name]

export const ASK_FIRST_COMMANDS = ['git push', 'npm publish', 'gh', 'curl', 'wget', 'ssh', 'scp', 'rsync']

export type ChatInfo = PermissionSwitches & {
  id: string
  name: string
  mod?: string
  parentId?: string
  subagent?: boolean
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
  // When its last turn ended, and when the user last saw it (core clock, ISO). Unread: a turn ended since it was seen.
  doneAt?: string
  readAt?: string
}

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

export type WorkFolder = PermissionSwitches & { path?: string; defaultPath: string; canSandbox: boolean }

// Layers nearest first: a chat, the chats above it, then the work folder's defaults.
export const editsAnywhere = (...layers: PermissionSwitches[]) => switchedOn('editAnywhere', ...layers)

export const MODEL_ROLES = ['chat', 'planning', 'searching', 'subagents'] as const

export type ModelRole = (typeof MODEL_ROLES)[number]

export const ROLE_NAMES: Record<ModelRole, string> = {
  chat: 'Chat',
  planning: 'Planning',
  searching: 'Searching',
  subagents: 'Subagents',
}

// One entry in a role's model list: a model on an engine, and the thinking level it runs at there. `thinking` is left
// out only for a model that takes no levels, or until its engine has said which it takes.
export type ModelRow = { engine: string; model: string; thinking?: ThinkingLevel }

// One list per role, shared by every engine; a list can mix engines.
export type ModelLists = Record<ModelRole, ModelRow[]>

export const NO_LISTS: ModelLists = { chat: [], planning: [], searching: [], subagents: [] }

/** The thinking levels a model takes: its own list if its engine gives one, else the engine's. */
export const levelsOf = (engine: EngineInfo | undefined, model?: string): ThinkingLevel[] =>
  engine?.models?.find((m) => m.id === model)?.thinking ?? engine?.thinking ?? []

// What a chat runs now: the engine, model and thinking level the core picked for it (models.ts). The core sends it
// with every chat and never saves it; it's absent when nothing can run.
export type Run = { engine: string; model: string; thinking?: ThinkingLevel }

export type ModInfo = {
  id: string
  name: string
  description: string
  enabled: boolean
  settings: ModSetting[]
  values: ModValues
  setup?: SetupState
  loadError?: string
}

export type SetupState = {
  description: string
  status: 'checking' | 'missing' | 'installing' | 'ready'
  message?: string
  progressText?: string
  progress?: number
  error?: string
}

export function settingProblem(setting: ModSetting, value: unknown) {
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
}

const BINARY_SNIFF_BYTES = 8192

export const looksBinary = (bytes: Uint8Array) => bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)

export type NewChat = { name: string; engine?: string; folders?: string[]; files?: string[] }

export const MAX_ATTACHMENT_BYTES = 20_000_000
// Base64 grows by a third, which keeps 75 MB of files under the WebSocket's 100 MiB message limit.
export const MAX_ATTACHMENTS_TOTAL_BYTES = 75_000_000
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

export type { Attachment } from '@kotharhq/mod-api'

export type Upload = { name: string; mimeType: string; base64: string }

// A subagent's final reply to its lead: which subagent, and why its turn ended early, if it did.
export type SubagentReport = { chatId: string; name: string; error?: string }

// steering: handed to the running turn, waiting for its next tool boundary; it can't be taken back.
export type QueuedMessage = {
  id: string
  text: string
  attachments?: Attachment[]
  report?: SubagentReport
  steering?: true
}

// A mod's tab in the right sidebar, and a mod's action in the General tab, for one chat.
export type PanelTab = { mod: string; id: string; title: string }
export type CommandInfo = { mod: string; id: string; label: string; hint?: string }

export type ChatState = ChatInfo & {
  run?: Run
  status: ChatStatus
  entries: ChatEntry[]
  draft: string
  queue: QueuedMessage[]
}

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
  // Replies with chat.context and chat.mods.
  | { type: 'context.get'; chatId: string }
  | { type: 'mod.panel.get'; chatId: string; mod: string; panel: string }
  | { type: 'mod.panel.action'; chatId: string; mod: string; panel: string; action: ModAction }
  | { type: 'mod.command'; chatId: string; mod: string; command: string }
  | { type: 'context.add'; chatId: string; section: 'folders' | 'files'; path: string }
  | { type: 'context.remove'; chatId: string; section: 'folders' | 'files'; path: string }
  | { type: 'context.set'; chatId: string; path: string; enabled: boolean }
  | { type: 'context.write'; chatId: string; text: string }
  | { type: 'context.setDefault'; section: ContextSection; enabled: boolean }
  | { type: 'instructions.write'; text: string }
  | { type: 'workFolder.set'; path: string }
  | { type: 'permission.setDefault'; name: PermissionSwitch; enabled: boolean }
  | { type: 'mod.setEnabled'; modId: string; enabled: boolean }
  | { type: 'mod.setValue'; modId: string; key: string; value: string | number | boolean }
  | { type: 'mod.install'; modId: string }
  | { type: 'mod.cancelInstall'; modId: string }
  | { type: 'models.setList'; role: ModelRole; models: ModelRow[] }
  | { type: 'memory.set'; engine?: string; model?: string }
  | { type: 'account.login'; engine: string; name: string }
  | { type: 'account.code'; engine: string; code: string }
  | { type: 'account.addApiKey'; engine: string; name: string; key: string }
  | { type: 'account.cancelLogin'; engine: string }
  | { type: 'account.use'; engine: string; accountId: string }
  | { type: 'account.remove'; engine: string; accountId: string }
  // Replies with marketplace.catalog.
  | { type: 'marketplace.list' }
  // Replies with themes.updated.
  | { type: 'themes.get' }
  // Downloads, checks and saves the theme, then sends everyone themes.updated; replies theme.installFailed if it can't.
  | { type: 'theme.install'; id: string }
  | { type: 'theme.uninstall'; id: string }
  // Searches the message text of Home (while its mod is on) and every space, not subagents. Replies search.results with
  // the same id, so a reply to an older query can be told apart.
  | { type: 'search'; id: number; query: string }

// One message matching a search. snippet is one line around the match, which sits at match.start; nth counts the
// earlier messages in the same chat that match too.
export type SearchHit = {
  chatId: string
  at: string
  kind: 'user' | 'text' | 'report'
  snippet: string
  match: { start: number; length: number }
  nth: number
}

export const BAD_TOKEN_CLOSE_CODE = 4401

export type CoreMessage =
  | {
      type: 'snapshot'
      engines: EngineInfo[]
      chats: ChatState[]
      accounts: EngineAccounts[]
      contextDefaults: Record<ContextSection, boolean>
      mods: ModInfo[]
      modelLists: ModelLists
      memory: MemorySettings
      workFolder: WorkFolder
      themes: ThemeFile[]
    }
  | { type: 'engine.updated'; engine: EngineInfo }
  | { type: 'accounts.updated'; accounts: EngineAccounts }
  | { type: 'chat.added'; chat: ChatState }
  | { type: 'chat.updated'; chat: ChatInfo & { run?: Run } }
  | { type: 'chat.removed'; chatId: string }
  | { type: 'chat.entry'; chatId: string; entry: ChatEntry }
  | { type: 'chat.delta'; chatId: string; text: string }
  | { type: 'chat.thinking'; chatId: string; text: string }
  | { type: 'chat.status'; chatId: string; status: ChatStatus }
  | { type: 'chat.queue'; chatId: string; queue: QueuedMessage[] }
  | { type: 'chat.context'; chatId: string; items: ContextItem[] }
  | { type: 'chat.mods'; chatId: string; panels: PanelTab[]; commands: CommandInfo[] }
  | { type: 'mod.panel'; chatId: string; mod: string; panel: string; view?: ModView; error?: string }
  | { type: 'context.file'; path: string; text: string }
  | { type: 'context.defaults'; defaults: Record<ContextSection, boolean> }
  | { type: 'mod.updated'; mod: ModInfo }
  | { type: 'models.updated'; lists: ModelLists }
  | { type: 'memory.updated'; memory: MemorySettings }
  | { type: 'workFolder.updated'; workFolder: WorkFolder }
  // The marketplace's entries, or why they couldn't be fetched (offline, say).
  | { type: 'marketplace.catalog'; entries?: CatalogEntry[]; error?: string }
  // Every installed theme.
  | { type: 'themes.updated'; themes: ThemeFile[] }
  | { type: 'theme.installFailed'; id: string; error: string }
  | { type: 'search.results'; id: number; query: string; hits: SearchHit[] }
  | { type: 'error'; message: string }

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

// One entry of the marketplace's index.json. path is relative to the index; sha256 is of the file's exact bytes. Only
// themes install today; kind leaves room for mods, which need signing and review before Kothar runs outside code.
export type CatalogEntry = {
  id: string
  kind: 'theme'
  name: string
  author: string
  description: string
  version: string
  path: string
  sha256: string
  preview?: ThemePreview
}

export const MAX_THEME_BYTES = 64 * 1024

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
// Lowercase only, so two ids can't name one file on a case-insensitive disk.
const ITEM_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/
const SHA256 = /^[0-9a-f]{64}$/

export const isItemId = (id: unknown): id is string => typeof id === 'string' && ITEM_ID.test(id)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function onlyKeys(value: unknown, what: string, required: readonly string[], optional: readonly string[] = []) {
  if (!isRecord(value)) throw new Error(`${what} must be an object`)
  const extra = Object.keys(value).find((key) => !required.includes(key) && !optional.includes(key))
  if (extra !== undefined) throw new Error(`${what} has an unknown field "${extra}"`)
  const missing = required.find((key) => !Object.hasOwn(value, key))
  if (missing !== undefined) throw new Error(`${what} is missing "${missing}"`)
  return value
}

function text(value: unknown, what: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`${what} must be text of 1 to ${max} characters`)
  }
  return value
}

function colors<K extends string>(value: unknown, what: string, tokens: readonly K[]) {
  const palette = onlyKeys(value, what, tokens)
  for (const token of tokens) {
    const color = palette[token]
    if (typeof color !== 'string' || !HEX_COLOR.test(color)) throw new Error(`${what} ${token} must be a hex colour`)
  }
  return palette as Record<K, string>
}

function itemFields(value: Record<string, unknown>, what: string) {
  if (!isItemId(value.id)) throw new Error(`${what} id must be lowercase letters, digits and dashes`)
  if (typeof value.version !== 'string' || !VERSION.test(value.version)) {
    throw new Error(`${what} version must look like 1.2.3`)
  }
  return {
    id: value.id,
    name: text(value.name, `${what} name`, 40),
    version: value.version,
    author: text(value.author, `${what} author`, 60),
    description: text(value.description, `${what} description`, 200),
  }
}

// Throws, saying why, unless value is a theme file with exactly the known fields.
export function checkTheme(value: unknown): ThemeFile {
  const fields = ['id', 'name', 'version', 'author', 'description', 'dark', 'light']
  const theme = onlyKeys(value, 'The theme', fields, ['variants'])
  const variants =
    theme.variants === undefined
      ? undefined
      : onlyKeys(theme.variants, 'The theme variants', ['dark', 'light'])
  return {
    ...itemFields(theme, 'The theme'),
    ...(variants && {
      variants: { dark: text(variants.dark, 'The dark variant', 30), light: text(variants.light, 'The light variant', 30) },
    }),
    dark: colors(theme.dark, 'The dark palette', THEME_TOKENS),
    light: colors(theme.light, 'The light palette', THEME_TOKENS),
  }
}

// Throws, saying why, unless value is a marketplace index: { entries: CatalogEntry[] } with unique ids.
export function checkCatalog(value: unknown): CatalogEntry[] {
  const index = onlyKeys(value, 'The marketplace index', ['entries'], ['version'])
  if (!Array.isArray(index.entries)) throw new Error('The marketplace index entries must be a list')
  const entries = index.entries.map((raw, i): CatalogEntry => {
    const required = ['id', 'kind', 'name', 'author', 'description', 'version', 'path', 'sha256']
    const entry = onlyKeys(raw, `Marketplace entry ${i + 1}`, required, ['preview'])
    const fields = itemFields(entry, `Marketplace entry ${i + 1}`)
    if (entry.kind !== 'theme') throw new Error(`Marketplace entry "${fields.id}" is a "${entry.kind}"; only themes install`)
    if (entry.path !== `themes/${fields.id}.json`) throw new Error(`Marketplace entry "${fields.id}" must live at themes/${fields.id}.json`)
    if (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) {
      throw new Error(`Marketplace entry "${fields.id}" needs a sha256`)
    }
    const preview =
      entry.preview === undefined
        ? undefined
        : onlyKeys(entry.preview, `The preview of "${fields.id}"`, ['dark', 'light'])
    return {
      ...fields,
      kind: 'theme',
      path: entry.path,
      sha256: entry.sha256,
      ...(preview && {
        preview: {
          dark: colors(preview.dark, `The dark preview of "${fields.id}"`, PREVIEW_TOKENS),
          light: colors(preview.light, `The light preview of "${fields.id}"`, PREVIEW_TOKENS),
        },
      }),
    }
  })
  const ids = entries.map((entry) => entry.id)
  const twin = ids.find((id, i) => ids.indexOf(id) !== i)
  if (twin !== undefined) throw new Error(`Two marketplace entries have the id "${twin}"`)
  return entries
}

export const previewOf = (theme: ThemeFile): ThemePreview => ({
  dark: Object.fromEntries(PREVIEW_TOKENS.map((token) => [token, theme.dark[token]])) as ThemePreview['dark'],
  light: Object.fromEntries(PREVIEW_TOKENS.map((token) => [token, theme.light[token]])) as ThemePreview['light'],
})
