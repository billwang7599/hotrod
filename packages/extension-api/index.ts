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
  // stopped: the call was cut short and the engine never reported its result (shown as stopped, not done or failed).
  | { type: 'tool.completed'; toolId: string; output: string; isError: boolean; stopped?: boolean }
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
  // errorKind (here and on session.ended): why it failed, as the engine's adapter reads its error (see TurnErrorKind).
  | { type: 'turn.completed'; error?: string; errorKind?: TurnErrorKind }
  | { type: 'session.ended'; error?: string; errorKind?: TurnErrorKind }

export type PermissionRequest = Extract<EngineEvent, { type: 'permission.requested' }>

export type ChatStatus = 'idle' | 'running' | 'waiting' | 'stopping'

export type ChatSummary = { id: string; name: string; engine: string; parentId?: string; worker?: boolean }

// What an extension can know about any chat. A space is a top-level chat; extension is set on an extension's own chat
// (Home). model: the model its next message runs on, as Kothar picks it (the chat's own pick, its setup's, or its model
// list's), in the engine's own id; absent when nothing can run on its engine.
export type ChatDetail = ChatSummary & {
  model?: string
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
  // panel: clicking the note opens that panel of the extension's, then sends it action. card: drawn as a card.
  | {
      type: 'extension.note'
      text: string
      extension?: string
      panel?: string
      action?: ExtensionAction
      card?: ExtensionNoteCard
    }
  | Exclude<EngineEvent, { type: 'text.delta' | 'thinking.delta' | 'steer.landed' | 'steer.returned' }>
)

// A chat's log as memory reads it: the entries a conversation is made of, numbered from 0 in log order. user is the
// user's words, work a report from a worker or a message from another chat, talk the agent's reply, tool a tool call,
// echo its output, note a turn that ended early. Every memory (an extension's or the core's own window) numbers the
// same way.
export type MessageKind = 'user' | 'work' | 'talk' | 'tool' | 'echo' | 'note'
export type MemoryMessage = { id: number; kind: MessageKind; at: string; text: string }

// A message the transcript draws on its own: the user's (user), a worker's report (work) or the agent's reply (talk).
// entry: where it is in the chat's log (host.read's index), which never changes, since the log only grows. text as
// logged: a report without the line Kothar adds for the agent.
export type ExtensionMessage = { entry: number; kind: 'user' | 'work' | 'talk'; at: string; text: string }

// A small button on each message in the transcript, beside Copy: shown on hover or keyboard focus. A message marked()
// lists keeps the button in view with its icon filled, as a mark (such as a pin), and offers activeLabel instead.
export type ExtensionMessageAction = {
  id: string
  // Such as "Pin", and "Unpin" on a marked message; both default to label.
  label: string
  activeLabel?: string
  icon: 'pin' | 'bookmark' | 'star' | 'eye'
  hint?: string
  activeHint?: string
  // The kinds of message it's offered on; all three without it.
  kinds?: ExtensionMessage['kind'][]
  shown?(chat: ChatDetail, context: ExtensionContext): boolean
  // The messages of the chat to mark, by entry. Called when the chat's extensions draw: on opening it, after a run and
  // on host.refresh; keep it quick.
  marked?(chat: ChatDetail, context: ExtensionContext): number[]
  // Then the chat's extensions draw again (marks and open panels), as on host.refresh(chat.id).
  run(message: ExtensionMessage, chat: ChatDetail, context: ExtensionContext): void | Promise<void>
}

// A switch in a chat's composer, beside the message box, such as "Deep research": a chip the user turns on and off for
// that chat. Each chat keeps its own state (saved with the chat, so it outlives a restart), starting at `default` (off
// without it). Several extensions can each add theirs. The extension reads a chat's state with host.toggled and sets
// it with host.setToggle; onChange runs when the user flips it, after the new state is saved. While the extension is
// off, or left out of the chat by its setup, the chip isn't shown and the saved state waits for it to come back.
export type ExtensionComposerToggle = {
  id: string
  // Short, such as "Deep research"; shown on the chip.
  label: string
  icon?: 'search' | 'globe' | 'book' | 'sparkle' | 'bolt'
  // Explanations on hover, while it's off and while it's on; both default to label.
  hint?: string
  activeHint?: string
  default?: boolean
  shown?(chat: ChatDetail, context: ExtensionContext): boolean
  onChange?(on: boolean, chat: ChatDetail, context: ExtensionContext): void | Promise<void>
}

