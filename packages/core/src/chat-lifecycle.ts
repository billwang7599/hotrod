// A chat's life: loaded from the garage at start, made (a space, or a worker below a chat), renamed, archived, moved in
// the sidebar, and deleted with every chat below it. The core holds the chats map and passes in what these need; the
// files themselves are read and written by chat-store.ts.
import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatDetail, Extension, ExtensionContext, SpaceDetail } from '@kothar/extension-api'
import type { Chat } from './chat.ts'
import { quitMidTurn, readChat, storedChatIds } from './chat-store.ts'
import type { DeclaredChat } from './community-load.ts'
import { checkPath } from './context.ts'
import type { ExtensionHook } from './extensions.ts'
import { PARENT_VIEW_FILE } from './instruction-parts.ts'
import { messagesOf } from './memory.ts'
import type { openModels } from './models.ts'
import { WORKER_SETUP } from './setups.ts'
import {
  bySpaceOrder,
  type ChatEntry,
  type ChatInfo,
  type ChatState,
  type CoreMessage,
  type MemoryMessage,
  type ModelRole,
  MODEL_ROLES,
  type NewChat,
  type Setup,
} from './shared.ts'

// What createChat takes: a new space from the UI or an extension, or (parentId and worker) a worker below a chat.
export type ChatSpec = NewChat & { parentId?: string; worker?: boolean; role?: ModelRole; setup?: string }

export type ChatLifecycleDeps = {
  chats: Map<string, Chat>
  chatsDir: string
  home: string
  now: () => Date
  broadcast: (message: CoreMessage) => void
  // The chats extensions declare (Home), loaded first and named as declared.
  extensionChats: readonly DeclaredChat[]
  models: Pick<ReturnType<typeof openModels>, 'engineFor' | 'pinOn'>
  checkEngine: (engine: string) => void
  checkEnabled: (engine: string) => void
  chatFor: (chatId: string) => Chat
  parentOf: (chat: Chat) => Chat | undefined
  familyOf: (chat: Chat) => Chat[]
  checkActive: (chat: Chat) => void
  setupOf: (chat: Chat) => Setup | undefined
  setupNamed: (name: unknown) => Setup | undefined
  saveChat: (chat: Chat) => void
  updateChat: (chat: Chat, change: Partial<ChatInfo>) => void
  append: (chat: Chat, entry: ChatEntry) => void
  shownState: (chat: Chat) => ChatState
  detailOf: (chat: Chat) => ChatDetail
  spaceOf: (chat: Chat) => SpaceDetail
  // A parent's memory as a new worker's frozen view of it.
  viewOf: (chat: Chat, messages: MemoryMessage[], tools: boolean) => string
  takesMcp: (engine: string) => boolean
  callExtensions: (hook: ExtensionHook, run: (extension: Extension, context: ExtensionContext) => unknown) => void
  // What ends with a removed chat: its session, its panels, its work folder.
  stopSession: (chat: Chat) => void
  forgetChat: (chatId: string) => void
  removeWorkDir: (chat: Chat) => Promise<void>
}

export const checkName = (name: unknown) => {
  const trimmed = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : ''
  if (!trimmed) throw new Error('A chat needs a name')
  return trimmed
}

const checkRemovable = (chat: Chat) => {
  if (chat.info.extension) throw new Error(`${chat.info.name} cannot be archived or deleted`)
  if (chat.status !== 'idle') throw new Error('Stop the running chat first')
}

