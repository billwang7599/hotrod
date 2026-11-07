import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeAdapter, FAKE_MODELS, FAKE_THINKING, type FakeStep } from './adapters/fake.ts'
import { openCore, TITLE_MAX_CHARS, type Core } from './core.ts'
import { localMachine } from './machine.ts'
import {
  DEFAULT_SUBAGENT_LIMIT,
  type Adapter,
  type ChatEntry,
  type CoreMessage,
  type EngineEvent,
  type SessionOptions,
} from './types.ts'

const TEST_STOP_GRACE_MS = 30
const at = '2026-11-06T00:00:00.000Z'

const textScript: FakeStep[] = [
  { type: 'text.delta', text: 'Hel' },
  { type: 'text.delta', text: 'lo' },
  { type: 'text.completed', text: 'Hello' },
]

const permissionScript: FakeStep[] = [
  { type: 'tool.started', toolId: 't1', name: 'Bash', kind: 'shell', summary: 'touch x', input: { command: 'touch x' } },
  {
    type: 'permission',
    toolId: 't1',
    name: 'Bash',
    kind: 'shell',
    summary: 'touch x',
    input: { command: 'touch x' },
    output: 'created',
  },
  { type: 'text.completed', text: 'Done' },
]

function recording(adapter: Adapter) {
  const calls: { options: SessionOptions; prompt?: string; interrupted?: boolean; closed: boolean }[] = []
  const wrapped: Adapter = {
    ...adapter,
    start(machine, options, emit) {
      const call: (typeof calls)[number] = { options, closed: false }
      calls.push(call)
      const session = adapter.start(machine, options, emit)
      return {
        ...session,
        prompt(text) {
          call.prompt = text
          session.prompt(text)
        },
        interrupt() {
          call.interrupted = true
          session.interrupt()
        },
        close() {
          call.closed = true
          session.close()
        },
      }
    },
  }
  return { adapter: wrapped, calls }
}

let dirs: string[] = []
let cores: Core[] = []

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'hotrod-test-'))
  dirs.push(dir)
  return dir
}

function setup(source: FakeStep[] | Adapter, garage = tempDir(), stopGraceMs = TEST_STOP_GRACE_MS) {
  const { adapter, calls } = recording(Array.isArray(source) ? createFakeAdapter(source, 0) : source)
  return { ...open(garage, [adapter], adapter.id, stopGraceMs), calls }
}

function open(
  garage: string,
  adapters: Adapter[],
  defaultEngine: string,
  stopGraceMs = TEST_STOP_GRACE_MS,
  enabled = adapters.map((a) => a.id),
) {
  const machine = localMachine
  const core = openCore({ garage, adapters, defaultEngine, machine, stopGraceMs })
  cores.push(core)
  for (const engine of enabled) core.handle({ type: 'engine.setEnabled', engine, enabled: true }, () => {})
  const messages: CoreMessage[] = []
  core.onMessage((m) => messages.push(m))
  const replies: CoreMessage[] = []
  const handle = (m: Parameters<Core['handle']>[0]) => core.handle(m, (r) => replies.push(r))
  return { core, garage, messages, replies, handle }
}

function addProject(t: ReturnType<typeof open>, dir = tempDir()) {
  const before = [t.messages.length, t.replies.length]
  t.handle({ type: 'project.add', path: dir })
  const added = [...t.messages.slice(before[0]), ...t.replies.slice(before[1])].find((m) => m.type === 'project.added')
  if (added?.type !== 'project.added') throw new Error('no project.added')
  return { ...added.chat, projectId: added.project.id, path: added.project.path }
}

function createChat(t: ReturnType<typeof open>, projectId?: string) {
  t.handle({ type: 'chat.create', ...(projectId ? { projectId } : {}) })
  const added = t.messages.findLast((m) => m.type === 'chat.added')
  if (added?.type !== 'chat.added') throw new Error('no chat.added')
  return added.chat
}

function stubAdapter(start: Adapter['start']): Adapter {
  return { id: 'stub', detect: async () => ({ installed: true, signedIn: true }), start }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
  if (!check()) throw new Error('timed out')
}

const chatOf = (core: Core, id: string) => core.chats().find((c) => c.id === id)
const statusOf = (core: Core, id: string) => core.chats().find((p) => p.id === id)?.status
const entriesOf = (core: Core, id: string) => core.chats().find((p) => p.id === id)?.entries ?? []
const types = (entries: ChatEntry[]) => entries.map((e) => e.type)

beforeEach(() => {
  dirs = []
  cores = []
})