// A one-shot model call: no tools, no session. schema asks for JSON of that shape where the engine supports it.
// chatId: the chat it's for (a memory summary of that chat, a research run started in it), so the Inspector's Activity
// lists the call under that chat; without one it's listed as not tied to a chat.
export type CompletionRequest = { system: string; prompt: string; schema?: object; timeoutMs: number; chatId?: string }

// An extension's chat is pinned, can't be renamed, archived or deleted, and keeps no folders, files or AGENTS.md of its
// own. prompt: the id of one of the extension's prompts (where 'instructions') that holds these instructions, so the
// user can edit them in Settings; Kothar then sends the user's edit, else instructions.
export type ExtensionChat = { id: string; name: string; instructions: string; prompt?: string; seesAll?: boolean }

// provider: the model provider it signs in to, on engines with more than one (OpenCode); a model of one provider
// doesn't run on another's account.
export type ExtensionAccount = { id: string; name: string; signedIn?: boolean; provider?: string }

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
  // The files directly in a folder of it (the top without one), by name and size in bytes, sorted by name. Folders and
  // links aren't listed; a missing folder lists nothing. A chat's storage leaves out the core's own files.
  list(folder?: string): ExtensionStoredFile[]
}

export type ExtensionStoredFile = { name: string; size: number }

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
  // Only with parentId: the child's final reply isn't queued for its parent as a report and doesn't wake it. The
  // extension reads it in onTurnCompleted (TurnSummary.text, for the child's chat), for children whose work it gathers
  // itself, such as research workers. It's still listed under its parent while it runs, and removed once it's done.
  quiet?: boolean
}

// Each extension gets a host of its own, so storage and notes know which extension they belong to.
export type ExtensionHost = {
  // A new chat; send it its first message with send. Without parentId it's a space, with its own folders and files.
  // With parentId it's a child of that chat, made exactly as spawn_worker makes a worker: listed under its parent and
  // view only (the user can watch and stop it, not write to it), working in its space's work folder and checkouts,
  // seeing its parent's memory as it was at launch, on the models of `role` (default 'workers'). Its final reply joins
  // the parent's queue as a report and wakes it, and it is removed once it has reported. A child takes its folders from
  // its space (so no folders or files), can't have children of its own, and its parent must not be archived. The host
  // sets no limit on how many run; spawn_worker counts them toward the Workers extension's. With quiet, its reply comes
  // to the extension instead (NewChatSpec.quiet).
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
  // panel of this extension's, and with action too, then sends the panel that action (as if clicked in it), such as
  // which item to show. With card, it's drawn as a card instead (see ExtensionNoteCard), which stays in view when the
  // turn's steps fold away: for something the user will come back to, such as an artifact an agent made.
  note(chatId: string, text: string, options?: ExtensionNoteOptions): void
  // An error for the user, shown as one from a hook that throws is: after the extension's name. For background work.
  error(text: string): void
  // A system notification, such as "Reconnect gave up" or "The browser needs you". Kothar shows it as the other
  // notifications are (Settings → Appearance → Notifications): only while the user isn't looking at the chat, and a
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
  // Adds a file to the chat's context (Context → Files), as the user adding it there does: it's pasted into the
  // instructions of the chat's next sessions and its workers'. A worker's goes to its space. Throws with a short message
  // for the user when it can't: no such file, it's already there, or the chat keeps no files (an extension's own chat,
  // such as Home).
  addContextFile(chatId: string, path: string): void
  // Files of the extension's own that belong to one chat, in the chat's folder: they go when the chat is deleted. The
  // core's own files there (chat.json, log.jsonl, AGENTS.md, parent-view.md, attachments/) are out of reach.
  chatStorage(chatId: string): ExtensionStorage
  // The chatStorage of every chat Kothar keeps, by chat id: spaces, workers, archived chats, and an extension's own chat
  // (Home) even while that extension is off and its chat isn't shown. For housekeeping across chats, such as how much
  // disk an extension's files take, or removing them; not for reading chats the user can't see.
  everyChatStorage(): { chatId: string; storage: ExtensionStorage }[]
  // The user's home folder, as the core sees it (tests and a remote machine can give another).
  home: string
  // The core's clock. Use it instead of Date.now() or new Date(), so tests and the core agree on the time.
  now(): Date
  // The chat's log as numbered memory messages, oldest first.
  messages(chatId: string): MemoryMessage[]
  // The message at entry in the chat's log, if a message is there (see ExtensionMessage).
  message(chatId: string, entry: number): ExtensionMessage | undefined
  // One call to the model picked for summaries (Settings → Models), on the user's own login, in Kothar's scratch
  // folder. Rejects when no engine that is on can make one.
  complete(request: CompletionRequest): Promise<string>
  // Opens one of this extension's panels for the chat, without moving the user's focus: a dock panel slides in beside
  // the chat and a tab shows in the right sidebar, if the user is looking at that chat (or at a chat below it). A popup
  // isn't opened, since it would take over the window. For something new the user will want to see, such as an artifact
  // an agent just made; not for every change.
  showPanel(chatId: string, panel: string): void
  // Closes one of this extension's panels for the chat, if the user has it open there: a popup or a dock closes; a tab
  // stays. For a panel's own action that hands off elsewhere, such as a popup's Open beside chat; not to take a panel
  // away from the user unasked.
  closePanel(chatId: string, panel: string): void
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
  // Runs another extension's agent tool (ExtensionTool) as if chatId's agent called it, such as the Artifacts
  // extension's create_artifact, and returns what it returns. Only a tool that's on for that chat and offered to it
  // (as its agent would see it); rejects otherwise, or with the tool's own error. For handing work to another
  // extension through its public tools rather than its files.
  callTool(chatId: string, name: string, input: Record<string, unknown>): Promise<unknown>
  // Whether one of this extension's composerToggles is on for the chat (its default if the chat never set it). Throws
  // for a toggle the extension doesn't have.
  toggled(chatId: string, toggle: string): boolean
  // Turns one of this extension's composerToggles on or off for the chat, as the user flipping it does, but without
  // calling onChange; the chip redraws.
  setToggle(chatId: string, toggle: string, on: boolean): void
  // One of this extension's prompts (Extension.prompts) as it's sent now: the user's edit from Settings, else its
  // default text. Throws for a prompt the extension doesn't declare.
  prompt(id: string): string
  // Tells the user something the extension did on its own, outside what the agent's tool calls show (it launched a
  // browser, handed one to the user, checked quotes): it's listed in the chat's Activity in the Inspector, labelled
  // with the extension's name. Kothar already lists the extension's model calls (complete), messages it sends
  // (send, continue, retry), chats it starts, account switches and tool calls (callTool), so don't repeat those.
  activity(event: ActivityInput): void
  // Asks the user's leave for something the extension is about to do for the chat's running turn, such as calling a
  // tool it relays: as an engine's tool asks, through Kothar's own rules, then extensions' policies
  // (onPermissionRequested, this extension's too), else the permission card in the chat; recorded in the Activity with
  // the rule that answered. changes: it may change something, so a read-only turn refuses it (default true). Rejects
  // when the chat has no turn running; an unanswered request is denied when the turn ends.
  requestPermission(chatId: string, request: ExtensionPermissionRequest, options?: { changes?: boolean }): Promise<ExtensionPermissionAnswer>
}

