export type ExtensionSetting = { key: string; label: string; description?: string } & (
  | { type: 'select'; options: { value: string | number; label: string }[]; default: string | number }
  | { type: 'number'; default: number; min?: number; max?: number; integer?: boolean }
  | { type: 'boolean'; default: boolean }
  // A blank value means the default.
  | { type: 'text'; default: string; rows?: number }
)

export type ExtensionValues = Record<string, string | number | boolean>

// The common event stream every engine's adapter speaks. Extensions read it; only adapters write it.

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

export type ChatSummary = { id: string; name: string; engine: string; parentId?: string; worker?: boolean }

// What an extension can know about any chat. A space is a top-level chat; extension is set on an extension's own chat
// (Home).
export type ChatDetail = ChatSummary & {
  status: ChatStatus
  archived: boolean
  extension?: string
  /** @deprecated The same as `extension`, for extensions written when they were called mods. */
  mod?: string
  folders: string[]
  files: string[]
  createdAt: string
  // A worker: how many of its parent's messages there were when it started, so a memory extension can freeze its view
  // of the parent there.
  parentMessages?: number
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
  | { type: 'worker.report'; text: string; chatId: string; name: string; error?: string }
  | { type: 'permission.resolved'; requestId: string; allow: boolean; auto?: true }
  | { type: 'question.resolved'; requestId: string; answers?: Answers }
  // panel: clicking the note opens that panel of the extension's.
  | { type: 'extension.note'; text: string; extension?: string; panel?: string }
  | Exclude<EngineEvent, { type: 'text.delta' | 'thinking.delta' | 'steer.landed' | 'steer.returned' }>
)

// A chat's log as memory reads it: the entries a conversation is made of, numbered from 0 in log order. user is the
// user's words, work a report from a worker or a message from another chat, talk the agent's reply, tool a tool call,
// echo its output, note a turn that ended early. Every memory (an extension's or the core's own window) numbers the
// same way.
export type MessageKind = 'user' | 'work' | 'talk' | 'tool' | 'echo' | 'note'
export type MemoryMessage = { id: number; kind: MessageKind; at: string; text: string }

// A one-shot model call: no tools, no session. schema asks for JSON of that shape where the engine supports it.
export type CompletionRequest = { system: string; prompt: string; schema?: object; timeoutMs: number }

// An extension's chat is pinned, can't be renamed, archived or deleted, and keeps no folders, files or AGENTS.md of its
// own.
export type ExtensionChat = { id: string; name: string; instructions: string; seesAll?: boolean }

export type ExtensionAccount = { id: string; name: string; signedIn?: boolean }

export type ExtensionAccounts = { engine: string; active: string; accounts: ExtensionAccount[] }

export type ExtensionRun = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; onStdout?: (chunk: string) => void },
) => Promise<{ code: number | null; stdout: string; stderr: string }>

// A long-running process an extension started with host.spawn.
export type ExtensionProcess = {
  // Its stdout as it arrives. To get stderr too, run it through a shell with 2>&1.
  onOutput(listener: (chunk: string) => void): void
  // stderrTail: the end of what it wrote to stderr.
  onExit(listener: (code: number | null, stderrTail: string) => void): void
  // Stops it and everything it started (its process group): SIGTERM, then SIGKILL if it hasn't gone after a grace.
  stop(): void
}

// chat: run it as that chat's own commands run, sandboxed to its space's work folder and checkouts unless the chat may
// edit anywhere. cwd defaults to the space's work folder, or / without a chat.
export type ExtensionSpawnOptions = { cwd?: string; env?: Record<string, string>; chat?: string }

// Plain files of the extension's own, in <garage>/extensions/<id>/. Names are relative to that folder and can't leave
// it.
export type ExtensionStorage = {
  dir: string
  read(name: string): string | undefined
  write(name: string, text: string): void
  // Adds to the end of the file, making it if it's missing.
  append(name: string, text: string): void
  remove(name: string): void
}

// Which of the user's model lists (Settings → Models) a chat runs on.
export type ModelRole = 'chat' | 'planning' | 'searching' | 'workers'

