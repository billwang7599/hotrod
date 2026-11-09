export type ModSetting = { key: string; label: string; description?: string } & (
  | { type: 'select'; options: { value: string | number; label: string }[]; default: string | number }
  | { type: 'number'; default: number; min?: number; max?: number; integer?: boolean }
  | { type: 'boolean'; default: boolean }
  // A blank value means the default.
  | { type: 'text'; default: string; rows?: number }
)

export type ModValues = Record<string, string | number | boolean>

// The common event stream every engine's adapter speaks. Mods read it; only adapters write it.

export type ToolKind = 'shell' | 'edit' | 'read' | 'search' | 'fetch' | 'mcp' | 'other'

export type Question = {
  header: string
  question: string
  options: { label: string; description: string }[]
  multiSelect: boolean
}

// Keyed by question text: the labels picked, then any text the user typed. Sent without answers, a question is declined.
export type Answers = Record<string, string[]>

export type EngineEvent =
  | { type: 'turn.started' }
  | { type: 'text.delta'; text: string }
  | { type: 'text.completed'; text: string }
  | { type: 'thinking.delta'; text: string }
  // path: the file an edit or read is about, when the engine names one.
  | {
      type: 'tool.started'
      toolId: string
      name: string
      kind: ToolKind
      summary: string
      input: unknown
      path?: string
    }
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
  | { type: 'question.asked'; requestId: string; toolId?: string; questions: Question[] }
  // The account ran into a usage or rate limit; resetsAt (ISO) is when it lifts, if the engine says.
  | { type: 'limit.reached'; message: string; resetsAt?: string }
  // A message the core passed to Session.steer entered the running turn here, or is handed back unsent.
  | { type: 'steer.landed'; id: string }
  | { type: 'steer.returned'; id: string }
  | { type: 'turn.completed'; error?: string }
  | { type: 'session.ended'; error?: string }

export type PermissionRequest = Extract<EngineEvent, { type: 'permission.requested' }>

export type ChatStatus = 'idle' | 'running' | 'waiting' | 'stopping'

export type ChatSummary = { id: string; name: string; engine: string; parentId?: string; subagent?: boolean }

// What a mod can know about any chat. A space is a top-level chat; mod is set on a mod's own chat (Home).
export type ChatDetail = ChatSummary & {
  status: ChatStatus
  archived: boolean
  mod?: string
  folders: string[]
  files: string[]
  createdAt: string
}

// A git folder in a space's context, checked out in the space's work folder: path and branch of the worktree, and
// the branch the folder was on when Kothar checked it out (absent for checkouts made before Kothar recorded it).
export type Checkout = { folder: string; path: string; branch: string; from?: string }

// The space a chat belongs to: its work folder (absent until its first message picks one), its folders (git: has a
// .git) and its checkouts.
export type SpaceDetail = {
  id: string
  name: string
  workDir?: string
  folders: { path: string; git: boolean }[]
  checkouts: Checkout[]
}

export type Attachment = { name: string; path: string; mimeType: string; size: number }

// One entry of a chat's log, as stored in log.jsonl. Streamed deltas aren't logged; the completed text is.
export type ChatEntry = { at: string } & (
  // midTurn: sent while a turn ran, and taken in by it at this point (steering).
  | { type: 'user.message'; text: string; attachments?: Attachment[]; midTurn?: true }
  | { type: 'subagent.report'; text: string; chatId: string; name: string; error?: string }
  | { type: 'permission.resolved'; requestId: string; allow: boolean; auto?: true }
  | { type: 'question.resolved'; requestId: string; answers?: Answers }
  // panel: clicking the note opens that panel of the mod's.
  | { type: 'mod.note'; text: string; mod?: string; panel?: string }
  | Exclude<EngineEvent, { type: 'text.delta' | 'thinking.delta' | 'steer.landed' | 'steer.returned' }>
)

// A mod's chat is pinned, can't be renamed, archived or deleted, and keeps no folders, files or AGENTS.md of its own.
export type ModChat = { id: string; name: string; instructions: string; seesAll?: boolean }

