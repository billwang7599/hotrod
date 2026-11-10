import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatDetail, ExtensionContext, ExtensionView } from '@kothar/extension-api'
import { createFakeAdapter, type FakeStep } from '@kothar/core/fake'
import { startCore } from '@kothar/core/main'
import type { ClientMessage, CoreMessage, Machine, SessionOptions } from '@kothar/core/shared'
import { sandboxingMachine } from '@kothar/core/test-machine'
import {
  checksOf,
  createGitExtension,
  FILES_MAX,
  LIVE_REFRESH_MS,
  noteText,
  parseNumstat,
  PR_TTL_MS,
  repoState,
  repoView,
  type RepoState,
} from './index.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-git-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function until(check: () => boolean) {
  for (let i = 0; i < 600 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
  if (!check()) throw new Error('timed out')
}

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })

function repo() {
  const dir = tempDir()
  sh(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
  writeFileSync(join(dir, 'b.txt'), 'bee\n')
  sh(dir, 'add', '.')
  sh(dir, 'commit', '-q', '-m', 'first')
  return dir
}

type Gh = (args: string[]) => { code: number | null; stdout: string; stderr: string }
const noGh: Gh = () => ({ code: null, stdout: '', stderr: 'spawn gh ENOENT' })

// A core on the fake engine with the Git extension on. `work` runs at each session's start, in its checkout, as the
// agent.
async function start(work: (cwd: string) => void = () => {}, gh: Gh = noGh, clock = { now: 0 }) {
  const garage = tempDir()
  const ghCalls: string[][] = []
  const gitCalls: string[][] = []
  const machine: Machine = {
    ...sandboxingMachine,
    run: (command, args, options) => {
      if (command === 'git') gitCalls.push(args)
      if (command !== 'gh') return sandboxingMachine.run(command, args, options)
      ghCalls.push(args)
      return Promise.resolve(gh(args))
    },
  }
  const script = (options: SessionOptions): FakeStep[] => {
    work(options.cwd)
    return [{ type: 'text.completed', text: 'Done' }]
  }
  const extension = createGitExtension({ now: () => clock.now })
  const env = { KOTHAR_ENGINE: 'fake', KOTHAR_GARAGE: garage, KOTHAR_WORK: join(garage, 'work'), KOTHAR_PORT: '0' }
  const kothar = await startCore({ env, adapters: [createFakeAdapter(script, 0)], extensions: [extension], machine })
  cleanups.push(() => kothar.close(true))
  const { core } = kothar
  const messages: CoreMessage[] = []
  core.onMessage((m) => messages.push(m))
  const replies: CoreMessage[] = []
  const handle = (m: ClientMessage) => core.handle(m, (r) => replies.push(r))
  handle({ type: 'extension.setEnabled', extensionId: 'git', enabled: true })
  const create = (name: string, folders: string[] = []) => {
    handle({ type: 'chat.create', name, folders })
    return core.chats().findLast((c) => c.name === name)!.id
  }
  const chat = (id: string) => core.chats().find((c) => c.id === id)!
  const send = async (chatId: string) => {
    handle({ type: 'chat.send', chatId, text: 'Go' })
    await until(() => chat(chatId).status === 'idle' && chat(chatId).entries.some((e) => e.type === 'turn.completed'))
  }
  const tabs = (chatId: string) => {
    handle({ type: 'context.get', chatId })
    const listed = replies.findLast((m) => m.type === 'chat.extensions' && m.chatId === chatId)
    return listed?.type === 'chat.extensions' ? listed.panels.map((p) => p.title) : []
  }
  const views = () => messages.filter((m) => m.type === 'extension.panel')
  type Action = Pick<Extract<ClientMessage, { type: 'extension.panel.action' }>, 'action'>
  const panel = async (chatId: string, message?: Action) => {
    const seen = views().length
    if (message) handle({ type: 'extension.panel.action', chatId, extension: 'git', panel: 'changes', ...message })
    else handle({ type: 'extension.panel.get', chatId, extension: 'git', panel: 'changes' })
    await until(() => views().length > seen)
    const shown = views().at(-1)
    if (shown?.type !== 'extension.panel') throw new Error('no view')
    if (shown.error) throw new Error(shown.error)
    return shown.view!
  }
  return { core, garage, handle, create, chat, send, tabs, panel, ghCalls, gitCalls, messages }
}

// Every piece of text in a view, in order, for checking what the tab says.
function textOf(view: ExtensionView): string[] {
  switch (view.type) {
    case 'stack':
    case 'row':
      return view.children.flatMap(textOf)
    case 'card':
      return [view.title, ...(view.badges ?? []).map((b) => b.text), ...view.children.flatMap(textOf)]
    case 'list':
      return view.items.flatMap((i) => [i.label, ...(i.detail ? [i.detail] : [])])
    case 'heading':
    case 'text':
    case 'badge':
    case 'empty':
    case 'code':
      return [view.text]
    case 'link':
      return [view.text]
    case 'button':
      return [view.label]
    default:
      return []
  }
}

describe('the Changes tab', () => {
  it('shows only for spaces with a git folder', async () => {
    const t = await start()
    expect(t.tabs(t.create('Plain', [tempDir()]))).toEqual([])
    expect(t.tabs(t.create('Repo', [repo()]))).toEqual(['Changes'])
    t.handle({ type: 'extension.setEnabled', extensionId: 'git', enabled: false })
    expect(t.tabs(t.create('Off', [repo()]))).toEqual([])
  })

  it('shows the folder itself before the first message checks it out', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    const t = await start()
    const id = t.create('Repo', [dir])
    expect(textOf(await t.panel(id))).toEqual([
      'Refresh',
      basename(dir),
      'main',
      'Not pushed',
      'Uncommitted',
      'a.txt',
      '+0 −1',
    ])
  })

  it("lists a checkout's committed and uncommitted changes, opens a file's diff, and notes the turn", async () => {
    const dir = repo()
    const t = await start((cwd) => {
      writeFileSync(join(cwd, 'b.txt'), 'bee\nsee\n')
      sh(cwd, 'commit', '-q', '-am', 'more')
      writeFileSync(join(cwd, 'a.txt'), 'one\n2\n')
      writeFileSync(join(cwd, 'new.txt'), 'fresh\n')
    })
    const id = t.create('Repo', [dir])
    await t.send(id)
    await until(() => t.chat(id).entries.some((e) => e.type === 'extension.note'))
    const branch = t.chat(id).worktrees![dir]!.branch
    expect(t.chat(id).entries.findLast((e) => e.type === 'extension.note')).toMatchObject({
      text: `3 files changed on ${branch}`,
      extension: 'git',
      panel: 'changes',
    })
    const view = await t.panel(id)
    expect(textOf(view)).toEqual([
      'Refresh',
      basename(dir),
      branch,
      'Not pushed',
      'Uncommitted',
      'a.txt',
      '+1 −1',
      'new.txt',
      'new',
      'Committed since main',
      'b.txt',
      '+1 −0',
    ])
    const open = { name: 'open', value: { path: t.chat(id).worktrees![dir]!.path, group: 'committed', file: 'b.txt' } }
    const opened = await t.panel(id, { action: open })
    const diff = textOf(opened).find((text) => text.startsWith('diff --git'))
    expect(diff).toContain('+see')
    const closed = await t.panel(id, { action: open })
    expect(textOf(closed).some((text) => text.startsWith('diff --git'))).toBe(false)
  })

  it('notes nothing after a turn that changed no files', async () => {
    const t = await start()
    const id = t.create('Repo', [repo()])
    await t.send(id)
    await new Promise((r) => setTimeout(r, 100))
    expect(t.chat(id).entries.some((e) => e.type === 'extension.note')).toBe(false)
  })

  it("shows the branch's pull request and CI when gh has one, and keeps it a while", async () => {
    const clock = { now: 0 }
    const pr = {
      number: 7,
      title: 'Fix it',
      state: 'OPEN',
      url: 'https://github.com/o/r/pull/7',
      statusCheckRollup: [{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }],
    }
    const t = await start(() => {}, () => ({ code: 0, stdout: JSON.stringify(pr), stderr: '' }), clock)
    const id = t.create('Repo', [repo()])
    const view = await t.panel(id)
    expect(textOf(view)).toEqual(expect.arrayContaining(['#7 Fix it', 'open', 'CI running']))
    expect(t.ghCalls).toEqual([['pr', 'view', 'main', '--json', 'number,title,state,url,statusCheckRollup']])
    await t.panel(id)
    expect(t.ghCalls).toHaveLength(1)
    clock.now += PR_TTL_MS
    await t.panel(id)
    expect(t.ghCalls).toHaveLength(2)
    await t.panel(id, { action: { name: 'refresh' } })
    expect(t.ghCalls).toHaveLength(3)
  })

  it('shows no pull request, and no error, without gh', async () => {
    const t = await start()
    const id = t.create('Repo', [repo()])
    const view = await t.panel(id)
    expect(textOf(view)).toEqual(['Refresh', expect.any(String), 'main', 'Not pushed', 'No changes'])
  })
})