// Something Kothar or an extension did on its own, outside the agent's own tool calls (Extension.onActivity).
// kind: 'model' (a model call outside the chat's turn), 'permission' (a request answered, and which rule answered it),
// 'turn' (how an extension changed a turn: read only, another model list, a toggle that was on, a rewritten message),
// 'worker' (a chat started or sent a message by an extension, such as a quiet worker), 'tool' (an extension called
// another's tool), 'retry' (a turn carried on or run again), 'account' (an account switch), 'browser', 'other'.
export type ActivityKind = 'model' | 'permission' | 'turn' | 'worker' | 'tool' | 'retry' | 'account' | 'browser' | 'other'
export type ActivityEvent = {
  id: string
  at: string
  // The chat it's about; none for a model call not tied to a chat.
  chatId?: string
  // The chat's turn running then (SentTurn.turn), if any.
  turn?: string
  kind: ActivityKind
  // Who did it: Kothar itself (no extension), or an extension by id and name.
  by: { extension?: string; name: string }
  title: string
  detail?: string
  // A model call's model, and what it was sent, labelled as in SentSection.
  model?: string
  sections?: { label: string; text: string }[]
  result?: string
  error?: string
  // A permission request: how it was answered, and the rule that answered it.
  decision?: 'allowed' | 'denied'
  rule?: string
}
export type ActivityInput = { kind: ActivityKind; title: string; chatId?: string } & Partial<
  Pick<ActivityEvent, 'detail' | 'model' | 'sections' | 'result' | 'error'>
>

// How a note shows (host.note). card: title in bold, then text, with a badge (such as a kind) and a quieter detail
// (such as a version) beside it. Each is plain text, cut if long.
export type ExtensionNoteCard = { title: string; badge?: string; detail?: string }
export type ExtensionNoteOptions = { panel?: string; action?: ExtensionAction; card?: ExtensionNoteCard }