export function openChatLifecycle(deps: ChatLifecycleDeps) {
  const { chats, chatsDir, now, broadcast, models } = deps

  const loadChat = (dir: string, fallback: ChatInfo) => {
    const declared = deps.extensionChats.find((chat) => chat.id === fallback.id)
    const { info, context, entries, resave } = readChat(
      dir,
      fallback,
      declared && { name: declared.name, extension: declared.extension.id },
    )
    const chat: Chat = {
      info,
      dir,
      context,
      entries,
      status: 'idle',
      unsavedText: '',
      pendingRequests: new Map(),
      waits: new Map(),
      queue: [],
      turns: 0,
    }
    if (resave) deps.saveChat(chat)
    chats.set(info.id, chat)
    if (quitMidTurn(entries)) {
      deps.append(chat, { at: now().toISOString(), type: 'turn.completed', error: 'Kothar quit during this turn' })
    }
    return chat
  }

  const freshInfo = (id: string, name: string): ChatInfo => ({
    id,
    name,
    folders: [],
    files: [],
    engine: models.engineFor(),
    archived: false,
    createdAt: now().toISOString(),
  })

  // Once, as the core opens: extensions' chats first, then every chat in the garage. Nothing runs yet, so a worker
  // that has worked and is still here (Kothar quit or crashed mid-task, or an older Kothar kept it) goes now.
  const loadAll = () => {
    for (const { id, name } of deps.extensionChats) loadChat(join(chatsDir, id), freshInfo(id, name))
    for (const id of storedChatIds(chatsDir)) {
      if (chats.has(id)) continue
      loadChat(join(chatsDir, id), freshInfo(id, id))
    }
    for (const chat of chats.values()) {
      if (!chat.info.worker || !chat.entries.length) continue
      chats.delete(chat.info.id)
      rmSync(chat.dir, { recursive: true, force: true })
    }
  }

  const createChat = (spec: ChatSpec) => {
    const name = checkName(spec.name)
    const parent = spec.worker ? deps.chatFor(spec.parentId ?? '') : undefined
    if (parent && spec.setup !== undefined) throw new Error(WORKER_SETUP)
    const setup = parent ? deps.setupOf(parent) : spec.setup === undefined ? undefined : deps.setupNamed(spec.setup)
    if (spec.engine !== undefined) {
      deps.checkEngine(spec.engine)
      deps.checkEnabled(spec.engine)
    }
    const role = parent ? (spec.role ?? 'workers') : undefined
    // Named engine: the chat's own pick of that engine's first model in its list, else the engine's default model.
    // Otherwise it follows its list (a worker: its role's, else Workers', else Chat's).
    const pin = spec.engine === undefined ? undefined : models.pinOn(spec.engine, role)
    const engine = spec.engine ?? models.engineFor(role, setup)
    if (parent) deps.checkActive(parent)
    if (parent?.info.worker) throw new Error('A worker cannot start chats')
    const folders = [...new Set((spec.folders ?? []).map((path) => checkPath(path, 'folders', deps.home)))]
    const files = [...new Set((spec.files ?? []).map((path) => checkPath(path, 'files', deps.home)))]
    let id = randomBytes(4).toString('hex')
    while (chats.has(id)) id = randomBytes(4).toString('hex')
    const parentMessages = parent && messagesOf(parent.entries)
    const info: ChatInfo = {
      id,
      name,
      ...(parent && parentMessages && {
        parentId: parent.info.id,
        worker: true,
        role,
        parentMessages: parentMessages.length,
      }),
      folders,
      files,
      engine,
      archived: false,
      createdAt: now().toISOString(),
      ...pin,
      ...(!parent && setup && { setup: setup.id }),
    }
    const chat = loadChat(join(chatsDir, id), info)
    if (parent && parentMessages?.length) {
      writeFileSync(join(chat.dir, PARENT_VIEW_FILE), deps.viewOf(parent, parentMessages, deps.takesMcp(engine)))
    }
    broadcast({ type: 'chat.added', chat: deps.shownState(chat) })
    deps.callExtensions('onChatCreated', (extension, context) => extension.onChatCreated!(deps.detailOf(chat), context))
    return chat.info
  }

  // A chat below another, for one task: what spawn_worker and an extension's host.createChat with a parentId both make.
  const createChild = (parentId: string, spec: NewChat & { role?: ModelRole }) => {
    if (spec.folders?.length || spec.files?.length) throw new Error('A child chat takes its folders from its space')
    if (spec.role !== undefined && !MODEL_ROLES.includes(spec.role)) throw new Error(`Unknown role "${spec.role}"`)
    return createChat({ name: spec.name, engine: spec.engine, parentId, worker: true, role: spec.role })
  }

  const renameChat = (chat: Chat, name: unknown) => {
    if (chat.info.extension) throw new Error(`${chat.info.name} cannot be renamed`)
    deps.updateChat(chat, { name: checkName(name) })
  }

  const archiveChat = (chat: Chat, archived: boolean) => {
    const parent = deps.parentOf(chat)
    if (!archived && parent?.info.archived) throw new Error(`Unarchive "${parent.info.name}" first`)
    const family = deps.familyOf(chat)
    family.forEach(checkRemovable)
    family.forEach((c) => deps.updateChat(c, { archived }))
    for (const c of family) {
      deps.callExtensions('onChatArchived', (extension, context) => extension.onChatArchived!(deps.detailOf(c), archived, context))
    }
  }

  // Moves a space to index among the pinned spaces or the others, renumbering that group's order.
  const moveChat = (chat: Chat, pinned: boolean, index: unknown) => {
    if (chat.info.extension || chat.info.parentId) throw new Error('Only spaces can be moved or pinned')
    if (chat.info.archived) throw new Error('This chat is archived. Unarchive it first.')
    if (typeof index !== 'number' || !Number.isInteger(index)) throw new Error('The place to move to must be a number')
    const group = [...chats.values()]
      .map((c) => c.info)
      .filter((c) => !c.extension && !c.parentId && !c.archived && !!c.pinned === pinned && c.id !== chat.info.id)
      .sort(bySpaceOrder)
    group.splice(Math.max(0, Math.min(index, group.length)), 0, chat.info)
    group.forEach((info, order) => {
      const c = chats.get(info.id)!
      if (c.info.order !== order || !!c.info.pinned !== pinned) deps.updateChat(c, { order, pinned: pinned || undefined })
    })
  }

  // Removes each chat with its folder, without checks: deleteChat, and a finished worker (turn.ts).
  const removeChats = (family: Chat[]) => {
    const spaces: SpaceDetail[] = []
    for (const c of family) {
      deps.stopSession(c)
      const detail = deps.detailOf(c)
      if (!c.info.parentId && !c.info.extension) spaces.push(deps.spaceOf(c))
      chats.delete(c.info.id)
      deps.forgetChat(c.info.id)
      rmSync(c.dir, { recursive: true, force: true })
      broadcast({ type: 'chat.removed', chatId: c.info.id })
      deps.removeWorkDir(c).catch((error) => broadcast({ type: 'error', message: String(error) }))
      deps.callExtensions('onChatRemoved', (extension, context) => extension.onChatRemoved!(detail, context))
    }
    for (const space of spaces) {
      deps.callExtensions('onSpaceRemoved', (extension, context) => extension.onSpaceRemoved!(space, context))
    }
  }

  const deleteChat = (chat: Chat) => {
    const family = deps.familyOf(chat)
    family.forEach(checkRemovable)
    removeChats(family)
  }

  return { loadAll, createChat, createChild, renameChat, archiveChat, moveChat, removeChats, deleteChat }
}