export type NewChatSpec = {
  name: string
  folders?: string[]
  files?: string[]
  // An engine that is on; without one, the chat follows its role's model list.
  engine?: string
  // Makes a child of this chat (see ExtensionHost.createChat).
  parentId?: string
  // A child's model list; only with parentId.
  role?: ModelRole
}

// Each extension gets a host of its own, so storage and notes know which extension they belong to.
export type ExtensionHost = {
  // A new chat; send it its first message with send. Without parentId it's a space, with its own folders and files.
  // With parentId it's a child of that chat, made exactly as spawn_worker makes a worker: listed under its parent and
  // view only (the user can watch and stop it, not write to it), working in its space's work folder and checkouts,
  // seeing its parent's memory as it was at launch, on the models of `role` (default 'workers'). Its final reply joins
  // the parent's queue as a report and wakes it, and it is removed once it has reported. A child takes its folders from
  // its space (so no folders or files), can't have children of its own, and its parent must not be archived. The host
  // sets no limit on how many run; spawn_worker counts them toward the Workers extension's.
  createChat(spec: NewChatSpec): { id: string }
  // Sends a message as if the user typed it, queued behind a running turn.
  send(chatId: string, text: string): void
  // Every chat the user can see, spaces and workers.
  chats(): ChatDetail[]
  // The extension's spaceSettings for chatId's space (the chat itself, or the space a worker is in), defaults filled
  // in.
  spaceValues(chatId: string): ExtensionValues
  // Saves one of the extension's spaceSettings for chatId's space, checked as Settings checks a global one, and draws
  // the extension's panels again.
  setSpaceValue(chatId: string, key: string, value: string | number | boolean): void
  // Whether the chat callerId may reach chatId, by the rule the core's list_chats, read_chat, send_message and
  // stop_chat use: a chat reaches its own workers, and a chat that sees every chat (Home) also reaches every other chat
  // except other chats' workers. No chat reaches itself. An extension tool learns its caller from run's `caller`; check
  // before reading or messaging a chat the caller named.
  reaches(callerId: string, chatId: string): boolean
  // Every chat callerId may reach, by the same rule.
  reachable(callerId: string): ChatDetail[]
  chat(chatId: string): ChatDetail | undefined
  // The chat's log, oldest first; `last` keeps only the newest entries.
  read(chatId: string, options?: { last?: number }): ChatEntry[]
  // The space the chat is in (the chat itself for a space).
  space(chatId: string): SpaceDetail | undefined
  // Asks a running turn to stop, as Stop does.
  interrupt(chatId: string): void
  // An engine's saved accounts, in the order Settings lists them, or undefined if it keeps none.
  accounts(engine: string): ExtensionAccounts | undefined
  // Makes the account the engine's active one, for every chat. Turns already running keep theirs.
  useAccount(engine: string, accountId: string): void
  // Sends the chat's last message again, ahead of anything queued.
  retry(chatId: string): void
  // Carries on the chat's last turn with a prompt from Kothar, as a turn of its own: the agent sees the turn so far
  // in its memory, the prompt isn't shown or logged as a message, and queued messages run after. The chat must be
  // idle, as it is in onLimitReached.
  continue(chatId: string, text: string): void
  // A short line in the chat's transcript, for the user. Agents don't see it. With panel, clicking it opens that
  // panel of this extension's.
  note(chatId: string, text: string, options?: { panel?: string }): void
  // An error for the user, shown as one from a hook that throws is: after the extension's name. For background work.
  error(text: string): void
  // A system notification, such as "Reconnect gave up" or "The browser needs you". Kothar shows it as the other
  // notifications are (Settings → General → Notifications): only while the user isn't looking at the chat, and a
  // burst becomes one. With chatId, clicking it opens that chat. Title and body are plain text, cut if long.
  notify(notification: { chatId?: string; title: string; body?: string }): void
  // Runs a command through the Machine, so it works wherever the core runs. Not sandboxed: it's the extension's own.
  run: ExtensionRun
  // Starts a long-running command through the Machine and returns once it's started, without waiting for it to end.
  // Unlike run, nothing times it out. Everything an extension started stops when the extension is turned off or Kothar
  // quits.
  spawn(command: string, args: string[], options?: ExtensionSpawnOptions): Promise<ExtensionProcess>
  storage: ExtensionStorage
  // Opens the user's terminal app (a new window or tab) at a folder on this computer, such as a process's working
  // folder. The folder must be in some space: one of its folders, its work folder or a checkout, or inside one. Rejects
  // with a short message for the user when it can't (no such folder, the terminal app is missing).
  openTerminal(path: string): Promise<void>
  // Shows a file or folder in Finder (on macOS; the file manager elsewhere), selected. Only inside Kothar's own folders:
  // the data folder (the garage), the work folder, and each chat's folders, files, work folder and checkouts. Rejects
  // with a short message for the user otherwise, or when the path doesn't exist.
  reveal(path: string): Promise<void>
  // Files of the extension's own that belong to one chat, in the chat's folder: they go when the chat is deleted. The
  // core's own files there (chat.json, log.jsonl, AGENTS.md, parent-view.md, attachments/) are out of reach.
  chatStorage(chatId: string): ExtensionStorage
  // The chat's log as numbered memory messages, oldest first.
  messages(chatId: string): MemoryMessage[]
  // One call to the model picked for summaries (Settings → Models), on the user's own login, in Kothar's scratch
  // folder. Rejects when no engine that is on can make one.
  complete(request: CompletionRequest): Promise<string>
  // Draws this extension's panels and commands for the chat again, and its open panels: call it when what they show
  // changed. Without a chat, for every chat.
  refresh(chatId?: string): void
  // Puts the chat in waiting for the user, as an unanswered permission request does: amber in the sidebar, with a bar
  // above the composer showing text and the buttons (a worker's shows in its space too). Clicking one, or the user
  // sending the chat a message, calls the extension's onWaitAction. Only while the chat's turn runs, as from a tool's
  // run; calling it again replaces this extension's wait. It goes with endWait, when the turn ends, or when the
  // extension is turned off.
  // Called from onTurnCompleted or onSessionEnded (synchronously, before any await), it holds the chat after its turn
  // instead: the chat shows waiting, a worker doesn't report yet and queued messages, the user's included, wait. The
  // hold ends with endWait, Stop or the extension turned off, and the chat then ends its turn as it would have (a
  // worker reports, queued messages run); or with continue or retry, which carry the turn on.
  wait(chatId: string, wait: ExtensionWait): void
  endWait(chatId: string): void
  // The Processes tab's rows from every other extension that's on (Extension.processes) for the space, so an extension
  // that draws the tab can list them. processAction runs one of a row's actions in the extension that owns it;
  // processesChanged tells the extensions that draw them (onProcessesChanged) that this extension's rows changed.
  processes(spaceId: string): (ExtensionProcessRow & { extension: string })[]
  processAction(spaceId: string, extension: string, key: string, action: string): Promise<void>
  processesChanged(spaceId: string): void
}

