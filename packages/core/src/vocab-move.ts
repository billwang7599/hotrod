import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

// Subagents became workers, and aftermarket mods community mods. What older Kothars saved under the old words is read
// under the new ones: settings.json once at open (and saved back), each chat.json and log.jsonl line as it loads (and
// chat.json saved back the next time the chat changes), and the community mods folder moved once.

const renameKey = (object: Record<string, unknown>, from: string, to: string) => {
  if (!(from in object)) return false
  if (!(to in object)) object[to] = object[from]
  delete object[from]
  return true
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Moves the Subagents mod's switch and values to the Workers mod, and the Subagents model list to Workers, in place. */
export function renameSettings(settings: { mods?: unknown; models?: unknown }): boolean {
  let changed = false
  if (isObject(settings.mods)) changed = renameKey(settings.mods, 'subagents', 'workers') || changed
  if (isObject(settings.models)) {
    changed = renameKey(settings.models, 'subagents', 'workers') || changed
    // Lists saved per engine, from before one set of lists (migrateModels reads them next).
    for (const lists of Object.values(settings.models)) {
      if (isObject(lists)) changed = renameKey(lists, 'subagents', 'workers') || changed
    }
  }
  return changed
}

/** A saved chat.json's fields under today's names: `subagent: true` is `worker: true`, role `subagents` is `workers`. */
export function renameChatFile<T extends Record<string, unknown>>(saved: T): T {
  const { subagent, ...rest } = saved as Record<string, unknown>
  const next: Record<string, unknown> = { ...rest }
  if (subagent !== undefined && next.worker === undefined) next.worker = subagent
  if (next.role === 'subagents') next.role = 'workers'
  return next as T
}

/** A logged entry under today's type: `subagent.report` is `worker.report`. */
export function renameEntry<T extends { type: string }>(entry: T): T {
  return entry.type === 'subagent.report' ? { ...entry, type: 'worker.report' } : entry
}

/** Moves `<garage>/aftermarket/` to `<garage>/community/`, unless there's already one there. */
export function moveCommunityDir(garage: string) {
  const from = join(garage, 'aftermarket')
  const to = join(garage, 'community')
  if (existsSync(from) && !existsSync(to)) renameSync(from, to)
}
