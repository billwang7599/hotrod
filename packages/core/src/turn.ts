// What happens to a chat once it has a message: its turn starts (send), the engine's events come in (one session per
// turn, each with its own handler), steered and queued messages wait for it, and it ends (endTurn), stopped or not.
// The chat's status, waits and queue change here. The core passes in everything else as plain functions; nothing here
// keeps chats.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type {
  ChatDetail,
  Extension,
  ExtensionContext,
  ExtensionWait,
  ExtensionWaitAnswer,
  McpServer,
  ModelRole,
  PermissionRequest,
  PermissionVerdict,
} from '@kothar/extension-api'
import type { openAccounts } from './accounts.ts'
import type { Chat } from './chat.ts'
import type { Checkout } from './checkouts.ts'
import type { ExtensionHook } from './extensions.ts'
import { placeAccess, placesOf, type FolderPlace } from './folder-modes.ts'
import { summaryOf } from './kothar-mcp.ts'
import { instructionSections, type InstructionParts, type InstructionSection } from './instructions.ts'
import { continuationParts, messagesOf, seededParts, withAttachments, type PromptPart, type Report } from './memory.ts'
import type { openModels } from './models.ts'
import { decide, READ_ONLY_REASON, type RuledVerdict, type verdictOf } from './permissions.ts'
import type { Activity } from './activity.ts'
import { runningChildren } from './workers.ts'
import { isToggled } from './composer-toggles.ts'
import {
  editsAnywhere,
  IMAGE_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  MODEL_ROLES,
  type Adapter,
  type Answers,
  type Attachment,
  type ChatEntry,
  type ChatInfo,
  type ChatStatus,
  type ChatWait,
  type CoreMessage,
  type EngineEvent,
  type Machine,
  type MemoryMessage,
  type QueuedMessage,
  type Session,
  type SessionOptions,
  type Upload,
} from './shared.ts'
import { messageOf } from './util.ts'

// Where the Machine can't sandbox (Linux, Windows for now), a chat runs only once the user allows edits anywhere.
export const UNSANDBOXED_NEEDS_EDIT_ANYWHERE = true

type Sandbox = { writable: string[]; tmpDir: string; readOnly?: string[] }

export type TurnDeps = {
  garage: string
  /** The user's home folder, which permission answers keep secrets in. */
  home: string
  /** The time, for log entries. */
  now: () => Date
  machine: Machine
  stopGraceMs: number
  isQuitting: () => boolean
  chats: ReadonlyMap<string, Chat>
  broadcast: (message: CoreMessage) => void
  append: (chat: Chat, entry: ChatEntry) => void

  // Chats
  detailOf: (chat: Chat) => ChatDetail
  parentOf: (chat: Chat) => Chat | undefined
  chainOf: (chat: Chat) => Chat[]
  familyOf: (chat: Chat) => Chat[]
  switchesOf: (chat: Chat) => Parameters<typeof editsAnywhere>
  checkActive: (chat: Chat) => void
  updateChat: (chat: Chat, change: Partial<ChatInfo>) => void
  removeChats: (family: Chat[]) => void

  // Extensions
  extensions: readonly Extension[]
  isOn: (extension: Extension) => boolean
  isOnFor: (extension: Extension, chat: Chat | undefined) => boolean
  contextOf: (extension: Extension) => ExtensionContext
  callExtension: (extension: Extension, run: () => unknown) => void
  callExtensions: (hook: ExtensionHook, run: (extension: Extension, context: ExtensionContext) => unknown) => void
  watchersOf: (hook: ExtensionHook, chat?: Chat) => Extension[]
  extensionError: (extension: Extension, error: unknown) => void
  answerWait: (chat: Chat, extensionId: string, answer: ExtensionWaitAnswer) => void

  // Engines and sessions
  adapterFor: (engine: string) => Adapter | undefined
  models: Pick<ReturnType<typeof openModels>, 'runOf' | 'whyNot' | 'lists'>
  choosesOf: (chat: Chat) => Parameters<ReturnType<typeof openModels>['runOf']>[0]
  accounts: Pick<ReturnType<typeof openAccounts>, 'sessionFor' | 'activeOf'>
  takesMcp: (engine: string) => boolean
  mcpUrl: () => string | undefined
  grantMcp: (chatId: string) => string | undefined
  revokeMcp: (token: string) => void
  extensionServers: (chat: Chat, workDir: string, sandboxed: boolean) => McpServer[]

  // Where a session runs
  workDirOf: (chat: Chat) => string
  sandboxIn: (dir: string) => Sandbox | undefined
  attachmentsDirOf: (chat: Chat) => string
  checkoutOf: (space: Chat, folder: string, workDir: string, sandboxed: boolean) => Promise<Checkout>
  copyOf: (space: Chat, folder: string, workDir: string) => Promise<{ path: string }>

  // What a session is told
  viewOf: (chat: Chat, messages: MemoryMessage[], tools: boolean) => string
  instructionPartsOf: (chat: Chat, zoomable: boolean) => SessionParts
  // What a turn's session was sent, or a message steered into it, for extensions that watch (onTurnSent).
  turnSent?: (chat: Chat, sent: SentInput) => void
  // What Kothar and extensions do on their own (activity.ts): permission answers, how extensions changed a turn.
  activity?: Activity
  /** How many of one chat's children may run at once (Settings → Workers; -1: no limit). Absent: no limit. */
  workerLimit?: () => number
  // The engine's built-in tools for a chat's session (engine-tools.ts). Absent: the adapter's own defaults.
  engineToolsFor?: (chat: Chat, engine: string) => Pick<SessionOptions, 'tools' | 'noTools'>
  // The engine said which built-in tools its session has.
  toolsListed?: (engine: string, names: string[]) => void
}

