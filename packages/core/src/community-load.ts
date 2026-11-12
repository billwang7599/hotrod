// The extensions one run of the core has: the built-in ones, then the community extensions the garage has installed,
// checked so no two share an id, a tool name or a chat id. The core calls this once, as it opens; the lists it returns
// grow later only when a community extension is installed (see extension-switches.ts).
import type { Extension, ExtensionChat } from '@kothar/extension-api'
import { CORE_TOOL_NAMES } from './kothar-mcp.ts'
import { type CommunityEntry, type CommunityExtension, stubOf } from './extensions.ts'

// An extension's chat, with the extension that declares it.
export type DeclaredChat = ExtensionChat & { extension: Extension }

export type ExtensionSet = {
  // Every extension: built-in first, then community ones (a stub for one that didn't load).
  extensions: Extension[]
  // The chats extensions declare, such as Home.
  extensionChats: DeclaredChat[]
  // The ids of the built-in extensions, which a community extension can't take.
  builtInIds: Set<string>
  // Community extensions by id.
  community: Map<string, CommunityEntry>
  // The community extensions this run imported (whether or not they loaded), by id with their name.
  imported: Map<string, string>
  // Those installed again since this run imported them; empty at start.
  reinstalled: Set<string>
}

const chatsOf = (extension: Extension): DeclaredChat[] => (extension.chats ?? []).map((chat) => ({ ...chat, extension }))
const toolsOf = (extension: Extension) => (extension.tools ?? []).map((tool) => tool.name)

// Built-in extensions that clash throw: that's a bug in Kothar. Community extensions come after the built-in ones. One
// that clashes with a built-in extension's id isn't listed; one whose tool or chat is taken doesn't run. An extension
// that didn't load (off, or broken) is listed as a stub with no hooks, so it can be turned on or off; it runs from the
// next start.
export function gatherExtensions(builtIn: Extension[], found: CommunityExtension[]): ExtensionSet {
  const extensions = [...builtIn]
  const extensionChats = extensions.flatMap(chatsOf)
  const toolNames = [...CORE_TOOL_NAMES, ...extensions.flatMap(toolsOf)]
  for (const [what, ids] of [
    ['extensions', extensions.map((extension) => extension.id)],
    ['extension chats', extensionChats.map((chat) => chat.id)],
    ['tools', toolNames],
  ] as const) {
    const twin = ids.find((id, i) => ids.indexOf(id) !== i)
    if (twin !== undefined) throw new Error(`Two ${what} have the id "${twin}"`)
  }
  const builtInIds = new Set(extensions.map((extension) => extension.id))
  const community = new Map<string, CommunityEntry>()
  const imported = new Map<string, string>()
  for (const entry of found) {
    const { manifest, item } = entry
    if (builtInIds.has(manifest.id) || community.has(manifest.id)) {
      console.error(`Skipped the community extension "${manifest.id}": an extension already has that id`)
      continue
    }
    let { extension, loadError } = entry
    if (extension || loadError) imported.set(manifest.id, manifest.name)
    const clash =
      extension &&
      (toolsOf(extension).find((name) => toolNames.includes(name)) ??
        chatsOf(extension).map((chat) => chat.id).find((id) => extensionChats.some((chat) => chat.id === id)))
    if (clash) {
      loadError = `its tool or chat "${clash}" is already taken`
      extension = undefined
    }
    community.set(manifest.id, {
      manifest,
      item,
      ...(extension && { running: manifest.version }),
      ...(loadError && { loadError }),
      ...(entry.held && { held: entry.held }),
    })
    if (!extension) {
      extensions.push(stubOf(manifest))
      continue
    }
    extensions.push(extension)
    extensionChats.push(...chatsOf(extension))
    toolNames.push(...toolsOf(extension))
  }
  return { extensions, extensionChats, builtInIds, community, imported, reinstalled: new Set() }
}