// What waits for the user on a chat: a short line saying what's needed, and its buttons.
// closes: the button answers the wait for good, such as Done. Clicking it ends the wait at once, in the UI and in the
// core, before onWaitAction runs, so the bar goes the moment it's clicked, whatever slow work the extension then does,
// and a second click finds nothing to answer. Without it the wait stays until the extension calls endWait.
export type ExtensionWaitButton = { id: string; label: string; primary?: boolean; hint?: string; closes?: boolean }
export type ExtensionWait = { text: string; buttons: ExtensionWaitButton[] }

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
// since. model is the one the turn ran on, in the engine's own id, absent if Kothar didn't pick one. resetsAt is ISO, if the engine said. output: the engine had written, thought or called a tool since the
// chat's last message (across continuations), so sending that message again would redo work.
export type LimitReached = {
  chat: ChatSummary
  engine: string
  account?: string
  model?: string
  message: string
  resetsAt?: string
  output: boolean
}

// A turn as it started: the message the user (or an extension) sent, before any transform. A continuation has
// continued.
export type TurnStart = { chat: ChatDetail; text: string; continued: boolean }

// Why a turn failed, so extensions needn't read engines' error text: Stop (interrupted), a usage or rate limit
// (rate_limit), the connection (network), the engine's service overloaded or down (overloaded, as 502/503/504/529), or
// anything else (other). Each adapter reads its own engine's errors; absent when nothing labelled the error.
export type TurnErrorKind = 'interrupted' | 'rate_limit' | 'network' | 'overloaded' | 'other'

// A turn as it ended. text is its last reply; files are the paths its edit tools named, in order, without repeats.
// errorKind is set with error: see TurnErrorKind.
export type TurnSummary = {
  chat: ChatDetail
  error?: string
  errorKind?: TurnErrorKind
  text: string
  tools: { name: string; kind: ToolKind; summary: string; path?: string; isError?: boolean }[]
  files: string[]
}

// message is shown to the agent when the request is denied.
export type PermissionVerdict = { allow: boolean; message?: string }

// How one turn of a chat runs, set by an extension as the turn starts (Extension.turnOptions). It can only make a turn
// stricter, or pick the model list it runs on; nothing here gives a turn more than the chat's own settings do.
// - readOnly: the turn may read but change nothing. Kothar enforces it, not the agent: where the chat is sandboxed,
//   nothing in the work folder, checkouts or folders is writable (only the session's scratch .tmp folder and the
//   engine's own state); edit requests are refused; a command is refused unless Kothar can tell it only reads; and the
//   engine is started read-only where it has such a mode (Codex's read-only sandbox, OpenCode's edits denied, Claude
//   Code's edit tools off). Reads, searches and fetches are answered as the chat's switches say. These refusals are the
//   core's, so no extension's onPermissionRequested can allow them.
// - reason: what the agent is told when a request is refused for readOnly, such as "Plan first is on: …".
// - role: the turn runs on this model list (Settings → Models) when the user has put models in it; otherwise on the
//   chat's own model, as usual. The chat's saved engine and model don't change.
export type TurnOptions = { readOnly?: boolean; reason?: string; role?: ModelRole }

export type ExtensionTool = {
  name: string
  description: string
  // A JSON Schema of an object. Kothar reads type, properties, required and the usual keywords; one it can't read
  // leaves the tool out of the session, with the error shown.
  inputSchema: { type: 'object'; properties?: Record<string, object>; required?: string[]; [keyword: string]: unknown }
  offered(caller: ChatSummary): boolean
  // caller: the chat whose agent called the tool. host.reaches(caller.id, …) says which chats it may act on.
  run(input: Record<string, unknown>, call: { caller: ChatSummary; values: ExtensionValues; host: ExtensionHost }): unknown
  // 'mcp': run returns an McpToolResult, passed to the agent as it is (pictures and all) instead of as text. For an
  // extension that relays another MCP server's tools.
  result?: 'mcp'
}

// What an MCP tool call returns (the MCP spec's CallToolResult): content blocks such as { type: 'text', text } or
// { type: 'image', data, mimeType }, and isError for a failure the agent should see.
export type McpToolResult = { content: { type: string; [key: string]: unknown }[]; isError?: boolean; structuredContent?: Record<string, unknown> }

// A permission an extension asks for (host.requestPermission), as an engine's tool asks for one: name and summary as
// the card shows them, kind (default 'mcp') for the core's rules, input as the card's detail.
export type ExtensionPermissionRequest = { name: string; summary: string; kind?: ToolKind; input?: unknown; path?: string; command?: string }
// The answer, and the rule that gave it as the Activity names it ("You", "Read-only turn", an extension's name, …).
export type ExtensionPermissionAnswer = { allow: boolean; rule: string; message?: string }

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
  // Parts of the label to highlight, such as what a search matched: [start, end) character ranges.
  marks?: [number, number][]
  // A quieter line under the label, such as the line of text a search matched, with its own highlighted ranges.
  excerpt?: { text: string; marks?: [number, number][] }
  // A small button at the end of the row, apart from its action, such as "Link" on a mention.
  button?: { label: string; action: ExtensionAction; hint?: string }
}

