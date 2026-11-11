// A chat's context items: the global AGENTS.md, then each chat's folders, AGENTS.md and files from its space down,
// each switched on or off per chat (defaults in Settings). The core passes in the chats' tree and how to save them.
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { Chat } from './chat.ts'
import type { Settings } from './chat-store.ts'
import { GLOBAL_CONTEXT, looksBinary, type ChatInfo, type ContextItem, type ContextSection, type CoreMessage } from './shared.ts'
import { readBytes } from './util.ts'

export type ContextDeps = {
  garage: string
  settings: Settings
  saveSettings: () => void
  broadcast: (message: CoreMessage) => void
  parentOf: (chat: Chat) => Chat | undefined
  chainOf: (chat: Chat) => Chat[]
  familyOf: (chat: Chat) => Chat[]
  checkActive: (chat: Chat) => void
  saveChat: (chat: Chat) => void
  updateChat: (chat: Chat, change: Partial<ChatInfo>) => void
  /** The chat's panels and commands, sent again with its context: a setup or item can change them. */
  extensionsOf: (chat: Chat) => CoreMessage
}

export function openContext(deps: ContextDeps) {
  const { garage, settings, saveSettings, broadcast, parentOf, chainOf, familyOf, checkActive, saveChat, updateChat, extensionsOf } =
    deps
  const globalAgentsFile = join(garage, 'AGENTS.md')
  const contextDefaults = (): Record<ContextSection, boolean> => ({
    agents: settings.context?.agents ?? true,
    folders: settings.context?.folders ?? true,
    files: settings.context?.files ?? true,
  })

  const switchOf = (chat: Chat, item: Pick<ContextItem, 'section' | 'path' | 'from'>): boolean => {
    const pinned = chat.context[item.path]
    if (pinned !== undefined) return pinned
    if (item.from === chat.info.id) return true
    const parent = parentOf(chat)
    return chat.info.worker && parent ? switchOf(parent, item) : contextDefaults()[item.section]
  }

  const contextItems = (chat: Chat): ContextItem[] => {
    const owned = chainOf(chat).flatMap(({ info, dir }) =>
      info.extension
        ? []
        : [
            ...info.folders.map((path) => ({ section: 'folders' as const, path, from: info.id })),
            { section: 'agents' as const, path: join(dir, 'AGENTS.md'), from: info.id },
            ...info.files.map((path) => ({ section: 'files' as const, path, from: info.id })),
          ],
    )
    const seen = new Set<string>()
    return [{ section: 'agents' as const, path: globalAgentsFile, from: GLOBAL_CONTEXT }, ...owned].flatMap((item) => {
      if (seen.has(item.path)) return []
      seen.add(item.path)
      const bytes = readBytes(item.section === 'folders' ? join(item.path, 'AGENTS.md') : item.path)
      const binary = item.section === 'files' && looksBinary(bytes)
      const text = binary ? '' : bytes.toString('utf8')
      return [{ ...item, enabled: switchOf(chat, item), text, ...(binary && { binary }) }]
    })
  }

  const broadcastContext = (chat: Chat) =>
    familyOf(chat).forEach((c) => {
      broadcast({ type: 'chat.context', chatId: c.info.id, items: contextItems(c) })
      broadcast(extensionsOf(c))
    })

  const setContext = (chat: Chat, path: unknown, enabled: boolean) => {
    checkActive(chat)
    if (!contextItems(chat).some((item) => item.path === path)) {
      throw new Error(`This chat has no context item "${path}"`)
    }
    chat.context = { ...chat.context, [String(path)]: enabled }
    saveChat(chat)
    broadcastContext(chat)
  }

  const checkOwnsContext = (chat: Chat) => {
    if (chat.info.extension) throw new Error(`${chat.info.name} keeps no folders, files or AGENTS.md of its own`)
  }

  const addContext = (chat: Chat, section: 'folders' | 'files', rawPath: unknown) => {
    checkActive(chat)
    checkOwnsContext(chat)
    const path = checkPath(rawPath, section)
    if (contextItems(chat).some((item) => item.path === path)) {
      throw new Error(`${path} is already in this chat's context`)
    }
    updateChat(chat, { [section]: [...chat.info[section], path] })
    broadcastContext(chat)
  }

  const removeContext = (chat: Chat, section: 'folders' | 'files', path: unknown) => {
    checkActive(chat)
    if (!chat.info[section].includes(String(path))) throw new Error(`${path} is not one of this chat's ${section}`)
    delete chat.context[String(path)]
    updateChat(chat, { [section]: chat.info[section].filter((p) => p !== path) })
    broadcastContext(chat)
  }

  const writeAgentsFile = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
    broadcast({ type: 'context.file', path, text })
  }

  const writeContext = (chat: Chat, text: string) => {
    checkActive(chat)
    checkOwnsContext(chat)
    writeAgentsFile(join(chat.dir, 'AGENTS.md'), text)
  }

  const setContextDefault = (section: ContextSection, enabled: boolean) => {
    settings.context = { ...settings.context, [section]: enabled }
    saveSettings()
    broadcast({ type: 'context.defaults', defaults: contextDefaults() })
  }

  return {
    contextDefaults,
    contextItems,
    addContext,
    removeContext,
    setContext,
    writeContext,
    setContextDefault,
    writeInstructions: (text: string) => writeAgentsFile(globalAgentsFile, text),
  }
}

// A folder or file the user picked, resolved; ~ is their home folder.
export const checkPath = (rawPath: unknown, section: 'folders' | 'files') => {
  const path = String(rawPath).trim().replace(/^~(?=$|\/)/, homedir())
  if (!isAbsolute(path)) throw new Error(`The path must be absolute: ${rawPath}`)
  const stat = existsSync(path) ? statSync(path) : undefined
  if (section === 'folders' ? !stat?.isDirectory() : !stat?.isFile()) {
    throw new Error(`Not a ${section === 'folders' ? 'folder' : 'file'}: ${rawPath}`)
  }
  return realpathSync(path)
}
