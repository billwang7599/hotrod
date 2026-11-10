// Git checkouts of a space's folders in its work folder (design rule 10: worktrees are made in code), what a sandboxed
// chat may write to use them, and cleaning them up. The core passes in the machine and how to save a space's
// worktrees; nothing here keeps chats.
import { existsSync, rmSync } from 'node:fs'
import { basename, join, sep } from 'node:path'
import { realPath } from './machine.ts'
import type { ChatInfo, Machine, Worktree } from './shared.ts'

const GIT_TIMEOUT_MS = 120_000
const BRANCH_SLUG_MAX_CHARS = 40
// Enough of a repo's .git to commit, fetch and rebase in a worktree; hooks and config stay read-only.
const GIT_WRITABLE = ['objects', 'refs', 'logs', 'worktrees', 'packed-refs*', 'FETCH_HEAD']
// Moving a branch checked out in another worktree would show there as staged changes.
const PROTECT_CHECKED_OUT_BRANCHES = true

export type Checkout = { folder: string; worktree: Worktree; writable: string[]; readOnly: string[] }
export type GitAccess = { writable: string[]; readOnly: string[] }

/** What the checkouts need of a space: its saved info. */
type Space = { info: ChatInfo }

export function openCheckouts<S extends Space>(deps: {
  machine: Pick<Machine, 'run'>
  /** Saves a space's worktrees in its chat.json. */
  saveWorktrees: (space: S, worktrees: Record<string, Worktree>) => void
  /** Whether every chat of the space is idle, so its checkouts may be cleaned up. */
  isIdle: (space: S) => boolean
}) {
  const { machine, saveWorktrees, isIdle } = deps

  const git = async (folder: string, ...args: string[]) => {
    const options = { cwd: folder, timeoutMs: GIT_TIMEOUT_MS }
    const { code, stdout, stderr } = await machine.run('git', ['-C', folder, ...args], options)
    if (code !== 0) throw new Error(stderr.trim() || `git ${args[0]} exited with code ${code}`)
    return stdout.trim()
  }

  const makeWorktree = async (space: S, folder: string, workDir: string): Promise<Worktree> => {
    const saved = space.info.worktrees?.[folder]
    const branches = (await git(folder, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/')).split('\n')
    let worktree: Worktree
    if (saved && branches.includes(saved.branch)) {
      await git(folder, 'worktree', 'prune')
      await git(folder, 'worktree', 'add', saved.path, saved.branch)
      worktree = saved
    } else {
      const slug = space.info.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, BRANCH_SLUG_MAX_CHARS)
      const branch = freeName(`kothar/${slug.replace(/^-|-$/g, '') || 'space'}`, (b) => branches.includes(b))
      const taken = Object.values(space.info.worktrees ?? {}).map((w) => w.path)
      const path = freeName(join(workDir, basename(folder)), (p) => taken.includes(p) || existsSync(p))
      const from = await git(folder, 'rev-parse', '--abbrev-ref', 'HEAD').catch(() => '')
      await git(folder, 'worktree', 'add', '--no-track', '-b', branch, path, 'HEAD')
      worktree = { path, branch, ...(from && from !== 'HEAD' && { from }) }
    }
    saveWorktrees(space, { ...space.info.worktrees, [folder]: worktree })
    return worktree
  }

  const making = new Map<string, Promise<Worktree>>()
  const worktreeOf = (space: S, folder: string, workDir: string) => {
    const saved = space.info.worktrees?.[folder]
    if (saved && existsSync(saved.path)) return saved
    const key = `${space.info.id}\n${folder}`
    const made = making.get(key) ?? makeWorktree(space, folder, workDir).finally(() => making.delete(key))
    making.set(key, made)
    return made
  }

  // What a sandboxed chat may write in a git folder's repository to use its checkout, and the branches checked out
  // elsewhere that it may not move.
  const gitAccess = async (folder: string, workDir: string): Promise<GitAccess> => {
    const gitDir = await git(folder, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    const listed = PROTECT_CHECKED_OUT_BRANCHES ? await git(folder, 'worktree', 'list', '--porcelain') : ''
    const readOnly = listed.split('\n\n').flatMap((entry) => {
      const path = entry.match(/^worktree (.+)$/m)?.[1]
      const ref = entry.match(/^branch (.+)$/m)?.[1]
      return path && ref && !within(path, workDir) ? [join(gitDir, ref), `${join(gitDir, ref)}.lock`] : []
    })
    return { writable: GIT_WRITABLE.map((path) => join(gitDir, path)), readOnly }
  }

  const checkoutOf = async (space: S, folder: string, workDir: string, sandboxed: boolean): Promise<Checkout> => {
    try {
      const worktree = await worktreeOf(space, folder, workDir)
      if (!sandboxed) return { folder, worktree, writable: [], readOnly: [] }
      return { folder, worktree, ...(await gitAccess(folder, workDir)) }
    } catch (error) {
      throw new Error(`Couldn't check out ${folder} in the work folder: ${messageOf(error)}`)
    }
  }

  const removeWorkDir = async (space: S) => {
    const workDir = ownWorkDirOf(space)
    if (!workDir) return
    for (const [folder, { path }] of Object.entries(space.info.worktrees ?? {})) {
      await git(folder, 'worktree', 'remove', '--force', path).catch(() => {})
    }
    rmSync(workDir, { recursive: true, force: true })
  }

  // Removes worktrees in the space's work folder that aren't its own, once their branch is merged and gone upstream,
  // they have nothing uncommitted, and the space is idle.
  const sweeps = new Map<string, Promise<void>>()
  const sweepMergedWorktrees = (space: S) => {
    const idle = () => isIdle(space)
    const workDir = ownWorkDirOf(space)
    if (!workDir || !idle()) return
    const own = Object.values(space.info.worktrees ?? {}).map((w) => realPath(w.path))
    const sweepRepo = async (folder: string) => {
      await git(folder, 'fetch', '--prune', '--quiet').catch(() => {})
      const listed = await git(folder, 'worktree', 'list', '--porcelain')
      for (const entry of listed.split('\n\n')) {
        const path = entry.match(/^worktree (.+)$/m)?.[1]
        const branch = entry.match(/^branch refs\/heads\/(.+)$/m)?.[1]
        if (!path || !branch || !existsSync(path)) continue
        if (own.includes(realPath(path)) || !within(realPath(path), realPath(workDir))) continue
        try {
          const ref = `refs/heads/${branch}`
          if ((await git(folder, 'for-each-ref', '--format=%(upstream:track)', ref)) !== '[gone]') continue
          if (!(await git(folder, 'for-each-ref', '--contains', ref, '--format=%(refname)', 'refs/remotes/'))) continue
          if (await git(path, 'status', '--porcelain')) continue
          if (!idle()) return
          await git(folder, 'worktree', 'remove', path)
          await git(folder, 'branch', '-D', branch)
        } catch (error) {
          console.error(`Couldn't clean up the worktree ${path}: ${messageOf(error)}`)
        }
      }
    }
    for (const folder of Object.keys(space.info.worktrees ?? {})) {
      const swept = (sweeps.get(folder) ?? Promise.resolve())
        .then(() => sweepRepo(folder))
        .catch((error) => console.error(`Couldn't clean up the worktrees of ${folder}: ${messageOf(error)}`))
        .finally(() => sweeps.get(folder) === swept && sweeps.delete(folder))
      sweeps.set(folder, swept)
    }
  }

  return { checkoutOf, gitAccess, removeWorkDir, sweepMergedWorktrees }
}

/** Only a folder Kothar made for this space, whatever chat.json says. */
export const ownWorkDirOf = ({ info }: Space) =>
  info.workDir && basename(info.workDir) === info.id ? info.workDir : undefined

/** `base`, or `base-2`, `base-3`… if it's taken. */
export const freeName = (base: string, taken: (name: string) => boolean) => {
  let name = base
  for (let n = 2; taken(name); n++) name = `${base}-${n}`
  return name
}

const within = (inner: string, outer: string) => inner === outer || inner.startsWith(outer.replace(/\/?$/, sep))
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