// What waits for the user on a chat: a short line saying what's needed, and its buttons.
export type ExtensionWait = { text: string; buttons: { id: string; label: string; primary?: boolean; hint?: string }[] }

// How the user answered a wait: a button, or a message they sent the chat instead (it still goes to the agent).
export type ExtensionWaitAnswer = { button: string } | { message: string }

// Something of an extension's own that runs in a space, such as its browser, listed in the Processes tab beside the
// commands agents start. actions are buttons on the row; each comes back to the extension's onProcessAction.
export type ExtensionProcessRow = {
  key: string
  label: string
  detail?: string
  // When it started (epoch ms), for a live uptime.
  since?: number
  dot?: ExtensionTone
  hint?: string
  actions: { name: string; label: string; hint?: string; primary?: boolean }[]
}

export type ExtensionContext = { values: ExtensionValues; host: ExtensionHost }

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

// A turn as it started: the message the user (or an extension) sent, before any transform. A continuation has
// continued.
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

export type ExtensionTool = {
  name: string
  description: string
  inputSchema: { type: 'object'; properties?: Record<string, object>; required?: string[] }
  offered(caller: ChatSummary): boolean
  // caller: the chat whose agent called the tool. host.reaches(caller.id, …) says which chats it may act on.
  run(input: Record<string, unknown>, call: { caller: ChatSummary; values: ExtensionValues; host: ExtensionHost }): unknown
}

export type McpServer = {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  allowTools?: boolean
}

