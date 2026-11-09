import type { Checkout, ModHost } from '@kothar/mod-api'

// Removing a space's checkout once its work is merged. The checkout's folder is the user's own checkout and is never
// touched; a checkout with any uncommitted or untracked file stays. The core makes a fresh checkout at the space's
// next message.

type Run = ModHost['run']
const GIT_TIMEOUT_MS = 30_000
const FETCH_TIMEOUT_MS = 60_000
const GH_TIMEOUT_MS = 15_000

export type Cleanup = { removed: true; branch: string; reason: string } | { removed: false; why: string }

async function git(run: Run, cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS) {
  const result = await run('git', ['-C', cwd, ...args], { cwd, timeoutMs })
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`)
  return result.stdout.trim()
}

const tryGit = (run: Run, cwd: string, args: string[], timeoutMs?: number) =>
  git(run, cwd, args, timeoutMs).then(
    (out) => out,
    () => undefined,
  )

const isAncestor = async (run: Run, cwd: string, commit: string, of: string) =>
  (await run('git', ['-C', cwd, 'merge-base', '--is-ancestor', commit, of], { cwd, timeoutMs: GIT_TIMEOUT_MS }))
    .code === 0

const within = (inner: string, outer: string) => inner.startsWith(outer.replace(/\/?$/, '/'))

async function mergedPr(run: Run, cwd: string, branch: string) {
  try {
    const result = await run('gh', ['pr', 'view', branch, '--json', 'number,state'], { cwd, timeoutMs: GH_TIMEOUT_MS })
    if (result.code !== 0) return undefined
    const pr = JSON.parse(result.stdout)
    return pr?.state === 'MERGED' && typeof pr.number === 'number' ? (pr.number as number) : undefined
  } catch {
    return undefined
  }
}

// Why the branch counts as merged, or undefined. gh's word on its pull request comes first, since a squash merge
// leaves the branch's commits off the default branch. Without one, git alone: the branch was pushed, its upstream
// has gone (deleted on merge) and its tip is on the remote's default branch. A branch never pushed doesn't count, so
// a fresh checkout that is still level with its base isn't taken for merged.
export async function mergedReason(run: Run, cwd: string, branch: string) {
  const pr = await mergedPr(run, cwd, branch)
  if (pr !== undefined) return `its pull request #${pr} was merged`
  await tryGit(run, cwd, ['fetch', '--prune', '--quiet'], FETCH_TIMEOUT_MS)
  const track = await tryGit(run, cwd, ['for-each-ref', '--format=%(upstream:track)', `refs/heads/${branch}`])
  if (track !== '[gone]') return undefined
  const base = await tryGit(run, cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (!base || !(await isAncestor(run, cwd, branch, base))) return undefined
  return `it was merged into ${base}`
}

// stillIdle: asked again right before removing, since a message may have started the space meanwhile.
export async function cleanupCheckout(
  run: Run,
  checkout: Checkout,
  workDir: string | undefined,
  stillIdle: () => boolean = () => true,
): Promise<Cleanup> {
  const { folder, path } = checkout
  if (path === folder || !workDir || !within(path, workDir)) {
    return { removed: false, why: 'not a checkout of the space' }
  }
  // What the agent has checked out now, which may be a branch of its own rather than the one Kothar made.
  const branch = await tryGit(run, path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (!branch) return { removed: false, why: 'no branch checked out' }
  const status = await tryGit(run, path, ['status', '--porcelain'])
  if (status === undefined) return { removed: false, why: 'git status failed' }
  if (status) return { removed: false, why: 'uncommitted changes' }
  const reason = await mergedReason(run, path, branch)
  if (!reason) return { removed: false, why: 'not merged' }
  // The branch Kothar made goes too when it holds nothing the merged branch doesn't.
  const made = checkout.branch !== branch && (await isAncestor(run, path, checkout.branch, branch))
  if (!stillIdle()) return { removed: false, why: 'in use by a running chat' }
  // Without --force, git itself refuses a worktree that changed since the status above.
  await git(run, folder, ['worktree', 'remove', path])
  await git(run, folder, ['branch', '-D', branch])
  if (made) await tryGit(run, folder, ['branch', '-D', checkout.branch])
  return { removed: true, branch, reason }
}
