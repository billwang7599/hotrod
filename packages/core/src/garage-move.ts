import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import type { Machine } from './shared.ts'

// Kothar was called Hotrod. On the first launch after the rename, the old garage moves to Kothar's own folder, once,
// so nobody is left wondering which folder is in use. It is a rename, never a copy, and nothing is deleted; every
// stored absolute path into the old folder is then pointed at the new one.

// Files the core reads back to act on. Logs and summaries are history and keep the paths they were written with.
const STORED = (garage: string) => [
  join(garage, 'settings.json'),
  ...jsonIn(join(garage, 'accounts')),
  ...readdirOr(join(garage, 'chats')).map((id) => join(garage, 'chats', id, 'chat.json')),
]
// Not searched for symlinks: checkouts (their links are the repos' own) and package folders.
const SKIPPED_DIRS = new Set(['work', 'node_modules', '.git'])
const IN_USE_TIMEOUT_MS = 500
const GIT_TIMEOUT_MS = 30_000

type Log = (message: string) => void
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

function readdirOr(dir: string) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function jsonIn(dir: string) {
  return readdirOr(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(dir, name))
}

export function movedPath(path: string, from: string, to: string) {
  return path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path
}

// Every string, and every object key (chats key their checkouts by folder), that names a path in the old garage.
export function movedPaths(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return movedPath(value, from, to)
  if (Array.isArray(value)) return value.map((item) => movedPaths(item, from, to))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [movedPath(key, from, to), movedPaths(item, from, to)]),
    )
  return value
}

function rewriteFile(file: string, from: string, to: string, log: Log) {
  try {
    if (!existsSync(file)) return
    const text = readFileSync(file, 'utf8')
    if (!text.includes(from)) return
    const moved = JSON.stringify(movedPaths(JSON.parse(text), from, to), null, 2)
    writeFileSync(file, text.endsWith('\n') ? `${moved}\n` : moved)
  } catch (error) {
    log(`Couldn't update the paths in ${file}: ${messageOf(error)}`)
  }
}

function relinkSymlinks(dir: string, from: string, to: string, log: Log) {
  for (const name of readdirOr(dir)) {
    const path = join(dir, name)
    try {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path)
        const moved = movedPath(target, from, to)
        if (moved === target) continue
        unlinkSync(path)
        symlinkSync(moved, path)
      } else if (stat.isDirectory() && !SKIPPED_DIRS.has(name)) relinkSymlinks(path, from, to, log)
    } catch (error) {
      log(`Couldn't update the link ${path}: ${messageOf(error)}`)
    }
  }
}

// A checkout's back-pointer in its repo (.git/worktrees/<name>/gitdir) still names the old path; repair, run from
// the repo with the checkout's new path, fixes both directions.
async function repairCheckouts(garage: string, machine: Machine, log: Log) {
  for (const id of readdirOr(join(garage, 'chats'))) {
    let worktrees: Record<string, { path?: string }> = {}
    try {
      const file = join(garage, 'chats', id, 'chat.json')
      if (existsSync(file)) worktrees = JSON.parse(readFileSync(file, 'utf8')).worktrees ?? {}
    } catch {
      continue
    }
    for (const [folder, { path }] of Object.entries(worktrees)) {
      if (!path || !path.startsWith(`${garage}/`) || !existsSync(path)) continue
      const args = ['-C', folder, 'worktree', 'repair', path]
      const result = await machine
        .run('git', args, { cwd: existsSync(folder) ? folder : garage, timeoutMs: GIT_TIMEOUT_MS })
        .catch((error: unknown) => ({ code: 1, stderr: messageOf(error) }))
      if (result.code !== 0) log(`Couldn't repair the checkout ${path}: ${result.stderr.trim() || 'git failed'}`)
    }
  }
}

// Something answering on the core's port is another core, perhaps the old app still running on the old garage.
export function portInUse(port: number, host = '127.0.0.1') {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ port, host })
    const done = (used: boolean) => {
      socket.destroy()
      resolve(used)
    }
    socket.setTimeout(IN_USE_TIMEOUT_MS, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

export async function moveGarage(options: {
  from: string
  to: string
  machine: Machine
  inUse: () => Promise<boolean>
  rename?: (from: string, to: string) => void
  log?: Log
}): Promise<string> {
  const { from, to, machine, inUse, rename = renameSync, log = console.error } = options
  if (existsSync(to) || !existsSync(from)) return to
  if (await inUse()) {
    log(`Kothar is using ${from} for now, since another Kothar or Hotrod seems to be running on it`)
    return from
  }
  try {
    rename(from, to)
  } catch (error) {
    log(`Couldn't move ${from} to ${to}, so Kothar keeps using it where it is: ${messageOf(error)}`)
    return from
  }
  for (const file of STORED(to)) rewriteFile(file, from, to, log)
  relinkSymlinks(to, from, to, log)
  await repairCheckouts(to, machine, log)
  log(`Moved the garage from ${from} to ${to}`)
  return to
}