export type ModAccount = { id: string; name: string; signedIn?: boolean }

export type ModAccounts = { engine: string; active: string; accounts: ModAccount[] }

export type ModRun = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; onStdout?: (chunk: string) => void },
) => Promise<{ code: number | null; stdout: string; stderr: string }>

// A long-running process a mod started with host.spawn.
export type ModProcess = {
  // Its stdout as it arrives. To get stderr too, run it through a shell with 2>&1.
  onOutput(listener: (chunk: string) => void): void
  // stderrTail: the end of what it wrote to stderr.
  onExit(listener: (code: number | null, stderrTail: string) => void): void
  // Stops it and everything it started (its process group): SIGTERM, then SIGKILL if it hasn't gone after a grace.
  stop(): void
}

// chat: run it as that chat's own commands run, sandboxed to its space's work folder and checkouts unless the chat may
// edit anywhere. cwd defaults to the space's work folder, or / without a chat.
export type ModSpawnOptions = { cwd?: string; env?: Record<string, string>; chat?: string }

// Plain files of the mod's own, in <garage>/mods/<id>/. Names are relative to that folder and can't leave it.
export type ModStorage = {
  dir: string
  read(name: string): string | undefined
  write(name: string, text: string): void
  remove(name: string): void
}

// Each mod gets a host of its own, so storage and notes know which mod they belong to.
export type ModHost = {
  createChat(spec: { name: string; folders?: string[]; files?: string[]; engine?: string }): { id: string }
  // Sends a message as if the user typed it, queued behind a running turn.
  send(chatId: string, text: string): void
  // Every chat the user can see, spaces and subagents.
  chats(): ChatDetail[]
  chat(chatId: string): ChatDetail | undefined
  // The chat's log, oldest first; `last` keeps only the newest entries.
  read(chatId: string, options?: { last?: number }): ChatEntry[]
  // The space the chat is in (the chat itself for a space).
  space(chatId: string): SpaceDetail | undefined
  // Asks a running turn to stop, as Stop does.
  interrupt(chatId: string): void
  // An engine's saved accounts, in the order Settings lists them, or undefined if it keeps none.
  accounts(engine: string): ModAccounts | undefined
  // Makes the account the engine's active one, for every chat. Turns already running keep theirs.
  useAccount(engine: string, accountId: string): void
  // Sends the chat's last message again, ahead of anything queued.
  retry(chatId: string): void
  // Carries on the chat's last turn with a prompt from Kothar, as a turn of its own: the agent sees the turn so far
  // in its memory, the prompt isn't shown or logged as a message, and queued messages run after. The chat must be
  // idle, as it is in onLimitReached.
  continue(chatId: string, text: string): void
  // A short line in the chat's transcript, for the user. Agents don't see it. With panel, clicking it opens that
  // panel of this mod's.
  note(chatId: string, text: string, options?: { panel?: string }): void
  // Runs a command through the Machine, so it works wherever the core runs. Not sandboxed: it's the mod's own.
  run: ModRun
  // Starts a long-running command through the Machine and returns once it's started, without waiting for it to end.
  // Unlike run, nothing times it out. Everything a mod started stops when the mod is turned off or Kothar quits.
  spawn(command: string, args: string[], options?: ModSpawnOptions): Promise<ModProcess>
  storage: ModStorage
  // Draws this mod's panels and commands for the chat again, and its open panels: call it when what they show changed.
  // Without a chat, for every chat.
  refresh(chatId?: string): void
}

export type ModContext = { values: ModValues; host: ModHost }

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

// A turn as it started: the message the user (or a mod) sent, before any transform. A continuation has continued.
export type TurnStart = { chat: ChatDetail; text: string; continued: boolean }

// A turn as it ended. text is its last reply; files are the paths its edit tools named, in order, without repeats.
export type TurnSummary = {
  chat: ChatDetail
  error?: string
  text: string
  tools: { name: string; kind: ToolKind; summary: string; path?: string; isError?: boolean }[]
  files: string[]
}

// message is shown to the agent when the request is denied.
export type PermissionVerdict = { allow: boolean; message?: string }

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

