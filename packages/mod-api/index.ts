export type ModSetting = { key: string; label: string; description?: string } & (
  | { type: 'select'; options: { value: string | number; label: string }[]; default: string | number }
  | { type: 'number'; default: number; min?: number; max?: number; integer?: boolean }
  | { type: 'boolean'; default: boolean }
  // A blank value means the default.
  | { type: 'text'; default: string; rows?: number }
)

export type ModValues = Record<string, string | number | boolean>

export type ChatSummary = { id: string; name: string; engine: string; parentId?: string; subagent?: boolean }

// A mod's chat is pinned, can't be renamed, archived or deleted, and keeps no folders, files or AGENTS.md of its own.
export type ModChat = { id: string; name: string; instructions: string; seesAll?: boolean }

export type ModAccount = { id: string; name: string; signedIn?: boolean }

export type ModAccounts = { engine: string; active: string; accounts: ModAccount[] }

export type ModHost = {
  createChat(spec: { name: string; folders?: string[]; files?: string[]; engine?: string }): { id: string }
  send(chatId: string, text: string): void
  // An engine's saved accounts, in the order Settings lists them, or undefined if it keeps none.
  accounts(engine: string): ModAccounts | undefined
  // Makes the account the engine's active one, for every chat. Turns already running keep theirs.
  useAccount(engine: string, accountId: string): void
  // Sends the chat's last message again, ahead of anything queued.
  retry(chatId: string): void
  // Carries on the chat's last turn with a prompt from Hotrod, as a turn of its own: the agent sees the turn so far
  // in its memory, the prompt isn't shown or logged as a message, and queued messages run after. The chat must be
  // idle, as it is in onLimitReached.
  continue(chatId: string, text: string): void
  // A short line in the chat's transcript, for the user. Agents don't see it.
  note(chatId: string, text: string): void
}

// account is the one the turn ran on, absent if the engine keeps no accounts; the active account may have changed
// since. resetsAt is ISO, if the engine said. output: the engine had written, thought or called a tool since the
// chat's last message (across continuations), so sending that message again would redo work.
export type LimitReached = {
  chat: ChatSummary
  engine: string
  account?: string
  message: string
  resetsAt?: string
  output: boolean
}

export type ModTool = {
  name: string
  description: string
  inputSchema: { type: 'object'; properties?: Record<string, object>; required?: string[] }
  offered(caller: ChatSummary): boolean
  run(input: Record<string, unknown>, call: { caller: ChatSummary; values: ModValues; host: ModHost }): unknown
}

export type McpServer = {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  allowTools?: boolean
}

export type ModSession = { chat: ChatSummary; workDir: string; sandboxed: boolean; values: ModValues }

export type ModRun = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; onStdout?: (chunk: string) => void },
) => Promise<{ code: number | null; stdout: string; stderr: string }>

// progress runs from 0 to 1.
export type ModSetup = {
  description: string
  check(run: ModRun): Promise<{ ready: boolean; message?: string }>
  install(run: ModRun, report: (update: { text?: string; progress?: number }) => void): Promise<void>
}

export type Mod = {
  id: string
  name: string
  description: string
  enabledByDefault: boolean
  settings?: ModSetting[]
  chats?: ModChat[]
  tools?: ModTool[]
  mcpServers?(session: ModSession): McpServer[]
  setup?: ModSetup
  // A turn ran into its account's usage limit. The core stops the turn first, so the chat is idle here.
  onLimitReached?(limit: LimitReached, context: { values: ModValues; host: ModHost }): void
}