afterEach(async () => {
  await Promise.all(cores.map((core) => core.close(true)))
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('projects', () => {
  it('adds a folder once and keeps ids unique', () => {
    const t = setup(textScript)
    const parentA = tempDir()
    const parentB = tempDir()
    mkdirSync(join(parentA, 'app'))
    mkdirSync(join(parentB, 'app'))
    const first = addProject(t, join(parentA, 'app'))
    const again = addProject(t, join(parentA, 'app'))
    const second = addProject(t, join(parentB, 'app'))
    expect(first.projectId).toBe('app')
    expect(again.projectId).toBe('app')
    expect(second.projectId).not.toBe('app')
    expect(t.core.projects()).toHaveLength(2)
    const saved = JSON.parse(readFileSync(join(t.garage, 'projects', 'app', 'project.json'), 'utf8'))
    expect(saved).toEqual({ id: 'app', name: 'app', path: first.path, archived: false })
  })

  it('rejects a path that is not a directory', () => {
    const t = setup(textScript)
    const file = join(tempDir(), 'file.txt')
    writeFileSync(file, '')
    expect(() => t.handle({ type: 'project.add', path: file })).toThrow()
    expect(() => t.handle({ type: 'project.add', path: join(file, 'missing') })).toThrow()
  })
})

describe('main chat and subchats', () => {
  const infoOf = (core: Core, id: string) => {
    const { status, entries, draft, queue, ...info } = chatOf(core, id)!
    return info
  }

  it('opens one permanent Main chat that runs in a scratch home folder', async () => {
    const t = setup(textScript)
    expect(t.core.chats()).toEqual([
      expect.objectContaining({ id: 'main', main: true, title: 'Workshop', engine: 'fake', archived: false }),
    ])
    expect(chatOf(t.core, 'main')?.projectId).toBeUndefined()
    t.handle({ type: 'chat.send', chatId: 'main', text: 'hi' })
    await until(() => statusOf(t.core, 'main') === 'idle')
    expect(t.calls[0]?.options.cwd).toBe(join(t.garage, 'home'))
    expect(statSync(join(t.garage, 'home')).isDirectory()).toBe(true)
    const log = readFileSync(join(t.garage, 'chats', 'main', 'log.jsonl'), 'utf8')
    expect(log.trim().split('\n')).toHaveLength(4)
    expect(chatOf(t.core, 'main')?.title).toBe('Workshop')

    expect(() => t.handle({ type: 'chat.archive', chatId: 'main', archived: true })).toThrow(/main chat/i)
    expect(() => t.handle({ type: 'chat.delete', chatId: 'main' })).toThrow(/main chat/i)
    t.core.close()
    expect(entriesOf(setup(textScript, t.garage).core, 'main')).toHaveLength(4)
  })

  it('calls the root chat Workshop, even in a garage that saved it as Main', () => {
    const garage = tempDir()
    mkdirSync(join(garage, 'chats', 'main'), { recursive: true })
    const saved = { id: 'main', title: 'Main', engine: 'fake', archived: false, createdAt: at }
    writeFileSync(join(garage, 'chats', 'main', 'chat.json'), JSON.stringify(saved))
    expect(chatOf(setup(textScript, garage).core, 'main')?.title).toBe('Workshop')
  })

  it('creates subchats under Main and in projects, titled by their first message', async () => {
    const t = setup(textScript)
    const home = createChat(t)
    expect(home).toMatchObject({ main: false, title: 'New chat', engine: 'fake', archived: false, entries: [] })
    expect(home.projectId).toBeUndefined()
    const saved = JSON.parse(readFileSync(join(t.garage, 'chats', home.id, 'chat.json'), 'utf8'))
    expect(saved).toEqual({ id: home.id, title: 'New chat', engine: 'fake', archived: false, createdAt: home.createdAt })

    const text = 'Please look into why the build is slow on the CI machines today'
    t.handle({ type: 'chat.send', chatId: home.id, text })
    const title = `${text.slice(0, TITLE_MAX_CHARS).trimEnd()}…`
    expect(t.messages).toContainEqual({ type: 'chat.updated', chat: { ...infoOf(t.core, home.id), title } })
    await until(() => statusOf(t.core, home.id) === 'idle')
    t.handle({ type: 'chat.send', chatId: home.id, text: 'something else' })
    await until(() => statusOf(t.core, home.id) === 'idle')
    expect(chatOf(t.core, home.id)?.title).toBe(title)
    expect(t.calls[0]?.options.cwd).toBe(join(t.garage, 'home'))

    const main = addProject(t)
    const sub = createChat(t, main.projectId)
    expect(sub.projectId).toBe(main.projectId)
    expect(existsSync(join(t.garage, 'projects', main.projectId, 'chats', sub.id, 'chat.json'))).toBe(true)
    t.handle({ type: 'chat.send', chatId: sub.id, text: 'short' })
    await until(() => statusOf(t.core, sub.id) === 'idle')
    expect(t.calls[2]?.options.cwd).toBe(main.path)
    expect(t.calls[2]?.prompt).toBe('short')
    expect(chatOf(t.core, sub.id)?.title).toBe('short')
    expect(chatOf(t.core, main.id)?.title).toBe('Main')
    expect(entriesOf(t.core, main.id)).toEqual([])

    t.core.close()
    const reopened = setup(textScript, t.garage)
    expect(reopened.core.chats()).toEqual(t.core.chats())
    expect(() => t.handle({ type: 'chat.create', projectId: 'nope' })).toThrow(/Unknown project/)
  })

  it('archives a subchat, keeping its log, and refuses to run it until unarchived', async () => {
    const t = setup(textScript)
    const chat = createChat(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    t.handle({ type: 'chat.archive', chatId: chat.id, archived: true })
    expect(t.messages.at(-1)).toEqual({ type: 'chat.updated', chat: { ...infoOf(t.core, chat.id), archived: true } })
    expect(() => t.handle({ type: 'chat.send', chatId: chat.id, text: 'again' })).toThrow(/archived/)
    t.core.close()

    const reopened = setup(textScript, t.garage)
    expect(chatOf(reopened.core, chat.id)).toMatchObject({ archived: true })
    expect(entriesOf(reopened.core, chat.id)).toHaveLength(4)
    reopened.handle({ type: 'chat.archive', chatId: chat.id, archived: false })
    reopened.handle({ type: 'chat.send', chatId: chat.id, text: 'again' })
    expect(reopened.calls).toHaveLength(1)
  })

  it('deletes a subchat folder, but not while it runs', async () => {
    const t = setup(permissionScript)
    const chat = createChat(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'go' })
    await until(() => statusOf(t.core, chat.id) === 'waiting')
    expect(() => t.handle({ type: 'chat.delete', chatId: chat.id })).toThrow(/Stop/)
    expect(() => t.handle({ type: 'chat.archive', chatId: chat.id, archived: true })).toThrow(/Stop/)
    t.handle({ type: 'chat.interrupt', chatId: chat.id })
    await until(() => statusOf(t.core, chat.id) === 'idle')

    t.handle({ type: 'chat.delete', chatId: chat.id })
    expect(t.messages.at(-1)).toEqual({ type: 'chat.removed', chatId: chat.id })
    expect(existsSync(join(t.garage, 'chats', chat.id))).toBe(false)
    expect(chatOf(t.core, chat.id)).toBeUndefined()
    expect(existsSync(join(t.garage, 'chats', 'main'))).toBe(true)
  })

  it('archives a project with its chats and refuses to run them until unarchived', async () => {
    const t = setup(permissionScript)
    const main = addProject(t)
    const sub = createChat(t, main.projectId)
    t.handle({ type: 'chat.send', chatId: sub.id, text: 'go' })
    await until(() => statusOf(t.core, sub.id) === 'waiting')
    expect(() => t.handle({ type: 'project.archive', projectId: main.projectId, archived: true })).toThrow(/Stop/)
    t.handle({ type: 'chat.interrupt', chatId: sub.id })
    await until(() => statusOf(t.core, sub.id) === 'idle')

    t.handle({ type: 'project.archive', projectId: main.projectId, archived: true })
    const project = { id: main.projectId, name: main.path.split('/').at(-1), path: main.path, archived: true }
    expect(t.messages.at(-1)).toEqual({ type: 'project.updated', project })
    expect(() => t.handle({ type: 'chat.send', chatId: main.id, text: 'hi' })).toThrow(/archived/)
    expect(() => t.handle({ type: 'chat.create', projectId: main.projectId })).toThrow(/archived/)
    expect(() => t.handle({ type: 'chat.archive', chatId: main.id, archived: true })).toThrow(/main chat/i)
    expect(() => t.handle({ type: 'chat.delete', chatId: main.id })).toThrow(/main chat/i)
    t.core.close()

    const reopened = setup(permissionScript, t.garage)
    expect(reopened.core.projects()).toEqual([project])
    reopened.handle({ type: 'project.add', path: main.path })
    expect(reopened.core.projects()).toEqual([{ ...project, archived: false }])
    reopened.handle({ type: 'chat.send', chatId: main.id, text: 'hi' })
    expect(reopened.calls).toHaveLength(1)
  })

  it("deletes a project's Hotrod data but never its folder", async () => {
    const t = setup(permissionScript)
    const dir = tempDir()
    writeFileSync(join(dir, 'keep.txt'), 'mine')
    writeFileSync(join(dir, 'AGENTS.md'), 'REPO RULES')
    const main = addProject(t, dir)
    const sub = createChat(t, main.projectId)
    t.handle({ type: 'chat.send', chatId: sub.id, text: 'go' })
    await until(() => statusOf(t.core, sub.id) === 'waiting')
    expect(() => t.handle({ type: 'project.delete', projectId: main.projectId })).toThrow(/Stop/)
    t.handle({ type: 'chat.interrupt', chatId: sub.id })
    await until(() => statusOf(t.core, sub.id) === 'idle')

    t.handle({ type: 'project.delete', projectId: main.projectId })
    expect(t.messages.at(-1)).toEqual({ type: 'project.removed', projectId: main.projectId })
    expect(existsSync(join(t.garage, 'projects', main.projectId))).toBe(false)
    expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('mine')
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('REPO RULES')
    expect(t.core.projects()).toEqual([])
    expect(t.core.chats().map((c) => c.id)).toEqual(['main'])
    expect(() => t.handle({ type: 'chat.send', chatId: sub.id, text: 'hi' })).toThrow(/Unknown chat/)
  })

  it('loads an old garage whose project kept its engine and log without a chat.json', () => {
    const garage = tempDir()
    const dir = tempDir()
    const projectDir = join(garage, 'projects', 'old')
    mkdirSync(join(projectDir, 'chats', 'main'), { recursive: true })
    writeFileSync(join(projectDir, 'project.json'), JSON.stringify({ id: 'old', name: 'old', path: dir, engine: 'fake' }))
    const history = [
      { at, type: 'user.message', text: 'hi' },
      { at, type: 'turn.started' },
      { at, type: 'text.completed', text: 'Hello' },
      { at, type: 'turn.completed' },
    ]
    writeFileSync(join(projectDir, 'chats', 'main', 'log.jsonl'), history.map((e) => JSON.stringify(e) + '\n').join(''))
    const other = { ...createFakeAdapter(textScript, 0), id: 'other' }
    const t = open(garage, [createFakeAdapter(textScript, 0), other], 'other')

    expect(t.core.projects()).toEqual([{ id: 'old', name: 'old', path: dir, archived: false }])
    expect(chatOf(t.core, 'old/main')).toMatchObject({ projectId: 'old', main: true, engine: 'fake', entries: history })
    expect(chatOf(t.core, 'main')?.engine).toBe('other')
  })
})

describe('chat', () => {
  it('streams a turn, saves it without deltas and closes the session', async () => {
    const t = setup(textScript)
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })
    expect(statusOf(t.core, chat.id)).toBe('running')
    await until(() => statusOf(t.core, chat.id) === 'idle')

    const deltas = t.messages.flatMap((m) => (m.type === 'chat.delta' ? [m.text] : []))
    expect(deltas.join('')).toBe('Hello')
    expect(types(entriesOf(t.core, chat.id))).toEqual([
      'user.message',
      'turn.started',
      'text.completed',
      'turn.completed',
    ])
    const statuses = t.messages.flatMap((m) => (m.type === 'chat.status' ? [m.status] : []))
    expect(statuses).toEqual(['running', 'idle'])
    const log = readFileSync(join(t.garage, 'projects', chat.projectId, 'chats', 'main', 'log.jsonl'), 'utf8')
    expect(log.trim().split('\n').map((l) => JSON.parse(l).type)).toEqual(types(entriesOf(t.core, chat.id)))
    expect(t.calls[0]?.options.cwd).toBe(chat.path)
    expect(t.calls[0]?.closed).toBe(true)
  })

  it('streams thinking live without saving or replaying it', async () => {
    const t = setup([{ type: 'thinking.delta', text: 'Hmm, ' }, { type: 'thinking.delta', text: 'SECRET' }, ...textScript])
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })
    await until(() => statusOf(t.core, chat.id) === 'idle')

    const thinking = t.messages.flatMap((m) => (m.type === 'chat.thinking' ? [m.text] : []))
    expect(thinking.join('')).toBe('Hmm, SECRET')
    expect(types(entriesOf(t.core, chat.id))).toEqual(['user.message', 'turn.started', 'text.completed', 'turn.completed'])
    const log = readFileSync(join(t.garage, 'projects', chat.projectId, 'chats', 'main', 'log.jsonl'), 'utf8')
    expect(log).not.toContain('SECRET')

    t.handle({ type: 'chat.send', chatId: chat.id, text: 'again' })
    expect(t.calls[1]?.prompt).not.toContain('SECRET')
  })

  it('keeps the log across a restart', async () => {
    const t = setup(textScript)
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    t.core.close()

    const reopened = setup(textScript, t.garage)
    expect(reopened.core.chats()).toEqual(t.core.chats())
    expect(entriesOf(reopened.core, chat.id)).toHaveLength(4)
  })

  it('closes a turn that was cut off when Hotrod quit', () => {
    const t = setup(textScript)
    const chat = addProject(t)
    const log = join(t.garage, 'projects', chat.projectId, 'chats', 'main', 'log.jsonl')
    appendFileSync(log, JSON.stringify({ at: 'x', type: 'user.message', text: 'hi' }) + '\n')
    appendFileSync(log, JSON.stringify({ at: 'x', type: 'turn.started' }) + '\n')
    t.core.close()

    const reopened = setup(textScript, t.garage)
    const last = entriesOf(reopened.core, chat.id).at(-1)
    expect(last?.type).toBe('turn.completed')
    expect(last?.type === 'turn.completed' && last.error).toBeTruthy()
    expect(statusOf(reopened.core, chat.id)).toBe('idle')
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(3)
  })

  it('runs an allowed tool after permission', async () => {
    const t = setup(permissionScript)
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'go' })
    await until(() => statusOf(t.core, chat.id) === 'waiting')
    const request = entriesOf(t.core, chat.id).find((e) => e.type === 'permission.requested')
    if (request?.type !== 'permission.requested') throw new Error('no request')

    t.handle({ type: 'permission.respond', chatId: chat.id, requestId: request.requestId, allow: true })
    expect(statusOf(t.core, chat.id)).toBe('running')
    await until(() => statusOf(t.core, chat.id) === 'idle')
    const entries = entriesOf(t.core, chat.id)
    expect(entries.find((e) => e.type === 'permission.resolved')).toMatchObject({ allow: true })
    expect(entries.find((e) => e.type === 'tool.completed')).toMatchObject({ output: 'created', isError: false })
  })

  it('reports a denied tool as an error', async () => {
    const t = setup(permissionScript)
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'go' })
    await until(() => statusOf(t.core, chat.id) === 'waiting')
    const request = entriesOf(t.core, chat.id).find((e) => e.type === 'permission.requested')
    if (request?.type !== 'permission.requested') throw new Error('no request')

    t.handle({ type: 'permission.respond', chatId: chat.id, requestId: request.requestId, allow: false })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    const entries = entriesOf(t.core, chat.id)
    expect(entries.find((e) => e.type === 'permission.resolved')).toMatchObject({ allow: false })
    expect(entries.find((e) => e.type === 'tool.completed')).toMatchObject({ isError: true })
    expect(() =>
      t.handle({ type: 'permission.respond', chatId: chat.id, requestId: request.requestId, allow: true }),
    ).toThrow()
  })

  it('interrupts a turn', async () => {
    const t = setup(permissionScript)
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'go' })
    await until(() => statusOf(t.core, chat.id) === 'waiting')
    t.handle({ type: 'chat.interrupt', chatId: chat.id })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    expect(entriesOf(t.core, chat.id).at(-1)?.type).toBe('turn.completed')
  })

  it('keeps tool and request ids unique across turns, even after a restart', async () => {
    const t = setup(permissionScript)
    const chat = addProject(t)
    const runTurn = async (h: ReturnType<typeof setup>, allow: boolean) => {
      const before = entriesOf(h.core, chat.id).length
      h.handle({ type: 'chat.send', chatId: chat.id, text: 'go' })
      await until(() => statusOf(h.core, chat.id) === 'waiting')
      const request = entriesOf(h.core, chat.id)
        .slice(before)
        .find((e) => e.type === 'permission.requested')
      if (request?.type !== 'permission.requested') throw new Error('no request')
      h.handle({ type: 'permission.respond', chatId: chat.id, requestId: request.requestId, allow })
      await until(() => statusOf(h.core, chat.id) === 'idle')
    }
    await runTurn(t, true)
    await runTurn(t, false)
    t.core.close()
    const reopened = setup(permissionScript, t.garage)
    await runTurn(reopened, true)

    const entries = entriesOf(reopened.core, chat.id)
    const toolIds = entries.flatMap((e) => (e.type === 'tool.started' ? [e.toolId] : []))
    const requestIds = entries.flatMap((e) => (e.type === 'permission.requested' ? [e.requestId] : []))
    expect(new Set(toolIds).size).toBe(3)
    expect(new Set(requestIds).size).toBe(3)
    const results = entries.flatMap((e) => (e.type === 'tool.completed' ? [e.isError] : []))
    expect(results).toEqual([false, true, false])
  })

  it('saves the text streamed so far when a turn stops', async () => {
    const t = setup([
      { type: 'text.delta', text: 'First' },
      { type: 'text.completed', text: 'First' },
      { type: 'text.delta', text: 'Hel' },
      { type: 'text.delta', text: 'lo' },
      ...permissionScript,
    ])
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'go' })
    await until(() => statusOf(t.core, chat.id) === 'waiting')
    t.handle({ type: 'chat.interrupt', chatId: chat.id })
    await until(() => statusOf(t.core, chat.id) === 'idle')

    const entries = entriesOf(t.core, chat.id)
    const texts = entries.flatMap((e) => (e.type === 'text.completed' ? [e.text] : []))
    expect(texts).toEqual(['First', 'Hello'])
    expect(types(entries).slice(-2)).toEqual(['text.completed', 'turn.completed'])
  })

  it('shows the text streamed so far to clients that join mid-turn', async () => {
    const t = setup([{ type: 'text.delta', text: 'Hel' }, { type: 'text.delta', text: 'lo' }, ...permissionScript])
    const chat = addProject(t)
    expect(chatOf(t.core, chat.id)?.draft).toBe('')
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'go' })
    await until(() => statusOf(t.core, chat.id) === 'waiting')
    expect(chatOf(t.core, chat.id)?.draft).toBe('Hello')

    t.handle({ type: 'chat.interrupt', chatId: chat.id })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    expect(chatOf(t.core, chat.id)?.draft).toBe('')
  })

  it('gives the engine the prior chat and the instructions', async () => {
    const t = setup(permissionScript)
    const dir = tempDir()
    writeFileSync(join(t.garage, 'AGENTS.md'), 'GLOBAL RULES')
    writeFileSync(join(dir, 'AGENTS.md'), 'REPO RULES')
    const chat = addProject(t, dir)
    writeFileSync(join(t.garage, 'projects', chat.projectId, 'AGENTS.md'), 'PERSONAL RULES')

    t.handle({ type: 'chat.send', chatId: chat.id, text: 'first question' })
    await until(() => statusOf(t.core, chat.id) === 'waiting')
    const request = entriesOf(t.core, chat.id).find((e) => e.type === 'permission.requested')
    if (request?.type !== 'permission.requested') throw new Error('no request')
    t.handle({ type: 'permission.respond', chatId: chat.id, requestId: request.requestId, allow: true })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    expect(t.calls[0]?.prompt).toBe('first question')

    t.handle({ type: 'chat.send', chatId: chat.id, text: 'second question' })
    const prompt = t.calls[1]?.prompt ?? ''
    expect(prompt).toContain('first question')
    expect(prompt).toContain('Done')
    expect(prompt).toMatch(/Bash.*touch x/)
    expect(prompt.trimEnd().endsWith('second question')).toBe(true)
    expect(prompt.indexOf('first question')).toBeLessThan(prompt.indexOf('Done'))

    expect(prompt).toContain('<tool_result status="ok">\ncreated\n</tool_result>')

    const instructions = t.calls[1]?.options.instructions ?? ''
    expect(instructions).toContain('GLOBAL RULES')
    expect(instructions).toContain('REPO RULES')
    expect(instructions.indexOf('GLOBAL RULES')).toBeLessThan(instructions.indexOf('REPO RULES'))
    expect(instructions.indexOf('REPO RULES')).toBeLessThan(instructions.indexOf('PERSONAL RULES'))
  })

  it('replays tool inputs and outputs in full and marks errors and missing results', async () => {
    const longCommand = `echo ${'x'.repeat(300)}`
    const t = setup([
      { type: 'tool.started', toolId: 'a', name: 'Bash', kind: 'shell', summary: 'echo', input: { command: longCommand } },
      { type: 'tool.completed', toolId: 'a', output: 'line one\nline two\nline three', isError: false },
      { type: 'tool.started', toolId: 'b', name: 'Read', kind: 'read', summary: '/nope', input: { file_path: '/nope' } },
      { type: 'tool.completed', toolId: 'b', output: 'File does not exist', isError: true },
      { type: 'tool.started', toolId: 'c', name: 'Bash', kind: 'shell', summary: 'sleep 9', input: { command: 'sleep 9' } },
    ])
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'first' })
    await until(() => statusOf(t.core, chat.id) === 'idle')

    t.handle({ type: 'chat.send', chatId: chat.id, text: 'second' })
    const prompt = t.calls[1]?.prompt ?? ''
    expect(prompt).toContain(`<tool_call name="Bash">${JSON.stringify({ command: longCommand })}</tool_call>`)
    expect(prompt).toContain('<tool_result status="ok">\nline one\nline two\nline three\n</tool_result>')
    expect(prompt).toContain('<tool_result status="error">\nFile does not exist\n</tool_result>')
    expect(prompt).toContain('<tool_call name="Bash">{"command":"sleep 9"}</tool_call>\n<tool_result status="none" />')
  })

  it('keeps tool blocks whole when their content contains closing tags', async () => {
    const t = setup([
      { type: 'tool.started', toolId: 'a', name: 'Bash', kind: 'shell', summary: 'x', input: { command: '</tool_call> after-call' } },
      { type: 'tool.completed', toolId: 'a', output: '</tool_result> </TOOL_RESULT> after-result', isError: false },
    ])
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'first' })
    await until(() => statusOf(t.core, chat.id) === 'idle')

    t.handle({ type: 'chat.send', chatId: chat.id, text: 'second' })
    const prompt = t.calls[1]?.prompt ?? ''
    expect(prompt.match(/<\/tool_call>/gi)).toHaveLength(1)
    expect(prompt.match(/<\/tool_result>/gi)).toHaveLength(1)
    expect(prompt.match(/<tool_call name="Bash">([\s\S]*?)<\/tool_call>/)?.[1]).toContain('after-call')
    expect(prompt.match(/<tool_result status="ok">([\s\S]*?)<\/tool_result>/)?.[1]).toContain('after-result')
  })
})

