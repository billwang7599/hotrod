import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

// Subagents became workers, aftermarket mods community mods, and then mods extensions. What older Kothars saved under
// the old words is read under the new ones: settings.json once at open (and saved back), each chat.json and log.jsonl
// line as it loads (and chat.json saved back the next time the chat changes), and the garage folders moved once.

const renameKey = (object: Record<string, unknown>, from: string, to: string) => {
  if (!(from in object)) return false
  if (!(to in object)) object[to] = object[from]
  delete object[from]
  return true
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Moves what settings.json kept under mods to extensions (`mods`, `communityMods`, `modVersions`), then the Subagents
 * extension's switch and values to the Workers extension, and the Subagents model list to Workers, in place.
 */
export function renameSettings(settings: { extensions?: unknown; models?: unknown }): boolean {
  const saved = settings as Record<string, unknown>
  let changed = renameKey(saved, 'mods', 'extensions')
  changed = renameKey(saved, 'communityMods', 'communityExtensions') || changed
  changed = renameKey(saved, 'modVersions', 'extensionVersions') || changed
  if (isObject(settings.extensions)) changed = renameKey(settings.extensions, 'subagents', 'workers') || changed
  if (isObject(settings.models)) {
    changed = renameKey(settings.models, 'subagents', 'workers') || changed
    // Lists saved per engine, from before one set of lists (migrateModels reads them next).
    for (const lists of Object.values(settings.models)) {
      if (isObject(lists)) changed = renameKey(lists, 'subagents', 'workers') || changed
    }
  }
  return changed
}

/**
 * A saved chat.json's fields under today's names: `subagent: true` is `worker: true`, role `subagents` is `workers`,
 * `mod` (the extension owning the chat) is `extension`, and `modValues` (a space's extension settings)
 * `extensionValues`.
 */
export function renameChatFile<T extends Record<string, unknown>>(saved: T): T {
  const { subagent, ...rest } = saved as Record<string, unknown>
  const next: Record<string, unknown> = { ...rest }
  if (subagent !== undefined && next.worker === undefined) next.worker = subagent
  renameKey(next, 'mod', 'extension')
  renameKey(next, 'modValues', 'extensionValues')
  if (next.role === 'subagents') next.role = 'workers'
  return next as T
}

/** A logged entry under today's type: `subagent.report` is `worker.report`, and `mod.note` (with `mod`) `extension.note`. */
export function renameEntry<T extends { type: string }>(entry: T): T {
  if (entry.type === 'subagent.report') return { ...entry, type: 'worker.report' }
  if (entry.type !== 'mod.note') return entry
  const { mod, ...rest } = entry as T & { mod?: string }
  return { ...rest, type: 'extension.note', ...(mod !== undefined && { extension: mod }) } as unknown as T
}

const moveDir = (garage: string, from: string, to: string) => {
  if (existsSync(join(garage, from)) && !existsSync(join(garage, to))) renameSync(join(garage, from), join(garage, to))
}

/** Moves `<garage>/aftermarket/` to `<garage>/community/`, unless there's already one there. */
export function moveCommunityDir(garage: string) {
  moveDir(garage, 'aftermarket', 'community')
}

/** Moves `<garage>/mods/` (each extension's own files) to `<garage>/extensions/`, unless there's already one there. */
export function moveExtensionsDir(garage: string) {
  moveDir(garage, 'mods', 'extensions')
}
