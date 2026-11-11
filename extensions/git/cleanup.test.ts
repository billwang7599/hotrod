import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Checkout, ExtensionHost } from '@kothar/extension-api'
import { createFakeAdapter, type FakeStep } from '@kothar/core/fake'
import { startCore } from '@kothar/core/main'
import type { Machine, SessionOptions } from '@kothar/core/shared'
import { sandboxingMachine } from '@kothar/core/test-machine'
import { cleanupCheckout, cleanupStrayWorktrees } from './cleanup.ts'
import { createGitExtension } from './index.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Answer = string | { code: number | null; stdout?: string }

// Plays back scripted git and gh output. Keys are the command without git's `-C <dir>`; a git command with no answer
// fails, except removing a worktree or a branch, which succeed.
function fakeRun(answers: Record<string, Answer>) {
  const calls: string[] = []
  const run: ExtensionHost['run'] = async (command, args) => {
    const [dir, rest] = command === 'git' && args[0] === '-C' ? [args[1], args.slice(2)] : ['', args]
    const key = [command, ...rest].join(' ')
    calls.push(dir ? `${dir}: ${key}` : key)
    const removing = key.startsWith('git worktree remove') || key.startsWith('git branch -D')
    const answer = answers[key] ?? (removing ? '' : { code: 1 })
    return typeof answer === 'string'
      ? { code: 0, stdout: answer, stderr: '' }
      : { code: answer.code, stdout: answer.stdout ?? '', stderr: 'failed' }
  }
  return { run, calls, removals: () => calls.filter((c) => /worktree remove|branch -D/.test(c)) }
}

const checkout: Checkout = { folder: '/repo', path: '/work/s1/repo', branch: 'kothar/space', from: 'main' }
const clean = {
  'git symbolic-ref --quiet --short HEAD': 'feat/x',
  'git status --porcelain': '',
  'git merge-base --is-ancestor kothar/space feat/x': '',
}