// What a fresh session sees of its chat's history. The core asks the first extension that's on with a memory; with
// none, it sends a window of the latest messages in full and says how many older ones it dropped. tools: the session
// has the Kothar MCP server, so the extension's tools (such as a zoom) reach it.
export type ExtensionMemoryRequest = { chat: ChatDetail; messages: MemoryMessage[]; tools: boolean }
export type ExtensionMemory = {
  // The history, oldest first, put before the new message as "This is the conversation so far". Also called for a
  // worker's frozen view of its parent at launch, with the parent's chat and messages.
  view(request: ExtensionMemoryRequest, context: ExtensionContext): string
  // How to read the view, for the session's instructions, where the memory goes: after extensions' instructions, before
  // the chat's context.
  instructions?(request: ExtensionInstructionsFor, context: ExtensionContext): string | undefined
}

export type ExtensionSession = { chat: ChatSummary; workDir: string; sandboxed: boolean; values: ExtensionValues }

// A session about to start. tools: it has the Kothar MCP server, so the extension's tools are offered to it.
export type ExtensionInstructionsFor = { chat: ChatDetail; tools: boolean }

// progress runs from 0 to 1.
// A setup can depend on the extension's settings: it is checked again whenever one changes.
export type ExtensionSetup = {
  description: string | ((values: ExtensionValues) => string)
  check(run: ExtensionRun, values: ExtensionValues): Promise<{ ready: boolean; message?: string }>
  install(
    run: ExtensionRun,
    report: (update: { text?: string; progress?: number }) => void,
    values: ExtensionValues,
  ): Promise<void>
}

// A panel's UI, as data: the extension's core side builds it and the UI draws it with Kothar's own controls, so a panel
// looks like the rest of Kothar in every theme and runs no code in the window. Actions come back to the panel's
// onAction. hint: an explanation, shown on hover.
export type ExtensionTone = 'normal' | 'muted' | 'faint' | 'accent' | 'success' | 'warning' | 'error'

export type ExtensionAction = { name: string; value?: ExtensionJson }

export type ExtensionJson = string | number | boolean | null | ExtensionJson[] | { [key: string]: ExtensionJson }

export type ExtensionListItem = {
  key: string
  label: string
  // A second, quieter line or column.
  detail?: string
  // A live time since this moment (epoch ms), such as an uptime, in place of detail. The UI ticks it itself, so the
  // extension needn't redraw the panel to keep it current. Shown as 5s, 2m 5s, 1h 2m, 1d 1h.
  since?: number
  mono?: boolean
  badges?: { text: string; tone?: ExtensionTone; hint?: string }[]
  // A status dot before the label, in this tone.
  dot?: ExtensionTone
  // A link at the end of the row, apart from its action.
  link?: { text: string; url: string }
  selected?: boolean
  action?: ExtensionAction
  hint?: string
}

export type ExtensionView =
  | { type: 'stack'; children: ExtensionView[]; gap?: 'tight' | 'normal' | 'loose' }
  | { type: 'row'; children: ExtensionView[]; justify?: 'start' | 'between' | 'end' }
  | { type: 'heading'; text: string; hint?: string }
  // copy: a button beside it that copies the text, such as a path. reveal: a Show in Finder button for the path the text
  // is, by host.reveal's rule (a path outside Kothar's folders shows an error when clicked).
  | {
      type: 'text'
      text: string
      tone?: ExtensionTone
      mono?: boolean
      small?: boolean
      hint?: string
      copy?: boolean
      reveal?: boolean
    }
  | { type: 'badge'; text: string; tone?: ExtensionTone; hint?: string }
  // A live time since this moment (epoch ms), ticked by the UI as ExtensionListItem.since is.
  | { type: 'elapsed'; since: number; tone?: ExtensionTone; mono?: boolean; small?: boolean; hint?: string }
  | {
      type: 'button'
      label: string
      action: ExtensionAction
      variant?: 'normal' | 'primary' | 'ghost'
      disabled?: boolean
      hint?: string
      // Asks first, in Kothar's own dialog: text is the question, body what follows it (such as what's lost), ok the
      // confirming button's label. The action is sent only if the user confirms. danger colours the button red.
      confirm?: { text: string; body?: string; ok?: string; danger?: boolean }
    }
  | { type: 'link'; text: string; url: string }
  | { type: 'list'; items: ExtensionListItem[]; empty?: string; label?: string }
  // language 'diff' colours added and removed lines; others are shown plain. follow: for output that grows, such as a
  // log: shows the last maxLines lines instead of the first, scrolled to the end, and stays at the end as lines arrive
  // unless the user scrolls up.
  | { type: 'code'; text: string; language?: string; maxLines?: number; follow?: boolean }
  // A card with a title that folds; open says how it starts.
  | { type: 'card'; title: string; badges?: ExtensionListItem['badges']; open?: boolean; children: ExtensionView[] }
  | { type: 'divider' }
  | { type: 'empty'; text: string }
  // Controls for one of the extension's spaceSettings in the panel's space (a worker's panel shows its space's): a
  // switch for a boolean setting, a picker for a select. The UI saves a change itself (no onAction) and the panel draws
  // again. label defaults to the setting's. value and options are filled in by the core from the space's saved values
  // and the setting; an extension leaves them out.
  | { type: 'switch'; setting: string; label?: string; hint?: string; disabled?: boolean; value?: boolean }
  | {
      type: 'picker'
      setting: string
      label?: string
      hint?: string
      disabled?: boolean
      value?: string | number
      options?: { value: string | number; label: string }[]
    }