// A session about to start. tools: it has the Kothar MCP server, so the mod's tools are offered to it.
export type ModInstructionsFor = { chat: ChatDetail; tools: boolean }

// progress runs from 0 to 1.
// A setup can depend on the mod's settings: it is checked again whenever one changes.
export type ModSetup = {
  description: string | ((values: ModValues) => string)
  check(run: ModRun, values: ModValues): Promise<{ ready: boolean; message?: string }>
  install(
    run: ModRun,
    report: (update: { text?: string; progress?: number }) => void,
    values: ModValues,
  ): Promise<void>
}

// A panel's UI, as data: the mod's core side builds it and the UI draws it with Kothar's own controls, so a panel looks
// like the rest of Kothar in every theme and runs no code in the window. Actions come back to the panel's onAction.
// hint: an explanation, shown on hover.
export type ModTone = 'normal' | 'muted' | 'faint' | 'accent' | 'success' | 'warning' | 'error'

export type ModAction = { name: string; value?: ModJson }

export type ModJson = string | number | boolean | null | ModJson[] | { [key: string]: ModJson }

export type ModListItem = {
  key: string
  label: string
  // A second, quieter line or column.
  detail?: string
  // A live time since this moment (epoch ms), such as an uptime, in place of detail. The UI ticks it itself, so the mod
  // needn't redraw the panel to keep it current. Shown as 5s, 2m 5s, 1h 2m, 1d 1h.
  since?: number
  mono?: boolean
  badges?: { text: string; tone?: ModTone; hint?: string }[]
  // A status dot before the label, in this tone.
  dot?: ModTone
  // A link at the end of the row, apart from its action.
  link?: { text: string; url: string }
  selected?: boolean
  action?: ModAction
  hint?: string
}

export type ModView =
  | { type: 'stack'; children: ModView[]; gap?: 'tight' | 'normal' | 'loose' }
  | { type: 'row'; children: ModView[]; justify?: 'start' | 'between' | 'end' }
  | { type: 'heading'; text: string; hint?: string }
  | { type: 'text'; text: string; tone?: ModTone; mono?: boolean; small?: boolean; hint?: string }
  | { type: 'badge'; text: string; tone?: ModTone; hint?: string }
  // A live time since this moment (epoch ms), ticked by the UI as ModListItem.since is.
  | { type: 'elapsed'; since: number; tone?: ModTone; mono?: boolean; small?: boolean; hint?: string }
  | {
      type: 'button'
      label: string
      action: ModAction
      variant?: 'normal' | 'primary' | 'ghost'
      disabled?: boolean
      hint?: string
    }
  | { type: 'link'; text: string; url: string }
  | { type: 'list'; items: ModListItem[]; empty?: string; label?: string }
  // language 'diff' colours added and removed lines; others are shown plain. follow: for output that grows, such as a
  // log: shows the last maxLines lines instead of the first, scrolled to the end, and stays at the end as lines arrive
  // unless the user scrolls up.
  | { type: 'code'; text: string; language?: string; maxLines?: number; follow?: boolean }
  // A card with a title that folds; open says how it starts.
  | { type: 'card'; title: string; badges?: ModListItem['badges']; open?: boolean; children: ModView[] }
  | { type: 'divider' }
  | { type: 'empty'; text: string }

// A tab beside General, Context and Permissions in the right sidebar.
export type ModPanel = {
  id: string
  title: string
  // Whether the chat gets this tab. Without it, every chat does.
  shown?(chat: ChatDetail, context: ModContext): boolean
  render(chat: ChatDetail, context: ModContext): ModView | Promise<ModView>
  onAction?(action: ModAction, chat: ChatDetail, context: ModContext): void | Promise<void>
}

// An action listed in the chat's General tab.
export type ModCommand = {
  id: string
  label: string
  hint?: string
  shown?(chat: ChatDetail, context: ModContext): boolean
  run(chat: ChatDetail, context: ModContext): void | Promise<void>
}

