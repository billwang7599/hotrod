// The UI's messages (ClientMessage), one handler each: a handler checks what came in, calls the core through deps and
// replies. Nothing here keeps state; the core passes in what the handlers reach as plain functions.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Extension, ExtensionAction, ExtensionUse, ExtensionWaitAnswer } from '@kothar/extension-api'
import type { openAccounts } from './accounts.ts'
import type { Chat } from './chat.ts'
import { readJson } from './chat-store.ts'
import { pageOf } from './history.ts'
import type { openMarketplace } from './marketplace.ts'
import type { openFileLinks } from './file-links.ts'
import type { openModels } from './models.ts'
import { searchChats } from './search.ts'
import {
  CONTEXT_SECTIONS,
  isUnread,
  type ChatInfo,
  type ClientMessage,
  type ContextItem,
  type ContextSection,
  type CopyChange,
  type CoreMessage,
  type MarketKind,
  type NewChat,
  type QueuedMessage,
  type Setup,
} from './shared.ts'
import { checkSwitch } from './settings.ts'
import { messageOf } from './util.ts'

export type Reply = (message: CoreMessage) => void

type Marketplace = ReturnType<typeof openMarketplace>
type Accounts = ReturnType<typeof openAccounts>

export type ProtocolDeps = {
  broadcast: (message: CoreMessage) => void
  /** The time, for when a chat was read. */
  now: () => Date
  isQuitting: () => boolean
  /** Restarts Kothar; without it, the user restarts it themselves. */
  restart?: () => void

  // Chats
  chatFor: (chatId: string) => Chat
  shownChats: () => Chat[]
  createChat: (spec: NewChat) => ChatInfo
  renameChat: (chat: Chat, name: unknown) => void
  archiveChat: (chat: Chat, archived: boolean) => void
  moveChat: (chat: Chat, pinned: boolean, index: unknown) => void
  deleteChat: (chat: Chat) => void
  updateChat: (chat: Chat, change: Partial<ChatInfo>) => void
  checkActive: (chat: Chat) => void
  setModel: (chat: Chat, engine?: string, model?: string, thinking?: string) => void

  // Turns
  sendMessage: (chat: Chat, text: unknown, uploads: unknown, steering?: boolean) => void
  setQueue: (chat: Chat, queue: QueuedMessage[]) => void
  interrupt: (chat: Chat, force: boolean) => void
  respond: (chat: Chat, requestId: string, allow: boolean) => void
  answer: (chat: Chat, requestId: string, answers: unknown) => void

  // Context
  contextItems: (chat: Chat) => ContextItem[]
  addContext: (chat: Chat, section: 'folders' | 'files', path: unknown) => void
  removeContext: (chat: Chat, section: 'folders' | 'files', path: unknown) => void
  setContext: (chat: Chat, path: unknown, enabled: boolean) => void
  setFolderMode: (chat: Chat, path: unknown, mode: unknown) => void
  copyChanges: (chat: Chat, path: unknown) => Promise<CopyChange[]>
  copyBack: (chat: Chat, path: unknown, files: unknown, overwrite: boolean) => Promise<number>
  writeContext: (chat: Chat, text: string) => void
  writeInstructions: (text: string) => void
  setContextDefault: (section: ContextSection, enabled: boolean) => void

  // Settings
  setEngineEnabled: (engine: string, enabled: boolean) => void
  setWorkFolder: (path: unknown) => void
  setPermissionDefault: (name: unknown, enabled: boolean) => void
  setTerminal: (terminal: unknown) => void
  setMemory: (engine?: string, model?: string) => void
  models: Pick<ReturnType<typeof openModels>, 'setList'>
  followModels: () => void
  saveSetup: (input: unknown) => Setup
  removeSetup: (id: unknown) => void
  setChatSetup: (chat: Chat, name: unknown) => void
  accounts: Pick<Accounts, 'login' | 'addApiKey' | 'submitCode' | 'cancelLogin' | 'use' | 'remove'>

  // Extensions
  extensionFor: (id: string) => Extension
  extensionsOf: (chat: Chat) => Extract<CoreMessage, { type: 'chat.extensions' }>
  openPanel: (chat: Chat, extensionId: unknown, panelId: unknown) => void
  panelOf: (chat: Chat, extensionId: unknown, panelId: unknown) => unknown
  panelAction: (chat: Chat, extensionId: unknown, panelId: unknown, action: ExtensionAction) => Promise<void>
  setSpaceValue: (extension: Extension, chat: Chat, key: string, value: unknown) => void
  runCommand: (chat: Chat, extensionId: unknown, commandId: unknown) => void
  runMessageAction: (chat: Chat, extensionId: unknown, actionId: unknown, entry: unknown) => Promise<void>
  renderDetail: (chat: Chat, extensionId: unknown, detailId: unknown, entry: unknown) => Promise<Extract<CoreMessage, { type: 'extension.detail' }>>
  flipToggle: (chat: Chat, extensionId: unknown, toggleId: unknown, on: unknown) => Promise<void>
  answerWait: (chat: Chat, extensionId: string, answer: ExtensionWaitAnswer) => void
  setExtensionEnabled: (extension: Extension, enabled: boolean) => void
  setExtensionValue: (extension: Extension, key: string, value: unknown) => void
  setPrompt: (extension: Extension, id: string, text: string | undefined) => void
  install: (extension: Extension) => void
  cancelInstall: (extension: Extension) => void
  settingsViewChanged: (extension: Extension) => void
  settingsViewAction: (extension: Extension, action: ExtensionAction) => Promise<void>
  setCommunityExtensions: (enabled: boolean) => void

  // Marketplace
  marketplace: Pick<Marketplace, 'listing' | 'themes' | 'install' | 'installLocal' | 'uninstall'>
  builtInIds: ReadonlySet<string>
  communityChanged: (id: string, added: ExtensionUse[]) => void
  marketChanged: (kind: MarketKind) => void
  uninstallExtension: (id: string) => void

  // The computer
  reveal: (path: unknown) => Promise<void>
  terminalFor: (chat: Chat, path: unknown) => Promise<void>
  fileLinks: ReturnType<typeof openFileLinks>
  setEditor: (editor: unknown, command?: unknown) => void
}