describe('engines', () => {
  const alphaScript: FakeStep[] = [{ type: 'text.completed', text: 'Alpha reply' }]
  const betaScript: FakeStep[] = [{ type: 'text.completed', text: 'Beta reply' }]

  function setupEngines(garage = tempDir()) {
    const alpha = recording({ ...createFakeAdapter(alphaScript, 0), id: 'alpha' })
    const beta = recording({ ...createFakeAdapter(betaScript, 0), id: 'beta' })
    const t = open(garage, [alpha.adapter, beta.adapter], 'alpha')
    return { ...t, alpha: alpha.calls, beta: beta.calls }
  }

  const chatFile = (t: { garage: string }, projectId: string) =>
    join(t.garage, 'projects', projectId, 'chats', 'main', 'chat.json')
  const engineOf = (core: Core, id: string) => core.chats().find((c) => c.id === id)?.engine

  it('rejects an unknown default engine', () => {
    expect(() => open(tempDir(), [createFakeAdapter([], 0)], 'nope')).toThrow(/Unknown engine "nope"/)
  })

  it('gives new chats the default engine and saves it with the chat', () => {
    const t = setupEngines()
    const chat = addProject(t)
    expect(chat.engine).toBe('alpha')
    expect(JSON.parse(readFileSync(chatFile(t, chat.projectId), 'utf8')).engine).toBe('alpha')
    expect(createChat(t).engine).toBe('alpha')
    expect(engineOf(t.core, 'main')).toBe('alpha')
  })

  it('gives an old project without an engine the default', () => {
    const t = setupEngines()
    const chat = addProject(t)
    rmSync(chatFile(t, chat.projectId))
    t.core.close()
    expect(engineOf(setupEngines(t.garage).core, chat.id)).toBe('alpha')
  })

  it('sets a chat engine, saves it and tells every client', () => {
    const t = setupEngines()
    const chat = addProject(t)
    const other = createChat(t, chat.projectId)
    t.handle({ type: 'chat.setEngine', chatId: chat.id, engine: 'beta' })
    const { status, entries, draft, queue, ...info } = chatOf(t.core, chat.id)!
    expect(t.messages.at(-1)).toEqual({ type: 'chat.updated', chat: { ...info, engine: 'beta' } })
    expect(engineOf(t.core, chat.id)).toBe('beta')
    expect(engineOf(t.core, other.id)).toBe('alpha')
    t.core.close()
    expect(engineOf(setupEngines(t.garage).core, chat.id)).toBe('beta')
  })

  it('rejects an unknown engine and a change while a turn runs', () => {
    const t = setupEngines()
    const chat = addProject(t)
    expect(() => t.handle({ type: 'chat.setEngine', chatId: chat.id, engine: 'nope' })).toThrow(
      /Unknown engine "nope"/,
    )
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })
    expect(() => t.handle({ type: 'chat.setEngine', chatId: chat.id, engine: 'beta' })).toThrow(/turn/)
    expect(engineOf(t.core, chat.id)).toBe('alpha')
    expect(JSON.parse(readFileSync(chatFile(t, chat.projectId), 'utf8')).engine).toBe('alpha')
  })

  it('continues a chat on another engine with the whole conversation', async () => {
    const t = setupEngines()
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'first question' })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    t.handle({ type: 'chat.setEngine', chatId: chat.id, engine: 'beta' })
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'second question' })
    await until(() => statusOf(t.core, chat.id) === 'idle')

    expect(t.alpha).toHaveLength(1)
    expect(t.beta).toHaveLength(1)
    const prompt = t.beta[0]?.prompt ?? ''
    expect(prompt).toContain('User: first question')
    expect(prompt).toContain('Assistant: Alpha reply')
    expect(prompt.trimEnd().endsWith('second question')).toBe(true)
    const texts = entriesOf(t.core, chat.id).flatMap((e) => (e.type === 'text.completed' ? [e.text] : []))
    expect(texts).toEqual(['Alpha reply', 'Beta reply'])
  })

  it('sets a chat model and thinking level, saves them and starts the next session with them', async () => {
    const t = setupEngines()
    await t.core.refreshEngines()
    const chat = addProject(t)
    const [model, thinking] = [FAKE_MODELS.at(-1)!, FAKE_THINKING.at(-1)!]
    t.handle({ type: 'chat.setModel', chatId: chat.id, model, thinking })
    expect(t.messages.at(-1)).toMatchObject({ type: 'chat.updated', chat: { id: chat.id, model, thinking } })
    expect(JSON.parse(readFileSync(chatFile(t, chat.projectId), 'utf8'))).toMatchObject({ model, thinking })
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    expect(t.alpha[0]?.options).toMatchObject({ model, thinking })

    t.handle({ type: 'chat.setModel', chatId: chat.id, thinking })
    const updated = t.messages.at(-1)
    expect(updated?.type === 'chat.updated' && 'model' in updated.chat).toBe(false)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'again' })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    expect(t.alpha[1]?.options.model).toBeUndefined()
    expect(t.alpha[1]?.options.thinking).toBe(thinking)
    expect(JSON.parse(readFileSync(chatFile(t, chat.projectId), 'utf8')).model).toBeUndefined()

    t.core.close()
    const reopened = chatOf(setupEngines(t.garage).core, chat.id)
    expect(reopened?.model).toBeUndefined()
    expect(reopened?.thinking).toBe(thinking)
  })

  it('rejects a model or thinking level the engine does not offer, and a change while a turn runs', async () => {
    const t = setupEngines()
    await t.core.refreshEngines()
    const chat = addProject(t)
    expect(() => t.handle({ type: 'chat.setModel', chatId: chat.id, model: 'nope' })).toThrow(/model "nope"/)
    expect(() => t.handle({ type: 'chat.setModel', chatId: chat.id, thinking: 'nope' })).toThrow(
      /thinking level "nope"/,
    )
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })
    expect(() => t.handle({ type: 'chat.setModel', chatId: chat.id, model: FAKE_MODELS[0] })).toThrow(/turn/)
    expect(chatOf(t.core, chat.id)?.model).toBeUndefined()
  })

  it('drops a model or thinking level the new engine does not offer when the engine changes', async () => {
    const alpha = createFakeAdapter([], 0)
    const betaOffers = { models: FAKE_MODELS.slice(0, 1), thinking: FAKE_THINKING }
    const detect = async () => ({ installed: true, signedIn: true, ...betaOffers })
    const beta: Adapter = { ...alpha, id: 'beta', detect }
    const t = open(tempDir(), [{ ...alpha, id: 'alpha' }, beta], 'alpha')
    await t.core.refreshEngines()
    const [model, thinking] = [FAKE_MODELS.at(-1)!, FAKE_THINKING[0]!]
    t.handle({ type: 'chat.setModel', chatId: 'main', model, thinking })
    t.handle({ type: 'chat.setEngine', chatId: 'main', engine: 'beta' })
    expect(chatOf(t.core, 'main')).toMatchObject({ engine: 'beta', thinking })
    expect(chatOf(t.core, 'main')?.model).toBeUndefined()
    t.handle({ type: 'chat.setModel', chatId: 'main', model: FAKE_MODELS[0], thinking })
    t.handle({ type: 'chat.setEngine', chatId: 'main', engine: 'alpha' })
    expect(chatOf(t.core, 'main')).toMatchObject({ engine: 'alpha', model: FAKE_MODELS[0], thinking })
  })

  it('keeps a chat whose saved engine is gone and refuses to send', () => {
    const t = setupEngines()
    const chat = addProject(t)
    const saved = JSON.parse(readFileSync(chatFile(t, chat.projectId), 'utf8'))
    writeFileSync(chatFile(t, chat.projectId), JSON.stringify({ ...saved, engine: 'removed' }))
    t.core.close()

    const reopened = setupEngines(t.garage)
    expect(engineOf(reopened.core, chat.id)).toBe('removed')
    expect(() => reopened.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })).toThrow(
      /Engine "removed" is not available/,
    )
    expect(entriesOf(reopened.core, chat.id)).toEqual([])
    expect(statusOf(reopened.core, chat.id)).toBe('idle')
    reopened.handle({ type: 'chat.setEngine', chatId: chat.id, engine: 'beta' })
    reopened.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })
    expect(reopened.beta).toHaveLength(1)
  })
})

