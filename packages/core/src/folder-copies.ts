// Folders set to Work on a copy (folder-modes.ts): the core copies the folder into its space's work folder once, before
// the first session that needs it (as checkouts are made in code), and later copies the user's pick of changes back.
// What each copy held when made, file by file (sha256), is kept in the space's folder-copies.json, so Copy changes back
// can tell what the agents changed and refuse to overwrite an original that changed since.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { freeName } from './checkouts.ts'
import type { CopyChange } from './shared.ts'
import { within } from './util.ts'

export const COPIES_FILE = 'folder-copies.json'
// Folders left out of a copy wherever they are: dependencies anyone can reinstall, and other repos' history, which
// copying back could corrupt. Symlinks are left out too, since one could point anywhere.
export const COPY_SKIPPED = ['node_modules', '.git']
export const MAX_COPY_FILES = 20_000
export const MAX_COPY_BYTES = 1_000_000_000

export type FolderCopy = { path: string; madeAt: string; files: Record<string, string> }
type Copies = Record<string, FolderCopy>

/** What the copies need of a space: its folder in the garage and the paths its checkouts took. */
type Space = { dir: string; info: { id: string; worktrees?: Record<string, { path: string }> } }

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

// Every file under dir by its path from dir ('/' separated), with its sha256, leaving out COPY_SKIPPED and symlinks.
// Throws when the folder is too big to copy.
async function filesOf(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  let count = 0
  let bytes = 0
  const walk = async (at: string) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) {
        if (!COPY_SKIPPED.includes(entry.name)) await walk(path)
        continue
      }
      if (!entry.isFile()) continue
      const content = await readFile(path)
      count++
      bytes += content.length
      if (count > MAX_COPY_FILES || bytes > MAX_COPY_BYTES) {
        throw new Error(`${dir} is too big to copy (over ${MAX_COPY_FILES} files or 1 GB). Set it to Edit in place or Read only.`)
      }
      files[relative(dir, path).split(sep).join('/')] = sha256(content)
    }
  }
  if (existsSync(dir)) await walk(dir)
  return files
}

const fileSha = async (path: string) => {
  const stat = await lstat(path).catch(() => undefined)
  return stat?.isFile() ? sha256(await readFile(path)) : undefined
}

export function openFolderCopies<S extends Space>(deps: { now: () => Date }) {
  const fileOf = (space: S) => join(space.dir, COPIES_FILE)

  const read = (space: S): Copies => {
    try {
      return existsSync(fileOf(space)) ? (JSON.parse(readFileSync(fileOf(space), 'utf8')) as Copies) : {}
    } catch {
      return {}
    }
  }

  const write = (space: S, copies: Copies) => {
    const fresh = `${fileOf(space)}.tmp`
    writeFileSync(fresh, `${JSON.stringify(copies, null, 2)}\n`)
    renameSync(fresh, fileOf(space))
  }

  /** The folder's copy, if one was made and is still there. */
  const savedCopy = (space: S, folder: string) => {
    const copy = read(space)[folder]
    return copy && existsSync(copy.path) ? copy : undefined
  }

  const make = async (space: S, folder: string, workDir: string) => {
    const copies = read(space)
    const taken = [
      ...Object.values(space.info.worktrees ?? {}).map((w) => w.path),
      ...Object.entries(copies).flatMap(([f, c]) => (f === folder ? [] : [c.path])),
    ]
    const path = freeName(join(workDir, basename(folder)), (p) => taken.includes(p) || existsSync(p))
    const files = await filesOf(folder)
    for (const name of Object.keys(files)) {
      await mkdir(dirname(join(path, name)), { recursive: true })
      await copyFile(join(folder, name), join(path, name))
    }
    await mkdir(path, { recursive: true })
    const copy = { path, madeAt: deps.now().toISOString(), files }
    write(space, { ...read(space), [folder]: copy })
    return copy
  }

  const making = new Map<string, Promise<FolderCopy>>()
  /** The folder's copy in the work folder, made now if it has none. */
  const copyOf = async (space: S, folder: string, workDir: string): Promise<FolderCopy> => {
    const saved = savedCopy(space, folder)
    if (saved) return saved
    const key = `${space.info.id}\n${folder}`
    const made =
      making.get(key) ??
      make(space, folder, workDir)
        .catch((error: unknown) => {
          throw new Error(`Couldn't copy ${folder} into the work folder: ${error instanceof Error ? error.message : error}`)
        })
        .finally(() => making.delete(key))
    making.set(key, made)
    return made
  }

  /** What changed in the copy since it was made, and which of those the original also changed since (conflict). */
  const changesOf = async (space: S, folder: string): Promise<{ copy: FolderCopy; changes: CopyChange[] }> => {
    const copy = savedCopy(space, folder)
    if (!copy) throw new Error(`${folder} has no copy in the work folder yet`)
    const now = await filesOf(copy.path)
    const names = [...new Set([...Object.keys(copy.files), ...Object.keys(now)])].toSorted()
    const changes: CopyChange[] = []
    for (const name of names) {
      const [was, is] = [copy.files[name], now[name]]
      if (was === is) continue
      const original = await fileSha(join(folder, name))
      const kind = was === undefined ? 'added' : is === undefined ? 'deleted' : 'changed'
      // The original changed since the copy was made, or (for a new file) someone else made one there.
      const conflict = original !== was && original !== is
      changes.push({ path: name, kind, ...(conflict && { conflict: true }) })
    }
    return { copy, changes }
  }

  /**
   * Copies the picked changes back into the original folder. Refuses all of them, writing nothing, when one would
   * overwrite an original that changed since the copy was made, unless overwrite says the user confirmed.
   */
  const copyBack = async (space: S, folder: string, picked: unknown, overwrite: boolean) => {
    if (!Array.isArray(picked) || !picked.every((p) => typeof p === 'string')) throw new Error('Pick the files to copy back')
    const { copy, changes } = await changesOf(space, folder)
    const chosen = changes.filter((c) => picked.includes(c.path))
    const unknown = picked.filter((p) => !changes.some((c) => c.path === p))
    if (unknown.length) throw new Error(`Not changed in the copy: ${unknown.join(', ')}`)
    const conflicts = chosen.filter((c) => c.conflict)
    if (conflicts.length && !overwrite) {
      throw new Error(`These changed in ${folder} since it was copied: ${conflicts.map((c) => c.path).join(', ')}`)
    }
    const files = { ...copy.files }
    for (const { path: name, kind } of chosen) {
      const [from, to] = [join(copy.path, name), join(folder, name)]
      if (!within(to, folder) || !within(from, copy.path)) throw new Error(`${name} isn't inside the folder`)
      if (kind === 'deleted') {
        await rm(to, { force: true })
        delete files[name]
      } else {
        await mkdir(dirname(to), { recursive: true })
        await copyFile(from, to)
        files[name] = sha256(await readFile(from))
      }
    }
    // What was copied back now counts as the copy's starting point, so it stops showing as changed.
    write(space, { ...read(space), [folder]: { ...copy, files } })
    return chosen.length
  }

  return { copyOf, savedCopy, changesOf, copyBack }
}