type Handlers = {
  [T in ClientMessage['type']]: (message: Extract<ClientMessage, { type: T }>, reply: Reply) => unknown
}

export function openProtocol(deps: ProtocolDeps) {
  const { broadcast, chatFor, marketplace, accounts } = deps

  const handlers = {
    // Chats
    'chat.create': (message) =>
      void deps.createChat({
        name: message.name,
        engine: optionalText(message.engine),
        folders: message.folders,
        files: message.files,
      }),
    'chat.rename': (message) => deps.renameChat(chatFor(message.chatId), message.name),
    'chat.archive': (message) => deps.archiveChat(chatFor(message.chatId), message.archived === true),
    'chat.move': (message) => deps.moveChat(chatFor(message.chatId), message.pinned === true, message.index),
    'chat.delete': (message) => deps.deleteChat(chatFor(message.chatId)),
    'chat.read': (message) => {
      const chat = chatFor(message.chatId)
      return isUnread(chat.info) ? deps.updateChat(chat, { readAt: deps.now().toISOString() }) : undefined
    },
    'chat.history': (message, reply) => {
      const { chatId, before, to } = message
      const page = pageOf(chatFor(chatId).entries, Number(before), to === undefined ? undefined : Number(to))
      return reply({ type: 'chat.history', chatId, before: page.from + page.entries.length, ...page })
    },
    'chat.setSetup': (message) => deps.setChatSetup(chatFor(message.chatId), message.setup),
    'chat.setModel': (message) =>
      deps.setModel(
        chatFor(message.chatId),
        optionalText(message.engine),
        optionalText(message.model),
        optionalText(message.thinking),
      ),
    'chat.setPermission': (message) => {
      const chat = chatFor(message.chatId)
      const name = checkSwitch(message.name)
      deps.checkActive(chat)
      return deps.updateChat(chat, { [name]: typeof message.enabled === 'boolean' ? message.enabled : undefined })
    },
    search: (message, reply) => {
      const spaces = deps.shownChats().filter((c) => !c.info.worker)
      const hits = searchChats(
        spaces.map((c) => ({ id: c.info.id, name: c.info.name, entries: c.entries })),
        String(message.query ?? ''),
      )
      return reply({ type: 'search.results', id: Number(message.id), query: String(message.query ?? ''), hits })
    },

    // Turns
    'chat.send': (message) =>
      deps.sendMessage(chatFor(message.chatId), message.text, message.attachments, message.steer === true),
    'chat.unqueue': (message) => {
      const chat = chatFor(message.chatId)
      const removed = chat.queue.find((q) => q.id === message.id)
      if (!removed) return
      if (removed.steering) throw new Error('That message is already with the engine, so it can no longer be taken back')
      for (const { path } of removed.attachments ?? []) rmSync(path, { force: true })
      return deps.setQueue(chat, chat.queue.filter((q) => q !== removed))
    },
    'chat.interrupt': (message) => deps.interrupt(chatFor(message.chatId), message.force === true),
    'permission.respond': (message) => deps.respond(chatFor(message.chatId), message.requestId, message.allow === true),
    'question.respond': (message) => deps.answer(chatFor(message.chatId), message.requestId, message.answers),

    // Context
    'context.get': (message, reply) => {
      const chat = chatFor(message.chatId)
      reply({ type: 'chat.context', chatId: chat.info.id, items: deps.contextItems(chat) })
      return reply(deps.extensionsOf(chat))
    },
    'context.add': (message) => deps.addContext(chatFor(message.chatId), addable(message.section), message.path),
    'context.remove': (message) => deps.removeContext(chatFor(message.chatId), addable(message.section), message.path),
    'context.set': (message) => deps.setContext(chatFor(message.chatId), message.path, message.enabled === true),
    'context.folderMode': (message) => deps.setFolderMode(chatFor(message.chatId), message.path, message.mode),
    'context.copyChanges': (message, reply) => {
      const chat = chatFor(message.chatId)
      const answer = { type: 'context.copyChanges' as const, chatId: chat.info.id, path: String(message.path ?? '') }
      return void deps.copyChanges(chat, message.path).then(
        (changes) => reply({ ...answer, changes }),
        (error) => reply({ ...answer, changes: [], error: messageOf(error) }),
      )
    },
    'context.copyBack': (message, reply) => {
      const chat = chatFor(message.chatId)
      const answer = { type: 'context.copyChanges' as const, chatId: chat.info.id, path: String(message.path ?? '') }
      // The changes are sent again either way, so the list the user sees is never stale.
      return void deps.copyBack(chat, message.path, message.files, message.overwrite === true).then(
        async (copied) => reply({ ...answer, changes: await deps.copyChanges(chat, message.path), copied }),
        async (error) => {
          const changes = await deps.copyChanges(chat, message.path).catch(() => [])
          reply({ ...answer, changes, error: messageOf(error) })
        },
      )
    },
    'context.write': (message) => {
      if (typeof message.text !== 'string') throw new Error('Context text is missing')
      return deps.writeContext(chatFor(message.chatId), message.text)
    },
    'instructions.write': (message) => {
      if (typeof message.text !== 'string') throw new Error('Instructions text is missing')
      return deps.writeInstructions(message.text)
    },
    'context.setDefault': (message) => {
      if (!CONTEXT_SECTIONS.includes(message.section)) {
        throw new Error(`Unknown context section "${message.section}"`)
      }
      return deps.setContextDefault(message.section, message.enabled === true)
    },

    // Extensions in a chat
    'extension.panel.get': (message) => deps.openPanel(chatFor(message.chatId), message.extension, message.panel),
    'extension.panel.action': (message) => {
      const chat = chatFor(message.chatId)
      deps.panelOf(chat, message.extension, message.panel)
      return void deps
        .panelAction(chat, message.extension, message.panel, message.action)
        .catch((error) => broadcast({ type: 'error', message: messageOf(error) }))
    },
    'extension.space.set': (message) =>
      deps.setSpaceValue(
        deps.extensionFor(String(message.extension)),
        chatFor(message.chatId),
        String(message.key),
        message.value,
      ),
    'extension.command': (message) => deps.runCommand(chatFor(message.chatId), message.extension, message.command),
    'extension.message.action': (message) =>
      deps.runMessageAction(chatFor(message.chatId), message.extension, message.action, message.entry),
    'extension.detail.get': async (message, reply) =>
      reply(await deps.renderDetail(chatFor(message.chatId), message.extension, message.detail, message.entry)),
    'extension.toggle': (message) => deps.flipToggle(chatFor(message.chatId), message.extension, message.toggle, message.on),
    'extension.wait.answer': (message) =>
      deps.answerWait(chatFor(message.chatId), String(message.extension), { button: String(message.button) }),

    // Settings
    'engine.setEnabled': (message) => deps.setEngineEnabled(String(message.engine), message.enabled === true),
    'workFolder.set': (message) => deps.setWorkFolder(message.path),
    'permission.setDefault': (message) => deps.setPermissionDefault(message.name, message.enabled === true),
    'terminal.set': (message) => deps.setTerminal(message.terminal),
    'editor.set': (message) => deps.setEditor(message.editor, message.command),
    'memory.set': (message) => deps.setMemory(optionalText(message.engine), optionalText(message.model)),
    'models.setList': (message) => {
      deps.models.setList(message.role, message.models)
      return deps.followModels()
    },
    'app.restart': () => {
      if (!deps.restart) throw new Error('This Kothar can\'t restart itself. Stop it and start it again.')
      if (deps.isQuitting()) return
      return deps.restart()
    },

    // Setups
    'setup.save': (message, reply) => {
      let answer: CoreMessage
      try {
        answer = { type: 'setup.saved', setup: deps.saveSetup(message.setup) }
      } catch (error) {
        answer = { type: 'setup.refused', error: messageOf(error) }
      }
      return reply(answer)
    },
    'setup.remove': (message) => deps.removeSetup(message.id),

    // Extensions in Settings
    'extension.setEnabled': (message) =>
      deps.setExtensionEnabled(deps.extensionFor(String(message.extensionId)), message.enabled === true),
    'extension.setValue': (message) =>
      deps.setExtensionValue(deps.extensionFor(String(message.extensionId)), String(message.key), message.value),
    'extension.prompt.set': (message) =>
      deps.setPrompt(
        deps.extensionFor(String(message.extensionId)),
        String(message.promptId),
        typeof message.text === 'string' ? message.text : undefined,
      ),
    'extension.install': (message) => deps.install(deps.extensionFor(String(message.extensionId))),
    'extension.settingsView.get': (message) => deps.settingsViewChanged(deps.extensionFor(String(message.extensionId))),
    'extension.settingsView.action': (message) =>
      deps.settingsViewAction(deps.extensionFor(String(message.extensionId)), message.action),
    'extension.cancelInstall': (message) => deps.cancelInstall(deps.extensionFor(String(message.extensionId))),
    'communityExtensions.setEnabled': (message) => deps.setCommunityExtensions(message.enabled === true),

    // Accounts
    'account.login': (message) =>
      accounts.login(
        String(message.engine),
        String(message.name ?? ''),
        optionalText(message.provider),
        optionalText(message.method),
      ),
    'account.addApiKey': (message) =>
      accounts.addApiKey(
        String(message.engine),
        String(message.name ?? ''),
        String(message.key ?? ''),
        optionalText(message.provider),
        optionalText(message.method),
      ),
    'account.code': (message) => accounts.submitCode(String(message.engine), String(message.code ?? '')),
    'account.cancelLogin': (message) => accounts.cancelLogin(String(message.engine)),
    'account.use': (message) => accounts.use(String(message.engine), String(message.accountId)),
    'account.remove': (message, reply) =>
      accounts.remove(String(message.engine), String(message.accountId), reply),

    // Marketplace
    'marketplace.list': (_message, reply) =>
      void marketplace.listing().then(
        (entries) => reply({ type: 'marketplace.catalog', entries }),
        (error) => reply({ type: 'marketplace.catalog', error: messageOf(error) }),
      ),
    'themes.get': (_message, reply) => reply({ type: 'themes.updated', themes: marketplace.themes() }),
    'market.install': (message, reply) => {
      const { kind } = message
      const id = String(message.id)
      if (kind === 'extension' && deps.builtInIds.has(id)) {
        return reply({ type: 'market.installFailed', kind, id, error: `A built-in extension is already called "${id}"` })
      }
      return void marketplace.install(kind, id).then(
        ({ added }) => {
          if (kind === 'extension') deps.communityChanged(id, added)
          deps.marketChanged(kind)
        },
        (error) => reply({ type: 'market.installFailed', kind, id, error: messageOf(error) }),
      )
    },
    'market.installLocal': (message, reply) => {
      const path = String(message.path ?? '')
      let result: ReturnType<typeof marketplace.installLocal>
      try {
        // A broken manifest is the marketplace's to explain.
        const id = (() => {
          try {
            return (readJson(join(path.trim(), 'manifest.json')) as { id?: unknown }).id
          } catch {
            return undefined
          }
        })()
        if (typeof id === 'string' && deps.builtInIds.has(id)) throw new Error(`A built-in extension is already called "${id}"`)
        result = marketplace.installLocal(path)
      } catch (error) {
        return reply({ type: 'market.localFailed', path, error: messageOf(error) })
      }
      const { kind, ids, added } = result
      if (kind === 'extension') deps.communityChanged(ids[0]!, added)
      deps.marketChanged(kind)
      return reply({ type: 'market.localInstalled', path, kind, ids })
    },
    'market.uninstall': (message) => {
      if (message.kind === 'extension') deps.uninstallExtension(String(message.id))
      else marketplace.uninstall(message.kind, message.id)
      return deps.marketChanged(message.kind)
    },

    // The computer
    // Show in Finder, from an extension's view (a text with reveal). Refused paths come back as an error.
    reveal: (message, reply) =>
      void deps.reveal(message.path).catch((error) => reply({ type: 'error', message: messageOf(error) })),
    'terminal.open': (message, reply) => {
      const chat = chatFor(message.chatId)
      const path = String(message.path ?? '')
      return void deps.terminalFor(chat, message.path).then(
        () => reply({ type: 'terminal.result', chatId: chat.info.id, path }),
        (error) => reply({ type: 'terminal.result', chatId: chat.info.id, path, error: messageOf(error) }),
      )
    },
    'files.check': (message, reply) => {
      const chat = chatFor(message.chatId)
      return reply({ type: 'files.checked', chatId: chat.info.id, paths: deps.fileLinks.checkPaths(chat, message.paths) })
    },
    'file.open': (message, reply) => {
      const chat = chatFor(message.chatId)
      const opened =
        message.in === 'terminal'
          ? deps.fileLinks.openTerminalAtFile(chat, message.path)
          : deps.fileLinks.openFile(chat, message.path, message.line, message.col)
      return void opened.catch((error) => reply({ type: 'error', message: messageOf(error) }))
    },
  } satisfies Handlers

  type Handled = ReturnType<(typeof handlers)[keyof typeof handlers]>

  return (message: ClientMessage, reply: Reply): Handled => {
    const { type } = message
    if (typeof type !== 'string' || !Object.hasOwn(handlers, type)) {
      throw new Error(`Unknown message type "${(message as { type: unknown }).type}"`)
    }
    const handler = handlers[type] as (message: ClientMessage, reply: Reply) => Handled
    return handler(message, reply)
  }
}

const optionalText = (value: unknown) => (typeof value === 'string' && value ? value : undefined)


const addable = (section: unknown) => {
  if (section !== 'folders' && section !== 'files') {
    throw new Error(`Only folders and files can be added, not "${section}"`)
  }
  return section
}
