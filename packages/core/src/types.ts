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
  | { type: 'turn.completed'; error?: string }
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

export type EngineStatus = { installed: boolean; signedIn: boolean; detail?: string }

export type EngineInfo = { id: string; enabled: boolean } & EngineStatus

export type SessionOptions = {
  cwd: string
  instructions: string
  accountDir?: string
  apiKey?: string
  hotrodMcp?: { url: string; token: string }
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

export type Project = { id: string; name: string; path: string; archived: boolean }

export type ChatInfo = {
  id: string
  projectId?: string
  main: boolean
  title: string
  engine: string
  archived: boolean
  createdAt: string
}

export const CONTEXT_KINDS = ['workshop', 'repo', 'project', 'own'] as const

export type ContextKind = (typeof CONTEXT_KINDS)[number]

export type ContextLayer = {
  kind: ContextKind
  path: string
  enabled: boolean
  writable: boolean
  text: string
}

export type ChatStatus = 'idle' | 'running' | 'waiting' | 'stopping'

export type ChatEntry = { at: string } & (
  | { type: 'user.message'; text: string }
  | { type: 'permission.resolved'; requestId: string; allow: boolean }
  | Exclude<EngineEvent, { type: 'text.delta' | 'thinking.delta' }>
)

export type ChatState = ChatInfo & { status: ChatStatus; entries: ChatEntry[]; draft: string }

export type ClientMessage =
  | { type: 'engine.setEnabled'; engine: string; enabled: boolean }
  | { type: 'project.add'; path: string }
  | { type: 'project.archive'; projectId: string; archived: boolean }
  | { type: 'project.delete'; projectId: string }
  | { type: 'chat.create'; projectId?: string }
  | { type: 'chat.archive'; chatId: string; archived: boolean }
  | { type: 'chat.delete'; chatId: string }
  | { type: 'chat.setEngine'; chatId: string; engine: string }
  | { type: 'chat.send'; chatId: string; text: string }
  | { type: 'chat.interrupt'; chatId: string; force?: boolean }
  | { type: 'permission.respond'; chatId: string; requestId: string; allow: boolean }
  | { type: 'context.get'; chatId: string }
  | { type: 'context.set'; chatId: string; kind: ContextKind; enabled: boolean }
  | { type: 'context.write'; chatId: string; kind: ContextKind; text: string }
  | { type: 'context.setDefault'; kind: ContextKind; enabled: boolean }
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
      projects: Project[]
      chats: ChatState[]
      accounts: EngineAccounts[]
      contextDefaults: Record<ContextKind, boolean>
    }
  | { type: 'engine.updated'; engine: EngineInfo }
  | { type: 'accounts.updated'; accounts: EngineAccounts }
  | { type: 'project.added'; project: Project; chat: ChatState }
  | { type: 'project.updated'; project: Project }
  | { type: 'project.removed'; projectId: string }
  | { type: 'chat.added'; chat: ChatState }
  | { type: 'chat.updated'; chat: ChatInfo }
  | { type: 'chat.removed'; chatId: string }
  | { type: 'chat.entry'; chatId: string; entry: ChatEntry }
  | { type: 'chat.delta'; chatId: string; text: string }
  | { type: 'chat.thinking'; chatId: string; text: string }
  | { type: 'chat.status'; chatId: string; status: ChatStatus }
  | { type: 'chat.context'; chatId: string; layers: ContextLayer[] }
  | { type: 'context.file'; path: string; text: string }
  | { type: 'context.defaults'; defaults: Record<ContextKind, boolean> }
  | { type: 'error'; message: string }
