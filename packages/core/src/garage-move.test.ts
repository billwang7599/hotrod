import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createFakeAdapter } from './adapters/fake.ts'
import { LOCK_FILE } from './garage-lock.ts'
import { moveGarage, movedPaths, portInUse } from './garage-move.ts'
import { localMachine } from './machine.ts'
import { defaultGarage } from './main.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

// A pretend home folder, never the real one.
function home() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-home-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const support = join(dir, 'Library', 'Application Support')
  mkdirSync(support, { recursive: true })
  return { dir, old: join(support, 'Hotrod'), garage: join(support, 'Kothar') }
}

function oldGarage(old: string) {
  mkdirSync(join(old, 'chats', 'c1'), { recursive: true })
  writeFileSync(join(old, 'settings.json'), JSON.stringify({ engines: {}, workFolder: join(old, 'work') }))
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const quiet = { log: () => {} }

it('a fresh install gets the Kothar garage', async () => {
  const { dir, garage } = home()
  expect(await defaultGarage({ home: dir, ...quiet })).toBe(garage)
  expect(existsSync(garage)).toBe(false)
})

it('moves a garage from when Kothar was Hotrod into Kothar, once', async () => {
  const { dir, old, garage } = home()
  oldGarage(old)
  expect(await defaultGarage({ home: dir, ...quiet })).toBe(garage)
  expect(existsSync(old)).toBe(false)
  expect(existsSync(join(garage, 'chats', 'c1'))).toBe(true)
  expect(JSON.parse(readFileSync(join(garage, 'settings.json'), 'utf8')).workFolder).toBe(join(garage, 'work'))
})

it('leaves the old garage alone when a Kothar one already exists', async () => {
  const { dir, old, garage } = home()
  oldGarage(old)
  mkdirSync(garage)
  expect(await defaultGarage({ home: dir, ...quiet })).toBe(garage)
  expect(existsSync(join(old, 'settings.json'))).toBe(true)
})

it('keeps using the old garage where it is while another core runs on it, or if the move fails', async () => {
  const { old, garage } = home()
  oldGarage(old)
  const logged: string[] = []
  const log = (m: string) => logged.push(m)
  const options = { from: old, to: garage, machine: localMachine, log }
  expect(await moveGarage({ ...options, inUse: async () => true })).toBe(old)
  const rename = () => {
    throw new Error('EXDEV: cross-device link')
  }
  expect(await moveGarage({ ...options, inUse: async () => false, rename })).toBe(old)
  expect(logged.join('\n')).toContain('EXDEV')
  expect(existsSync(garage)).toBe(false)
  expect(existsSync(join(old, 'settings.json'))).toBe(true)
})

it('leaves the old garage where it is while a Kothar holds its lock, on any port', async () => {
  const { old, garage } = home()
  oldGarage(old)
  const other = spawn('sleep', ['30'], { stdio: 'ignore' })
  cleanups.push(() => void other.kill())
  writeFileSync(join(old, LOCK_FILE), JSON.stringify({ pid: other.pid, token: 'theirs' }))
  const options = { from: old, to: garage, machine: localMachine, inUse: async () => false, ...quiet }
  expect(await moveGarage(options)).toBe(old)
  expect(existsSync(garage)).toBe(false)
})

it('a garage set in the environment is used as is, with nothing moved', async () => {
  const { dir, old } = home()
  oldGarage(old)
  const { startCore } = await import('./main.ts')
  const garage = mkdtempSync(join(tmpdir(), 'kothar-test-'))
  cleanups.push(() => rmSync(garage, { recursive: true, force: true }))
  const env = { KOTHAR_GARAGE: garage, KOTHAR_PORT: '4457' }
  const kothar = await startCore({ env, home: dir, mods: [], adapters: [createFakeAdapter()] })
  cleanups.push(() => kothar.close(true))
  expect(kothar.garage).toBe(garage)
  expect(existsSync(join(old, 'settings.json'))).toBe(true)
})

it('rewrites stored paths into the old garage, and only those', () => {
  const old = '/Users/u/Library/Application Support/Hotrod'
  const garage = '/Users/u/Library/Application Support/Kothar'
  const chat = {
    workDir: `${old}/work/c1`,
    worktrees: { [`${old}/projects/app`]: { path: `${old}/work/c1/app`, branch: 'kothar/x' } },
    folders: ['/Users/u/code/site', `${old}-other/x`],
    files: [`${old}/chats/c1/attachments/a.png`],
  }
  expect(movedPaths(chat, old, garage)).toEqual({
    workDir: `${garage}/work/c1`,
    worktrees: { [`${garage}/projects/app`]: { path: `${garage}/work/c1/app`, branch: 'kothar/x' } },
    folders: ['/Users/u/code/site', `${old}-other/x`],
    files: [`${garage}/chats/c1/attachments/a.png`],
  })
})

it('after the move, stored paths, links and git checkouts all point at the new garage', async () => {
  const { dir, old, garage } = home()
  oldGarage(old)
  // A repo outside the garage, with a space's checkout inside the old work folder.
  const repo = join(dir, 'code', 'app')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first')
  const checkout = join(old, 'work', 'c1', 'app')
  mkdirSync(join(old, 'work', 'c1'), { recursive: true })
  git(repo, 'worktree', 'add', '-q', '-b', 'kothar/c1', checkout)
  // A repo inside the garage too, whose checkout's .git file names the old path.
  const inside = join(old, 'projects', 'lib')
  mkdirSync(inside, { recursive: true })
  git(inside, 'init', '-q', '-b', 'main')
  git(inside, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first')
  const insideCheckout = join(old, 'work', 'c1', 'lib')
  git(inside, 'worktree', 'add', '-q', '-b', 'kothar/c1', insideCheckout)
  const chat = {
    id: 'c1',
    workDir: join(old, 'work', 'c1'),
    worktrees: {
      [repo]: { path: checkout, branch: 'kothar/c1' },
      [inside]: { path: insideCheckout, branch: 'kothar/c1' },
      [join(dir, 'gone')]: { path: join(old, 'work', 'c1', 'gone'), branch: 'kothar/c1' },
    },
    files: [join(old, 'chats', 'c1', 'attachments', 'a.png')],
  }
  writeFileSync(join(old, 'chats', 'c1', 'chat.json'), JSON.stringify(chat))
  writeFileSync(join(old, 'chats', 'c1', 'log.jsonl'), JSON.stringify({ text: `${old}/x` }) + '\n')
  mkdirSync(join(old, 'accounts'))
  writeFileSync(join(old, 'accounts', 'pi.json'), JSON.stringify({ dir: join(old, 'accounts', 'pi', 'a') }))
  mkdirSync(join(old, 'accounts', 'pi', 'a'), { recursive: true })
  symlinkSync(join(old, 'accounts', 'pi', 'a'), join(old, 'accounts', 'login'))

  expect(await defaultGarage({ home: dir, ...quiet })).toBe(garage)

  const moved = JSON.parse(readFileSync(join(garage, 'chats', 'c1', 'chat.json'), 'utf8'))
  expect(moved.workDir).toBe(join(garage, 'work', 'c1'))
  expect(moved.worktrees[repo].path).toBe(join(garage, 'work', 'c1', 'app'))
  expect(moved.worktrees[join(garage, 'projects', 'lib')].path).toBe(join(garage, 'work', 'c1', 'lib'))
  expect(moved.files).toEqual([join(garage, 'chats', 'c1', 'attachments', 'a.png')])
  expect(readFileSync(join(garage, 'chats', 'c1', 'log.jsonl'), 'utf8')).toContain(`${old}/x`)
  const account = JSON.parse(readFileSync(join(garage, 'accounts', 'pi.json'), 'utf8'))
  expect(account.dir).toBe(join(garage, 'accounts', 'pi', 'a'))
  expect(readlinkSync(join(garage, 'accounts', 'login'))).toBe(join(garage, 'accounts', 'pi', 'a'))

  expect(git(repo, 'worktree', 'list')).toContain(join(garage, 'work', 'c1', 'app'))
  expect(git(repo, 'worktree', 'list')).not.toContain(old)
  expect(git(join(garage, 'work', 'c1', 'app'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('kothar/c1')
  const insideRepo = join(garage, 'projects', 'lib')
  expect(git(insideRepo, 'worktree', 'list')).toContain(join(garage, 'work', 'c1', 'lib'))
  expect(git(join(garage, 'work', 'c1', 'lib'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('kothar/c1')
})

it('a core answering on the port counts as in use', async () => {
  const server = createServer().listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const { port } = server.address() as { port: number }
  expect(await portInUse(port)).toBe(true)
  server.close()
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(await portInUse(port)).toBe(false)
})
