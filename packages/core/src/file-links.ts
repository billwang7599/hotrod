// File links in a chat: which paths a message mentions really exist where the chat works, and opening one in the
// user's editor or a terminal at its folder. Only paths inside the chat's own places count: its folders, checkouts,
// work folder and files, and its folder in the garage (attachments). Anything else is refused, checked through
// symlinks, so a link can't point the user's apps anywhere else.
import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Chat } from './chat.ts'
import { editorLaunch, type FileSpot } from './editors.ts'
import { realOr } from './folder-access.ts'
import type { Machine } from './shared.ts'
import { within } from './util.ts'

// How long a check's answer is kept: files come and go while agents work, but a transcript asks about the same paths
// every time it renders.
const CHECK_TTL_MS = 10_000
// The most paths one check answers, and the longest path it looks at.
export const MAX_CHECKED = 200
const MAX_PATH = 1024
const OPEN_TIMEOUT_MS = 15_000

export type FileLinkDeps = {
  home: string
  platform?: NodeJS.Platform
  machine: Pick<Machine, 'run'>
  now: () => Date
  chainOf: (chat: Chat) => Chat[]
  // A chat's folders, its space's work folder and the checkouts (folder-access.ts).
  terminalRoots: (chat: Chat) => string[]
  openTerminalAt: (dir: string) => Promise<void>
  // settings.json's editor and its custom command, read each time.
  editor: () => { choice?: string; command?: string }
  exists?: (path: string) => boolean
}

export function openFileLinks(deps: FileLinkDeps) {
  const { home, platform = process.platform, exists = existsSync } = deps
  const cache = new Map<string, { path: string | null; at: number }>()

  // Where a relative path may be, in the order it's looked for: checkouts first, where agents edit, then the work
  // folder, the folders themselves and the chat's own folder in the garage.
  const bases = (chat: Chat) => {
    const chain = deps.chainOf(chat)
    return [
      ...chain.flatMap(({ info }) => Object.values(info.worktrees ?? {}).map((w) => w.path)),
      ...chain.flatMap(({ info }) => (info.workDir ? [info.workDir] : [])),
      ...chain.flatMap(({ info }) => (info.extension ? [] : info.folders)),
      ...chain.map((c) => c.dir),
    ]
  }
  const roots = (chat: Chat) => [
    ...deps.terminalRoots(chat),
    ...deps.chainOf(chat).flatMap((c) => [c.dir, ...(c.info.extension ? [] : c.info.files)]),
  ]
  const inRoots = (chat: Chat, path: string) => {
    const real = realOr(path)
    return roots(chat).some((root) => within(real, realOr(root)))
  }

  const expand = (path: string) => path.replace(/^~(?=$|\/)/, home)

  // The absolute path a mention means in this chat, if it's there.
  const find = (chat: Chat, raw: string): string | null => {
    const path = expand(raw.trim())
    if (!path || path.length > MAX_PATH || path.includes('\0')) return null
    const candidates = isAbsolute(path) ? [resolve(path)] : [...new Set(bases(chat))].map((base) => join(base, path))
    return candidates.find((candidate) => exists(candidate) && inRoots(chat, candidate)) ?? null
  }

  // Which of paths exist for this chat: each to its absolute path, or null.
  const checkPaths = (chat: Chat, rawPaths: unknown): Record<string, string | null> => {
    const paths = Array.isArray(rawPaths) ? rawPaths.filter((p): p is string => typeof p === 'string') : []
    const now = deps.now().getTime()
    const found: Record<string, string | null> = {}
    for (const path of paths.slice(0, MAX_CHECKED)) {
      const key = `${chat.info.id}\0${path}`
      const cached = cache.get(key)
      if (cached && now - cached.at < CHECK_TTL_MS) {
        found[path] = cached.path
        continue
      }
      found[path] = find(chat, path)
      cache.set(key, { path: found[path], at: now })
    }
    if (cache.size > 5_000) for (const [key, { at }] of cache) if (now - at >= CHECK_TTL_MS) cache.delete(key)
    return found
  }

  // A path the UI got from checkPaths, checked again: it must still be there and inside the chat's places.
  const checked = (chat: Chat, rawPath: unknown) => {
    const path = typeof rawPath === 'string' ? expand(rawPath) : ''
    if (!isAbsolute(path) || !inRoots(chat, path)) {
      throw new Error(`${path || 'That'} isn't in this chat's folders, checkouts or work folder`)
    }
    if (!exists(path)) throw new Error(`${path} doesn't exist`)
    return realOr(path)
  }

  const lineOf = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined

  // Opens a file (or folder) with the editor in settings, at its line where the editor can.
  const openFile = async (chat: Chat, rawPath: unknown, rawLine?: unknown, rawCol?: unknown) => {
    const file = checked(chat, rawPath)
    const line = lineOf(rawLine)
    const col = line === undefined ? undefined : lineOf(rawCol)
    const spot: FileSpot = { file, ...(line !== undefined && { line }), ...(col !== undefined && { col }) }
    const { choice, command } = deps.editor()
    const launch = editorLaunch(spot, { choice, command, platform, home, exists })
    const { code, stderr } = await deps.machine
      .run(launch.command, launch.args, { cwd: dirname(file), timeoutMs: OPEN_TIMEOUT_MS })
      .catch((error: NodeJS.ErrnoException) => {
        if (error?.code === 'ENOENT') throw new Error(`Couldn't find ${launch.command}`)
        throw error
      })
    if (code !== 0) throw new Error(stderr.trim() || `Couldn't open ${file}`)
  }

  // Opens the user's terminal at a file's folder (or at the folder itself).
  const openTerminalAtFile = async (chat: Chat, rawPath: unknown) => {
    const path = checked(chat, rawPath)
    await deps.openTerminalAt(statSync(path).isDirectory() ? path : dirname(path))
  }

  return { checkPaths, openFile, openTerminalAtFile }
}