describe('settings', () => {
  const settingsFile = (t: { garage: string }) => join(t.garage, 'settings.json')
  const engineInfo = (core: Core, id: string) => core.engines().find((e) => e.id === id)

  it('starts with every engine off, refuses to send, and points at Settings', () => {
    const fake = recording(createFakeAdapter(textScript, 0))
    const t = open(tempDir(), [fake.adapter], 'fake', TEST_STOP_GRACE_MS, [])
    expect(t.core.engines()).toEqual([{ id: 'fake', enabled: false, installed: false, signedIn: false }])
    expect(existsSync(settingsFile(t))).toBe(false)
    expect(() => t.handle({ type: 'chat.send', chatId: 'main', text: 'hi' })).toThrow(/"fake" is off.*Settings/)
    expect(fake.calls).toHaveLength(0)
    expect(entriesOf(t.core, 'main')).toEqual([])
  })

  it('turns an engine on, saves it in settings.json and tells every client', async () => {
    const garage = tempDir()
    const t = open(garage, [createFakeAdapter(textScript, 0)], 'fake', TEST_STOP_GRACE_MS, [])
    t.handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true })
    expect(t.messages.at(-1)).toEqual({
      type: 'engine.updated',
      engine: { id: 'fake', enabled: true, installed: false, signedIn: false },
    })
    expect(JSON.parse(readFileSync(settingsFile(t), 'utf8'))).toEqual({ engines: { fake: true } })
    t.handle({ type: 'chat.send', chatId: 'main', text: 'hi' })
    await until(() => statusOf(t.core, 'main') === 'idle')
    expect(types(entriesOf(t.core, 'main'))).toContain('text.completed')

    t.core.close()
    const reopened = open(garage, [createFakeAdapter(textScript, 0)], 'fake', TEST_STOP_GRACE_MS, [])
    expect(engineInfo(reopened.core, 'fake')?.enabled).toBe(true)
    reopened.handle({ type: 'engine.setEnabled', engine: 'fake', enabled: false })
    expect(JSON.parse(readFileSync(settingsFile(t), 'utf8'))).toEqual({ engines: { fake: false } })
  })

  it('keeps other settings when saving and rejects an unknown engine', () => {
    const garage = tempDir()
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ engines: { gone: true }, theme: 'dark' }))
    const t = open(garage, [createFakeAdapter([], 0)], 'fake', TEST_STOP_GRACE_MS, [])
    expect(() => t.handle({ type: 'engine.setEnabled', engine: 'nope', enabled: true })).toThrow(/Unknown engine/)
    t.handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true })
    expect(JSON.parse(readFileSync(settingsFile(t), 'utf8'))).toEqual({
      engines: { gone: true, fake: true },
      theme: 'dark',
    })
  })

  it('lets a chat switch only to an engine that is on', () => {
    const alpha = createFakeAdapter([], 0)
    const t = open(tempDir(), [{ ...alpha, id: 'alpha' }, { ...alpha, id: 'beta' }], 'alpha', TEST_STOP_GRACE_MS, [
      'alpha',
    ])
    expect(() => t.handle({ type: 'chat.setEngine', chatId: 'main', engine: 'beta' })).toThrow(/"beta" is off/)
    t.handle({ type: 'engine.setEnabled', engine: 'beta', enabled: true })
    t.handle({ type: 'chat.setEngine', chatId: 'main', engine: 'beta' })
    expect(chatOf(t.core, 'main')?.engine).toBe('beta')
  })

  it('gives new chats the default engine when it is on, else the first engine that is on', () => {
    const base = createFakeAdapter([], 0)
    const t = open(tempDir(), [{ ...base, id: 'alpha' }, { ...base, id: 'beta' }], 'alpha', TEST_STOP_GRACE_MS, [
      'beta',
    ])
    expect(createChat(t).engine).toBe('beta')
    t.handle({ type: 'engine.setEnabled', engine: 'alpha', enabled: true })
    expect(createChat(t).engine).toBe('alpha')
  })

  it('reports what each engine detected, and a detect that throws as not installed', async () => {
    const ok = stubAdapter(() => ({ prompt() {}, interrupt() {}, respond() {}, close() {} }))
    const broken: Adapter = { ...ok, id: 'broken', detect: () => Promise.reject(new Error('no binary')) }
    const t = open(tempDir(), [ok, broken], 'stub', TEST_STOP_GRACE_MS, [])
    await t.core.refreshEngines()
    expect(t.core.engines()).toEqual([
      { id: 'stub', enabled: false, installed: true, signedIn: true },
      { id: 'broken', enabled: false, installed: false, signedIn: false, detail: 'no binary' },
    ])
    expect(t.messages.filter((m) => m.type === 'engine.updated')).toHaveLength(2)
  })
})