// Hooks run in the core. A hook that throws or rejects shows its error and doesn't stop the chat; the core doesn't wait
// for async hooks except onPermissionRequested.
export type Mod = {
  id: string
  name: string
  description: string
  enabledByDefault: boolean
  settings?: ModSetting[]
  chats?: ModChat[]
  tools?: ModTool[]
  mcpServers?(session: ModSession): McpServer[]
  // Text for every session's instructions, after where the chat may write and before its memory. Return nothing to add
  // none. Mods are joined in load order.
  instructions?(session: ModInstructionsFor, context: ModContext): string | undefined
  setup?: ModSetup
  panels?: ModPanel[]
  commands?: ModCommand[]
  onChatCreated?(chat: ChatDetail, context: ModContext): void | Promise<void>
  // The chat is gone from the core by now; its log and folder too.
  onChatRemoved?(chat: ChatDetail, context: ModContext): void | Promise<void>
  onChatArchived?(chat: ChatDetail, archived: boolean, context: ModContext): void | Promise<void>
  onStatusChanged?(chat: ChatDetail, status: ChatStatus, context: ModContext): void | Promise<void>
  onTurnStarted?(turn: TurnStart, context: ModContext): void | Promise<void>
  onTurnCompleted?(turn: TurnSummary, context: ModContext): void | Promise<void>
  // Each message runs its own engine session, so this follows every turn; error is set if the engine quit early.
  onSessionEnded?(ended: { chat: ChatDetail; error?: string }, context: ModContext): void | Promise<void>
  // Every common event as it arrives, deltas included. Read-only, so keep it quick.
  onEvent?(chat: ChatDetail, event: EngineEvent, context: ModContext): void
  // A policy for permission requests the core would otherwise ask the user about, or would allow on its own. Return a
  // verdict to answer it, or nothing to leave it. Mods are asked in load order; the first verdict wins. The core's own
  // denials (edits outside the work folder in a sandbox) always stand.
  onPermissionRequested?(
    request: PermissionRequest,
    chat: ChatDetail,
    context: ModContext,
  ): PermissionVerdict | undefined | Promise<PermissionVerdict | undefined>
  // Rewrites a message on its way to the engine. The log and the user keep the original. Mods chain in load order.
  transformMessage?(text: string, chat: ChatDetail, context: ModContext): string
  // Rewrites a finished reply before it's logged, shown and remembered. Streaming shows the engine's own text until
  // the reply finishes. Mods chain in load order.
  transformOutput?(text: string, chat: ChatDetail, context: ModContext): string
  // A turn ran into its account's usage limit. The core stops the turn first, so the chat is idle here.
  onLimitReached?(limit: LimitReached, context: ModContext): void
}

// A community mod ships as two assets of a GitHub release in its own repo: manifest.json, which is this, and main.mjs,
// one ES module (bundled, imports only node: built-ins) whose default export is the Mod. See
// https://github.com/billwang7599/kothar-sample-mod.
export type ModManifest = {
  // The Mod's id, and its folder's name: lowercase letters, digits and dashes.
  id: string
  name: string
  // 1.2.3. The Marketplace offers an update when the latest release's version differs from the installed one.
  version: string
  author: string
  description: string
  // The mod API version the mod is written for.
  api: 1
  // Everything the mod does through the mod API. Kothar shows the list before install, and won't start a mod that does
  // more: a Mod field or a host call it didn't list.
  uses: ModUse[]
}

export type ModUse =
  // Mod fields.
  | 'tools'
  | 'mcpServers'
  | 'instructions'
  // onPermissionRequested
  | 'permissions'
  // transformMessage, transformOutput
  | 'transforms'
  // onEvent, onTurnStarted, onTurnCompleted, onStatusChanged, onSessionEnded, onChatCreated, onChatRemoved,
  // onChatArchived, onLimitReached
  | 'events'
  | 'panels'
  | 'commands'
  | 'settings'
  | 'chats'
  | 'setup'
  // Host calls: chats, chat, read, space.
  | 'readChats'
  // send, createChat, retry, continue, interrupt
  | 'sendMessages'
  // accounts, useAccount
  | 'accounts'
  // run, spawn
  | 'run'