describe('cleaning up a checkout', () => {
  it('removes it and its branches once gh says the pull request is merged', async () => {
    const fake = fakeRun({ ...clean, 'gh pr view feat/x --json number,state': '{"number":12,"state":"MERGED"}' })
    expect(await cleanupCheckout(fake.run, checkout, '/work/s1')).toEqual({
      removed: true,
      branch: 'feat/x',
      reason: 'its pull request #12 was merged',
    })
    expect(fake.removals()).toEqual([
      '/repo: git worktree remove /work/s1/repo',
      '/repo: git branch -D feat/x',
      '/repo: git branch -D kothar/space',
    ])
  })

  it('keeps the branch Kothar made when it has work the merged branch lacks', async () => {
    const fake = fakeRun({
      ...clean,
      'git merge-base --is-ancestor kothar/space feat/x': { code: 1 },
      'gh pr view feat/x --json number,state': '{"number":12,"state":"MERGED"}',
    })
    await cleanupCheckout(fake.run, checkout, '/work/s1')
    expect(fake.removals()).toEqual(['/repo: git worktree remove /work/s1/repo', '/repo: git branch -D feat/x'])
  })

  it('without gh, removes a pushed branch whose upstream is gone and whose tip is on the default branch', async () => {
    const fake = fakeRun({
      ...clean,
      'gh pr view feat/x --json number,state': { code: null },
      'git fetch --prune --quiet': '',
      'git for-each-ref --format=%(upstream:track) refs/heads/feat/x': '[gone]',
      'git symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main',
      'git merge-base --is-ancestor feat/x origin/main': '',
    })
    expect(await cleanupCheckout(fake.run, checkout, '/work/s1')).toMatchObject({
      removed: true,
      reason: 'it was merged into origin/main',
    })
  })

  it("keeps a branch that was never pushed, even when it's level with the default branch", async () => {
    const fake = fakeRun({
      ...clean,
      'git for-each-ref --format=%(upstream:track) refs/heads/feat/x': '',
      'git symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main',
      'git merge-base --is-ancestor feat/x origin/main': '',
    })
    expect(await cleanupCheckout(fake.run, checkout, '/work/s1')).toEqual({ removed: false, why: 'not merged' })
    expect(fake.removals()).toEqual([])
  })

  it('keeps a checkout with uncommitted or untracked files', async () => {
    const fake = fakeRun({
      ...clean,
      'git status --porcelain': '?? notes.txt',
      'gh pr view feat/x --json number,state': '{"number":12,"state":"MERGED"}',
    })
    const kept = await cleanupCheckout(fake.run, checkout, '/work/s1')
    expect(kept).toEqual({ removed: false, why: 'uncommitted changes' })
    expect(fake.removals()).toEqual([])
  })

  it("never touches the user's own checkout, or a path outside the space's work folder", async () => {
    const fake = fakeRun({ ...clean, 'gh pr view feat/x --json number,state': '{"number":12,"state":"MERGED"}' })
    const own = { ...checkout, path: '/repo' }
    expect(await cleanupCheckout(fake.run, own, '/work/s1')).toMatchObject({ removed: false })
    expect(await cleanupCheckout(fake.run, checkout, '/work/s2')).toMatchObject({ removed: false })
    expect(await cleanupCheckout(fake.run, checkout, undefined)).toMatchObject({ removed: false })
    expect(fake.calls).toEqual([])
  })

  it('keeps it when a chat starts running before the removal', async () => {
    const fake = fakeRun({ ...clean, 'gh pr view feat/x --json number,state': '{"number":12,"state":"MERGED"}' })
    expect(await cleanupCheckout(fake.run, checkout, '/work/s1', () => false)).toEqual({
      removed: false,
      why: 'in use by a running chat',
    })
    expect(fake.removals()).toEqual([])
  })

  it('keeps a checkout git refuses to remove, such as one whose own folder is gone, and deletes no branch', async () => {
    const merged = { 'gh pr view feat/x --json number,state': '{"number":12,"state":"MERGED"}' }
    const fake = fakeRun({ ...clean, ...merged, 'git worktree remove /work/s1/repo': { code: 128 } })
    expect(await cleanupCheckout(fake.run, checkout, '/work/s1')).toEqual({ removed: false, why: 'git kept it: failed' })
    expect(fake.removals()).toEqual(['/repo: git worktree remove /work/s1/repo'])
  })

  it('says so when the checkout went but git kept its branch', async () => {
    const merged = { 'gh pr view feat/x --json number,state': '{"number":12,"state":"MERGED"}' }
    const fake = fakeRun({ ...clean, ...merged, 'git branch -D feat/x': { code: 1 } })
    expect(await cleanupCheckout(fake.run, checkout, '/work/s1')).toEqual({
      removed: true,
      branch: 'feat/x',
      reason: 'its pull request #12 was merged',
      branchKept: true,
    })
  })

  it('keeps a detached checkout, and one where git status fails', async () => {
    const detached = fakeRun({ ...clean, 'git symbolic-ref --quiet --short HEAD': { code: 1 } })
    expect(await cleanupCheckout(detached.run, checkout, '/work/s1')).toMatchObject({ removed: false })
    const broken = fakeRun({ ...clean, 'git status --porcelain': { code: 128 } })
    expect(await cleanupCheckout(broken.run, checkout, '/work/s1')).toMatchObject({ removed: false })
    expect([...detached.removals(), ...broken.removals()]).toEqual([])
  })
})

function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-git-cleanup-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function until(check: () => boolean) {
  for (let i = 0; i < 1000 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
  if (!check()) throw new Error('timed out')
}

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })

