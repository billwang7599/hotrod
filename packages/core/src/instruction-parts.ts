// What a session is told, gathered as its turn starts: the chat's context items, its role, its parent's view, its
// setup, the Workers instructions, and what the memory extension and every other extension add. This module asks the
// extensions and reads the files; instructions.ts only orders and formats the parts it returns.
import { join } from 'node:path'
import type { ChatDetail, Extension, ExtensionContext, ExtensionInstructionsFor } from '@kothar/extension-api'
import type { Chat } from './chat.ts'
import type { ExtensionHook } from './extensions.ts'
import type { ContextItem, Setup } from './shared.ts'
import type { SessionParts } from './turn.ts'
import { readBytes } from './util.ts'
import { workerInstructionsFor } from './workers.ts'

// A worker's view of its parent's memory, frozen at launch, in the worker's chat folder.
export const PARENT_VIEW_FILE = 'parent-view.md'

export type InstructionPartsDeps = {
  contextItems: (chat: Chat) => ContextItem[]
  setupOf: (chat: Chat) => Setup | undefined
  // The role instructions of the extension that owns this chat (Home's), if one does.
  roleOf: (chat: Chat) => string | undefined
  // The id of the extension that owns this chat, if one does.
  roleOwnerOf?: (chat: Chat) => string | undefined
  isOnFor: (extension: Extension, chat: Chat | undefined) => boolean
  valuesOf: (extension: Extension) => ExtensionContext['values']
  detailOf: (chat: Chat) => ChatDetail
  // The extension that provides memory for this chat, if any.
  memoryExtension: (chat: Chat) => Extension | undefined
  watchersOf: (hook: ExtensionHook, chat?: Chat) => Extension[]
  contextOf: (extension: Extension) => ExtensionContext
  extensionError: (extension: Extension, error: unknown) => void
}

// An extension's instructions hook: trimmed text, or nothing when it returns none or throws (the throw shows as that
// extension's error).
function textFrom(extension: Extension, what: string, run: () => unknown, extensionError: InstructionPartsDeps['extensionError']) {
  try {
    const text = run()
    if (text === undefined || text === null) return []
    if (typeof text !== 'string') throw new Error(`${what} must return text`)
    return text.trim() ? [text.trim()] : []
  } catch (error) {
    extensionError(extension, error)
    return []
  }
}

export function openInstructionParts(deps: InstructionPartsDeps) {
  const memoryInstructions = (forSession: ExtensionInstructionsFor, chat: Chat) => {
    const extension = deps.memoryExtension(chat)
    if (!extension?.memory?.instructions) return []
    return textFrom(extension, 'memory.instructions', () => extension.memory!.instructions!(forSession, deps.contextOf(extension)), deps.extensionError)
  }

  // zoomable: the session gets the Kothar MCP server's tools (zoom, workers and the rest).
  const instructionPartsOf = (chat: Chat, zoomable: boolean): SessionParts => {
    const items = deps.contextItems(chat).filter((item) => item.enabled)
    const setup = deps.setupOf(chat)
    const role = deps.roleOf(chat)
    const parentView = readBytes(join(chat.dir, PARENT_VIEW_FILE)).toString('utf8')
    const forSession = { chat: deps.detailOf(chat), tools: zoomable }
    const workers = zoomable ? workerInstructionsFor(chat, deps) : undefined
    const memory = memoryInstructions(forSession, chat)
    const ids: string[] = []
    const extensions = deps.watchersOf('instructions', chat).flatMap((extension) => {
      const text = textFrom(extension, 'instructions', () => extension.instructions!(forSession, deps.contextOf(extension)), deps.extensionError)
      for (const _ of text) ids.push(extension.id)
      return text
    })
    const memoryId = memory.length ? deps.memoryExtension(chat)?.id : undefined
    const roleId = role ? deps.roleOwnerOf?.(chat) : undefined
    const sources = { extensions: ids, ...(memoryId && { memory: memoryId }), ...(roleId && { role: roleId }) }
    return { role, extensions, workers, memory, parentView, setup, items, sources }
  }

  return { instructionPartsOf }
}