describe('the Changes tab, polished', () => {
  it('opens a diff without reading every repo again, and closes a file that left its group', async () => {
    const dir = repo()
    const t = await start()
    const id = t.create('Repo', [dir])
    writeFileSync(join(dir, 'a.txt'), 'one\nTWO\n')
    await t.panel(id)
    const before = t.gitCalls.length
    const open = { name: 'open', value: { path: dir, group: 'uncommitted', file: 'a.txt' } }
    const opened = await t.panel(id, { action: open })
    expect(textOf(opened).find((text) => text.startsWith('diff --git'))).toContain('+TWO')
    // Only the diff itself: the repo's state is the one the tab already shows.
    expect(t.gitCalls.slice(before).map((args) => args.slice(2, 3))).toEqual([['diff']])
    // The agent commits the file: it leaves Uncommitted, and its diff closes rather than show nothing.
    sh(dir, 'commit', '-q', '-am', 'two')
    const after = await t.panel(id, { action: { name: 'refresh' } })
    expect(textOf(after).some((text) => text.startsWith('diff --git'))).toBe(false)
    expect(textOf(after)).toContain('No changes')
    writeFileSync(join(dir, 'a.txt'), 'one\nthree\n')
    const again = await t.panel(id, { action: { name: 'refresh' } })
    expect(textOf(again).some((text) => text.startsWith('diff --git'))).toBe(false)
  })

})

