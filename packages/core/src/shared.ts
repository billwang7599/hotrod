import type { McpServer, ModSetting, ModValues } from '@hotrod/mod-api'

export type ToolKind = 'shell' | 'edit' | 'read' | 'search' | 'fetch' | 'mcp' | 'other'

export type EngineEvent =
  | { type: 'turn.started' }
  | { type: 'text.delta'; text: string }
  | { type: 'text.completed'; text: string }
  | { type: 'thinking.delta'; text: string }
  | { type: 'tool.started'; toolId: string; name: string; kind: ToolKind; summary: string; input: unknown }
  | { type: 'tool.completed'; toolId: string; output: string; isError: boolean }
  | {
      type: 'permission.requested'
      requestId: string
      toolId?: string
      name: string
      kind: ToolKind
      summary: string
      path?: string
      command?: string
      input: unknown
    }
  | { type: 'turn.completed'; error?: string }
  | { type: 'session.ended'; error?: string }

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

export type ModelOption = { id: string; label: string }

export type EngineStatus = {
  installed: boolean
  signedIn: boolean
  detail?: string
  models?: string[]
  thinking?: string[]
  defaultModel?: string
  defaultThinking?: string
}

export type EngineInfo = Omit<EngineStatus, 'models'> & { id: string; enabled: boolean; models?: ModelOption[] }

export type SessionOptions = {
  cwd: string
  instructions: string
  accountDir?: string
  apiKey?: string
  hotrodMcp?: { url: string; token: string }
  mcpServers?: McpServer[]
  extraDirs?: string[]
  readFiles?: string[]
  model?: string
  thinking?: string
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
  detect(machine: Machine): Promise<EngineStatus>
  start(machine: Machine, options: SessionOptions, emit: (event: EngineEvent) => void): Session
  complete?(machine: Machine, options: CompleteOptions): Promise<string>
  imageInput?: boolean
  hotrodMcp?: boolean
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

export const PERMISSION_DEFAULTS = { editAnywhere: false, autoRunCommands: true, askNetworkCommands: true }

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
  engine: string
  archived: boolean
  createdAt: string
  role?: ModelRole
  model?: string
  thinking?: string
  workDir?: string
  worktrees?: Record<string, Worktree>
}

export type Worktree = { path: string; branch: string }

export type WorkFolder = PermissionSwitches & { path?: string; defaultPath: string; canSandbox: boolean }

export const editsAnywhere = (chat: PermissionSwitches, workFolder: PermissionSwitches) =>
  switchedOn('editAnywhere', chat, workFolder)

export const MODEL_ROLES = ['chat', 'planning', 'searching', 'subagents'] as const

export type ModelRole = (typeof MODEL_ROLES)[number]

export type ModelLists = Record<ModelRole, string[]>

export function pickModel(engine: EngineInfo | undefined, lists: ModelLists, chat: Pick<ChatInfo, 'model' | 'role'>) {
  const offers = (id?: string) => engine?.models?.some((m) => m.id === id) ?? false
  if (offers(chat.model)) return chat.model
  const list = lists[chat.role ?? 'chat']
  return (list?.length ? list : lists.chat).find(offers) ?? engine?.defaultModel
}

export const pickThinking = (engine: EngineInfo | undefined, chat: Pick<ChatInfo, 'thinking'>) =>
  chat.thinking && engine?.thinking?.includes(chat.thinking) ? chat.thinking : engine?.defaultThinking

