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
      input: unknown
    }
  | { type: 'turn.completed'; error?: string; model?: string }
  | { type: 'session.ended'; error?: string }

export interface EngineProcess {
  write(data: string): void
  closeStdin(): void
  kill(): void
  onStdout(listener: (chunk: string) => void): void
  onExit(listener: (code: number | null, stderrTail: string) => void): void
}

export interface Machine {
  spawn(command: string, args: string[], options: { cwd: string; env?: Record<string, string> }): EngineProcess
  run(
    command: string,
    args: string[],
    options: { cwd: string; env?: Record<string, string> },
  ): Promise<{ code: number | null; stdout: string; stderr: string }>
  stopAll(): Promise<void>
}

export type ModelOption = { id: string; label: string }

export type EngineStatus = {
  installed: boolean
  signedIn: boolean
  detail?: string
  models?: ModelOption[]
  thinking?: string[]
}

export type EngineInfo = { id: string; enabled: boolean } & EngineStatus

export type SessionOptions = {
  cwd: string
  instructions: string
  accountDir?: string
  apiKey?: string
  hotrodMcp?: { url: string; token: string }
  extraDirs?: string[]
  model?: string
  thinking?: string
}

export interface Session {
  prompt(text: string): void
  interrupt(): void
  respond(requestId: string, allow: boolean): void
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

export const WORKSHOP_ID = 'main'

export type ChatInfo = {
  id: string
  name: string
  parentId?: string
  subagent?: boolean
  folders: string[]
  files: string[]
  engine: string
  archived: boolean
  createdAt: string
  role?: ModelRole
  model?: string
  thinking?: string
}

export const MODEL_ROLES = ['chat', 'planning', 'searching', 'subagents'] as const

export type ModelRole = (typeof MODEL_ROLES)[number]

export type ModelLists = Record<ModelRole, string[]>

export function pickModel(offered: ModelOption[], lists: ModelLists, chat: { model?: string; role?: ModelRole }) {
  const offers = (id?: string) => offered.some((m) => m.id === id)
  if (offers(chat.model)) return chat.model
  const list = lists[chat.role ?? 'chat']
  return (list?.length ? list : lists.chat).find(offers)
}

export type Mods = { subagents: { enabled: boolean; limit: number } }

export const DEFAULT_SUBAGENT_LIMIT = 4

export const CONTEXT_SECTIONS = ['agents', 'folders', 'files'] as const

export type ContextSection = (typeof CONTEXT_SECTIONS)[number]

export type ContextItem = {
  section: ContextSection
  path: string
  from: string
  enabled: boolean
  text: string
}

export type NewChat = { parentId?: string; name: string; engine?: string; folders?: string[]; files?: string[] }

export type ChatStatus = 'idle' | 'running' | 'waiting' | 'stopping'

export type ChatEntry = { at: string } & (
  | { type: 'user.message'; text: string }
  | { type: 'permission.resolved'; requestId: string; allow: boolean }
  | Exclude<EngineEvent, { type: 'text.delta' | 'thinking.delta' }>
)

export type QueuedMessage = { id: string; text: string }

export type ChatState = ChatInfo & {
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
  | { type: 'chat.delete'; chatId: string }
  | { type: 'chat.setEngine'; chatId: string; engine: string }
  | { type: 'chat.setModel'; chatId: string; model?: string; thinking?: string }
  | { type: 'chat.send'; chatId: string; text: string }
  | { type: 'chat.unqueue'; chatId: string; id: string }
  | { type: 'chat.interrupt'; chatId: string; force?: boolean }
  | { type: 'permission.respond'; chatId: string; requestId: string; allow: boolean }
  | { type: 'context.get'; chatId: string }
  | { type: 'context.add'; chatId: string; section: 'folders' | 'files'; path: string }
  | { type: 'context.remove'; chatId: string; section: 'folders' | 'files'; path: string }
  | { type: 'context.set'; chatId: string; path: string; enabled: boolean }
  | { type: 'context.write'; chatId: string; text: string }
  | { type: 'context.setDefault'; section: ContextSection; enabled: boolean }
  | { type: 'subagents.set'; enabled: boolean; limit: number }
  | { type: 'models.setList'; engine: string; role: ModelRole; models: string[] }
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
      mods: Mods
      modelLists: Record<string, ModelLists>
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
  | { type: 'mods.updated'; mods: Mods }
  | { type: 'models.updated'; engine: string; lists: ModelLists }
  | { type: 'error'; message: string }
