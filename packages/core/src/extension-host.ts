// What each extension gets from Kothar: its host (ExtensionHost) and context, made once per extension and kept, plus
// the commands it starts with host.spawn. The core passes in everything a host reaches as plain functions; nothing here
// keeps chats or settings.
import { checkedActivity, type Activity } from './activity.ts'
import { appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type {
  ChatDetail,
  Extension,
  ExtensionAction,
  ExtensionContext,
  ExtensionHost,
  ExtensionNoteCard,
  ExtensionPermissionAnswer,
  ExtensionTool,
  ExtensionRun,
  ExtensionStorage,
  ExtensionStoredFile,
  ExtensionUse,
  ExtensionValues,
  ExtensionWait,
  PermissionRequest,
  SpaceDetail,
} from '@kothar/extension-api'
import type { openAccounts } from './accounts.ts'
import { isToggled, toggleOf, withToggle } from './composer-toggles.ts'
import { guardHost } from './extensions.ts'
import { summaryOf } from './kothar-mcp.ts'
import { messagesOf } from './memory.ts'
import { messageAt } from './message-actions.ts'
import type { Machine, ChatEntry, ChatInfo, ChatStatus, CompletionRequest, CoreMessage } from './shared.ts'
import { within } from './util.ts'

// A note in the transcript (host.note) and its card, cut to what a line shows; its action is kept to what a click
// would send.
const NOTE_CHARS = 1000
const CARD_CHARS = { title: 120, badge: 30, detail: 60 }
const NOTE_ACTION_BYTES = 4000

function noteAction(action: unknown, panel: string | undefined): ExtensionAction {
  if (panel === undefined) throw new Error('A note’s action goes to one of the extension’s panels: give its panel too')
  const name = (action as { name?: unknown } | null)?.name
  if (typeof name !== 'string' || !name) throw new Error('A note’s action needs a name')
  const json = JSON.stringify(action)
  if (json.length > NOTE_ACTION_BYTES) throw new Error(`A note’s action is at most ${NOTE_ACTION_BYTES} characters of JSON`)
  const { value } = JSON.parse(json) as ExtensionAction
  return { name, ...(value !== undefined && { value }) }
}

function noteCard(card: unknown): ExtensionNoteCard {
  const field = (key: keyof typeof CARD_CHARS) => {
    const value = (card as Record<string, unknown> | null)?.[key]
    return value === undefined ? undefined : String(value).replace(/\s+/g, ' ').trim().slice(0, CARD_CHARS[key])
  }
  const title = field('title')
  if (!title) throw new Error('A note’s card needs a title')
  const badge = field('badge')
  const detail = field('detail')
  return { title, ...(badge && { badge }), ...(detail && { detail }) }
}

// An extension's notification (host.notify), cut to what a system notification shows anyway.
const NOTIFY_TITLE_CHARS = 120
const NOTIFY_BODY_CHARS = 400

/** What a host needs of a chat. */
export type HostChat = { info: ChatInfo; dir: string; entries: ChatEntry[]; status: ChatStatus; ending?: boolean }

type Accounts = ReturnType<typeof openAccounts>
type CreateSpec = Parameters<ExtensionHost['createChat']>[0]
type Place = { workDir: string; sandbox?: Parameters<Machine['spawn']>[2]['sandbox'] }

export type HostDeps<C extends HostChat> = {
  garage: string
  /** The user's home folder and the clock, as the core has them. */
  home: string
  now: () => Date
  machine: Pick<Machine, 'spawn'>
  /** The core's own files in a chat's folder, which an extension's chat storage can't touch. */
  chatOwnFiles: string[]
  isQuitting: () => boolean

  // Extensions
  extensions: readonly Extension[]
  extensionFor: (id: string) => Extension
  isOn: (extension: Extension) => boolean
  valuesOf: (extension: Extension) => ExtensionContext['values']
  /** What a community extension declared it uses; undefined for a built-in one, which isn't guarded. */
  usesOf: (extension: Extension) => ExtensionUse[] | undefined
  extensionError: (extension: Extension, error: unknown) => void
  /** Tells every other extension a space's processes changed (onProcessesChanged). */
  processesChanged: (from: Extension, spaceId: string) => void
  refresh: (extension: Extension, chatId?: string) => void

  // Chats
  chat: (chatId: string) => C | undefined
  /** The chat, or a throw if there's none. */
  chatFor: (chatId: string) => C
  shown: (chat: C) => boolean
  shownChats: () => C[]
  /** Every chat the core keeps, shown or not. */
  allChats: () => C[]
  detailOf: (chat: C) => ChatDetail
  spaceOf: (chat: C) => SpaceDetail
  reachable: (callerId: string, chat: C) => boolean
  createChat: (spec: Pick<CreateSpec, 'name' | 'folders' | 'files' | 'engine'>) => ChatInfo
  createChild: (parentId: string, spec: Omit<CreateSpec, 'parentId'>) => ChatInfo
  enqueue: (chat: C, message: { text: string }) => void
  interrupt: (chat: C) => void
  retry: (chat: C) => void
  continueTurn: (chat: C, text: string) => void
  append: (chat: C, entry: ChatEntry) => void
  setWait: (chat: C, extensionId: string, wait: ExtensionWait | undefined) => void
  checkWait: (wait: ExtensionWait) => ExtensionWait
  spaceValuesOf: (extension: Extension, chat: C) => ExtensionValues
  setSpaceValue: (extension: Extension, chat: C, key: string, value: unknown) => void
  /** Saves a change to the chat's info (chat.json) and tells the UI. */
  updateChat: (chat: C, change: Partial<ChatInfo>) => void
  /** Whether the extension shapes the chat's sessions: on, and not left out by the chat's setup. */
  isOnFor: (extension: Extension, chat: C) => boolean
  /** Adds a file to the chat's own context (Context → Files), as the user adding it there does. */
  addContextFile: (chat: C, path: string) => void
  /** An extension's permission request (host.requestPermission), raised in the chat's running turn (turn.ts). */
  requestPermission: (chat: C, request: Omit<PermissionRequest, 'type' | 'requestId'>, changes: boolean) => Promise<ExtensionPermissionAnswer>
  /** Where a command an extension starts for a chat runs, and its sandbox. */
  commandPlaceOf: (chat: C) => Promise<Place>

  // The rest of Kothar
  accounts: Pick<Accounts, 'list' | 'use'>
  run: () => ExtensionRun
  /** A model call for an extension (host.complete); from: the extension, for the Activity record. */
  complete: (request: CompletionRequest, from: Extension) => Promise<string>
  /** Kothar's activity stream (activity.ts): what extensions do through the host is emitted to it. */
  activity: Activity
  /** One of the extension's prompts as it's sent: the user's edit, else its default. */
  promptText: (extension: Extension, id: string) => string
  broadcast: (message: CoreMessage) => void
  /** Every folder the chat's Open in Terminal may open. */
  terminalRoots: (chat: C) => string[]
  openTerminalAt: (path: string) => Promise<void>
  reveal: (path: unknown) => Promise<void>
  /** The real path, or the resolved one if it doesn't exist. */
  realOr: (path: string) => string
}

export function openExtensionHosts<C extends HostChat>(deps: HostDeps<C>) {
  const { chatFor, extensionError } = deps
  const hosts = new Map<string, ExtensionHost>()

  // What each extension has running from host.spawn, so turning the extension off stops it.
  const spawned = new Map<string, Set<{ kill(): void }>>()
  const stopSpawned = (extension: Extension) => {
    for (const proc of spawned.get(extension.id) ?? []) proc.kill()
  }
  const spawnFor =
    (extension: Extension): ExtensionHost['spawn'] =>
    async (command, args, options = {}) => {
      if (deps.isQuitting()) throw new Error('Kothar is quitting')
      if (!deps.isOn(extension)) throw new Error(`${extension.name} is off`)
      const chat = options.chat === undefined ? undefined : chatFor(options.chat)
      const place = chat ? await deps.commandPlaceOf(chat) : undefined
      const cwd = options.cwd ?? place?.workDir ?? '/'
      const proc = deps.machine.spawn(command, args, {
        cwd,
        ...(options.env && { env: options.env }),
        ...(place?.sandbox && { sandbox: place.sandbox }),
      })
      const running = spawned.get(extension.id) ?? new Set()
      spawned.set(extension.id, running)
      running.add(proc)
      proc.onExit(() => running.delete(proc))
      // Nothing reads its stdin, but some watchers stop when it closes, so it stays open.
      return {
        onOutput: (listener) => proc.onStdout(listener),
        onExit: (listener) => proc.onExit(listener),
        stop: () => proc.kill(),
      }
    }

  const contextOf = (extension: Extension): ExtensionContext => ({ values: deps.valuesOf(extension), host: hostFor(extension) })

  // The extension's tools for a chat: its fixed ones, then those it makes for the chat (toolsFor). A toolsFor that
  // throws shows its error and adds none.
  const toolsOf = (extension: Extension, chat: C): ExtensionTool[] => {
    const fixed = extension.tools ?? []
    if (!extension.toolsFor) return fixed
    try {
      const made = extension.toolsFor(summaryOf(chat.info), contextOf(extension))
      if (!Array.isArray(made)) throw new Error('toolsFor must return a list of tools')
      return [...fixed, ...made]
    } catch (error) {
      extensionError(extension, error)
      return fixed
    }
  }
  const hostFor = (extension: Extension): ExtensionHost => {
    const known = hosts.get(extension.id)
    if (known) return known
    const dir = join(deps.garage, 'extensions', extension.id)
    const chatStorageOf = (chat: C) => storageAt(chat.dir, `${extension.name}'s files in this chat`, deps.chatOwnFiles)
    const host: ExtensionHost = {
      createChat({ name, folders, files, engine, parentId, role, quiet, showReport }) {
        if (parentId === undefined) {
          if (role !== undefined) throw new Error('Only a child chat (with parentId) takes a role')
          if (quiet !== undefined) throw new Error('Only a child chat (with parentId) can be quiet')
          if (showReport !== undefined) throw new Error('Only a quiet child chat can show its report')
          return deps.createChat({ name, folders, files, engine })
        }
        if (showReport === true && quiet !== true) throw new Error('Only a quiet child chat can show its report')
        const shows = quiet === true && showReport === true
        const info = deps.createChild(String(parentId), { name, engine, role, folders, files, ...(quiet === true && { quiet }), ...(shows && { showReport }) })
        deps.activity.emit(String(parentId), () => ({
          kind: 'worker',
          by: extension,
          title: `Started ${quiet === true ? (shows ? 'a quiet worker, shown in the chat' : 'a quiet worker') : 'a child chat'}: ${info.name}`,
          ...(role !== undefined && { detail: `On the ${role} model list` }),
        }))
        return info
      },
      send(chatId, text) {
        const chat = chatFor(chatId)
        deps.enqueue(chat, { text })
        // A worker's goes under its parent too: a finished worker's chat (and its folder) is removed.
        deps.activity.emit(chat.info.parentId ?? chat.info.id, () => ({
          kind: 'worker',
          by: extension,
          title: `Sent ${chat.info.name} a message`,
          sections: [{ label: 'The message', text: String(text) }],
        }))
      },
      chats: () => deps.shownChats().map(deps.detailOf),
      chat(chatId) {
        const chat = deps.chat(chatId)
        return chat && deps.shown(chat) ? deps.detailOf(chat) : undefined
      },
      read(chatId, options) {
        const { entries } = chatFor(chatId)
        const last = options?.last
        return last === undefined ? [...entries] : last > 0 ? entries.slice(-last) : []
      },
      space(chatId) {
        const chat = deps.chat(chatId)
        return chat && deps.shown(chat) ? deps.spaceOf(chat) : undefined
      },
      spaceValues: (chatId) => deps.spaceValuesOf(extension, chatFor(chatId)),
      setSpaceValue: (chatId, key, value) => deps.setSpaceValue(extension, chatFor(chatId), String(key), value),
      reaches(callerId, chatId) {
        const chat = deps.chat(String(chatId))
        return !!chat && deps.reachable(String(callerId), chat)
      },
      reachable: (callerId) =>
        deps
          .shownChats()
          .filter((chat) => deps.reachable(String(callerId), chat))
          .map(deps.detailOf),
      interrupt: (chatId) => deps.interrupt(chatFor(chatId)),
      accounts(engine) {
        const found = deps.accounts.list().find((state) => state.engine === engine)
        if (!found) return undefined
        const list = found.accounts.map(({ id, name, signedIn, provider }) => ({
          id,
          name,
          ...(signedIn !== undefined && { signedIn }),
          ...(provider !== undefined && { provider }),
        }))
        return { engine, active: found.active, accounts: list }
      },
      useAccount(engine, accountId) {
        deps.accounts.use(engine, accountId, true)
        deps.activity.emit(undefined, () => ({ kind: 'account', by: extension, title: `Switched ${engine} to the account ${accountId}` }))
      },
      retry(chatId) {
        const chat = chatFor(chatId)
        deps.retry(chat)
        deps.activity.emit(chat.info.id, () => ({ kind: 'retry', by: extension, title: 'Ran the turn again' }))
      },
      continue(chatId, text) {
        const chat = chatFor(chatId)
        deps.continueTurn(chat, text)
        deps.activity.emit(chat.info.id, () => ({
          kind: 'retry',
          by: extension,
          title: 'Carried the turn on',
          sections: [{ label: 'Sent to carry it on', text: String(text) }],
        }))
      },
      note(chatId, text, options) {
        const panel = options?.panel
        if (panel !== undefined && !extension.panels?.some((p) => p.id === panel)) {
          throw new Error(`${extension.name} has no panel "${panel}"`)
        }
        const action = options?.action === undefined ? undefined : noteAction(options.action, panel)
        const card = options?.card === undefined ? undefined : noteCard(options.card)
        const at = deps.now().toISOString()
        deps.append(chatFor(chatId), {
          at,
          type: 'extension.note',
          text: String(text).slice(0, NOTE_CHARS),
          ...(panel !== undefined && { extension: extension.id, panel }),
          ...(action && { action }),
          ...(card && { card }),
          // A card is the extension's even without a panel, so the transcript can say whose it is.
          ...(card && panel === undefined && { extension: extension.id }),
        })
      },
      error: (text) => extensionError(extension, String(text)),
      // The UI decides whether it shows (Settings → Appearance → Notifications) and draws it as the system's notification.
      notify({ chatId, title, body }) {
        const chat = chatId === undefined ? undefined : chatFor(String(chatId))
        deps.broadcast({
          type: 'notify',
          extension: extension.id,
          title: String(title).slice(0, NOTIFY_TITLE_CHARS),
          body: String(body ?? '').slice(0, NOTIFY_BODY_CHARS),
          ...(chat && { chatId: chat.info.id }),
        })
      },
      run: deps.run(),
      spawn: spawnFor(extension),
      storage: storageAt(dir, `${extension.name}'s storage`),
      chatStorage: (chatId) => chatStorageOf(chatFor(chatId)),
      everyChatStorage: () => deps.allChats().map((chat) => ({ chatId: chat.info.id, storage: chatStorageOf(chat) })),
      home: deps.home,
      now: () => deps.now(),
      messages: (chatId) => messagesOf(chatFor(chatId).entries),
      message: (chatId, entry) => messageAt(chatFor(chatId).entries, Number(entry)),
      complete: (request) => deps.complete(request, extension),
      refresh: (chatId) => deps.refresh(extension, chatId),
      showPanel(chatId, panel) {
        const chat = chatFor(String(chatId))
        const found = extension.panels?.find((p) => p.id === panel)
        if (!found) throw new Error(`${extension.name} has no panel "${panel}"`)
        // A popup would take over the window, so only a dock or a tab opens this way.
        if (found.placement === 'popup' || !deps.isOn(extension)) return
        deps.broadcast({
          type: 'extension.panel.show',
          chatId: chat.info.id,
          extension: extension.id,
          panel: found.id,
          placement: found.placement === 'dock' ? 'dock' : 'tab',
        })
      },
      closePanel(chatId, panel) {
        const chat = chatFor(String(chatId))
        const found = extension.panels?.find((p) => p.id === panel)
        if (!found) throw new Error(`${extension.name} has no panel "${panel}"`)
        // A tab has nothing to close: it stays among the right sidebar's tabs.
        if (found.placement !== 'popup' && found.placement !== 'dock') return
        deps.broadcast({ type: 'extension.panel.close', chatId: chat.info.id, extension: extension.id, panel: found.id, placement: found.placement })
      },
      wait(chatId, wait) {
        const chat = chatFor(chatId)
        if (!['running', 'waiting'].includes(chat.status) && !chat.ending) {
          throw new Error('A chat waits for the user only while its turn runs, or as it ends (onTurnCompleted)')
        }
        deps.setWait(chat, extension.id, deps.checkWait(wait))
      },
      endWait: (chatId) => deps.setWait(chatFor(chatId), extension.id, undefined),
      processes: (spaceId) =>
        deps.extensions
          .filter((other) => other !== extension && deps.isOn(other) && other.processes)
          .flatMap((other) => {
            try {
              return other.processes!(String(spaceId), contextOf(other)).map((row) => ({ ...row, extension: other.id }))
            } catch (error) {
              extensionError(other, error)
              return []
            }
          }),
      async processAction(spaceId, extensionId, key, action) {
        const other = deps.extensionFor(String(extensionId))
        if (!deps.isOn(other)) throw new Error(`${other.name} is off`)
        await other.onProcessAction?.(String(spaceId), String(key), String(action), contextOf(other))
      },
      processesChanged: (spaceId) => deps.processesChanged(extension, String(spaceId)),
      // Only inside a folder some chat could open: an extension can't open a terminal anywhere it likes.
      async openTerminal(path) {
        const real = deps.realOr(String(path))
        const roots = deps.shownChats().flatMap(deps.terminalRoots).map(deps.realOr)
        if (!isAbsolute(String(path)) || !roots.some((root) => within(real, root))) {
          throw new Error(`${path} isn't inside a space's folders, work folder or checkouts`)
        }
        await deps.openTerminalAt(real)
      },
      reveal: (path) => deps.reveal(path),
      // A worker's goes to its space, which owns the context its workers see.
      async callTool(chatId, name, input) {
        const chat = chatFor(String(chatId))
        const caller = summaryOf(chat.info)
        let tool: ExtensionTool | undefined
        const owner = deps.extensions.find((other) => {
          if (!deps.isOnFor(other, chat)) return false
          tool = toolsOf(other, chat).find((t) => t.name === name && t.offered(caller))
          return tool !== undefined
        })
        if (!owner || !tool) throw new Error(`No tool "${name}" is on for ${chat.info.name}`)
        if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('A tool takes an object as its input')
        const record = (outcome: { result?: unknown; error?: unknown }) =>
          deps.activity.emit(chat.info.id, () => ({
            kind: 'tool',
            by: extension,
            title: `Called ${owner === extension ? 'its own' : `${owner.name}’s`} tool ${name}`,
            sections: [{ label: 'Input', text: JSON.stringify(input, null, 2) }],
            ...('result' in outcome && { result: typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result) ?? '' }),
            ...('error' in outcome && { error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) }),
          }))
        const found = tool
        try {
          const result = await found.run(input, { caller, values: deps.valuesOf(owner), host: hostFor(owner) })
          record({ result })
          return result
        } catch (error) {
          record({ error })
          throw error
        }
      },
      requestPermission(chatId, request, options = {}) {
        const chat = chatFor(String(chatId))
        if (typeof request !== 'object' || request === null) return Promise.reject(new Error('A permission request is an object'))
        const { name, summary, kind = 'mcp', input, path, command } = request
        if (typeof name !== 'string' || !name.trim() || typeof summary !== 'string') {
          return Promise.reject(new Error('A permission request needs a name and a summary'))
        }
        const asked = {
          name,
          summary,
          kind,
          input: input ?? {},
          ...(typeof path === 'string' && { path }),
          ...(typeof command === 'string' && { command }),
        }
        return deps.requestPermission(chat, asked, options.changes !== false)
      },
      extensionEnabled(id, chatId) {
        const other = deps.extensions.find((m) => m.id === String(id))
        if (!other || !deps.isOn(other)) return false
        return chatId === undefined ? true : deps.isOnFor(other, chatFor(String(chatId)))
      },
      toggled: (chatId, toggle) => isToggled(chatFor(String(chatId)).info, extension, toggleOf(extension, toggle)),
      prompt: (id) => deps.promptText(extension, String(id)),
      activity(input) {
        const checked = checkedActivity(input)
        const chatId = checked.chatId === undefined ? undefined : chatFor(String(checked.chatId)).info.id
        deps.activity.emit(chatId, () => ({ ...checked, by: extension }))
      },
      setToggle(chatId, toggle, on) {
        const chat = chatFor(String(chatId))
        const found = toggleOf(extension, toggle)
        if (typeof on !== 'boolean') throw new Error('A composer toggle is on or off')
        if (isToggled(chat.info, extension, found) === on && chat.info.toggles?.[extension.id]?.[found.id] !== undefined) return
        deps.updateChat(chat, { toggles: withToggle(chat.info, extension, found, on) })
        if (deps.isOn(extension) && deps.shown(chat)) deps.refresh(extension, chat.info.id)
      },
      addContextFile: (chatId, path) => deps.addContextFile(chatFor(deps.spaceOf(chatFor(String(chatId))).id), String(path)),
    }
    const uses = deps.usesOf(extension)
    const given = uses ? guardHost(host, extension, uses) : host
    hosts.set(extension.id, given)
    return given
  }

  /** Drops an extension's host, for an uninstall; a reinstall gets a fresh one. */
  const forgetHost = (extensionId: string) => hosts.delete(extensionId)

  return { hostFor, contextOf, forgetHost, stopSpawned, toolsOf }
}