describe('queue', () => {
  const userTexts = (core: Core, id: string) =>
    entriesOf(core, id).flatMap((e) => (e.type === 'user.message' ? [e.text] : []))
  const queueOf = (core: Core, id: string) => chatOf(core, id)?.queue.map((q) => q.text)

  it('queues messages sent during a turn and sends them as one prompt when it ends', async () => {
    const t = setup(permissionScript)
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'one' })
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'two' })
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'three' })
    expect(userTexts(t.core, chat.id)).toEqual(['one'])
    expect(queueOf(t.core, chat.id)).toEqual(['two', 'three'])
    const last = t.messages.at(-1)
    expect(last).toMatchObject({ type: 'chat.queue', chatId: chat.id, queue: [{ text: 'two' }, { text: 'three' }] })

    await until(() => statusOf(t.core, chat.id) === 'waiting')
    const request = entriesOf(t.core, chat.id).find((e) => e.type === 'permission.requested')
    if (request?.type !== 'permission.requested') throw new Error('no request')
    t.handle({ type: 'permission.respond', chatId: chat.id, requestId: request.requestId, allow: true })
    await until(() => userTexts(t.core, chat.id).length === 2)

    expect(userTexts(t.core, chat.id)).toEqual(['one', 'two\n\nthree'])
    expect(t.calls[1]?.prompt?.endsWith('two\n\nthree')).toBe(true)
    expect(queueOf(t.core, chat.id)).toEqual([])
    expect(t.messages).toContainEqual({ type: 'chat.queue', chatId: chat.id, queue: [] })
    expect(statusOf(t.core, chat.id)).not.toBe('idle')
  })

  it('sends the queue after a stopped or failed turn too', async () => {
    const t = setup(permissionScript)
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'one' })
    await until(() => statusOf(t.core, chat.id) === 'waiting')
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'two' })
    t.handle({ type: 'chat.interrupt', chatId: chat.id })
    await until(() => userTexts(t.core, chat.id).length === 2)
    expect(entriesOf(t.core, chat.id).find((e) => e.type === 'turn.completed')).toMatchObject({ error: 'Interrupted' })
    expect(userTexts(t.core, chat.id)).toEqual(['one', 'two'])

    const emits: ((event: EngineEvent) => void)[] = []
    const failing = setup(
      stubAdapter((_machine, _options, emit) => {
        emits.push(emit)
        return { prompt() {}, interrupt() {}, respond() {}, close() {} }
      }),
    )
    const other = addProject(failing)
    failing.handle({ type: 'chat.send', chatId: other.id, text: 'go' })
    failing.handle({ type: 'chat.send', chatId: other.id, text: 'next' })
    emits[0]?.({ type: 'session.ended', error: 'crashed' })
    expect(userTexts(failing.core, other.id)).toEqual(['go', 'next'])
    expect(statusOf(failing.core, other.id)).toBe('running')
  })

  it('removes a queued message by id, ignoring one that is already gone', () => {
    const t = setup(permissionScript)
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'one' })
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'two' })
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'three' })
    const [two] = chatOf(t.core, chat.id)?.queue ?? []
    if (!two) throw new Error('nothing queued')
    t.handle({ type: 'chat.unqueue', chatId: chat.id, id: two.id })
    expect(queueOf(t.core, chat.id)).toEqual(['three'])
    expect(t.messages.at(-1)).toMatchObject({ type: 'chat.queue', queue: [{ text: 'three' }] })
    const count = t.messages.length
    t.handle({ type: 'chat.unqueue', chatId: chat.id, id: two.id })
    expect(t.messages).toHaveLength(count)
  })

  it('sends nothing queued while Hotrod quits', async () => {
    const t = setup(permissionScript)
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'one' })
    await until(() => statusOf(t.core, chat.id) === 'waiting')
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'two' })
    await t.core.close()
    expect(userTexts(t.core, chat.id)).toEqual(['one'])
    expect(t.calls).toHaveLength(1)
  })

  it('keeps the queue and reports why when it cannot be sent', async () => {
    const t = setup(permissionScript)
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'one' })
    await until(() => statusOf(t.core, chat.id) === 'waiting')
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'two' })
    t.handle({ type: 'engine.setEnabled', engine: 'fake', enabled: false })
    t.handle({ type: 'chat.interrupt', chatId: chat.id })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    expect(userTexts(t.core, chat.id)).toEqual(['one'])
    expect(queueOf(t.core, chat.id)).toEqual(['two'])
    expect(t.messages).toContainEqual({ type: 'error', message: expect.stringMatching(/is off/) })

    t.handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true })
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'three' })
    expect(userTexts(t.core, chat.id)).toEqual(['one', 'two\n\nthree'])
    expect(queueOf(t.core, chat.id)).toEqual([])
  })

  it('still refuses an empty message', () => {
    const t = setup(permissionScript)
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'one' })
    expect(() => t.handle({ type: 'chat.send', chatId: chat.id, text: '  ' })).toThrow(/empty/)
    expect(queueOf(t.core, chat.id)).toEqual([])
  })
})