// A tab beside General, Context and Permissions in the right sidebar.
export type ExtensionPanel = {
  id: string
  title: string
  // Whether the chat gets this tab. Without it, every chat does.
  shown?(chat: ChatDetail, context: ExtensionContext): boolean
  render(chat: ChatDetail, context: ExtensionContext): ExtensionView | Promise<ExtensionView>
  onAction?(action: ExtensionAction, chat: ChatDetail, context: ExtensionContext): void | Promise<void>
}

// Part of the extension's page in Settings, drawn below its settings: a readout or actions that aren't settings, such
// as how much disk its files take and a button to delete them. Built of the same views as a panel (no switches or
// pickers: those are for space settings). Unlike settings, it's shown while the extension is off too, for a built-in
// extension. render is called whenever the page opens, a setting changes, after an action, and on host.refresh()
// without a chat; keep it quick and synchronous.
export type ExtensionSettingsView = {
  render(context: ExtensionContext): ExtensionView
  onAction?(action: ExtensionAction, context: ExtensionContext): void | Promise<void>
}

// An action listed in the chat's General tab.
export type ExtensionCommand = {
  id: string
  label: string
  hint?: string
  shown?(chat: ChatDetail, context: ExtensionContext): boolean
  run(chat: ChatDetail, context: ExtensionContext): void | Promise<void>
}