describe('reading git, edge cases', () => {
  const run = sandboxingMachine.run.bind(sandboxingMachine) as never

  it('reads a repo with no commits yet: its branch and its new files', async () => {
    const dir = tempDir()
    sh(dir, 'init', '-q', '-b', 'trunk')
    writeFileSync(join(dir, 'first.txt'), 'hi\n')
    const state = await repoState(run, { folder: dir, path: dir })
    expect(state.error).toBeUndefined()
    expect(state).toMatchObject({ branch: 'trunk', uncommitted: [{ path: 'first.txt', untracked: true }] })
  })

  it('says plainly when a folder is gone or is no repo', async () => {
    const dir = tempDir()
    expect((await repoState(run, { folder: dir, path: dir })).error).toBe(`Not a git repository: ${dir}`)
    const gone = join(dir, 'gone')
    expect((await repoState(run, { folder: gone, path: gone })).error).toBe(`Folder not found: ${gone}`)
    expect(textOf(repoView(await repoState(run, { folder: gone, path: gone })))).toEqual(['gone', `Folder not found: ${gone}`])
  })

  it('names the commit of a detached checkout instead of calling it HEAD', async () => {
    const dir = repo()
    const sha = sh(dir, 'rev-parse', '--short=7', 'HEAD').trim()
    sh(dir, 'checkout', '-q', '--detach')
    const state = await repoState(run, { folder: dir, path: dir })
    expect(state.detached).toBe(sha)
    expect(textOf(repoView(state))).toContain(`detached at ${sha}`)
    expect(textOf(repoView(state))).not.toContain('HEAD')
  })

  it('lists at most FILES_MAX files a group, and says how many more', () => {
    const files = Array.from({ length: FILES_MAX + 5 }, (_, i) => ({ path: `out/${i}.js`, untracked: true }))
    const state: RepoState = { target: { folder: '/r', path: '/r' }, branch: 'main', committed: [], uncommitted: files }
    const view = repoView(state)
    expect(textOf(view).filter((text) => text.startsWith('out/'))).toHaveLength(FILES_MAX)
    expect(textOf(view)).toContain('and 5 more files')
  })

  it("shows a diff git couldn't read as an error, not as a diff", () => {
    const state: RepoState = {
      target: { folder: '/r', path: '/r' },
      branch: 'main',
      committed: [],
      uncommitted: [{ path: 'a.txt', added: 1, removed: 0 }],
    }
    const view = repoView(state, { path: '/r', group: 'uncommitted', file: 'a.txt' }, { error: 'Couldn’t read the diff: x' })
    const find = (v: ExtensionView): ExtensionView[] =>
      'children' in v && Array.isArray(v.children) ? v.children.flatMap(find) : [v]
    expect(find(view)).toContainEqual({ type: 'text', text: 'Couldn’t read the diff: x', tone: 'error', small: true })
    expect(find(view).some((v) => v.type === 'code')).toBe(false)
  })
})

