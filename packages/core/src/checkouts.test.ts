import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { freeName, openCheckouts, ownWorkDirOf } from './checkouts.ts'
import { localMachine } from './machine.ts'
import type { ChatInfo, Worktree } from './shared.ts'

const temps: string[] = []
afterEach(() => temps.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
const tempDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-checkouts-')))
  temps.push(dir)
  return dir
}

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    encoding: 'utf8',
  }).trim()
const gitRepo = (dir: string) => {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), 'committed\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'first')
  return dir
}

type Space = { info: ChatInfo }
const spaceAt = (workDir: string, name = 'My Space'): Space => ({
  info: { id: 'abc123', name, folders: [], files: [], workDir } as unknown as ChatInfo,
})

// The checkouts with saving kept in plain test state, no core.
const checkoutsFor = () => {
  const saved: Record<string, Worktree>[] = []
  const checkouts = openCheckouts<Space>({
    machine: localMachine,
    saveWorktrees: (space, worktrees) => {
      space.info.worktrees = worktrees
      saved.push(worktrees)
    },
  })
  return { ...checkouts, saved }
}

describe('checkoutOf', () => {
  it('checks a folder out on a new kothar/ branch in the work folder and saves it', async () => {
    const root = tempDir()
    const repo = gitRepo(join(root, 'repo'))
    const workDir = join(root, 'work', 'abc123')
    mkdirSync(workDir, { recursive: true })
    const space = spaceAt(workDir)
    const { checkoutOf, saved } = checkoutsFor()

    const checkout = await checkoutOf(space, repo, workDir, false)

    expect(checkout).toEqual({
      folder: repo,
      worktree: { path: join(workDir, 'repo'), branch: 'kothar/my-space', from: 'main' },
      writable: [],
      readOnly: [],
    })
    expect(existsSync(join(workDir, 'repo', 'README.md'))).toBe(true)
    expect(saved).toEqual([{ [repo]: checkout.worktree }])
  })

  it('makes one worktree for calls at the same time, and reuses the saved one after', async () => {
    const root = tempDir()
    const repo = gitRepo(join(root, 'repo'))
    const workDir = join(root, 'work', 'abc123')
    mkdirSync(workDir, { recursive: true })
    const space = spaceAt(workDir)
    const { checkoutOf, saved } = checkoutsFor()

    const [a, b] = await Promise.all([checkoutOf(space, repo, workDir, false), checkoutOf(space, repo, workDir, false)])
    const c = await checkoutOf(space, repo, workDir, false)

    expect(b.worktree).toEqual(a.worktree)
    expect(c.worktree).toEqual(a.worktree)
    expect(saved).toHaveLength(1)
  })

  it('picks a free branch name when the space name is taken', async () => {
    const root = tempDir()
    const repo = gitRepo(join(root, 'repo'))
    git(repo, 'branch', 'kothar/my-space')
    const workDir = join(root, 'work', 'abc123')
    mkdirSync(workDir, { recursive: true })

    const { worktree } = await checkoutsFor().checkoutOf(spaceAt(workDir), repo, workDir, false)

    expect(worktree.branch).toBe('kothar/my-space-2')
  })

  it('gives a sandboxed chat the repo parts it may write, and keeps branches checked out elsewhere read-only', async () => {
    const root = tempDir()
    const repo = gitRepo(join(root, 'repo'))
    const workDir = join(root, 'work', 'abc123')
    mkdirSync(workDir, { recursive: true })

    const checkout = await checkoutsFor().checkoutOf(spaceAt(workDir), repo, workDir, true)

    const gitDir = join(repo, '.git')
    expect(checkout.writable).toEqual(
      ['objects', 'refs', 'logs', 'worktrees', 'packed-refs*', 'FETCH_HEAD'].map((path) => join(gitDir, path)),
    )
    // main is checked out in the repo itself, outside the work folder; the space's own branch isn't listed.
    expect(checkout.readOnly).toEqual([join(gitDir, 'refs/heads/main'), join(gitDir, 'refs/heads/main.lock')])
  })

  it('says which folder it couldn’t check out', async () => {
    const root = tempDir()
    const notRepo = join(root, 'plain')
    mkdirSync(notRepo)
    const workDir = join(root, 'work', 'abc123')
    mkdirSync(workDir, { recursive: true })

    await expect(checkoutsFor().checkoutOf(spaceAt(workDir), notRepo, workDir, false)).rejects.toThrow(
      `Couldn't check out ${notRepo} in the work folder`,
    )
  })
})

describe('removeWorkDir', () => {
  it('removes the space’s worktrees and its own work folder', async () => {
    const root = tempDir()
    const repo = gitRepo(join(root, 'repo'))
    const workDir = join(root, 'work', 'abc123')
    mkdirSync(workDir, { recursive: true })
    const space = spaceAt(workDir)
    const { checkoutOf, removeWorkDir } = checkoutsFor()
    await checkoutOf(space, repo, workDir, false)

    await removeWorkDir(space)

    expect(existsSync(workDir)).toBe(false)
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(workDir)
  })

  it('leaves a work folder Kothar didn’t make for the space', async () => {
    const root = tempDir()
    const workDir = join(root, 'someone-elses')
    mkdirSync(workDir)

    await checkoutsFor().removeWorkDir(spaceAt(workDir))

    expect(existsSync(workDir)).toBe(true)
  })
})

describe('helpers', () => {
  it('ownWorkDirOf is only a folder named after the space', () => {
    expect(ownWorkDirOf(spaceAt('/work/abc123'))).toBe('/work/abc123')
    expect(ownWorkDirOf(spaceAt('/Users/me/project'))).toBeUndefined()
  })

  it('freeName counts up from 2', () => {
    const taken = new Set(['a', 'a-2'])
    expect(freeName('b', (n) => taken.has(n))).toBe('b')
    expect(freeName('a', (n) => taken.has(n))).toBe('a-3')
  })
})