// Hooks run in the core. A hook that throws or rejects shows its error and doesn't stop the chat; the core doesn't wait
// for async hooks except onPermissionRequested.
export type Extension = {
  id: string
  name: string
  description: string
  enabledByDefault: boolean
  settings?: ExtensionSetting[]
  // Settings kept per space instead of once for all of Kothar, of the same kinds. Each space starts at the defaults;
  // a worker uses its space's. Read them with host.spaceValues, change them with host.setSpaceValue or with a switch or
  // picker in a panel. They're saved in the space's chat.json, so they go when the space is deleted.
  spaceSettings?: ExtensionSetting[]
  // The version of the extension's saved settings, 1 or more; leave it out until they first need migrating. When the
  // garage holds an older version (none saved counts as 0), migrateSettings runs once at load, before the extension is
  // used: on the global values and on each space's, as saved (no defaults filled in). What it returns replaces them
  // and the new version is saved. If it throws, the error shows, nothing is saved, and it runs again next launch.
  settingsView?: ExtensionSettingsView
  settingsVersion?: number
  migrateSettings?(saved: Record<string, unknown>, from: number, where: { spaceId?: string }): Record<string, unknown>
  // One of the extension's global settings changed in Settings, while it's on (and, with an onStart, once that has
  // run: until then onStart reads the values itself). context.values has the new values.
  onSettingsChanged?(changed: { key: string; value: unknown; previous: unknown }, context: ExtensionContext): void | Promise<void>
  chats?: ExtensionChat[]
  tools?: ExtensionTool[]
  mcpServers?(session: ExtensionSession): McpServer[]
  // Text for every session's instructions, after where the chat may write and before its memory. Return nothing to add
  // none. Extensions are joined in load order.
  instructions?(session: ExtensionInstructionsFor, context: ExtensionContext): string | undefined
  setup?: ExtensionSetup
  panels?: ExtensionPanel[]
  commands?: ExtensionCommand[]
  memory?: ExtensionMemory
  // Kothar is ready for model calls (engines detected, a work folder chosen), or the extension was turned on after
  // that. For background work, such as summarizing chats.
  onStart?(context: ExtensionContext): void | Promise<void>
  // The extension was turned off, or Kothar is quitting: stop background work. Not called for an extension that never
  // started.
  onStop?(context: ExtensionContext): void | Promise<void>
  onChatCreated?(chat: ChatDetail, context: ExtensionContext): void | Promise<void>
  // The chat is gone from the core by now; its log and folder too.
  onChatRemoved?(chat: ChatDetail, context: ExtensionContext): void | Promise<void>
  onChatArchived?(chat: ChatDetail, archived: boolean, context: ExtensionContext): void | Promise<void>
  onStatusChanged?(chat: ChatDetail, status: ChatStatus, context: ExtensionContext): void | Promise<void>
  onTurnStarted?(turn: TurnStart, context: ExtensionContext): void | Promise<void>
  onTurnCompleted?(turn: TurnSummary, context: ExtensionContext): void | Promise<void>
  // Each message runs its own engine session, so this follows every turn; error is set if the engine quit early.
  onSessionEnded?(ended: { chat: ChatDetail; error?: string }, context: ExtensionContext): void | Promise<void>
  // Every common event as it arrives, deltas included. Read-only, so keep it quick.
  onEvent?(chat: ChatDetail, event: EngineEvent, context: ExtensionContext): void
  // A policy for permission requests the core would otherwise ask the user about, or would allow on its own. Return a
  // verdict to answer it, or nothing to leave it. Extensions are asked in load order; the first verdict wins. The
  // core's own denials (edits outside the work folder in a sandbox) always stand.
  onPermissionRequested?(
    request: PermissionRequest,
    chat: ChatDetail,
    context: ExtensionContext,
  ): PermissionVerdict | undefined | Promise<PermissionVerdict | undefined>
  // Rewrites a message on its way to the engine. The log and the user keep the original. Extensions chain in load
  // order.
  transformMessage?(text: string, chat: ChatDetail, context: ExtensionContext): string
  // Rewrites a finished reply before it's logged, shown and remembered. Streaming shows the engine's own text until
  // the reply finishes. Extensions chain in load order.
  transformOutput?(text: string, chat: ChatDetail, context: ExtensionContext): string
  // A turn ran into its account's usage limit. The core stops the turn first, so the chat is idle here.
  onLimitReached?(limit: LimitReached, context: ExtensionContext): void
  // The user answered this extension's wait on the chat (host.wait). The wait stays until the extension ends it.
  onWaitAction?(chat: ChatDetail, answer: ExtensionWaitAnswer, context: ExtensionContext): void | Promise<void>
  // This extension's rows in the space's Processes tab, now. Called whenever the tab draws.
  processes?(spaceId: string, context: ExtensionContext): ExtensionProcessRow[]
  onProcessAction?(spaceId: string, key: string, action: string, context: ExtensionContext): void | Promise<void>
  // Another extension's rows in the space changed (host.processesChanged): an extension that draws them draws again.
  onProcessesChanged?(spaceId: string, context: ExtensionContext): void
}

// A community extension ships as two assets of a GitHub release in its own repo: manifest.json, which is this, and
// main.mjs, one ES module (bundled, imports only node: built-ins) whose default export is the Extension. See
// https://github.com/billwang7599/kothar-sample-mod.
export type ExtensionManifest = {
  // The Extension's id, and its folder's name: lowercase letters, digits and dashes.
  id: string
  name: string
  // 1.2.3. The Marketplace offers an update when the latest release's version differs from the installed one.
  version: string
  author: string
  description: string
  // The extension API version the extension is written for.
  api: 1
  // Everything the extension does through the extension API. Kothar shows the list before install, and won't start an
  // extension that does more: an Extension field or a host call it didn't list.
  uses: ExtensionUse[]
}