// What the core hands on of a turn as its session opens (kind 'turn'), or of a message steered into it ('steer'), for
// sent.ts to label.
export type SentInput =
  | {
      kind: 'turn'
      turn: string
      instructions: InstructionSection[]
      prompt: PromptPart[]
      // The user's message was rewritten by transformMessage on its way.
      rewritten: boolean
      continued: boolean
      engine: string
      model?: string
      thinking?: string
      account?: string
      sandboxed: boolean
      readOnly?: { reason?: string; by?: string }
      role?: { role: ModelRole; by: string; used: boolean }
      kotharMcp: boolean
      mcpServers: string[]
      images: number
      // The engine's own tools turned off for the turn (Settings → Engines → Tools), by its names; none: every one,
      // by a master switch. Absent for an engine whose tools Kothar can't switch.
      engineTools?: { off: string[]; none?: true }
    }
  | { kind: 'steer'; turn: string; text: string; engine: string }

type TurnInput = { text: string; attachments: Attachment[]; reports: Report[]; continuation?: string }

/** A turn ready to start: what it runs on, its prompt, what its session is told, and where it may reach. */
export type TurnPlan = {
  run: ReturnType<ReturnType<typeof openModels>['runOf']>
  adapter: Adapter
  prompt: string
  zoomable: boolean
  attachments: Attachment[]
  workDir: string
  parts: SessionParts
  readFiles: string[]
  attachmentsDir: string
  folders: string[]
  repos: string[]
  // The folders that aren't git repos, with their modes (folder-modes.ts).
  places: FolderPlace[]
  sandbox?: Sandbox
  // Extensions made the turn read only (TurnOptions): nothing it reaches is writable, and edits and changing commands
  // are refused with reason.
  readOnly?: { reason?: string }
  // For the Inspector: the prompt in labelled parts, whether the message was rewritten, and who set the turn's options.
  sent?: { parts: PromptPart[]; rewritten: boolean; continued: boolean; readOnlyBy?: string; role?: { role: ModelRole; by: string; used: boolean } }
}

/** What a session is told, but where it runs and its checkouts (buildInstructions). */
export type SessionParts = Omit<InstructionParts, 'workDir' | 'checkouts' | 'folders'>

// Where a turn's session runs and what it's told, once its checkouts are ready: the first checkout (else the work
// folder) as its folder, the other folders it may reach, its sandbox widened by the checkouts' git folders, and every
// attached folder's place for the permission answers.
// copies: each folder set to Work on a copy, by the path of its copy in the work folder.
export function sessionPlaceOf(
  plan: Pick<TurnPlan, 'workDir' | 'parts' | 'attachmentsDir' | 'folders' | 'repos' | 'places' | 'sandbox' | 'readOnly'>,
  checkouts: Checkout[],
  copies: Record<string, string> = {},
) {
  const { workDir, parts, attachmentsDir, folders, repos, sandbox } = plan
  const places = plan.places.map((place) => (place.mode === 'copy' ? { ...place, where: copies[place.path] } : place))
  const cwd = checkouts[0]?.worktree.path ?? workDir
  const sections = instructionSections({
    ...parts,
    ...(sandbox && { workDir }),
    checkouts: checkouts.map(({ folder, worktree }) => ({ folder, path: worktree.path, branch: worktree.branch })),
    folders: places,
  })
  const instructions = sections.map((section) => section.text).join('\n\n')
  const extraDirs = [
    ...(cwd === workDir ? [] : [workDir]),
    ...checkouts.slice(1).map((c) => c.worktree.path),
    ...folders.filter((folder) => !repos.includes(folder) && copies[folder] === undefined),
    ...(existsSync(attachmentsDir) ? [attachmentsDir] : []),
  ]
  const readOnly = [...(sandbox?.readOnly ?? []), ...checkouts.flatMap((c) => c.readOnly)]
  const { readOnly: _, ...rest } = sandbox ?? {}
  // A read-only turn writes only to the sandbox's scratch folder (tmpDir), which the Machine always allows.
  const jail = sandbox && {
    ...rest,
    writable: plan.readOnly ? [] : [...sandbox.writable, ...checkouts.flatMap((c) => c.writable)],
    ...(readOnly.length && { readOnly }),
  }
  const checkoutPlaces = checkouts.map((c): FolderPlace => ({ path: c.folder, mode: 'checkout', where: c.worktree.path }))
  return { cwd, instructions, sections, extraDirs, jail, folderPlaces: [...places, ...checkoutPlaces] }
}