describe('after a turn, with real git', () => {
  // A repo with an origin; the agent's first turn makes feat/x in its checkout, commits and pushes it.
  async function merged(cleanup: boolean) {
    const origin = tempDir()
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
    const repo = tempDir()
    execFileSync('git', ['clone', '-q', origin, repo])
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    sh(repo, 'add', '.')
    sh(repo, 'commit', '-q', '-m', 'first')
    sh(repo, 'push', '-q', '-u', 'origin', 'main')
    sh(repo, 'remote', 'set-head', 'origin', 'main')
    let turn = 0
    const script = (options: SessionOptions): FakeStep[] => {
      if (turn++ === 0) {
        sh(options.cwd, 'switch', '-q', '-c', 'feat/x')
        writeFileSync(join(options.cwd, 'b.txt'), 'b\n')
        sh(options.cwd, 'add', '.')
        sh(options.cwd, 'commit', '-q', '-m', 'feature')
        sh(options.cwd, 'push', '-q', '-u', 'origin', 'feat/x')
        // A worktree of the agent's own beside the checkout, pushed too.
        const stray = join(dirname(options.cwd), 'stray')
        sh(options.cwd, 'worktree', 'add', '-q', '-b', 'stray', stray, 'main')
        writeFileSync(join(stray, 'c.txt'), 'c\n')
        sh(stray, 'add', '.')
        sh(stray, 'commit', '-q', '-m', 'stray')
        sh(stray, 'push', '-q', '-u', 'origin', 'stray')
      }
      return [{ type: 'text.completed', text: 'Done' }]
    }
    const garage = tempDir()
    // No gh here, so the merge is found through git alone.
    const machine: Machine = {
      ...sandboxingMachine,
      run: (command, args, options) =>
        command === 'gh'
          ? Promise.resolve({ code: null, stdout: '', stderr: 'spawn gh ENOENT' })
          : sandboxingMachine.run(command, args, options),
    }
    const env = { KOTHAR_ENGINE: 'fake', KOTHAR_GARAGE: garage, KOTHAR_WORK: join(garage, 'work'), KOTHAR_PORT: '0' }
    const kothar = await startCore({ env, adapters: [createFakeAdapter(script, 0)], extensions: [createGitExtension()], machine })
    cleanups.push(() => kothar.close(true))
    const { core } = kothar
    const handle = (m: Parameters<typeof core.handle>[0]) => core.handle(m, () => {})
    handle({ type: 'extension.setEnabled', extensionId: 'git', enabled: true })
    if (!cleanup) handle({ type: 'extension.setValue', extensionId: 'git', key: 'cleanup', value: false })
    handle({ type: 'chat.create', name: 'Space', folders: [repo] })
    const id = core.chats()[0]!.id
    const chat = () => core.chats().find((c) => c.id === id)!
    const send = async () => {
      const turns = chat().entries.filter((e) => e.type === 'turn.completed').length
      handle({ type: 'chat.send', chatId: id, text: 'Go' })
      const ended = () => chat().entries.filter((e) => e.type === 'turn.completed').length
      await until(() => chat().status === 'idle' && ended() > turns)
    }
    await send()
    const path = chat().worktrees![repo]!.path
    // Merged on GitHub, which deletes the branch.
    const elsewhere = tempDir()
    execFileSync('git', ['clone', '-q', origin, elsewhere])
    sh(elsewhere, 'merge', '-q', '--no-ff', '-m', 'Merge feat/x', 'origin/feat/x')
    sh(elsewhere, 'merge', '-q', '--no-ff', '-m', 'Merge stray', 'origin/stray')
    sh(elsewhere, 'push', '-q', 'origin', 'main', ':feat/x', ':stray')
    const stray = join(dirname(path), 'stray')
    await send()
    const notes = () => chat().entries.flatMap((e) => (e.type === 'extension.note' ? [e.text] : []))
    return { repo, path, stray, chat, notes, send }
  }

  it('removes the merged checkout and its branch, notes it, and the next message makes a new checkout', async () => {
    const t = await merged(true)
    await until(() => t.notes().some((n) => n.startsWith('Removed')))
    expect(t.notes()).toContain('Removed the checkout of feat/x: it was merged into origin/main')
    expect(existsSync(t.path)).toBe(false)
    expect(sh(t.repo, 'branch', '--list', 'feat/x')).toBe('')
    // The user's own checkout is as it was.
    expect(sh(t.repo, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main')
    // The agent's own merged worktree goes too.
    await until(() => !existsSync(t.stray) && sh(t.repo, 'branch', '--list', 'stray') === '')
    await t.send()
    expect(existsSync(t.chat().worktrees![t.repo]!.path)).toBe(true)
  })

  it('leaves everything when the setting is off', async () => {
    const t = await merged(false)
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(t.path)).toBe(true)
    expect(existsSync(t.stray)).toBe(true)
    expect(t.notes().some((n) => n.startsWith('Removed'))).toBe(false)
  })
})

describe("cleaning up an agent's other worktrees, with real git", () => {
  const repoWithOrigin = () => {
    const origin = tempDir()
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
    const repo = tempDir()
    sh(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    sh(repo, 'add', '.')
    sh(repo, 'commit', '-q', '-m', 'first')
    sh(repo, 'remote', 'add', 'origin', origin)
    sh(repo, 'push', '-q', '-u', 'origin', 'main')
    return { origin, repo }
  }
  // A worktree on a new branch with one commit; pushed, merged into main and deleted on the remote unless told not.
  const branchIn = (
    { origin, repo }: { origin: string; repo: string },
    path: string,
    branch: string,
    { push = true, merge = true, gone = true } = {},
  ) => {
    if (!existsSync(path)) sh(repo, 'worktree', 'add', '-q', '-b', branch, path, 'main')
    writeFileSync(join(path, `${branch.replace('/', '-')}.txt`), 'work\n')
    sh(path, 'add', '-A')
    sh(path, 'commit', '-q', '-m', branch)
    if (push) sh(path, 'push', '-q', '-u', 'origin', branch)
    if (merge) {
      sh(repo, 'merge', '-q', '--no-ff', '-m', `Merge ${branch}`, branch)
      sh(repo, 'push', '-q', 'origin', 'main')
    }
    if (push && gone) execFileSync('git', ['-C', origin, 'update-ref', '-d', `refs/heads/${branch}`])
    return path
  }
  const run: ExtensionHost['run'] = async (command, args, options) => {
    try {
      const stdout = execFileSync(command, args, { cwd: options?.cwd, encoding: 'utf8', stdio: 'pipe' })
      return { code: 0, stdout, stderr: '' }
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string }
      return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
    }
  }
  const spaceOf = (remote: { repo: string }) => {
    const workDir = tempDir()
    const own = branchIn({ ...remote, origin: '' }, join(workDir, 'repo'), 'kothar/app', { push: false, merge: false })
    const checkouts: Checkout[] = [{ folder: remote.repo, path: own, branch: 'kothar/app' }]
    return { workDir, own, space: { workDir, checkouts } }
  }

  it('removes one in the work folder once its branch is merged and gone upstream, and keeps every other', async () => {
    const remote = repoWithOrigin()
    const { repo } = remote
    const { workDir, own, space } = spaceOf(remote)
    const merged = branchIn(remote, join(workDir, 'merged'), 'merged')
    const dirty = branchIn(remote, join(workDir, 'dirty'), 'dirty')
    writeFileSync(join(dirty, 'notes.txt'), 'not committed\n')
    const unmerged = branchIn(remote, join(workDir, 'unmerged'), 'unmerged', { merge: false })
    const local = branchIn(remote, join(workDir, 'local'), 'local', { push: false })
    const outside = branchIn(remote, join(tempDir(), 'outside'), 'outside')

    expect(await cleanupStrayWorktrees(run, space)).toEqual([merged])
    expect(existsSync(merged)).toBe(false)
    expect(sh(repo, 'worktree', 'list', '--porcelain')).not.toContain(merged)
    expect(sh(repo, 'branch', '--format=%(refname:short)').trim().split('\n')).toEqual([
      'dirty',
      'kothar/app',
      'local',
      'main',
      'outside',
      'unmerged',
    ])
    for (const kept of [own, dirty, unmerged, local, outside]) expect(existsSync(kept), kept).toBe(true)
    expect(sh(repo, 'branch', '-r')).not.toContain('origin/merged')
  })

  it('keeps it when a chat in the space starts running before the removal, and does nothing while one runs', async () => {
    const remote = repoWithOrigin()
    const { workDir, space } = spaceOf(remote)
    const merged = branchIn(remote, join(workDir, 'merged'), 'merged')

    expect(await cleanupStrayWorktrees(run, space, () => false)).toEqual([])
    let checks = 0
    // Idle when asked first; running by the time it would remove the worktree.
    expect(await cleanupStrayWorktrees(run, space, () => checks++ === 0)).toEqual([])
    expect(checks).toBe(2)
    expect(existsSync(merged)).toBe(true)
  })

  it('does nothing for a space without a work folder', async () => {
    const remote = repoWithOrigin()
    const { space } = spaceOf(remote)
    expect(await cleanupStrayWorktrees(run, { ...space, workDir: undefined })).toEqual([])
  })
})