// Plain files under dir, by relative name; names can't leave it or reach the core's own files in it.
export const storageAt = (dir: string, what: string, reserved: string[] = []): ExtensionStorage => {
  const isReserved = (top: string) => reserved.some((own) => own.toLowerCase() === top.toLowerCase())
  const fileOf = (name: string) => {
    const path = resolve(dir, String(name))
    const top = path.slice(dir.length + 1).split(sep)[0]!
    if (path === dir || !within(path, dir) || isReserved(top)) throw new Error(`"${name}" is outside ${what}`)
    return path
  }
  const writable = (name: string) => {
    const path = fileOf(name)
    mkdirSync(dirname(path), { recursive: true })
    return path
  }
  return {
    dir,
    read(name) {
      try {
        return readFileSync(fileOf(name), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
    write: (name, text) => writeFileSync(writable(name), text),
    append: (name, text) => appendFileSync(writable(name), text),
    remove: (name) => rmSync(fileOf(name), { force: true }),
    list(folder) {
      const at = folder === undefined || folder === '' ? dir : fileOf(folder)
      let names: string[]
      try {
        names = readdirSync(at)
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return []
        throw error
      }
      return names
        .filter((name) => at !== dir || !isReserved(name))
        .sort()
        .flatMap((name): ExtensionStoredFile[] => {
          try {
            const stat = lstatSync(join(at, name))
            return stat.isFile() ? [{ name, size: stat.size }] : []
          } catch {
            return []
          }
        })
    },
  }
}