describe('interrupt', () => {
  const ignoresInterrupt = (onInterrupt: (emit: (event: EngineEvent) => void) => void = () => {}) =>
    stubAdapter((_machine, _options, emit) => ({
      prompt() {
        emit({ type: 'turn.started' })
        emit({ type: 'text.delta', text: 'partial' })
      },
      interrupt: () => onInterrupt(emit),
      respond() {},
      close() {},
    }))

  it('shows the chat as stopping, then force-stops an engine that ignores the interrupt', async () => {
    let emitLate: ((event: EngineEvent) => void) | undefined
    const t = setup(ignoresInterrupt((emit) => (emitLate = emit)))
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'go' })
    t.handle({ type: 'chat.interrupt', chatId: chat.id })
    expect(statusOf(t.core, chat.id)).toBe('stopping')
    expect(t.messages).toContainEqual({ type: 'chat.status', chatId: chat.id, status: 'stopping' })
    await until(() => statusOf(t.core, chat.id) === 'idle')

    const entries = entriesOf(t.core, chat.id)
    expect(entries.slice(-2)).toMatchObject([
      { type: 'text.completed', text: 'partial' },
      { type: 'turn.completed', error: 'Interrupted' },
    ])
    expect(t.calls[0]).toMatchObject({ closed: true })
    emitLate?.({ type: 'turn.completed' })
    expect(entriesOf(t.core, chat.id)).toHaveLength(entries.length)
  })

  it('force-stops at once when asked, keeping the text streamed so far', () => {
    const t = setup(ignoresInterrupt())
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'go' })
    t.handle({ type: 'chat.interrupt', chatId: chat.id })
    t.handle({ type: 'chat.interrupt', chatId: chat.id, force: true })
    expect(statusOf(t.core, chat.id)).toBe('idle')
    expect(entriesOf(t.core, chat.id).slice(-2)).toMatchObject([
      { type: 'text.completed', text: 'partial' },
      { type: 'turn.completed', error: 'Interrupted' },
    ])
    expect(t.calls[0]).toMatchObject({ closed: true })
  })

  it('stays stopping while the engine winds down', () => {
    const t = setup(
      ignoresInterrupt((emit) =>
        emit({ type: 'permission.requested', requestId: 'r1', name: 'Bash', kind: 'shell', summary: 'ls', input: {} }),
      ),
    )
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'go' })
    t.handle({ type: 'chat.interrupt', chatId: chat.id })
    expect(statusOf(t.core, chat.id)).toBe('stopping')
  })

  it('closes a session gently once the engine stops in time', async () => {
    const t = setup(permissionScript)
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'go' })
    await until(() => statusOf(t.core, chat.id) === 'waiting')
    t.handle({ type: 'chat.interrupt', chatId: chat.id })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    expect(t.calls[0]).toMatchObject({ closed: true })
    await new Promise((r) => setTimeout(r, TEST_STOP_GRACE_MS * 3))
    expect(entriesOf(t.core, chat.id).filter((e) => e.type === 'turn.completed')).toHaveLength(1)
  })

})

describe('quit', () => {
  const ignoresInterrupt = () =>
    stubAdapter((_machine, _options, emit) => ({
      prompt() {
        emit({ type: 'turn.started' })
        emit({ type: 'text.delta', text: 'partial' })
      },
      interrupt() {},
      respond() {},
      close() {},
    }))

  it('asks a busy engine to stop first and closes its session once the turn ends', async () => {
    const t = setup(permissionScript)
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'go' })
    await until(() => statusOf(t.core, chat.id) === 'waiting')
    await t.core.close()
    expect(t.calls[0]).toMatchObject({ interrupted: true, closed: true })
    expect(entriesOf(t.core, chat.id).at(-1)).toMatchObject({ type: 'turn.completed', error: 'Interrupted' })
  })

  it('shows a busy chat as stopping and forces it after the stop grace', async () => {
    const t = setup(ignoresInterrupt())
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'go' })
    let closed = false
    const closing = t.core.close().then(() => (closed = true))
    expect(t.calls[0]).toMatchObject({ interrupted: true, closed: false })
    expect(statusOf(t.core, chat.id)).toBe('stopping')
    expect(closed).toBe(false)
    await closing
    expect(t.calls[0]?.closed).toBe(true)
    expect(entriesOf(t.core, chat.id).slice(-2)).toMatchObject([
      { type: 'text.completed', text: 'partial' },
      { type: 'turn.completed', error: 'Interrupted' },
    ])
  })

  it('skips the interrupt on a forced quit and closes every session at once', async () => {
    const t = setup(ignoresInterrupt())
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'go' })
    await t.core.close(true)
    expect(t.calls[0]).toMatchObject({ closed: true })
    expect(t.calls[0]?.interrupted).toBeUndefined()
    expect(statusOf(t.core, chat.id)).toBe('idle')
  })

  it('ends a waiting quit when it is forced', async () => {
    const longGraceMs = 60_000
    const t = setup(ignoresInterrupt(), tempDir(), longGraceMs)
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'go' })
    const start = performance.now()
    const closing = t.core.close()
    await t.core.close(true)
    await closing
    expect(performance.now() - start).toBeLessThan(longGraceMs / 2)
    expect(t.calls[0]).toMatchObject({ interrupted: true, closed: true })
  })

  it('refuses new messages while quitting', () => {
    const t = setup(ignoresInterrupt())
    const busy = addProject(t)
    const idle = addProject(t)
    t.handle({ type: 'chat.send', chatId: busy.id, text: 'go' })
    void t.core.close()
    expect(() => t.handle({ type: 'chat.send', chatId: idle.id, text: 'hi' })).toThrow(/quitting/)
  })
})

describe('engine failures', () => {
  it('records an engine that throws on start and stays usable', () => {
    const t = setup(
      stubAdapter(() => {
        throw new Error('claude: command not found')
      }),
    )
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })
    expect(statusOf(t.core, chat.id)).toBe('idle')
    const last = entriesOf(t.core, chat.id).at(-1)
    expect(last).toMatchObject({ type: 'turn.completed', error: expect.stringContaining('command not found') })
    expect(t.messages).toContainEqual({ type: 'chat.entry', chatId: chat.id, entry: last })
    expect(t.messages.flatMap((m) => (m.type === 'chat.status' ? [m.status] : []))).toEqual(['running', 'idle'])
    expect(() => t.handle({ type: 'chat.send', chatId: chat.id, text: 'again' })).not.toThrow()
  })

  it('records an engine process that fails to spawn', async () => {
    const t = setup(
      stubAdapter((machine, options, emit) => {
        const proc = machine.spawn('hotrod-test-missing-engine', [], { cwd: options.cwd })
        proc.onExit((code, stderr) => emit({ type: 'session.ended', error: stderr || `exited with code ${code}` }))
        return {
          prompt(text) {
            proc.write(text)
            emit({ type: 'turn.started' })
          },
          interrupt() {},
          respond() {},
          close: () => proc.kill(),
        }
      }),
    )
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    const last = entriesOf(t.core, chat.id).at(-1)
    expect(last).toMatchObject({ type: 'session.ended', error: expect.stringContaining('ENOENT') })
  })

  it('does not prompt an engine that ended while starting', () => {
    let prompted = false
    const t = setup(
      stubAdapter((_machine, _options, emit) => {
        emit({ type: 'session.ended', error: 'no engine' })
        return {
          prompt() {
            prompted = true
            emit({ type: 'turn.started' })
          },
          interrupt() {},
          respond() {},
          close() {},
        }
      }),
    )
    const chat = addProject(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })
    expect(statusOf(t.core, chat.id)).toBe('idle')
    expect(types(entriesOf(t.core, chat.id))).toEqual(['user.message', 'session.ended'])
    expect(prompted).toBe(false)
    expect(t.calls[0]?.closed).toBe(true)
  })
})