// An entry of a menu view: acts as a button does (confirm and pick too; an entry whose pick has no picker, in a
// browser tab, isn't drawn). checked: a tick before it, such as the order a list is in. danger colours it red.
// { type: 'divider' } draws a line between groups.
export type ExtensionMenuItem =
  | {
      label: string
      action: ExtensionAction
      hint?: string
      disabled?: boolean
      checked?: boolean
      danger?: boolean
      confirm?: { text: string; body?: string; ok?: string; danger?: boolean }
      pick?: { kind: 'folder' | 'file'; title?: string }
    }
  | { type: 'divider' }

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
      // Opens the system's picker first, for a folder or a file, with title as its heading. The action is sent with
      // value: the picked path; nothing is sent if the user cancels. The picker exists only in the desktop app: in a
      // browser tab the button isn't drawn, so offer another way too, such as a form for a typed path.
      pick?: { kind: 'folder' | 'file'; title?: string }
    }
  | { type: 'link'; text: string; url: string }
  | { type: 'list'; items: ExtensionListItem[]; empty?: string; label?: string }
  // language 'diff' colours added and removed lines; javascript (js, mjs), jsx, typescript (ts), tsx, html (htm, svg,
  // xml), css, json and python (py) get syntax colours in the theme's; others are shown plain. follow: for output that
  // grows, such as a log: shows the last maxLines lines instead of the first, scrolled to the end, and stays at the end
  // as lines arrive unless the user scrolls up. lineNumbers: numbers each line in a gutter. fill: takes the room it's
  // given (a popup's or a dock's main column) instead of at most 480 px.
  | {
      type: 'code'
      text: string
      language?: string
      maxLines?: number
      follow?: boolean
      lineNumbers?: boolean
      fill?: boolean
    }
  // Markdown, drawn as Kothar draws replies (GitHub-flavoured: tables, task lists, code blocks with Copy). Raw HTML in it
  // stays text, and links open in the browser.
  | { type: 'markdown'; text: string }
  // A card with a title that folds; open says how it starts.
  | { type: 'card'; title: string; badges?: ExtensionListItem['badges']; open?: boolean; children: ExtensionView[] }
  | { type: 'divider' }
  // Text fields the user fills in, such as a note to save. The UI keeps what's typed until submit, which sends the
  // action named submit.action with value { [field name]: text }; cancel sends its action as a button does. value is a
  // field's starting text; rows above 1 make it a multi-line box. A form with a new key (or new starting values) starts
  // over.
  | {
      type: 'form'
      key?: string
      fields: { name: string; label: string; value?: string; placeholder?: string; rows?: number; mono?: boolean; hint?: string }[]
      submit: { label: string; action: string }
      cancel?: { label: string; action: ExtensionAction }
    }
  | { type: 'empty'; text: string }
  // Two columns, for a popup (ExtensionPanel.placement): side is a narrow column on the left, such as a list, and main
  // takes the rest, such as an editor. Each scrolls on its own. In a narrow panel side sits above main.
  | { type: 'split'; side: ExtensionView; main: ExtensionView }
  // A search box. As the user types it sends the action named action with value: the text (after a short pause), so the
  // panel can draw what matches. key: a new key starts over at value; otherwise what's typed stays as the panel draws
  // again. submit: Enter sends this action with value: the text, at once (such as opening the best match). ArrowDown
  // moves to the first list below it, and the arrows move along a list. autofocus: in a popup, the box takes the keyboard
  // when the popup opens (unless something else in it, such as an editor's autofocus, took it first); a tab or a dock
  // never takes focus by itself.
  | { type: 'search'; key?: string; value?: string; placeholder?: string; label?: string; action: string; submit?: string; autofocus?: boolean }
  // A Markdown editor with live preview, as in Obsidian: the text stays plain Markdown, but outside the line being
  // edited its marks are hidden and it's drawn as it reads (headings, bold, italics, code, quotes, lists, links). It
  // sends the action named change with value: the whole text, a moment after the user stops typing and when the
  // editor loses focus or closes. key: a new key starts over at text. With the same key, a new text from the extension
  // (say, the file changed on disk) replaces the editor's only while the user has nothing unsent.
  // links: clicking a [[wikilink]] sends this action with value: its target (before any | or #). tags: clicking a
  // #tag sends this action with value: the tag without its #. Without them, they're drawn but don't act.
  | {
      type: 'editor'
      key: string
      text: string
      change: string
      label?: string
      placeholder?: string
      links?: string
      tags?: string
      // Puts the cursor in it when it first shows.
      autofocus?: boolean
      // Names typing [[ offers, such as every note's: the arrows pick one, Enter or Tab puts it in as [[name]].
      completions?: string[]
      // When the text changed elsewhere while the user had unsent typing and they pick "Keep mine", this action is sent
      // first with value: the other text, so the extension can keep it somewhere (say, as a copy) before the editor's
      // text replaces it. Without it, the other text is dropped.
      keep?: string
      // Moves the cursor to the start of a line (numbered from 1) and scrolls it to the top, such as a heading picked in
      // an outline; the editor takes focus. Each new key jumps once; the same key again does nothing.
      jump?: { key: string; line: number }
      // A folder of the extension's own (in host.storage.dir or a chat's chatStorage folder) that pictures in the text
      // are read from: ![alt](attachments/a.png) shows <files>/attachments/a.png. Kothar serves only plain pictures (PNG,
      // JPEG, GIF, WebP) inside the extension's folders, outside the core's own files; anything else stays text.
      files?: string
      // With files: pasting or dropping a picture puts ![](attachments/pasted-<time>.png) in the text at once and sends
      // this action with value { path, mimeType, data }: path relative to files (always attachments/<name>, the name made
      // of letters, digits and dashes), data the picture's bytes in base64. The extension saves it there; until it does,
      // the editor shows its own copy. Pictures over 10 MB are refused.
      paste?: string
    }
  // A page of HTML, such as a chart or a mockup an agent made, drawn in a sandboxed frame. Its scripts run, but in an
  // origin of their own: they can't reach Kothar's window, storage, token or core, open windows or popups, submit forms
  // or navigate Kothar. It loads nothing from the network: scripts and styles only inline, images, fonts and media only
  // as data: or blob: URLs, and no fetch, XHR or WebSocket. web: also lets it load scripts, styles, images, fonts and
  // media from https: URLs (such as a chart library from a CDN); fetch, XHR and WebSockets stay blocked. label names
  // the frame for screen readers. height in pixels; without it the frame takes the room it's given (a popup's main
  // column). errors: each runtime error the page hits (an uncaught error or a rejected promise, with its stack where
  // there is one) is sent as the action named errors with value: the error's text, at most 2000 characters and 20 per
  // page load. The page could send any text this way, so treat it as the page's, not Kothar's. theme: the page draws in
  // Kothar's light or dark scheme (prefers-color-scheme inside matches it, and there's no white sheet behind it), for
  // pages made to follow it; without it a page draws on white, as in a browser. libraries: libraries Kothar ships and
  // serves itself, offline, loaded before the page's own scripts (and allowed by the policy, which stays closed to the
  // network otherwise): see HtmlLibrary.
  | {
      type: 'html'
      html: string
      label: string
      web?: boolean
      height?: number
      errors?: string
      theme?: boolean
      libraries?: HtmlLibrary[]
    }
  // A message of the panel's chat, quoted: author and time (ISO, shown short) above its text, drawn as Markdown and
  // folded with Show more when long. Clicking the author line scrolls the chat to the message at entry (loading older
  // history first if needed) and flashes it. buttons: small views beside the author line, such as an Unpin button or
  // a copy.
  | { type: 'message'; entry: number; author: string; at: string; text: string; buttons?: ExtensionView[]; hint?: string }
  // A ⋯ button that opens a menu of actions, for the rarer things a view can do (rename, move, delete) so they don't
  // crowd it. label names the button for screen readers and on hover ("More for Project plan"). See ExtensionMenuItem.
  | { type: 'menu'; label: string; items: ExtensionMenuItem[] }
  // A button that copies text, such as a file's contents, to the clipboard.
  | { type: 'copy'; text: string; label: string; hint?: string }
  // A button that saves text as a file through the browser's download (a save dialog in the desktop app). mimeType
  // defaults to text/plain.
  | { type: 'download'; text: string; filename: string; label: string; mimeType?: string; hint?: string }
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