export function openTurns(deps: TurnDeps) {
  const {
    garage,
    home,
    now,
    machine,
    stopGraceMs,
    isQuitting,
    chats,
    broadcast,
    append,
    detailOf,
    parentOf,
    chainOf,
    familyOf,
    switchesOf,
    checkActive,
    updateChat,
    removeChats,
    extensions,
    isOn,
    contextOf,
    callExtension,
    callExtensions,
    watchersOf,
    extensionError,
    answerWait,
    adapterFor,
    models,
    choosesOf,
    accounts,
    takesMcp,
    mcpUrl,
    grantMcp,
    revokeMcp,
    extensionServers,
    workDirOf,
    sandboxIn,
    attachmentsDirOf,
    checkoutOf,
    copyOf,
    viewOf,
  } = deps
  const allStoppedWaiters: (() => void)[] = []

  const waitsOf = (chat: Chat): ChatWait[] => [...chat.waits].map(([extension, wait]) => ({ extension, ...wait }))
  // An extension's wait, or none: the chat waits while any extension or request does, and runs again once none does.
  const setWait = (chat: Chat, extensionId: string, wait: ExtensionWait | undefined) => {
    if (!wait && !chat.waits.has(extensionId)) return
    if (wait) chat.waits.set(extensionId, wait)
    else chat.waits.delete(extensionId)
    broadcast({ type: 'chat.waits', chatId: chat.info.id, waits: waitsOf(chat) })
    if (wait && chat.ending && !chat.held) {
      chat.held = {}
      setStatus(chat, 'waiting')
    }
    if (wait && chat.status === 'running') setStatus(chat, 'waiting')
    if (!wait && chat.held && !chat.waits.size) return release(chat, true)
    if (!wait && chat.status === 'waiting' && !chat.pendingRequests.size && !chat.waits.size) setStatus(chat, 'running')
  }

  // A chat held after its turn goes idle. finish: it ends as the turn would have (a worker reports and goes, queued
  // messages run); otherwise an extension carries the turn on (continue, retry) and that turn ends it.
  const release = (chat: Chat, finish: boolean) => {
    const held = chat.held
    if (!held) return
    chat.held = undefined
    setStatus(chat, 'idle')
    if (finish && !isQuitting()) finishTurn(chat, held.error)
  }

  const setStatus = (chat: Chat, status: ChatStatus) => {
    if (chat.status === status || (chat.status === 'stopping' && status !== 'idle')) return
    chat.status = status
    if (status === 'idle' && chat.waits.size) {
      chat.waits.clear()
      broadcast({ type: 'chat.waits', chatId: chat.info.id, waits: [] })
    }
    broadcast({ type: 'chat.status', chatId: chat.info.id, status })
    callExtensions('onStatusChanged', (extension, context) => extension.onStatusChanged!(detailOf(chat), status, context))
  }

  const stopSession = (chat: Chat) => {
    clearTimeout(chat.stopTimer)
    chat.stopTimer = undefined
    const session = chat.session
    chat.session = undefined
    if (chat.mcpToken) revokeMcp(chat.mcpToken)
    chat.mcpToken = undefined
    session?.close()
  }

  const allStopped = () => [...chats.values()].every((chat) => !chat.session)

  const endTurn = (chat: Chat, ended: Extract<ChatEntry, { type: 'turn.completed' | 'session.ended' }>) => {
    const { limit, account, runModel } = chat
    chat.limit = undefined
    // Why it failed goes to extensions, not the log. A turn the core stopped for its limit shows the limit, not
    // "Interrupted".
    const { errorKind: engineKind, ...entry } = ended
    const end = limit && entry.error ? { ...entry, error: limit.message } : entry
    const errorKind = limit && entry.error ? 'rate_limit' : engineKind
    if (chat.unsavedText) completeText(chat, end.at, chat.unsavedText)
    chat.unsavedText = ''
    append(chat, end)
    stopSession(chat)
    unsteer(chat)
    chat.pendingRequests.clear()
    dropAsks(chat, 'The turn ended before it was answered')
    setStatus(chat, 'idle')
    // Only spaces and Home show unread; a worker is removed once it reports, so it keeps no read state.
    if (!chat.info.worker) updateChat(chat, { doneAt: end.at })
    if (allStopped()) allStoppedWaiters.splice(0).forEach((resolve) => resolve())
    if (isQuitting()) return
    const turn = chat.turn ?? { text: '', tools: [] }
    chat.turn = undefined
    const detail = detailOf(chat)
    const files = [...new Set(turn.tools.flatMap((t) => (t.kind === 'edit' && t.path ? [t.path] : [])))]
    const summary = { chat: detail, ...(end.error && { error: end.error, ...(errorKind && { errorKind }) }), ...turn, files }
    const sessionError = end.type === 'session.ended' ? end.error : undefined
    chat.ending = true
    try {
      callExtensions('onSessionEnded', (extension, context) =>
        extension.onSessionEnded!({ chat: detail, ...(sessionError && { error: sessionError }) }, context),
      )
      callExtensions('onTurnCompleted', (extension, context) => extension.onTurnCompleted!(summary, context))
    } finally {
      chat.ending = false
    }
    if (chat.held) chat.held.error = end.error
    if (limit) reportLimit(chat, account, runModel, limit)
    // An extension sent the message again, so the turn goes on, or holds the chat until it does or lets go.
    if (chat.status !== 'idle') return
    finishTurn(chat, end.error)
  }

  // What follows a turn that's over: a worker reports and goes, queued messages run.
  const finishTurn = (chat: Chat, error?: string) => {
    const parent = chat.info.worker && !chat.info.quiet ? parentOf(chat) : undefined
    if (parent) reportErrors(() => enqueue(parent, reportOf(chat, error)))
    showReport(chat, error)
    if (chat.queue.length) reportErrors(() => sendQueue(chat))
    // Workers are there for one task: once the lead has their reply, they go. The reply lives on in the lead's log.
    if (chat.info.worker && chat.status === 'idle') {
      removeChats(familyOf(chat))
      startWaitingWorkers(chat.info.parentId)
    }
  }

  // A write for an engine event failed. If the chat's folder is gone, its session stops and it goes idle; either way
  // the user sees why, and the core runs on. A worker with no folder can do nothing more, so it leaves the way a
  // finished one does, with its lead told why. A space or Home stays listed, idle, so the user decides what to do.
  const lostChat = (chat: Chat, error: unknown) => {
    const gone = !existsSync(chat.dir)
    broadcast({
      type: 'error',
      message: gone
        ? `"${chat.info.name}" stopped: its folder ${chat.dir} is gone (${messageOf(error)})`
        : `"${chat.info.name}": ${messageOf(error)}`,
    })
    if (!gone) return
    stopSession(chat)
    chat.pendingRequests.clear()
    dropAsks(chat, 'The chat stopped before it was answered')
    chat.turn = undefined
    setStatus(chat, 'idle')
    if (allStopped()) allStoppedWaiters.splice(0).forEach((resolve) => resolve())
    if (!chat.info.worker || !chats.has(chat.info.id)) return
    const parent = chat.info.quiet ? undefined : parentOf(chat)
    if (parent) reportErrors(() => enqueue(parent, reportOf(chat, `its folder ${chat.dir} is gone`)))
    showReport(chat, `its folder ${chat.dir} is gone`)
    removeChats(familyOf(chat))
    startWaitingWorkers(chat.info.parentId)
  }

  const reportErrors = (run: () => void) => {
    try {
      run()
    } catch (error) {
      broadcast({ type: 'error', message: messageOf(error) })
    }
  }

  // A quiet worker that shows its report (ChatInfo.showReport): logged in its parent's transcript for the user, as a
  // quiet report that neither queues for the parent's agent nor wakes it.
  const showReport = (chat: Chat, error?: string) => {
    if (!chat.info.quiet || !chat.info.showReport) return
    const parent = parentOf(chat)
    if (!parent) return
    const { text, report } = reportOf(chat, error)
    reportErrors(() => append(parent, { at: now().toISOString(), type: 'worker.report', text, ...report, quiet: true }))
  }

  const reportOf = (chat: Chat, error?: string) => {
    const asked = chat.entries.findLastIndex((e) => e.type === 'user.message')
    const reply = chat.entries.slice(asked + 1).findLast((e) => e.type === 'text.completed')
    const text = reply?.type === 'text.completed' ? reply.text : ''
    return { text, report: { chatId: chat.info.id, name: chat.info.name, ...(error && { error }) } }
  }

  const limitWatchers = () => extensions.filter((extension) => isOn(extension) && extension.onLimitReached)

  const reportLimit = (
    chat: Chat,
    account: string | undefined,
    model: string | undefined,
    { message, resetsAt }: NonNullable<Chat['limit']>,
  ) => {
    const { engine } = chat.info
    const limit = {
      chat: summaryOf(chat.info),
      engine,
      ...(account !== undefined && { account }),
      ...(model !== undefined && { model }),
      message,
      output: chat.produced === true,
      ...(resetsAt && { resetsAt }),
    }
    for (const extension of limitWatchers()) {
      callExtension(extension, () => extension.onLimitReached!(limit, contextOf(extension)))
    }
  }

  // A turn's input is the worker reports and the message it started with, logged together at its start.
  const retry = (chat: Chat) => {
    // A message steered into the turn isn't what started it.
    const isInput = (e: ChatEntry) => (e.type === 'user.message' && !e.midTurn) || (e.type === 'worker.report' && !e.quiet)
    const end = chat.entries.findLastIndex(isInput)
    if (end < 0) throw new Error(`${chat.info.name} has no message to send again`)
    const together = (e?: ChatEntry) => e !== undefined && isInput(e) && e.at === chat.entries[end]!.at
    let start = end
    while (together(chat.entries[start - 1])) start--
    const again = chat.entries.slice(start, end + 1).map((e): QueuedMessage => {
      const id = randomBytes(4).toString('hex')
      if (e.type === 'worker.report') {
        const { chatId, name, error } = e
        return { id, text: e.text, report: { chatId, name, ...(error !== undefined && { error }) } }
      }
      const { text, attachments } = e as Extract<ChatEntry, { type: 'user.message' }>
      return { id, text, ...(attachments && { attachments }) }
    })
    setQueue(chat, [...again, ...chat.queue])
    release(chat, false)
    if (chat.status === 'idle') sendQueue(chat)
  }

  // Carries on a turn that stopped part way, as a turn of its own; queued messages wait for it.
  const continueTurn = (chat: Chat, text: string) => {
    if (!text.trim()) throw new Error('A continuation needs a prompt')
    release(chat, false)
    if (chat.status !== 'idle') throw new Error(`${chat.info.name} is still running`)
    send(chat, '', [], [], text)
  }

  // Each extension's text transform in turn; one that throws leaves the text as it was.
  // How extensions shaped a turn as it opened: read only, another model list, and the composer toggles that were on.
  const recordTurnChanges = (chat: Chat, sent: NonNullable<TurnPlan['sent']>, readOnly: TurnPlan['readOnly']) => {
    const activity = deps.activity
    if (!activity?.listening(chat.info.id)) return
    const extensionOf = (id: string) => watchersOf('turnOptions', chat).find((extension) => extension.id === id)
    if (readOnly && sent.readOnlyBy) {
      activity.emit(chat.info.id, () => ({
        kind: 'turn',
        ...(extensionOf(sent.readOnlyBy!) && { by: extensionOf(sent.readOnlyBy!) }),
        title: 'Made this turn read only',
        ...(readOnly.reason && { detail: `Told the agent when it tries a change: ${readOnly.reason}` }),
      }))
    }
    if (sent.role) {
      const { role, by, used } = sent.role
      activity.emit(chat.info.id, () => ({
        kind: 'turn',
        ...(extensionOf(by) && { by: extensionOf(by) }),
        title: used ? `Ran this turn on the ${role} model list` : `Asked for the ${role} model list, which is empty, so the chat’s own model ran`,
      }))
    }
    for (const extension of deps.extensions.filter((e) => e.composerToggles?.length && deps.isOnFor(e, chat))) {
      const on = extension.composerToggles!.filter((toggle) => isToggled(chat.info, extension, toggle))
      if (!on.length) continue
      activity.emit(chat.info.id, () => ({
        kind: 'turn',
        by: extension,
        title: `On for this turn: ${on.map((toggle) => toggle.label).join(', ')}`,
      }))
    }
  }

  // Requests left to the user, by id, so their answer is recorded with what was asked.
  const asked = new Map<string, PermissionRequest>()
  // Permission requests an extension raised (host.requestPermission), by id: answered here, not by the engine.
  const extensionAsks = new Map<string, { chat: Chat; resolve: (verdict: RuledVerdict) => void }>()
  // Each chat's live session events, for an extension's request to go through as an engine's does.
  const liveEvents = new WeakMap<Chat, ReturnType<typeof sessionEvents>>()
  const respondTo = (session: Session | undefined, requestId: string, verdict: RuledVerdict) => {
    const own = extensionAsks.get(requestId)
    if (!own) return session?.respond(requestId, verdict.allow, verdict.message)
    extensionAsks.delete(requestId)
    own.resolve(verdict)
  }
  // The turn ended or the chat stopped with an extension's request unanswered: it's denied.
  const dropAsks = (chat: Chat, why: string) => {
    for (const [requestId, own] of extensionAsks) {
      if (own.chat !== chat) continue
      extensionAsks.delete(requestId)
      own.resolve({ allow: false, message: why, rule: why })
    }
  }
  const recordPermission = (chat: Chat, request: PermissionRequest, allow: boolean, rule: string, message?: string) =>
    deps.activity?.emit(chat.info.id, () => ({
      kind: 'permission',
      title: `${allow ? 'Allowed' : 'Denied'}: ${request.summary || request.name}`,
      decision: allow ? 'allowed' : 'denied',
      rule,
      detail: [
        `${request.name} (${request.kind})`,
        ...(request.path !== undefined ? [`Path: ${request.path}`] : []),
        ...(request.command !== undefined ? [`Command: ${request.command}`] : []),
        ...(message ? [`Told the agent: ${message}`] : []),
      ].join('\n'),
    }))

  const transformed = (hook: 'transformMessage' | 'transformOutput', chat: Chat, text: string) =>
    watchersOf(hook, chat).reduce((current, extension) => {
      try {
        const next = extension[hook]!(current, detailOf(chat), contextOf(extension))
        if (typeof next !== 'string') throw new Error(`${hook} must return text`)
        if (hook === 'transformMessage' && next !== current) {
          deps.activity?.emit(chat.info.id, () => ({
            kind: 'turn',
            by: extension,
            title: 'Rewrote your message before it was sent',
            sections: [
              { label: 'Before', text: current },
              { label: 'As sent', text: next },
            ],
          }))
        }
        return next
      } catch (error) {
        extensionError(extension, error)
        return current
      }
    }, text)

  const completeText = (chat: Chat, at: string, text: string) => {
    const done = transformed('transformOutput', chat, text)
    if (chat.turn) chat.turn.text = done
    append(chat, { at, type: 'text.completed', text: done })
  }

  // How the turn runs, from every extension that's on for the chat (Extension.turnOptions): read only if any says so,
  // on the first role named. Only ever stricter, or another model list.
  const turnOptionsOf = (chat: Chat): { readOnly?: { reason?: string }; role?: ModelRole; by: { readOnly?: string; role?: string } } => {
    let readOnly: { reason?: string } | undefined
    let role: ModelRole | undefined
    const by: { readOnly?: string; role?: string } = {}
    for (const extension of watchersOf('turnOptions', chat)) {
      try {
        const options = extension.turnOptions!(detailOf(chat), contextOf(extension))
        if (options === undefined || options === null) continue
        if (typeof options !== 'object') throw new Error('turnOptions must return an object or nothing')
        if (options.readOnly === true && !readOnly) {
          readOnly = typeof options.reason === 'string' && options.reason.trim() ? { reason: options.reason.trim() } : {}
          by.readOnly = extension.id
        }
        if (role === undefined && options.role !== undefined) {
          if (!MODEL_ROLES.includes(options.role)) throw new Error(`Unknown model role "${String(options.role)}"`)
          role = options.role
          by.role = extension.id
        }
      } catch (error) {
        extensionError(extension, error)
      }
    }
    return { ...(readOnly && { readOnly }), ...(role && { role }), by }
  }

  // The first extension with a verdict answers; an extension's promise is waited for before asking the next.
  const extensionVerdict = (
    request: PermissionRequest,
    chat: Chat,
  ): RuledVerdict | undefined | Promise<RuledVerdict | undefined> => {
    const watchers = watchersOf('onPermissionRequested', chat)
    const checked = (extension: Extension, verdict: PermissionVerdict | undefined) => {
      if (verdict === undefined || verdict === null) return undefined
      if (typeof verdict.allow === 'boolean') return { ...verdict, rule: `Extension: ${extension.name}` }
      extensionError(extension, new Error('A permission verdict needs allow: true or false'))
      return undefined
    }
    const ask = (from: number): RuledVerdict | undefined | Promise<RuledVerdict | undefined> => {
      for (let i = from; i < watchers.length; i++) {
        const extension = watchers[i]!
        let answer: ReturnType<NonNullable<Extension['onPermissionRequested']>>
        try {
          answer = extension.onPermissionRequested!(request, detailOf(chat), contextOf(extension))
        } catch (error) {
          extensionError(extension, error)
          continue
        }
        if (answer instanceof Promise) {
          return answer.then(
            (verdict) => checked(extension, verdict) ?? ask(i + 1),
            (error) => (extensionError(extension, error), ask(i + 1)),
          )
        }
        const verdict = checked(extension, answer)
        if (verdict) return verdict
      }
      return undefined
    }
    return ask(0)
  }

  // Runs from Stop's grace timer too, where a throw would leave the chat stopping for good: a chat whose folder is
  // gone goes the way lostChat sends it.
  const forceStop = (chat: Chat) => {
    try {
      endTurn(chat, { at: now().toISOString(), type: 'turn.completed', error: 'Interrupted', errorKind: 'interrupted' })
    } catch (error) {
      lostChat(chat, error)
    }
  }

  // A turn starts in four steps: send checks the chat can run, logs the message, works out what the session is told,
  // then checks out the space's git folders and opens the turn's session (openSession).
  // A continuation is a prompt from Kothar, not the user: it isn't logged, and the turn it starts carries on the last.
  const send = (
    chat: Chat,
    text: string,
    attachments: Attachment[] = [],
    reports: Report[] = [],
    continuation?: string,
  ) => {
    const { readOnly, role, by } = turnOptionsOf(chat)
    const { run, adapter, editAnywhere, roleUsed } = checkCanStart(chat, role)
    const workDir = workDirOf(chat)
    mkdirSync(workDir, { recursive: true })
    const { prompt, zoomable, parts, rewritten } = logTurn(chat, adapter, { text, attachments, reports, continuation })
    const session = planSession(chat, workDir, zoomable, editAnywhere)
    const sent = {
      parts,
      rewritten,
      continued: continuation !== undefined,
      ...(by.readOnly && { readOnlyBy: by.readOnly }),
      ...(role && by.role && { role: { role, by: by.role, used: roleUsed } }),
    }
    const plan: TurnPlan = { run, adapter, prompt, zoomable, attachments, ...session, ...(readOnly && { readOnly }), sent }
    const start = (checkouts: Checkout[], copies: Record<string, string> = {}) => openSession(chat, plan, checkouts, copies)
    const { repos, places, sandbox } = plan
    const copied = places.filter((place) => place.mode === 'copy').map((place) => place.path)

    const turn = ++chat.turns
    if (!repos.length && !copied.length) return start([])
    const space = chainOf(chat)[0]!
    const stillStarting = () => chat.turns === turn && chat.status === 'running' && !chat.session && !isQuitting()
    // Checkouts and copies are made once, before the first session that needs them, and kept.
    const prepare = async () => {
      const checkouts: Checkout[] = []
      for (const folder of repos) checkouts.push(await checkoutOf(space, folder, workDir, sandbox !== undefined))
      const copies: Record<string, string> = {}
      for (const folder of copied) copies[folder] = (await copyOf(space, folder, workDir)).path
      return { checkouts, copies }
    }
    prepare().then(
      ({ checkouts, copies }) => stillStarting() && start(checkouts, copies),
      (error) => {
        if (!stillStarting()) return
        endTurn(chat, { at: now().toISOString(), type: 'turn.completed', error: messageOf(error) })
      },
    )
  }

  // Whether the chat can take a turn now, and on what. Throws why not. role: an extension's model list for this turn
  // (TurnOptions), used when it has models that can run; the chat keeps its own engine and model.
  const checkCanStart = (chat: Chat, role?: ModelRole) => {
    if (isQuitting()) throw new Error('Kothar is quitting')
    if (chat.status !== 'idle') throw new Error('A turn is already running in this chat')
    checkActive(chat)
    const roleRun = role && models.lists()[role].length ? models.runOf({ engine: chat.info.engine, role }) : undefined
    const run = roleRun ?? models.runOf(choosesOf(chat))
    if (run && !roleRun && run.engine !== chat.info.engine) updateChat(chat, { engine: run.engine })
    const cant = run ? undefined : models.whyNot(choosesOf(chat))
    if (cant) throw new Error(cant)
    const adapter = adapterFor(roleRun?.engine ?? chat.info.engine)!
    const editAnywhere = editsAnywhere(...switchesOf(chat))
    if (!machine.canSandbox && !editAnywhere && UNSANDBOXED_NEEDS_EDIT_ANYWHERE) {
      throw new Error("Kothar can't sandbox engines on this system yet. Turn on Edits anywhere in this chat's Context panel, or as the default in Settings → Work folder, to run it unsandboxed.")
    }
    return { run, adapter, editAnywhere, roleUsed: roleRun !== undefined }
  }

  // Logs the turn's input and makes the prompt that carries it with the chat's memory. The chat runs from here.
  const logTurn = (chat: Chat, adapter: Adapter, input: TurnInput) => {
    const { text, attachments, reports, continuation } = input
    const rewrite = text ? transformed('transformMessage', chat, text) : text
    const message = withAttachments(rewrite, attachments)
    const zoomable = takesMcp(adapter.id)
    const view = viewOf(chat, messagesOf(chat.entries), zoomable)
    const parts = continuation ? continuationParts(view, continuation) : seededParts(view, message, reports)
    const prompt = parts.map((part) => part.text).join('\n\n')
    const at = now().toISOString()
    if (!continuation) {
      chat.produced = false
      for (const { text, report } of reports) append(chat, { at, type: 'worker.report', text, ...report })
      if (text || attachments.length || !reports.length) {
        append(chat, { at, type: 'user.message', text, ...(attachments.length && { attachments }) })
      }
    }
    chat.turn = { text: '', tools: [] }
    setStatus(chat, 'running')
    const started = { chat: detailOf(chat), text: continuation ?? text, continued: continuation !== undefined }
    callExtensions('onTurnStarted', (extension, context) => extension.onTurnStarted!(started, context))
    return { prompt, zoomable, parts, rewritten: !continuation && rewrite !== text }
  }

  // What the session is told, and the folders it reaches.
  const planSession = (chat: Chat, workDir: string, zoomable: boolean, editAnywhere: boolean) => {
    const parts = deps.instructionPartsOf(chat, zoomable)
    const { items } = parts
    const readFiles = items.flatMap((item) => (item.binary ? [item.path] : []))
    const attachmentsDir = attachmentsDirOf(chat)
    const folders = items.flatMap((item) => (item.section === 'folders' ? [item.path] : []))
    const repos = items.flatMap((item) => (item.section === 'folders' && item.git ? [item.path] : []))
    const places = placesOf(items)
    const base = editAnywhere ? undefined : sandboxIn(workDir)
    const access = placeAccess(places, home, garage)
    const sandbox = base && {
      ...base,
      writable: [...base.writable, ...access.writable],
      ...(access.readOnly.length && { readOnly: access.readOnly }),
    }
    return { workDir, parts, readFiles, attachmentsDir, folders, repos, places, sandbox }
  }

  // The turn's session, once its checkouts are ready: where it runs (sessionPlaceOf), how each event it sends is handled
  // (sessionEvents), and starting it. Its session and tools live here, one per turn.
  const openSession = (chat: Chat, plan: TurnPlan, checkouts: Checkout[], copies: Record<string, string>) => {
    const { run, adapter, prompt, zoomable, attachments, workDir, readFiles } = plan
    const { cwd, instructions, sections, extraDirs, jail, folderPlaces } = sessionPlaceOf(plan, checkouts, copies)
    // Read at each request, so a switch flipped mid-turn counts at once. Folder modes count from the next turn, as
    // the sandbox does.
    const { readOnly } = plan
    const permissionsOf = () => ({
      cwd,
      workDir,
      sandboxed: !!jail,
      switches: switchesOf(chat),
      home,
      garage,
      folders: folderPlaces,
      ...(readOnly && { readOnly }),
    })
    const events = sessionEvents(chat, adapter.id, permissionsOf)
    liveEvents.set(chat, events)
    try {
      chat.mcpToken = zoomable ? grantMcp(chat.info.id) : undefined
      const url = mcpUrl()
      const kotharMcp = url && chat.mcpToken ? { url, token: chat.mcpToken } : undefined
      const { model, thinking } = run ?? {}
      const mcpServers = adapter.kotharMcp ? extensionServers(chat, workDir, jail !== undefined) : []
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
        ...(readOnly && { readOnly: true }),
        ...deps.engineToolsFor?.(chat, adapter.id),
      }
      chat.account = accounts.activeOf(adapter.id)
      chat.runModel = model
      chat.sentTurn = randomBytes(6).toString('hex')
      const { sent } = plan
      if (deps.turnSent && sent) {
        deps.turnSent(chat, {
          kind: 'turn',
          turn: chat.sentTurn,
          instructions: sections,
          prompt: sent.parts,
          rewritten: sent.rewritten,
          continued: sent.continued,
          engine: adapter.id,
          ...(model && { model }),
          ...(thinking && { thinking }),
          ...(chat.account && { account: chat.account }),
          sandboxed: !!jail,
          ...(readOnly && { readOnly: { ...readOnly, ...(sent.readOnlyBy && { by: sent.readOnlyBy }) } }),
          ...(sent.role && { role: sent.role }),
          kotharMcp: !!kotharMcp,
          mcpServers: mcpServers.map((server) => server.name),
          images: images?.length ?? 0,
          ...(options.tools && { engineTools: { off: options.tools.off, ...(options.noTools && { none: true as const }) } }),
        })
      }
      if (sent && !sent.continued) recordTurnChanges(chat, sent, readOnly)
      const session = adapter.start(machine, options, events.emit)
      events.ref.session = session
      if (chat.status === 'idle') return session.close()
      chat.session = session
      session.prompt(prompt, images)
    } catch (error) {
      if (chat.status === 'idle') return
      endTurn(chat, { at: now().toISOString(), type: 'turn.completed', error: String(error) })
    }
  }

  // Handles the events one session sends for chat: tools tracked for the turn summary, text streamed and saved, steers,
  // limits, questions, and permission requests answered by the core's rules, then extensions, else the user. Events
  // from any other session than ref.session (an older turn's, or one that never became the chat's) are dropped.
  const sessionEvents = (chat: Chat, engine: string, permissionsOf: () => Parameters<typeof verdictOf>[1]) => {
    const ref: { session?: Session } = {}
    // Where each tool sits in chat.turn.tools, counting from 1.
    const toolIds = new Map<string, number>()
    // Engine events arrive from an adapter's stdout handler, where a throw would take the whole app down. A write
    // that fails (the chat's folder was deleted under it, say) is reported instead; with the folder gone, the chat's
    // session stops.
    const guarded = (run: () => void) => {
      try {
        run()
      } catch (error) {
        lostChat(chat, error)
      }
    }
    const handleEvent = (event: EngineEvent) => {
      if (chat.session !== ref.session) return
      const at = now().toISOString()
      for (const extension of watchersOf('onEvent')) callExtension(extension, () => extension.onEvent!(detailOf(chat), event, contextOf(extension)))
      if (event.type === 'tools.listed') return deps.toolsListed?.(engine, event.names)
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
        // An engine may wait out the limit; an extension that reacts to it gets the chat idle.
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
      const settle = (verdict: RuledVerdict | undefined) => {
        if (!verdict) {
          chat.pendingRequests.set(requestId, 'permission')
          asked.set(requestId, event)
          return setStatus(chat, 'waiting')
        }
        chat.pendingRequests.delete(requestId)
        const resolvedAt = now().toISOString()
        append(chat, { at: resolvedAt, type: 'permission.resolved', requestId, allow: verdict.allow, auto: true })
        recordPermission(chat, event, verdict.allow, verdict.rule, verdict.message)
        respondTo(ref.session, requestId, verdict)
      }
      const own = decide(event, permissionsOf())
      // The core's denials stand; otherwise an extension's policy goes first.
      if (own?.allow === false) return settle(own)
      const fromExtensions = extensionVerdict(event, chat)
      if (!(fromExtensions instanceof Promise)) return settle(fromExtensions ?? own)
      // Pending, so the user can still answer it while an extension decides; whoever answers first wins.
      chat.pendingRequests.set(requestId, 'permission')
      void fromExtensions.then((verdict) => {
        if (chat.session !== ref.session || chat.pendingRequests.get(requestId) !== 'permission') return
        guarded(() => settle(verdict ?? own))
      })
    }
    const emit = (event: EngineEvent) => guarded(() => handleEvent(event))
    // An extension's request (host.requestPermission), raised in this session as if the engine had: the core's rules,
    // extensions' policies, else the user's card, and the Activity record. changes: what it does may change something,
    // so a read-only turn refuses it.
    const ask = (request: Omit<PermissionRequest, 'type' | 'requestId'>, changes: boolean) =>
      new Promise<RuledVerdict>((resolve) => {
        const event = { type: 'permission.requested' as const, requestId: `x-${randomBytes(6).toString('hex')}`, ...request }
        const readOnly = permissionsOf().readOnly
        if (readOnly && changes) {
          const message = readOnly.reason?.trim() || READ_ONLY_REASON
          recordPermission(chat, event, false, 'Read-only turn', message)
          return resolve({ allow: false, message, rule: 'Read-only turn' })
        }
        extensionAsks.set(event.requestId, { chat, resolve })
        emit(event)
      })
    return { ref, emit, ask }
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
    if (deps.turnSent && chat.sentTurn) deps.turnSent(chat, { kind: 'steer', turn: chat.sentTurn, text: sent, engine: adapter.id })
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

  // A worker that hasn't started while its parent already runs as many children as Settings → Workers allows: its
  // first message waits in its queue, and it starts as soon as one of them is done (startWaitingWorkers).
  const waitsForSlot = (chat: Chat) => {
    if (!chat.info.worker || chat.turns > 0 || chat.info.parentId === undefined) return false
    const limit = deps.workerLimit?.() ?? -1
    return limit !== -1 && runningChildren(chat.info.parentId, chats.values()) >= limit
  }

  // Starts the workers waiting for a slot, oldest first, while the limit allows: below parentId, or below every chat.
  const startWaitingWorkers = (parentId?: string) => {
    const waiting = [...chats.values()].filter(
      (c) => c.info.worker && c.status === 'idle' && c.turns === 0 && c.queue.length > 0 && (parentId === undefined || c.info.parentId === parentId),
    )
    for (const chat of waiting) {
      if (isQuitting() || waitsForSlot(chat) || !chats.has(chat.info.id)) continue
      reportErrors(() => sendQueue(chat))
    }
  }

  const enqueue = (chat: Chat, message: Omit<QueuedMessage, 'id'>) => {
    if (isQuitting()) throw new Error('Kothar is quitting')
    checkActive(chat)
    if (chat.status === 'idle' && !waitsForSlot(chat)) return sendQueue(chat, message)
    const waits = chat.status === 'idle'
    setQueue(chat, [...chat.queue, { id: randomBytes(4).toString('hex'), ...message }])
    if (waits && chat.info.parentId !== undefined) {
      const parentId = chat.info.parentId
      deps.activity?.emit(parentId, () => ({
        kind: 'worker',
        title: `${chat.info.name} waits to start: this chat already runs as many workers as Settings → Workers allows`,
      }))
    }
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
      // oxlint-disable-next-line no-control-regex -- strips control characters from file names on purpose
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
      // A chat held after its turn queues the message first, so it runs once the extension lets go.
      if (chat.held) {
        enqueue(chat, message)
        for (const extensionId of [...chat.waits.keys()]) answerWait(chat, extensionId, { message: text })
        return
      }
      // A message sent while extensions wait on the user answers them too; it still goes to the agent.
      for (const extensionId of chat.waits.keys()) answerWait(chat, extensionId, { message: text })
      if (steering && canSteer(chat)) {
        checkActive(chat)
        steer(chat, message)
      } else enqueue(chat, message)
    } catch (error) {
      for (const { path } of attachments) rmSync(path, { force: true })
      throw error
    }
  }

  const interrupt = (chat: Chat, force: boolean) => {
    // Stop on a chat an extension holds after its turn: nothing runs, so it ends now.
    if (chat.held && !chat.session) return release(chat, true)
    if (!chat.session && (chat.status === 'running' || chat.status === 'stopping')) return forceStop(chat)
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
    if (chat.pendingRequests.size === 0 && chat.waits.size === 0) setStatus(chat, 'running')
    return chat.session
  }

  const respond = (chat: Chat, requestId: string, allow: boolean) => {
    const entry = { at: now().toISOString(), type: 'permission.resolved' as const, requestId, allow }
    respondTo(settle(chat, entry), requestId, { allow, rule: 'You' })
    const request = asked.get(requestId)
    asked.delete(requestId)
    if (request) recordPermission(chat, request, allow, 'You')
  }

  const answer = (chat: Chat, requestId: string, answers: unknown) => {
    const valid = (list: unknown) => Array.isArray(list) && list.every((text) => typeof text === 'string')
    const isObject = typeof answers === 'object' && answers !== null && !Array.isArray(answers)
    if (answers !== undefined && !(isObject && Object.values(answers).every(valid))) {
      throw new Error('Answers must give each question a list of choices')
    }
    const given = answers as Answers | undefined
    const entry = { at: now().toISOString(), type: 'question.resolved' as const, requestId }
    settle(chat, { ...entry, ...(given && { answers: given }) }).answer?.(requestId, given)
  }

  // Resolves once no chat has a session, as when Kothar quits.
  const whenAllStopped = () =>
    allStopped() ? Promise.resolve() : new Promise<void>((resolve) => allStoppedWaiters.push(resolve))

  // host.requestPermission: only while the chat has a session to ask in.
  const requestPermission = (chat: Chat, request: Omit<PermissionRequest, 'type' | 'requestId'>, changes: boolean) => {
    const events = liveEvents.get(chat)
    if (!chat.session || !events || events.ref.session !== chat.session) {
      return Promise.reject(new Error(`${chat.info.name} has no turn running to ask in`))
    }
    return events.ask(request, changes)
  }

  return {
    requestPermission,
    startWaitingWorkers,
    send,
    sendMessage,
    enqueue,
    setQueue,
    canSteer,
    interrupt,
    respond,
    answer,
    retry,
    continueTurn,
    setStatus,
    setWait,
    waitsOf,
    stopSession,
    whenAllStopped,
  }
}
