// Git checkouts of a space's folders in its work folder (design rule 10: worktrees are made in code), what a sandboxed
// chat may write to use them, and removing them with a deleted space. Removing merged work while the space lives is
// the Git extension's (extensions/git/cleanup.ts). The core passes in the machine and how to save a space's
// worktrees; nothing here keeps chats.
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { ChatInfo, Machine, Worktree } from './shared.ts'
import { within, messageOf } from './util.ts'

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
}) {
  const { machine, saveWorktrees } = deps

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

  return { checkoutOf, gitAccess, removeWorkDir }
}

/**
 * Whether the folder is a git repo with no commits yet (a fresh `git init`: HEAD names a branch that doesn't exist).
 * There's nothing to check out, and a worktree off it would be empty and hide the user's files, so such a folder is
 * used as a plain folder, with its mode, until its first commit. Read from the files, not git: the context items ask
 * on every draw, and the Machine is this computer for now (as the `.git` check beside it assumes). Anything it can't
 * read, such as a reftable repo or a broken `.git`, counts as having commits, so git itself says what's wrong.
 */
export const hasNoCommits = (folder: string) => {
  try {
    const dotGit = join(folder, '.git')
    const gitDir = statSync(dotGit).isDirectory()
      ? dotGit
      : resolve(folder, readFileSync(dotGit, 'utf8').match(/^gitdir: (.+)$/m)?.[1]?.trim() ?? '')
    const commonFile = join(gitDir, 'commondir')
    const common = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, 'utf8').trim()) : gitDir
    const ref = readFileSync(join(gitDir, 'HEAD'), 'utf8').match(/^ref: (refs\/heads\/\S+)\s*$/)?.[1]
    // Detached (a commit), unreadable, or reftable's placeholder: let git decide.
    if (!ref || ref === 'refs/heads/.invalid' || existsSync(join(common, 'reftable'))) return false
    if (existsSync(join(common, ref))) return false
    const packed = join(common, 'packed-refs')
    return !(existsSync(packed) && readFileSync(packed, 'utf8').split('\n').some((line) => line.endsWith(` ${ref}`)))
  } catch {
    return false
  }
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