// Libraries an html view's page can load from Kothar, offline:
// - react: React 19 and ReactDOM. The page puts its component in <script type="text/jsx"> (JSX and TypeScript work;
//   only react and react-dom can be imported) and its default export is drawn into #root.
// - mermaid: every element with class "mermaid" is drawn as a Mermaid diagram, in the frame's scheme, with Mermaid's
//   strict security.
// - tailwind: Tailwind CSS's browser build styles the page's utility classes.
export type HtmlLibrary = 'react' | 'mermaid' | 'tailwind'

// A tab beside General and Context in the right sidebar, or a popup over the chat.
export type ExtensionPanel = {
  id: string
  title: string
  // 'tab' (the default): a tab in the right sidebar. 'popup': a large window over the chat, for work that wants room,
  // such as notes; Esc closes it. 'dock': a column beside the chat, for something to look at while the chat goes on,
  // such as an artifact: the user resizes it by its edge, widens it to fill the chat pane, and closes it; it takes no
  // focus when it opens. One dock panel shows at a time, kept per chat. Only one right-hand column shows: while a dock
  // is open the right sidebar hides, and the sidebar's toggle swaps the two. Whichever, it belongs to the chat that's
  // open, and draws for it.
  placement?: 'tab' | 'popup' | 'dock'
  // Keys that open the panel (a popup) or show its tab, out of the box, such as 'Mod+Shift+N' (Mod is ⌘ on macOS,
  // Ctrl elsewhere). The user can change them in Settings → Shortcuts. Keys some other shortcut already has are left
  // off; pick ones that are free.
  shortcut?: string
  // Also show a launcher for this panel in the left sidebar; the panel is always a tab in the right panel. The user
  // picks where launchers sit (Settings → Appearance), at the top of the sidebar by default.
  launcher?: boolean
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

// Text an extension sends to agents that the user can read and change: in Settings, on the extension's page (Prompts),
// and in the Inspector, where it shows labelled in what each turn was sent. Read it with host.prompt(id), which gives
// the user's edit or else text, and send that, such as from instructions(). The user can reset an edit to text; when
// text changes in an update, an edit made before it is marked "Updated default".
// - id: lowercase letters, digits and dashes, unique in the extension.
// - label: what it's for, such as "When to make artifacts".
// - where: 'instructions' for text that goes in the session's instructions (from instructions() or memory.instructions);
//   'message' for text put with the user's message, such as a memory's view header; 'background' for text the
//   extension sends a model it calls on its own (host.complete, a quiet worker's prompt), outside the chat's turn.
// Each agent tool's description is a prompt too, without declaring it: id tool:<name>. Agents are sent the user's edit.
export type ExtensionPrompt = { id: string; label: string; text: string; where: 'instructions' | 'message' | 'background'; description?: string }

// What a turn was sent, in order, as Kothar handed it to the engine (Extension.onTurnSent). Joining the instructions
// sections with a blank line gives the session's instructions exactly, and the prompt sections the prompt.
// source: you (the user's message), core (Kothar's own rules), context (the chat's context items and setup), extension
// (an extension's text: extension is its id), tools (a tool the session is offered, with its owner), turn (how the turn
// runs: engine, model, read only, sandbox), engine (what the engine adds itself, which Kothar can't see: text says so).
export type SentSource = 'you' | 'core' | 'context' | 'extension' | 'tools' | 'turn' | 'engine'
export type SentSection = {
  source: SentSource
  // 'instructions', 'prompt' (the message the engine gets), or 'other' (tools, how the turn runs, the engine's own)
  part: 'instructions' | 'prompt' | 'other'
  label: string
  text: string
  extension?: string
  // The extension's name, as Settings shows it.
  extensionName?: string
  // The extension's prompts in it, with whether the user edited each; editable: the user can change it in Settings.
  prompts?: { id: string; label: string; edited: boolean }[]
  editable?: boolean
}
// kind 'turn': a turn's session opened with these sections. 'steer': a message entered the running turn (turn is the
// id of the turn it entered), with one section.
export type SentTurn = {
  id: string
  kind: 'turn' | 'steer'
  turn: string
  chat: ChatSummary
  at: string
  engine: string
  model?: string
  account?: string
  continued: boolean
  sections: SentSection[]
}

// Hooks run in the core. A hook that throws or rejects shows its error and doesn't stop the chat; the core doesn't wait
// for async hooks except onPermissionRequested.
export type Extension = {
  id: string
  name: string
  description: string
  enabledByDefault: boolean
  settings?: ExtensionSetting[]
  // Text it sends agents that the user may edit (see ExtensionPrompt).
  prompts?: ExtensionPrompt[]
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
  // More tools, made for each chat as its session lists them (each turn's session asks once, as it starts), such as
  // tools relayed from another MCP server. Keep it quick and synchronous; an error shows and offers none. offered still
  // counts. host.callTool reaches them too.
  toolsFor?(caller: ChatSummary, context: ExtensionContext): ExtensionTool[]
  mcpServers?(session: ExtensionSession): McpServer[]
  // Text for every session's instructions, after where the chat may write and before its memory. Return nothing to add
  // none. Extensions are joined in load order.
  instructions?(session: ExtensionInstructionsFor, context: ExtensionContext): string | undefined
  setup?: ExtensionSetup
  panels?: ExtensionPanel[]
  commands?: ExtensionCommand[]
  messageActions?: ExtensionMessageAction[]
  composerToggles?: ExtensionComposerToggle[]
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
  // A space was deleted (after onChatRemoved for each of its chats): its work folder and checkouts as they were. Kothar
  // removes the work folder and the checkouts itself, since it made them; this is for an extension's own records of
  // them, such as cached pull requests of a checkout.
  onSpaceRemoved?(space: SpaceDetail, context: ExtensionContext): void | Promise<void>
  onStatusChanged?(chat: ChatDetail, status: ChatStatus, context: ExtensionContext): void | Promise<void>
  onTurnStarted?(turn: TurnStart, context: ExtensionContext): void | Promise<void>
  onTurnCompleted?(turn: TurnSummary, context: ExtensionContext): void | Promise<void>
  // Each message runs its own engine session, so this follows every turn; error is set if the engine quit early.
  onSessionEnded?(ended: { chat: ChatDetail; error?: string }, context: ExtensionContext): void | Promise<void>
  // Every common event as it arrives, deltas included. Read-only, so keep it quick.
  onEvent?(chat: ChatDetail, event: EngineEvent, context: ExtensionContext): void
  // What a turn's session was sent, as it opens, and each message steered into it (SentTurn). Called only when some
  // extension that's on watches it, so the core builds nothing otherwise.
  onTurnSent?(sent: SentTurn, context: ExtensionContext): void
  // Something Kothar or an extension did on its own (ActivityEvent), as it happens. Like onTurnSent, called only when
  // some extension that's on watches, so the core builds nothing otherwise.
  onActivity?(event: ActivityEvent, context: ExtensionContext): void
  // A policy for permission requests the core would otherwise ask the user about, or would allow on its own. Return a
  // verdict to answer it, or nothing to leave it. Extensions are asked in load order; the first verdict wins. The
  // core's own denials (edits outside the work folder in a sandbox) always stand.
  onPermissionRequested?(
    request: PermissionRequest,
    chat: ChatDetail,
    context: ExtensionContext,
  ): PermissionVerdict | undefined | Promise<PermissionVerdict | undefined>
  // How the chat's next turn runs (TurnOptions), asked as each turn starts, continuations included, before its
  // session opens: read only, and on which model list. Return nothing to leave the turn as it is. Every extension
  // that's on for the chat is asked: the turn is read only if any says so (the first one's reason is used), and runs on
  // the first role given. Keep it quick and synchronous; one that throws shows its error and counts as nothing.
  turnOptions?(chat: ChatDetail, context: ExtensionContext): TurnOptions | undefined
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
  // Extension fields: tools, toolsFor; and host.callTool
  | 'tools'
  | 'mcpServers'
  // instructions, prompts
  | 'instructions'
  // onPermissionRequested, turnOptions, and host.requestPermission
  | 'permissions'
  // transformMessage, transformOutput
  | 'transforms'
  // onEvent, onTurnStarted, onTurnCompleted, onStatusChanged, onSessionEnded, onChatCreated, onChatRemoved,
  // onChatArchived, onSpaceRemoved, onLimitReached, onStart, onStop
  | 'events'
  // panels, processes, onProcessAction, onProcessesChanged, onWaitAction, and host.wait, endWait, processes,
  // processAction, processesChanged
  | 'panels'
  // commands, messageActions, composerToggles, and host.toggled, setToggle
  | 'commands'
  // settings, spaceSettings, migrateSettings, settingsView, onSettingsChanged, and host.spaceValues, setSpaceValue
  | 'settings'
  | 'chats'
  | 'setup'
  // memory, and host.chatStorage, everyChatStorage
  | 'memory'
  // Host calls: chats, chat, read, space, messages, message, reaches, reachable; and onTurnSent.
  | 'readChats'
  // send, createChat, retry, continue, interrupt, addContextFile
  | 'sendMessages'
  // accounts, useAccount
  | 'accounts'
  // run, spawn, openTerminal, reveal; and Node's child_process, worker_threads and cluster
  | 'run'
  // complete
  | 'models'
  // Node's own APIs, not the host: fetch, WebSocket, node:http, https, net, tls, dns and the like
  | 'network'
  // host.home; and Node's own APIs: node:fs, for anything outside host.storage
  | 'files'

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