export type ModInfo = {
  id: string
  name: string
  description: string
  enabled: boolean
  settings: ModSetting[]
  values: ModValues
  setup?: SetupState
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

export type ChatStatus = 'idle' | 'running' | 'waiting' | 'stopping'

export type ChatEntry = { at: string } & (
  | { type: 'user.message'; text: string; attachments?: Attachment[] }
  | { type: 'permission.resolved'; requestId: string; allow: boolean; auto?: true }
  | Exclude<EngineEvent, { type: 'text.delta' | 'thinking.delta' }>
)

export const MAX_ATTACHMENT_BYTES = 20_000_000
// Base64 grows by a third, which keeps 75 MB of files under the WebSocket's 100 MiB message limit.
export const MAX_ATTACHMENTS_TOTAL_BYTES = 75_000_000
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

export type Attachment = { name: string; path: string; mimeType: string; size: number }

export type Upload = { name: string; mimeType: string; base64: string }

export type QueuedMessage = { id: string; text: string; attachments?: Attachment[] }

export type ChatState = ChatInfo & {
  status: ChatStatus
  entries: ChatEntry[]
  draft: string
  queue: QueuedMessage[]
}

export type ClientMessage =
  | { type: 'engine.setEnabled'; engine: string; enabled: boolean }
  | { type: 'engine.setDefaultThinking'; engine: string; thinking: string }
  | ({ type: 'chat.create' } & NewChat)
  | { type: 'chat.rename'; chatId: string; name: string }
  | { type: 'chat.archive'; chatId: string; archived: boolean }
  | { type: 'chat.delete'; chatId: string }
  | { type: 'chat.setEngine'; chatId: string; engine: string }
  | { type: 'chat.setModel'; chatId: string; model?: string; thinking?: string }
  | { type: 'chat.setPermission'; chatId: string; name: PermissionSwitch; enabled?: boolean }
  | { type: 'chat.send'; chatId: string; text: string; attachments?: Upload[] }
  | { type: 'chat.unqueue'; chatId: string; id: string }
  | { type: 'chat.interrupt'; chatId: string; force?: boolean }
  | { type: 'permission.respond'; chatId: string; requestId: string; allow: boolean }
  | { type: 'context.get'; chatId: string }
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
  | { type: 'models.setList'; engine: string; role: ModelRole; models: string[] }
  | { type: 'memory.set'; engine?: string; model?: string }
  | { type: 'account.login'; engine: string; name: string }
  | { type: 'account.code'; engine: string; code: string }
  | { type: 'account.addApiKey'; engine: string; name: string; key: string }
  | { type: 'account.cancelLogin'; engine: string }
  | { type: 'account.use'; engine: string; accountId: string }
  | { type: 'account.remove'; engine: string; accountId: string }

export const BAD_TOKEN_CLOSE_CODE = 4401

export type CoreMessage =
  | {
      type: 'snapshot'
      engines: EngineInfo[]
      chats: ChatState[]
      accounts: EngineAccounts[]
      contextDefaults: Record<ContextSection, boolean>
      mods: ModInfo[]
      modelLists: Record<string, ModelLists>
      memory: MemorySettings
      workFolder: WorkFolder
    }
  | { type: 'engine.updated'; engine: EngineInfo }
  | { type: 'accounts.updated'; accounts: EngineAccounts }
  | { type: 'chat.added'; chat: ChatState }
  | { type: 'chat.updated'; chat: ChatInfo }
  | { type: 'chat.removed'; chatId: string }
  | { type: 'chat.entry'; chatId: string; entry: ChatEntry }
  | { type: 'chat.delta'; chatId: string; text: string }
  | { type: 'chat.thinking'; chatId: string; text: string }
  | { type: 'chat.status'; chatId: string; status: ChatStatus }
  | { type: 'chat.queue'; chatId: string; queue: QueuedMessage[] }
  | { type: 'chat.context'; chatId: string; items: ContextItem[] }
  | { type: 'context.file'; path: string; text: string }
  | { type: 'context.defaults'; defaults: Record<ContextSection, boolean> }
  | { type: 'mod.updated'; mod: ModInfo }
  | { type: 'models.updated'; engine: string; lists: ModelLists }
  | { type: 'memory.updated'; memory: MemorySettings }
  | { type: 'workFolder.updated'; workFolder: WorkFolder }
  | { type: 'error'; message: string }