describe('accounts', () => {
  function setupAccounts(script: FakeStep[] = textScript, garage = tempDir()) {
    const logouts: string[] = []
    const fake = createFakeAdapter(script, 0)
    const logout = async (_machine: unknown, dir: string) => void logouts.push(dir)
    const adapter: Adapter = { ...fake, accounts: { ...fake.accounts!, logout } }
    const { adapter: wrapped, calls } = recording(adapter)
    return { ...open(garage, [wrapped, { ...stubAdapter(() => ({}) as never), id: 'plain' }], 'fake'), calls, logouts }
  }

  const accountsOf = (core: Core) => core.accounts().find((a) => a.engine === 'fake')!
  const accountDir = (garage: string, id: string) => join(garage, 'accounts', 'fake', id)

  async function signIn(t: ReturnType<typeof setupAccounts>, name: string) {
    t.handle({ type: 'account.login', engine: 'fake', name })
    await until(() => accountsOf(t.core).login?.url !== undefined)
    t.handle({ type: 'account.code', engine: 'fake', code: 'ok' })
    await until(() => !accountsOf(t.core).login)
  }

  it("lists the engine's own login as the default account, only for engines with accounts", async () => {
    const t = setupAccounts()
    await t.core.refreshAccounts()
    expect(t.core.accounts()).toEqual([
      {
        engine: 'fake',
        active: 'default',
        apiKeys: true,
        accounts: [{ id: 'default', name: 'Default', kind: 'login', label: 'default@fake.test', signedIn: true }],
      },
    ])
  })

  it('signs in a new account in its own folder and keeps it across a restart', async () => {
    const t = setupAccounts()
    t.handle({ type: 'account.login', engine: 'fake', name: 'Work' })
    expect(t.messages.at(-1)).toMatchObject({ type: 'accounts.updated', accounts: { login: { name: 'Work' } } })
    await until(() => accountsOf(t.core).login?.url !== undefined)
    expect(() => t.handle({ type: 'account.login', engine: 'fake', name: 'Other' })).toThrow(/already/)
    t.handle({ type: 'account.code', engine: 'fake', code: 'ok' })
    await until(() => !accountsOf(t.core).login)

    const work = { id: 'work', name: 'Work', kind: 'login', label: 'work@fake.test', signedIn: true }
    expect(accountsOf(t.core).accounts.at(-1)).toEqual(work)
    expect(existsSync(accountDir(t.garage, 'work'))).toBe(true)
    await signIn(t, 'work')
    expect(accountsOf(t.core).accounts.map((a) => a.id)).toEqual(['default', 'work', 'work-2'])

    const reopened = setupAccounts(textScript, t.garage)
    await reopened.core.refreshAccounts()
    expect(accountsOf(reopened.core).accounts.map((a) => a.id)).toEqual(['default', 'work', 'work-2'])
  })

  it('reports a failed sign-in, removes its folder and clears it on cancel', async () => {
    const t = setupAccounts()
    t.handle({ type: 'account.login', engine: 'fake', name: 'Work' })
    await until(() => accountsOf(t.core).login?.url !== undefined)
    t.handle({ type: 'account.code', engine: 'fake', code: 'fail' })
    await until(() => accountsOf(t.core).login?.error !== undefined)
    expect(existsSync(accountDir(t.garage, 'work'))).toBe(false)
    t.handle({ type: 'account.cancelLogin', engine: 'fake' })
    expect(accountsOf(t.core).login).toBeUndefined()
    expect(accountsOf(t.core).accounts.map((a) => a.id)).toEqual(['default'])
  })

  it('starts sessions with the active account and switches only while idle', async () => {
    const t = setupAccounts(permissionScript)
    await signIn(t, 'Work')
    const chat = addProject(t)

    t.handle({ type: 'account.use', engine: 'fake', accountId: 'work' })
    expect(accountsOf(t.core).active).toBe('work')
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })
    expect(t.calls[0]?.options.accountDir).toBe(accountDir(t.garage, 'work'))
    await until(() => statusOf(t.core, chat.id) === 'waiting')
    expect(() => t.handle({ type: 'account.use', engine: 'fake', accountId: 'default' })).toThrow(/turn/)
    expect(() => t.handle({ type: 'account.use', engine: 'fake', accountId: 'nope' })).toThrow(/Unknown account/)
    t.handle({ type: 'chat.interrupt', chatId: chat.id })
    await until(() => statusOf(t.core, chat.id) === 'idle')

    t.handle({ type: 'account.use', engine: 'fake', accountId: 'default' })
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'again' })
    expect(t.calls[1]?.options.accountDir).toBeUndefined()
    const reopened = setupAccounts(textScript, t.garage)
    expect(accountsOf(reopened.core).active).toBe('default')
  })

  it('removes an account: logs it out, deletes its folder and falls back to the default', async () => {
    const t = setupAccounts()
    await signIn(t, 'Work')
    t.handle({ type: 'account.use', engine: 'fake', accountId: 'work' })
    expect(() => t.handle({ type: 'account.remove', engine: 'fake', accountId: 'default' })).toThrow(/default/)
    t.handle({ type: 'account.remove', engine: 'fake', accountId: 'work' })
    await until(() => accountsOf(t.core).accounts.length === 1)
    expect(t.logouts).toEqual([accountDir(t.garage, 'work')])
    expect(existsSync(accountDir(t.garage, 'work'))).toBe(false)
    expect(accountsOf(t.core).active).toBe('default')
  })

  it('rejects account messages for an engine without accounts', () => {
    const t = setupAccounts()
    expect(() => t.handle({ type: 'account.login', engine: 'plain', name: 'Work' })).toThrow(/accounts/)
  })

  describe('API keys', () => {
    const key = 'sk-ant-test-0000-secret-1234abcd'
    const addKey = (t: ReturnType<typeof setupAccounts>, name = 'Billing', apiKey = `  ${key}\n`) =>
      t.handle({ type: 'account.addApiKey', engine: 'fake', name, key: apiKey })

    it('keeps the key in a 0600 file in its own folder and shows only its last 4 characters', async () => {
      const t = setupAccounts()
      addKey(t)
      const label = 'API key ••••abcd'
      const billing = { id: 'billing', name: 'Billing', kind: 'apiKey', label, signedIn: true }
      expect(accountsOf(t.core).accounts.at(-1)).toEqual(billing)
      const keyFile = join(accountDir(t.garage, 'billing'), 'api-key')
      expect(readFileSync(keyFile, 'utf8')).toBe(key)
      expect(statSync(keyFile).mode & 0o777).toBe(0o600)
      expect(readFileSync(join(t.garage, 'accounts', 'fake.json'), 'utf8')).not.toContain(key)
      expect(JSON.stringify([t.messages, t.replies, t.core.accounts()])).not.toContain(key)

      await t.core.refreshAccounts()
      const reopened = setupAccounts(textScript, t.garage)
      await reopened.core.refreshAccounts()
      expect(accountsOf(reopened.core).accounts.at(-1)).toEqual(billing)
    })

    it('starts sessions with the key and its folder, and never writes the key to the chat log', async () => {
      const t = setupAccounts()
      addKey(t)
      const chat = addProject(t)
      t.handle({ type: 'account.use', engine: 'fake', accountId: 'billing' })
      t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })
      expect(t.calls[0]?.options).toMatchObject({ accountDir: accountDir(t.garage, 'billing'), apiKey: key })
      await until(() => statusOf(t.core, chat.id) === 'idle')
      const log = readFileSync(join(t.garage, 'projects', chat.projectId, 'chats', 'main', 'log.jsonl'), 'utf8')
      expect(log).not.toContain(key)
      expect(JSON.stringify(t.messages)).not.toContain(key)
    })

    it('removes a key account without signing out', async () => {
      const t = setupAccounts()
      addKey(t)
      t.handle({ type: 'account.remove', engine: 'fake', accountId: 'billing' })
      await until(() => accountsOf(t.core).accounts.length === 1)
      expect(t.logouts).toEqual([])
      expect(existsSync(accountDir(t.garage, 'billing'))).toBe(false)
    })

    it('rejects an empty or spaced key without echoing it, and engines without key support', () => {
      const t = setupAccounts()
      expect(() => addKey(t, 'Billing', '   ')).toThrow(/Paste/)
      let error = ''
      try {
        addKey(t, 'Billing', 'sk-ant one')
      } catch (e) {
        error = String(e)
      }
      expect(error).toMatch(/space/)
      expect(error).not.toContain('sk-ant')
      expect(() => addKey(t, ' ')).toThrow(/name/)
      expect(accountsOf(t.core).accounts.map((a) => a.id)).toEqual(['default'])
      expect(existsSync(join(t.garage, 'accounts', 'fake', 'billing'))).toBe(false)

      const fake = createFakeAdapter(textScript, 0)
      const noKeys: Adapter = { ...fake, id: 'nokeys', accounts: { ...fake.accounts!, apiKeys: false } }
      const plain = open(tempDir(), [noKeys], 'nokeys')
      expect(plain.core.accounts()[0]?.apiKeys).toBe(false)
      const message = { type: 'account.addApiKey', engine: 'nokeys', name: 'Billing', key } as const
      expect(() => plain.handle(message)).toThrow(/API keys/)
    })
  })
})