export type ExtensionUse =
  // Extension fields.
  | 'tools'
  | 'mcpServers'
  | 'instructions'
  // onPermissionRequested
  | 'permissions'
  // transformMessage, transformOutput
  | 'transforms'
  // onEvent, onTurnStarted, onTurnCompleted, onStatusChanged, onSessionEnded, onChatCreated, onChatRemoved,
  // onChatArchived, onLimitReached, onStart, onStop
  | 'events'
  // panels, processes, onProcessAction, onProcessesChanged, onWaitAction, and host.wait, endWait, processes,
  // processAction, processesChanged
  | 'panels'
  | 'commands'
  // settings, spaceSettings, migrateSettings, settingsView, onSettingsChanged, and host.spaceValues, setSpaceValue
  | 'settings'
  | 'chats'
  | 'setup'
  // memory, and host.chatStorage
  | 'memory'
  // Host calls: chats, chat, read, space, messages, reaches, reachable.
  | 'readChats'
  // send, createChat, retry, continue, interrupt
  | 'sendMessages'
  // accounts, useAccount
  | 'accounts'
  // run, spawn, openTerminal
  | 'run'
  // complete
  | 'models'

// Extensions were called mods. These old names stay, so an extension written against them still type-checks.
/** @deprecated Use ExtensionSetting. */
export type ModSetting = ExtensionSetting
/** @deprecated Use ExtensionValues. */
export type ModValues = ExtensionValues
/** @deprecated Use ExtensionChat. */
export type ModChat = ExtensionChat
/** @deprecated Use ExtensionAccount. */
export type ModAccount = ExtensionAccount
/** @deprecated Use ExtensionAccounts. */
export type ModAccounts = ExtensionAccounts
/** @deprecated Use ExtensionRun. */
export type ModRun = ExtensionRun
/** @deprecated Use ExtensionProcess. */
export type ModProcess = ExtensionProcess
/** @deprecated Use ExtensionSpawnOptions. */
export type ModSpawnOptions = ExtensionSpawnOptions
/** @deprecated Use ExtensionStorage. */
export type ModStorage = ExtensionStorage
/** @deprecated Use ExtensionHost. */
export type ModHost = ExtensionHost
/** @deprecated Use ExtensionWait. */
export type ModWait = ExtensionWait
/** @deprecated Use ExtensionWaitAnswer. */
export type ModWaitAnswer = ExtensionWaitAnswer
/** @deprecated Use ExtensionProcessRow. */
export type ModProcessRow = ExtensionProcessRow
/** @deprecated Use ExtensionContext. */
export type ModContext = ExtensionContext
/** @deprecated Use ExtensionTool. */
export type ModTool = ExtensionTool
/** @deprecated Use ExtensionMemoryRequest. */
export type ModMemoryRequest = ExtensionMemoryRequest
/** @deprecated Use ExtensionMemory. */
export type ModMemory = ExtensionMemory
/** @deprecated Use ExtensionSession. */
export type ModSession = ExtensionSession
/** @deprecated Use ExtensionInstructionsFor. */
export type ModInstructionsFor = ExtensionInstructionsFor
/** @deprecated Use ExtensionSetup. */
export type ModSetup = ExtensionSetup
/** @deprecated Use ExtensionTone. */
export type ModTone = ExtensionTone
/** @deprecated Use ExtensionAction. */
export type ModAction = ExtensionAction
/** @deprecated Use ExtensionJson. */
export type ModJson = ExtensionJson
/** @deprecated Use ExtensionListItem. */
export type ModListItem = ExtensionListItem
/** @deprecated Use ExtensionView. */
export type ModView = ExtensionView
/** @deprecated Use ExtensionPanel. */
export type ModPanel = ExtensionPanel
/** @deprecated Use ExtensionCommand. */
export type ModCommand = ExtensionCommand
/** @deprecated Use Extension. */
export type Mod = Extension
/** @deprecated Use ExtensionManifest. */
export type ModManifest = ExtensionManifest
/** @deprecated Use ExtensionUse. */
export type ModUse = ExtensionUse