describe('during a turn', () => {
  it("draws the tab again after the agent's shell commands and edits, at most every LIVE_REFRESH_MS", async () => {
    vi.useFakeTimers()
    cleanups.push(() => void vi.useRealTimers())
    const extension = createGitExtension({ now: () => Date.now() })
    const refreshed: (string | undefined)[] = []
    const chat = { id: 's1' } as ChatDetail
    const host = { refresh: (id?: string) => refreshed.push(id), chat: () => chat }
    const context = { host } as unknown as ExtensionContext
    const tool = (toolId: string, kind: 'shell' | 'edit' | 'read') => {
      extension.onEvent!(chat, { type: 'tool.started', toolId, name: 'T', kind, summary: '', input: {} }, context)
      extension.onEvent!(chat, { type: 'tool.completed', toolId, output: '', isError: false }, context)
    }
    tool('r1', 'read')
    expect(refreshed).toEqual([])
    tool('t1', 'shell')
    expect(refreshed).toEqual(['s1'])
    tool('t2', 'edit')
    tool('t3', 'shell')
    expect(refreshed).toEqual(['s1'])
    vi.advanceTimersByTime(LIVE_REFRESH_MS)
    expect(refreshed).toEqual(['s1', 's1'])
    vi.advanceTimersByTime(LIVE_REFRESH_MS * 2)
    expect(refreshed).toEqual(['s1', 's1'])
  })
})

describe('reading git', () => {
  it('counts commits ahead of and behind the upstream', async () => {
    const origin = tempDir()
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
    const dir = repo()
    sh(dir, 'remote', 'add', 'origin', origin)
    sh(dir, 'push', '-q', '-u', 'origin', 'main')
    const other = tempDir()
    execFileSync('git', ['clone', '-q', origin, other])
    writeFileSync(join(other, 'c.txt'), 'c\n')
    sh(other, 'add', '.')
    sh(other, 'commit', '-q', '-m', 'theirs')
    sh(other, 'push', '-q')
    sh(dir, 'fetch', '-q')
    sh(dir, 'commit', '-q', '--allow-empty', '-m', 'mine')
    sh(dir, 'commit', '-q', '--allow-empty', '-m', 'mine again')
    const state = await repoState(sandboxingMachine.run.bind(sandboxingMachine) as never, { folder: dir, path: dir })
    expect(state).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 })
  })

  it('reads numstat, CI rollups and the note', () => {
    expect(parseNumstat('3\t1\ta.ts\n-\t-\timg.png\n')).toEqual([
      { path: 'a.ts', added: 3, removed: 1 },
      { path: 'img.png', binary: true },
    ])
    expect(checksOf([])).toBeUndefined()
    expect(checksOf([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }])).toBe('passing')
    expect(checksOf([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }])).toBe('failing')
    expect(checksOf([{ state: 'PENDING' }])).toBe('running')
    expect(noteText([{ branch: 'feat/x', files: 0 }])).toBeUndefined()
    expect(noteText([{ branch: 'feat/x', files: 1 }])).toBe('1 file changed on feat/x')
    expect(noteText([
      { branch: 'feat/x', files: 3 },
      { branch: 'other', files: 0 },
      { branch: 'feat/y', files: 2 },
    ])).toBe('3 files changed on feat/x, 2 on feat/y')
  })
})