describe('context', () => {
  const layersOf = (t: ReturnType<typeof open>, chatId: string) => {
    t.handle({ type: 'context.get', chatId })
    const reply = t.replies.findLast((m) => m.type === 'chat.context')
    if (reply?.type !== 'chat.context' || reply.chatId !== chatId) throw new Error('no chat.context')
    return reply.layers
  }
  const kinds = (t: ReturnType<typeof open>, chatId: string) => layersOf(t, chatId).map((l) => l.kind)
  const instructionsOf = async (t: ReturnType<typeof setup>, chatId: string) => {
    t.handle({ type: 'chat.send', chatId, text: 'hi' })
    await until(() => statusOf(t.core, chatId) === 'idle')
    return t.calls.at(-1)?.options.instructions ?? ''
  }

  it('gives each chat the layers from the root down to itself', () => {
    const t = setup(textScript)
    const repo = tempDir()
    writeFileSync(join(repo, 'AGENTS.md'), 'REPO RULES')
    const projectMain = addProject(t, repo)
    const projectSub = createChat(t, projectMain.projectId)
    const homeSub = createChat(t)

    expect(kinds(t, 'main')).toEqual(['workshop'])
    expect(kinds(t, homeSub.id)).toEqual(['workshop', 'own'])
    expect(kinds(t, projectMain.id)).toEqual(['workshop', 'repo', 'project'])
    expect(kinds(t, projectSub.id)).toEqual(['workshop', 'repo', 'project', 'own'])

    const layers = layersOf(t, projectSub.id)
    expect(layers.map((l) => l.path)).toEqual([
      join(t.garage, 'AGENTS.md'),
      join(projectMain.path, 'AGENTS.md'),
      join(t.garage, 'projects', projectMain.projectId, 'AGENTS.md'),
      join(t.garage, 'projects', projectMain.projectId, 'chats', projectSub.id, 'AGENTS.md'),
    ])
    expect(layers.map((l) => [l.enabled, l.writable, l.text])).toEqual([
      [true, true, ''],
      [true, false, 'REPO RULES'],
      [true, true, ''],
      [true, true, ''],
    ])
  })

  it('injects the enabled layers root first, and a parent never sees its child', async () => {
    const t = setup(textScript)
    const repo = tempDir()
    writeFileSync(join(repo, 'AGENTS.md'), 'REPO RULES')
    const projectMain = addProject(t, repo)
    const projectSub = createChat(t, projectMain.projectId)
    const homeSub = createChat(t)
    t.handle({ type: 'context.write', chatId: 'main', kind: 'workshop', text: 'WORKSHOP RULES' })
    t.handle({ type: 'context.write', chatId: projectMain.id, kind: 'project', text: 'PROJECT RULES' })
    t.handle({ type: 'context.write', chatId: projectSub.id, kind: 'own', text: 'SUB RULES' })
    t.handle({ type: 'context.write', chatId: homeSub.id, kind: 'own', text: 'HOME SUB RULES' })

    const sub = await instructionsOf(t, projectSub.id)
    const order = ['WORKSHOP RULES', 'REPO RULES', 'PROJECT RULES', 'SUB RULES'].map((text) => sub.indexOf(text))
    expect(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1]!))).toBe(true)
    expect(sub).not.toContain('HOME SUB RULES')

    const projectRules = await instructionsOf(t, projectMain.id)
    expect(projectRules).toContain('PROJECT RULES')
    expect(projectRules).not.toContain('SUB RULES')
    expect(await instructionsOf(t, 'main')).toBe('WORKSHOP RULES')
    expect(await instructionsOf(t, homeSub.id)).toBe('WORKSHOP RULES\n\nHOME SUB RULES')
  })

  it('turns a layer off for one chat, saves it in chat.json and tells every client', async () => {
    const t = setup(textScript)
    const repo = tempDir()
    writeFileSync(join(repo, 'AGENTS.md'), 'REPO RULES')
    const projectMain = addProject(t, repo)
    const projectSub = createChat(t, projectMain.projectId)
    t.handle({ type: 'context.write', chatId: 'main', kind: 'workshop', text: 'WORKSHOP RULES' })

    t.handle({ type: 'context.set', chatId: projectSub.id, kind: 'repo', enabled: false })
    const updated = t.messages.at(-1)
    if (updated?.type !== 'chat.context') throw new Error('no chat.context')
    expect(updated.chatId).toBe(projectSub.id)
    expect(updated.layers.find((l) => l.kind === 'repo')?.enabled).toBe(false)
    const file = join(t.garage, 'projects', projectMain.projectId, 'chats', projectSub.id, 'chat.json')
    expect(JSON.parse(readFileSync(file, 'utf8')).context).toEqual({ repo: false })

    expect(await instructionsOf(t, projectSub.id)).toBe('WORKSHOP RULES')
    expect(await instructionsOf(t, projectMain.id)).toBe('WORKSHOP RULES\n\nREPO RULES')

    t.handle({ type: 'context.set', chatId: 'main', kind: 'workshop', enabled: false })
    expect(await instructionsOf(t, 'main')).toBe('')
    expect(await instructionsOf(t, projectSub.id)).toBe('WORKSHOP RULES')

    t.core.close()
    const reopened = setup(textScript, t.garage)
    expect(layersOf(reopened, projectSub.id).find((l) => l.kind === 'repo')?.enabled).toBe(false)
    expect(chatOf(reopened.core, projectSub.id)).not.toHaveProperty('context')
    expect(() => reopened.handle({ type: 'context.set', chatId: 'main', kind: 'repo', enabled: false })).toThrow(
      /no "repo" layer/,
    )
  })

  it('falls back to the defaults in settings.json, keeping the other settings', () => {
    const garage = tempDir()
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ theme: 'dark' }))
    const t = setup(textScript, garage)
    expect(t.core.contextDefaults()).toEqual({ workshop: true, repo: true, project: true, parent: true, own: true })
    const sub = createChat(t)
    t.handle({ type: 'context.set', chatId: sub.id, kind: 'workshop', enabled: true })

    t.handle({ type: 'context.setDefault', kind: 'own', enabled: false })
    t.handle({ type: 'context.setDefault', kind: 'workshop', enabled: false })
    const defaults = { workshop: false, repo: true, project: true, parent: true, own: false }
    expect(t.messages.at(-1)).toEqual({ type: 'context.defaults', defaults })
    expect(JSON.parse(readFileSync(join(garage, 'settings.json'), 'utf8'))).toEqual({
      theme: 'dark',
      engines: { fake: true },
      context: { own: false, workshop: false },
    })
    expect(layersOf(t, sub.id).map((l) => l.enabled)).toEqual([true, false])
    expect(layersOf(t, 'main').map((l) => l.enabled)).toEqual([false])
    expect(() => t.handle({ type: 'context.setDefault', kind: 'nope', enabled: false } as never)).toThrow(
      /Unknown context layer/,
    )

    t.core.close()
    expect(setup(textScript, garage).core.contextDefaults()).toEqual(defaults)
  })

  it('writes a layer file, creating its folder, and tells every client', () => {
    const t = setup(textScript)
    const projectMain = addProject(t)
    const file = join(t.garage, 'projects', projectMain.projectId, 'AGENTS.md')
    rmSync(join(t.garage, 'projects', projectMain.projectId), { recursive: true })

    t.handle({ type: 'context.write', chatId: projectMain.id, kind: 'project', text: 'PROJECT RULES\n' })
    expect(readFileSync(file, 'utf8')).toBe('PROJECT RULES\n')
    expect(t.messages.at(-1)).toEqual({ type: 'context.file', path: file, text: 'PROJECT RULES\n' })
    expect(layersOf(t, projectMain.id).find((l) => l.kind === 'project')?.text).toBe('PROJECT RULES\n')
  })

  it('never writes the repo layer, and keeps archived chats read-only', () => {
    const t = setup(textScript)
    const repo = tempDir()
    writeFileSync(join(repo, 'AGENTS.md'), 'REPO RULES')
    const projectMain = addProject(t, repo)
    expect(() => t.handle({ type: 'context.write', chatId: projectMain.id, kind: 'repo', text: 'x' })).toThrow(
      /project folder/,
    )
    expect(readFileSync(join(repo, 'AGENTS.md'), 'utf8')).toBe('REPO RULES')

    const sub = createChat(t)
    t.handle({ type: 'chat.archive', chatId: sub.id, archived: true })
    expect(() => t.handle({ type: 'context.write', chatId: sub.id, kind: 'own', text: 'x' })).toThrow(/archived/)
    expect(() => t.handle({ type: 'context.set', chatId: sub.id, kind: 'own', enabled: false })).toThrow(/archived/)
    t.handle({ type: 'project.archive', projectId: projectMain.projectId, archived: true })
    expect(() =>
      t.handle({ type: 'context.write', chatId: projectMain.id, kind: 'project', text: 'x' }),
    ).toThrow(/archived/)
    expect(layersOf(t, sub.id)).toHaveLength(2)
  })
})

describe('subagents mod', () => {
  it('is off by default, and saves its switch and limit in settings.json', () => {
    const garage = tempDir()
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ theme: 'dark' }))
    const t = setup(textScript, garage)
    expect(t.core.mods()).toEqual({ subagents: { enabled: false, limit: DEFAULT_SUBAGENT_LIMIT } })

    t.handle({ type: 'subagents.set', enabled: true, limit: -1 })
    const mods = { subagents: { enabled: true, limit: -1 } }
    expect(t.messages.at(-1)).toEqual({ type: 'mods.updated', mods })
    expect(JSON.parse(readFileSync(join(garage, 'settings.json'), 'utf8'))).toMatchObject({ theme: 'dark', mods })

    for (const limit of [-2, 1.5, '3', undefined]) {
      expect(() => t.handle({ type: 'subagents.set', enabled: true, limit } as never)).toThrow(/limit/)
    }
    expect(t.core.mods()).toEqual(mods)
    t.core.close()
    expect(setup(textScript, garage).core.mods()).toEqual(mods)
  })
})
