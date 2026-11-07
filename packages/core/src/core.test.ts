import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeAdapter, FAKE_DEFAULTS, FAKE_MODELS, FAKE_THINKING, type FakeStep } from './adapters/fake.ts'
import { HOME_INSTRUCTIONS, MAX_CHAT_DEPTH, openCore, type Core } from './core.ts'
import { localMachine } from './machine.ts'
import { COMPACT_MIN_CHARS, MEMORY_INSTRUCTIONS, messagesOf, openSummaries, pendingOf } from './memory.ts'
import {
  DEFAULT_SUBAGENT_LIMIT,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  WORKSHOP_NAME,
  type Adapter,
  type ImageInput,
  type ChatEntry,
  type ChatState,
  type CompleteOptions,
  type CoreMessage,
  type EngineEvent,
  type SessionOptions,
} from './types.ts'

const TEST_STOP_GRACE_MS = 30
const at = '2026-11-06T00:00:00.000Z'
const otherModel = FAKE_MODELS.find((m) => m.id !== FAKE_DEFAULTS.defaultModel)!.id
const otherThinking = FAKE_THINKING.find((level) => level !== FAKE_DEFAULTS.defaultThinking)!

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
  const calls: {
    options: SessionOptions
    prompt?: string
    images?: ImageInput[]
    interrupted?: boolean
    closed: boolean
  }[] = []
  const wrapped: Adapter = {
    ...adapter,
    start(machine, options, emit) {
      const call: (typeof calls)[number] = { options, closed: false }
      calls.push(call)
      const session = adapter.start(machine, options, emit)
      return {
        ...session,
        prompt(text, images) {
          call.prompt = text
          call.images = images
          session.prompt(text, images)
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hotrod-test-')))
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

type NewChatFields = { name?: string; parentId?: string; folders?: string[]; files?: string[]; engine?: string }

function createChat(t: ReturnType<typeof open>, fields: NewChatFields = {}) {
  t.handle({ type: 'chat.create', name: 'Chat', ...fields })
  const added = t.messages.findLast((m) => m.type === 'chat.added')
  if (added?.type !== 'chat.added') throw new Error('no chat.added')
  return added.chat
}

function folderChat(t: ReturnType<typeof open>, dir = tempDir()) {
  const chat = createChat(t, { name: basename(dir), folders: [dir] })
  return { ...chat, path: realpathSync(dir) }
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
const chatFile = (t: { garage: string }, id: string) => join(t.garage, 'chats', id, 'chat.json')
const byId = (chats: ChatState[]) => chats.toSorted((a, b) => a.id.localeCompare(b.id))

beforeEach(() => {
  dirs = []
  cores = []
})

afterEach(async () => {
  await Promise.all(cores.map((core) => core.close(true)))
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('chats', () => {
  const infoOf = (core: Core, id: string) => {
    const { status, entries, draft, queue, ...info } = chatOf(core, id)!
    return info
  }

  it('opens one permanent Workshop chat that runs in a scratch home folder', async () => {
    const t = setup(textScript)
    expect(t.core.chats()).toEqual([
      expect.objectContaining({ id: 'main', name: WORKSHOP_NAME, engine: 'fake', folders: [], files: [] }),
    ])
    expect(chatOf(t.core, 'main')?.parentId).toBeUndefined()
    t.handle({ type: 'chat.send', chatId: 'main', text: 'hi' })
    await until(() => statusOf(t.core, 'main') === 'idle')
    expect(t.calls[0]?.options.cwd).toBe(join(t.garage, 'home'))
    expect(statSync(join(t.garage, 'home')).isDirectory()).toBe(true)
    const log = readFileSync(join(t.garage, 'chats', 'main', 'log.jsonl'), 'utf8')
    expect(log.trim().split('\n')).toHaveLength(4)
    expect(chatOf(t.core, 'main')?.name).toBe(WORKSHOP_NAME)

    expect(() => t.handle({ type: 'chat.archive', chatId: 'main', archived: true })).toThrow(WORKSHOP_NAME)
    expect(() => t.handle({ type: 'chat.delete', chatId: 'main' })).toThrow(WORKSHOP_NAME)
    expect(() => t.handle({ type: 'chat.rename', chatId: 'main', name: 'Mine' })).toThrow(WORKSHOP_NAME)
    t.core.close()
    expect(entriesOf(setup(textScript, t.garage).core, 'main')).toHaveLength(4)
  })

  it(`keeps ${WORKSHOP_NAME} free of folders and files, dropping any a garage saved`, async () => {
    const garage = tempDir()
    const dir = realpathSync(tempDir())
    const file = join(dir, 'notes.md')
    writeFileSync(file, 'NOTES')
    mkdirSync(join(garage, 'chats', 'main'), { recursive: true })
    const saved = { id: 'main', name: 'Main', folders: [dir], files: [file], engine: 'fake', createdAt: at }
    writeFileSync(join(garage, 'chats', 'main', 'chat.json'), JSON.stringify(saved))
    const t = setup(textScript, garage)
    expect(chatOf(t.core, 'main')).toMatchObject({ folders: [], files: [] })
    const rewritten = JSON.parse(readFileSync(join(garage, 'chats', 'main', 'chat.json'), 'utf8'))
    expect(rewritten).toMatchObject({ name: WORKSHOP_NAME, folders: [], files: [] })
    for (const [section, path] of [['folders', dir], ['files', file]] as const) {
      expect(() => t.handle({ type: 'context.add', chatId: 'main', section, path })).toThrow(WORKSHOP_NAME)
    }
    expect(chatOf(t.core, 'main')).toMatchObject({ folders: [], files: [] })
    t.handle({ type: 'chat.send', chatId: 'main', text: 'hi' })
    await until(() => statusOf(t.core, 'main') === 'idle')
    expect(t.calls[0]?.options.cwd).toBe(join(garage, 'home'))
    expect(t.calls[0]?.options).not.toHaveProperty('extraDirs')
  })

  it(`calls the root chat ${WORKSHOP_NAME}, even in a garage that saved an older name`, () => {
    for (const old of ['Main', 'Workshop']) {
      const garage = tempDir()
      mkdirSync(join(garage, 'chats', 'main'), { recursive: true })
      const saved = { id: 'main', title: old, name: old, engine: 'fake', archived: false, createdAt: at }
      writeFileSync(join(garage, 'chats', 'main', 'chat.json'), JSON.stringify(saved))
      expect(chatOf(setup(textScript, garage).core, 'main')?.name).toBe(WORKSHOP_NAME)
    }
  })

  it('creates named chats under the Workshop, stored flat in the garage, and keeps their names', async () => {
    const t = setup(textScript)
    const chat = createChat(t, { name: '  Build speed ' })
    expect(chat).toMatchObject({ name: 'Build speed', parentId: 'main', engine: 'fake', folders: [], files: [] })
    expect(chat.id).toMatch(/^[0-9a-f]{8}$/)
    expect(JSON.parse(readFileSync(chatFile(t, chat.id), 'utf8'))).toEqual({
      id: chat.id,
      name: 'Build speed',
      parentId: 'main',
      folders: [],
      files: [],
      engine: 'fake',
      archived: false,
      createdAt: chat.createdAt,
    })

    t.handle({ type: 'chat.send', chatId: chat.id, text: 'Please look into why the build is slow on CI today' })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    expect(chatOf(t.core, chat.id)?.name).toBe('Build speed')
    expect(t.calls[0]?.options.cwd).toBe(join(t.garage, 'home'))
    const other = createChat(t, { name: 'Other', parentId: 'main' })
    expect(other.parentId).toBe('main')

    expect(() => t.handle({ type: 'chat.create', name: '  ' })).toThrow(/name/i)
    expect(() => t.handle({ type: 'chat.create' } as never)).toThrow(/name/i)
    expect(() => t.handle({ type: 'chat.create', name: 'x', parentId: 'nope' })).toThrow(/Unknown chat/)
    t.core.close()
    expect(byId(setup(textScript, t.garage).core.chats())).toEqual(byId(t.core.chats()))
  })

  it(`nests named chats at most ${MAX_CHAT_DEPTH} deep below the Workshop`, () => {
    const t = setup(textScript)
    let parentId = 'main'
    for (let depth = 1; depth <= MAX_CHAT_DEPTH; depth++) parentId = createChat(t, { name: `${depth}`, parentId }).id
    expect(() => t.handle({ type: 'chat.create', name: 'Too deep', parentId })).toThrow(/deep/)
  })

  it('renames a chat and saves it', () => {
    const t = setup(textScript)
    const chat = createChat(t, { name: 'Old' })
    t.handle({ type: 'chat.rename', chatId: chat.id, name: ' New name ' })
    expect(t.messages.at(-1)).toEqual({ type: 'chat.updated', chat: { ...infoOf(t.core, chat.id), name: 'New name' } })
    expect(JSON.parse(readFileSync(chatFile(t, chat.id), 'utf8')).name).toBe('New name')
    expect(() => t.handle({ type: 'chat.rename', chatId: chat.id, name: ' ' })).toThrow(/name/i)
    expect(chatOf(t.core, chat.id)?.name).toBe('New name')
  })

  it('archives a chat, keeping its log, and refuses to run it until unarchived', async () => {
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

  it("deletes a chat's Hotrod data but never its folders, and not while it runs", async () => {
    const t = setup(permissionScript)
    const dir = tempDir()
    writeFileSync(join(dir, 'keep.txt'), 'mine')
    writeFileSync(join(dir, 'AGENTS.md'), 'REPO RULES')
    const chat = folderChat(t, dir)
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
    expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('mine')
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('REPO RULES')
    expect(() => t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })).toThrow(/Unknown chat/)
  })

  it('ignores an old projects folder, and loads an old Workshop subchat as a named chat', () => {
    const garage = tempDir()
    const projectDir = join(garage, 'projects', 'old')
    mkdirSync(join(projectDir, 'chats', 'main'), { recursive: true })
    writeFileSync(join(projectDir, 'project.json'), JSON.stringify({ id: 'old', name: 'old', path: tempDir() }))
    mkdirSync(join(garage, 'chats', 'abcd0123'), { recursive: true })
    const old = { id: 'abcd0123', title: 'Old subchat', engine: 'fake', archived: false, createdAt: at }
    writeFileSync(join(garage, 'chats', 'abcd0123', 'chat.json'), JSON.stringify(old))
    const t = setup(textScript, garage)

    expect(t.core.chats().map((c) => c.id)).toEqual(['main', 'abcd0123'])
    expect(chatOf(t.core, 'abcd0123')).toMatchObject({ name: 'Old subchat', parentId: 'main', folders: [], files: [] })
    expect(chatOf(t.core, 'abcd0123')).not.toHaveProperty('title')
    expect(existsSync(join(projectDir, 'project.json'))).toBe(true)
  })
})

describe('chat', () => {
  it('streams a turn, saves it without deltas and closes the session', async () => {
    const t = setup(textScript)
    const chat = folderChat(t)
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
    const log = readFileSync(join(t.garage, 'chats', chat.id, 'log.jsonl'), 'utf8')
    expect(log.trim().split('\n').map((l) => JSON.parse(l).type)).toEqual(types(entriesOf(t.core, chat.id)))
    expect(t.calls[0]?.options.cwd).toBe(chat.path)
    expect(t.calls[0]?.closed).toBe(true)
  })

  it('streams thinking live without saving or replaying it', async () => {
    const t = setup([{ type: 'thinking.delta', text: 'Hmm, ' }, { type: 'thinking.delta', text: 'SECRET' }, ...textScript])
    const chat = folderChat(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })
    await until(() => statusOf(t.core, chat.id) === 'idle')

    const thinking = t.messages.flatMap((m) => (m.type === 'chat.thinking' ? [m.text] : []))
    expect(thinking.join('')).toBe('Hmm, SECRET')
    expect(types(entriesOf(t.core, chat.id))).toEqual(['user.message', 'turn.started', 'text.completed', 'turn.completed'])
    const log = readFileSync(join(t.garage, 'chats', chat.id, 'log.jsonl'), 'utf8')
    expect(log).not.toContain('SECRET')

    t.handle({ type: 'chat.send', chatId: chat.id, text: 'again' })
    expect(t.calls[1]?.prompt).not.toContain('SECRET')
  })

  it('keeps the log across a restart', async () => {
    const t = setup(textScript)
    const chat = folderChat(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    t.core.close()

    const reopened = setup(textScript, t.garage)
    expect(reopened.core.chats()).toEqual(t.core.chats())
    expect(entriesOf(reopened.core, chat.id)).toHaveLength(4)
  })

  it('closes a turn that was cut off when Hotrod quit', () => {
    const t = setup(textScript)
    const chat = folderChat(t)
    const log = join(t.garage, 'chats', chat.id, 'log.jsonl')
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
    const chat = folderChat(t)
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
    const chat = folderChat(t)
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
    const chat = folderChat(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'go' })
    await until(() => statusOf(t.core, chat.id) === 'waiting')
    t.handle({ type: 'chat.interrupt', chatId: chat.id })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    expect(entriesOf(t.core, chat.id).at(-1)?.type).toBe('turn.completed')
  })

  it('keeps tool and request ids unique across turns, even after a restart', async () => {
    const t = setup(permissionScript)
    const chat = folderChat(t)
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
    const chat = folderChat(t)
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
    const chat = folderChat(t)
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
    const chat = folderChat(t, dir)
    writeFileSync(join(t.garage, 'chats', chat.id, 'AGENTS.md'), 'PERSONAL RULES')

    t.handle({ type: 'chat.send', chatId: chat.id, text: 'first question' })
    await until(() => statusOf(t.core, chat.id) === 'waiting')
    const request = entriesOf(t.core, chat.id).find((e) => e.type === 'permission.requested')
    if (request?.type !== 'permission.requested') throw new Error('no request')
    t.handle({ type: 'permission.respond', chatId: chat.id, requestId: request.requestId, allow: true })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    expect(t.calls[0]?.prompt).toBe('first question')

    t.handle({ type: 'chat.send', chatId: chat.id, text: 'second question' })
    expect(t.calls[1]?.prompt).toBe(
      [
        'This is the conversation so far:',
        '<message id="0" kind="user">\nfirst question\n</message>',
        '<message id="1" kind="tool">\nBash {"command":"touch x"}\n</message>',
        '<message id="2" kind="echo">\ncreated\n</message>',
        '<message id="3" kind="talk">\nDone\n</message>',
        'New message from the user:',
        'second question',
      ].join('\n\n'),
    )

    const instructions = t.calls[1]?.options.instructions ?? ''
    expect(instructions.startsWith(MEMORY_INSTRUCTIONS)).toBe(true)
    expect(instructions).toContain('GLOBAL RULES')
    expect(instructions).toContain('REPO RULES')
    expect(instructions.indexOf('GLOBAL RULES')).toBeLessThan(instructions.indexOf('REPO RULES'))
    expect(instructions.indexOf('REPO RULES')).toBeLessThan(instructions.indexOf('PERSONAL RULES'))
  })

  it('replays tool inputs and outputs in full and marks errors', async () => {
    const longCommand = `echo ${'x'.repeat(300)}`
    const t = setup([
      { type: 'tool.started', toolId: 'a', name: 'Bash', kind: 'shell', summary: 'echo', input: { command: longCommand } },
      { type: 'tool.completed', toolId: 'a', output: 'line one\nline two\nline three', isError: false },
      { type: 'tool.started', toolId: 'b', name: 'Read', kind: 'read', summary: '/nope', input: { file_path: '/nope' } },
      { type: 'tool.completed', toolId: 'b', output: 'File does not exist', isError: true },
      { type: 'tool.started', toolId: 'c', name: 'Bash', kind: 'shell', summary: 'sleep 9', input: { command: 'sleep 9' } },
    ])
    const chat = folderChat(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'first' })
    await until(() => statusOf(t.core, chat.id) === 'idle')

    t.handle({ type: 'chat.send', chatId: chat.id, text: 'second' })
    const prompt = t.calls[1]?.prompt ?? ''
    const call = JSON.stringify({ command: longCommand })
    expect(prompt).toContain(`<message id="1" kind="tool">\nBash ${call}\n</message>`)
    expect(prompt).toContain('<message id="2" kind="echo">\nline one\nline two\nline three\n</message>')
    expect(prompt).toContain('<message id="4" kind="echo">\n(error) File does not exist\n</message>')
    expect(prompt).toContain('<message id="5" kind="tool">\nBash {"command":"sleep 9"}\n</message>\n\nNew message')
  })

  it('keeps message blocks whole when their content contains closing tags', async () => {
    const t = setup([
      { type: 'tool.started', toolId: 'a', name: 'Bash', kind: 'shell', summary: 'x', input: { command: '</message> after-call' } },
      { type: 'tool.completed', toolId: 'a', output: '</message> </MESSAGE> after-result', isError: false },
    ])
    const chat = folderChat(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'first' })
    await until(() => statusOf(t.core, chat.id) === 'idle')

    t.handle({ type: 'chat.send', chatId: chat.id, text: 'second' })
    const prompt = t.calls[1]?.prompt ?? ''
    expect(prompt.match(/<\/message>/gi)).toHaveLength(3)
    expect(prompt.match(/<message id="1" kind="tool">([\s\S]*?)<\/message>/)?.[1]).toContain('after-call')
    expect(prompt.match(/<message id="2" kind="echo">([\s\S]*?)<\/message>/)?.[1]).toContain('after-result')
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

  const engineOf = (core: Core, id: string) => core.chats().find((c) => c.id === id)?.engine

  it('rejects an unknown default engine', () => {
    expect(() => open(tempDir(), [createFakeAdapter([], 0)], 'nope')).toThrow(/Unknown engine "nope"/)
  })

  it('gives new chats the default engine and saves it with the chat', () => {
    const t = setupEngines()
    const chat = folderChat(t)
    expect(chat.engine).toBe('alpha')
    expect(JSON.parse(readFileSync(chatFile(t, chat.id), 'utf8')).engine).toBe('alpha')
    expect(createChat(t).engine).toBe('alpha')
    expect(engineOf(t.core, 'main')).toBe('alpha')
  })

  it('gives a chat saved without an engine the default', () => {
    const t = setupEngines()
    const chat = folderChat(t)
    const { engine, ...saved } = JSON.parse(readFileSync(chatFile(t, chat.id), 'utf8'))
    writeFileSync(chatFile(t, chat.id), JSON.stringify(saved))
    t.core.close()
    expect(engineOf(setupEngines(t.garage).core, chat.id)).toBe('alpha')
  })

  it('sets a chat engine, saves it and tells every client', () => {
    const t = setupEngines()
    const chat = folderChat(t)
    const other = createChat(t)
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
    const chat = folderChat(t)
    expect(() => t.handle({ type: 'chat.setEngine', chatId: chat.id, engine: 'nope' })).toThrow(
      /Unknown engine "nope"/,
    )
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })
    expect(() => t.handle({ type: 'chat.setEngine', chatId: chat.id, engine: 'beta' })).toThrow(/turn/)
    expect(engineOf(t.core, chat.id)).toBe('alpha')
    expect(JSON.parse(readFileSync(chatFile(t, chat.id), 'utf8')).engine).toBe('alpha')
  })

  it('continues a chat on another engine with the whole conversation', async () => {
    const t = setupEngines()
    const chat = folderChat(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'first question' })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    t.handle({ type: 'chat.setEngine', chatId: chat.id, engine: 'beta' })
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'second question' })
    await until(() => statusOf(t.core, chat.id) === 'idle')

    expect(t.alpha).toHaveLength(1)
    expect(t.beta).toHaveLength(1)
    const prompt = t.beta[0]?.prompt ?? ''
    expect(prompt).toContain('<message id="0" kind="user">\nfirst question\n</message>')
    expect(prompt).toContain('<message id="1" kind="talk">\nAlpha reply\n</message>')
    expect(prompt.trimEnd().endsWith('second question')).toBe(true)
    const texts = entriesOf(t.core, chat.id).flatMap((e) => (e.type === 'text.completed' ? [e.text] : []))
    expect(texts).toEqual(['Alpha reply', 'Beta reply'])
  })

  it('sets a chat model and thinking level, saves them and starts the next session with them', async () => {
    const t = setupEngines()
    await t.core.refreshEngines()
    const chat = folderChat(t)
    const [model, thinking] = [otherModel, otherThinking]
    t.handle({ type: 'chat.setModel', chatId: chat.id, model, thinking })
    expect(t.messages.at(-1)).toMatchObject({ type: 'chat.updated', chat: { id: chat.id, model, thinking } })
    expect(JSON.parse(readFileSync(chatFile(t, chat.id), 'utf8'))).toMatchObject({ model, thinking })
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    expect(t.alpha[0]?.options).toMatchObject({ model, thinking })

    t.handle({ type: 'chat.setModel', chatId: chat.id, thinking })
    const updated = t.messages.at(-1)
    expect(updated?.type === 'chat.updated' && 'model' in updated.chat).toBe(false)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'again' })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    expect(t.alpha[1]?.options.model).toBe(FAKE_DEFAULTS.defaultModel)
    expect(t.alpha[1]?.options.thinking).toBe(thinking)
    expect(JSON.parse(readFileSync(chatFile(t, chat.id), 'utf8')).model).toBeUndefined()

    t.core.close()
    const reopened = chatOf(setupEngines(t.garage).core, chat.id)
    expect(reopened?.model).toBeUndefined()
    expect(reopened?.thinking).toBe(thinking)
  })

  it('rejects a model or thinking level the engine does not offer, and a change while a turn runs', async () => {
    const t = setupEngines()
    await t.core.refreshEngines()
    const chat = folderChat(t)
    expect(() => t.handle({ type: 'chat.setModel', chatId: chat.id, model: 'nope' })).toThrow(/model "nope"/)
    expect(() => t.handle({ type: 'chat.setModel', chatId: chat.id, thinking: 'nope' })).toThrow(
      /thinking level "nope"/,
    )
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })
    expect(() => t.handle({ type: 'chat.setModel', chatId: chat.id, model: FAKE_MODELS[0]!.id })).toThrow(/turn/)
    expect(chatOf(t.core, chat.id)?.model).toBeUndefined()
  })

  it('drops a model or thinking level the new engine does not offer when the engine changes', async () => {
    const alpha = createFakeAdapter([], 0)
    const betaOffers = { models: FAKE_MODELS.filter((m) => m.id !== otherModel), thinking: FAKE_THINKING }
    const detect = async () => ({ installed: true, signedIn: true, ...betaOffers })
    const beta: Adapter = { ...alpha, id: 'beta', detect }
    const t = open(tempDir(), [{ ...alpha, id: 'alpha' }, beta], 'alpha')
    await t.core.refreshEngines()
    const thinking = otherThinking
    t.handle({ type: 'chat.setModel', chatId: 'main', model: otherModel, thinking })
    t.handle({ type: 'chat.setEngine', chatId: 'main', engine: 'beta' })
    expect(chatOf(t.core, 'main')).toMatchObject({ engine: 'beta', thinking })
    expect(chatOf(t.core, 'main')?.model).toBeUndefined()
    const betaModel = betaOffers.models[0]!.id
    t.handle({ type: 'chat.setModel', chatId: 'main', model: betaModel, thinking })
    t.handle({ type: 'chat.setEngine', chatId: 'main', engine: 'alpha' })
    expect(chatOf(t.core, 'main')).toMatchObject({ engine: 'alpha', model: betaModel, thinking })
  })

  it('keeps a chat whose saved engine is gone and refuses to send', () => {
    const t = setupEngines()
    const chat = folderChat(t)
    const saved = JSON.parse(readFileSync(chatFile(t, chat.id), 'utf8'))
    writeFileSync(chatFile(t, chat.id), JSON.stringify({ ...saved, engine: 'removed' }))
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
    expect(createChat(t).engine).toBe('fake')
    expect(() => t.handle({ type: 'chat.create', name: 'Named', engine: 'fake' })).toThrow(/"fake" is off/)
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
    const chat = folderChat(t)
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
    const chat = folderChat(t)
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
    const other = folderChat(failing)
    failing.handle({ type: 'chat.send', chatId: other.id, text: 'go' })
    failing.handle({ type: 'chat.send', chatId: other.id, text: 'next' })
    emits[0]?.({ type: 'session.ended', error: 'crashed' })
    expect(userTexts(failing.core, other.id)).toEqual(['go', 'next'])
    expect(statusOf(failing.core, other.id)).toBe('running')
  })

  it('removes a queued message by id, ignoring one that is already gone', () => {
    const t = setup(permissionScript)
    const chat = folderChat(t)
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
    const chat = folderChat(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'one' })
    await until(() => statusOf(t.core, chat.id) === 'waiting')
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'two' })
    await t.core.close()
    expect(userTexts(t.core, chat.id)).toEqual(['one'])
    expect(t.calls).toHaveLength(1)
  })

  it('keeps the queue and reports why when it cannot be sent', async () => {
    const t = setup(permissionScript)
    const chat = folderChat(t)
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
    const chat = folderChat(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'one' })
    expect(() => t.handle({ type: 'chat.send', chatId: chat.id, text: '  ' })).toThrow(/empty/)
    expect(queueOf(t.core, chat.id)).toEqual([])
  })
})

describe('attachments', () => {
  const PNG = Buffer.from('89504e470d0a1a0a', 'hex')
  const BIG_JPEG = Buffer.alloc(6 * 1024 * 1024)
  const upload = (name: string, mimeType: string, bytes: Buffer | string) => ({
    name,
    mimeType,
    base64: Buffer.from(bytes).toString('base64'),
  })
  const attachmentsDir = (t: { garage: string }, id: string) => join(t.garage, 'chats', id, 'attachments')
  const sentAttachments = (core: Core, id: string) =>
    entriesOf(core, id).flatMap((e) => (e.type === 'user.message' ? [e.attachments ?? []] : []))

  it('saves uploads as files in the chat folder, never clobbering, and logs them without their bytes', async () => {
    const t = setup(textScript)
    const chat = folderChat(t)
    const dir = attachmentsDir(t, chat.id)
    t.handle({
      type: 'chat.send',
      chatId: chat.id,
      text: 'look',
      attachments: [
        upload('image.png', 'image/png', PNG),
        upload('image.png', 'image/png', 'second'),
        upload('../.notes.txt', 'text/plain', 'hello'),
      ],
    })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    const again = [upload('image.png', 'image/png', 'x')]
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'again', attachments: again })
    await until(() => statusOf(t.core, chat.id) === 'idle')

    expect(sentAttachments(t.core, chat.id)).toEqual([
      [
        { name: 'image.png', path: join(dir, 'image.png'), mimeType: 'image/png', size: PNG.length },
        { name: 'image.png', path: join(dir, 'image-2.png'), mimeType: 'image/png', size: 6 },
        { name: '../.notes.txt', path: join(dir, 'notes.txt'), mimeType: 'text/plain', size: 5 },
      ],
      [{ name: 'image.png', path: join(dir, 'image-3.png'), mimeType: 'image/png', size: 1 }],
    ])
    expect(readFileSync(join(dir, 'image.png'))).toEqual(PNG)
    expect(readFileSync(join(dir, 'image-2.png'), 'utf8')).toBe('second')
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('hello')
    expect(readFileSync(join(t.garage, 'chats', chat.id, 'log.jsonl'), 'utf8')).not.toContain('"base64"')
  })

  it('sends files with no text, and refuses a message with neither', async () => {
    const t = setup(textScript)
    expect(() => t.handle({ type: 'chat.send', chatId: 'main', text: '  ' })).toThrow('Message is empty')
    expect(() => t.handle({ type: 'chat.send', chatId: 'main', text: '', attachments: [] })).toThrow(
      'Message is empty',
    )
    t.handle({ type: 'chat.send', chatId: 'main', text: '', attachments: [upload('a.txt', 'text/plain', 'a')] })
    await until(() => statusOf(t.core, 'main') === 'idle')
    expect(entriesOf(t.core, 'main')[0]).toMatchObject({ type: 'user.message', text: '' })
    expect(existsSync(join(attachmentsDir(t, 'main'), 'a.txt'))).toBe(true)
  })

  it('refuses a file over the size cap, or files over the total for one message, saving nothing', () => {
    const t = setup(textScript)
    const huge = upload('huge.bin', 'application/octet-stream', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))
    const send = (attachments: ReturnType<typeof upload>[]) =>
      t.handle({ type: 'chat.send', chatId: 'main', text: 'hi', attachments })
    expect(() => send([upload('ok.txt', 'text/plain', 'ok'), huge])).toThrow(`huge.bin is larger than`)
    const big = upload('big.bin', 'application/octet-stream', Buffer.alloc(MAX_ATTACHMENT_BYTES))
    const count = Math.floor(MAX_ATTACHMENTS_TOTAL_BYTES / MAX_ATTACHMENT_BYTES) + 1
    expect(() => send(Array(count).fill(big))).toThrow('at most')
    expect(existsSync(attachmentsDir(t, 'main'))).toBe(false)
    expect(t.calls).toEqual([])
  })

  it('lists every file by path in the prompt and sends every supported image as image input', async () => {
    const t = setup(textScript)
    t.handle({
      type: 'chat.send',
      chatId: 'main',
      text: 'what is this?',
      attachments: [
        upload('shot.png', 'image/png', PNG),
        upload('big.jpg', 'image/jpeg', BIG_JPEG),
        upload('report.pdf', 'application/pdf', '%PDF'),
        upload('icon.svg', 'image/svg+xml', '<svg/>'),
      ],
    })
    await until(() => statusOf(t.core, 'main') === 'idle')
    const dir = attachmentsDir(t, 'main')
    expect(t.calls[0]?.prompt).toBe(
      'what is this?\n\nAttached files:\n' +
        `- ${dir}/shot.png (image/png)\n- ${dir}/big.jpg (image/jpeg)\n` +
        `- ${dir}/report.pdf (application/pdf)\n- ${dir}/icon.svg (image/svg+xml)`,
    )
    expect(t.calls[0]?.images).toEqual([
      { mimeType: 'image/png', base64: PNG.toString('base64') },
      { mimeType: 'image/jpeg', base64: BIG_JPEG.toString('base64') },
    ])

    const blind = setup({ ...createFakeAdapter(textScript, 0), imageInput: false })
    blind.handle({ type: 'chat.send', chatId: 'main', text: '', attachments: [upload('a.png', 'image/png', PNG)] })
    await until(() => statusOf(blind.core, 'main') === 'idle')
    expect(blind.calls[0]?.prompt).toBe(`Attached files:\n- ${attachmentsDir(blind, 'main')}/a.png (image/png)`)
    expect(blind.calls[0]?.images).toEqual([])
  })

  it('replays earlier files as paths only, sending images only with their own turn', async () => {
    const t = setup(textScript)
    const chat = folderChat(t)
    const dir = attachmentsDir(t, chat.id)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'first', attachments: [upload('one.png', 'image/png', PNG)] })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'second', attachments: [upload('two.png', 'image/png', 'b')] })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    const prompt = t.calls[1]?.prompt ?? ''
    expect(prompt).toContain(`kind="user">\nfirst\n\nAttached files:\n- ${dir}/one.png (image/png)\n</message>`)
    expect(prompt.endsWith(`second\n\nAttached files:\n- ${dir}/two.png (image/png)`)).toBe(true)
    expect(t.calls[1]?.images).toEqual([{ mimeType: 'image/png', base64: Buffer.from('b').toString('base64') }])
  })

  it("gives the engine the chat's own attachments folder once it exists, and never a parent's", async () => {
    const t = setup(textScript)
    t.handle({ type: 'chat.send', chatId: 'main', text: 'hi' })
    await until(() => statusOf(t.core, 'main') === 'idle')
    expect(t.calls[0]?.options.extraDirs).toBeUndefined()
    t.handle({ type: 'chat.send', chatId: 'main', text: 'see', attachments: [upload('a.txt', 'text/plain', 'a')] })
    await until(() => statusOf(t.core, 'main') === 'idle')
    t.handle({ type: 'chat.send', chatId: 'main', text: 'again' })
    await until(() => statusOf(t.core, 'main') === 'idle')
    expect(t.calls[1]?.options.extraDirs).toEqual([attachmentsDir(t, 'main')])
    expect(t.calls[2]?.options.extraDirs).toEqual([attachmentsDir(t, 'main')])

    const child = createChat(t, { name: 'Child' })
    t.handle({ type: 'chat.send', chatId: child.id, text: 'hi' })
    await until(() => statusOf(t.core, child.id) === 'idle')
    expect(t.calls[3]?.options.extraDirs).toBeUndefined()
    expect(t.calls[3]?.prompt).not.toContain('a.txt')
  })

  it('saves files sent during a turn at once, sends them with the queue, and deletes an unqueued one', async () => {
    const t = setup(permissionScript)
    const chat = folderChat(t)
    const dir = attachmentsDir(t, chat.id)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'one' })
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'two', attachments: [upload('two.png', 'image/png', PNG)] })
    t.handle({ type: 'chat.send', chatId: chat.id, text: '', attachments: [upload('three.txt', 'text/plain', '3')] })
    expect(readFileSync(join(dir, 'two.png'))).toEqual(PNG)
    const queue = chatOf(t.core, chat.id)?.queue ?? []
    expect(queue.map((q) => q.attachments?.map((a) => a.path))).toEqual([
      [join(dir, 'two.png')],
      [join(dir, 'three.txt')],
    ])
    t.handle({ type: 'chat.unqueue', chatId: chat.id, id: queue[1]!.id })
    expect(existsSync(join(dir, 'three.txt'))).toBe(false)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'four', attachments: [upload('four.txt', 'text/plain', '4')] })

    await until(() => statusOf(t.core, chat.id) === 'waiting')
    const request = entriesOf(t.core, chat.id).find((e) => e.type === 'permission.requested')
    if (request?.type !== 'permission.requested') throw new Error('no request')
    t.handle({ type: 'permission.respond', chatId: chat.id, requestId: request.requestId, allow: true })
    await until(() => sentAttachments(t.core, chat.id).length === 2)

    const merged = entriesOf(t.core, chat.id).findLast((e) => e.type === 'user.message')
    expect(merged).toMatchObject({ text: 'two\n\nfour' })
    expect(sentAttachments(t.core, chat.id)[1]?.map((a) => a.path)).toEqual([
      join(dir, 'two.png'),
      join(dir, 'four.txt'),
    ])
    expect(t.calls[1]?.images).toEqual([{ mimeType: 'image/png', base64: PNG.toString('base64') }])
  })

  it('pins a sent file to the context by its saved path, even in a garage reached through a symlink', async () => {
    const garage = join(tempDir(), 'garage')
    symlinkSync(tempDir(), garage)
    const t = setup(textScript, garage)
    const chat = createChat(t, { name: 'App' })
    t.handle({ type: 'chat.send', chatId: chat.id, text: '', attachments: [upload('notes.md', 'text/markdown', 'N')] })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    const path = sentAttachments(t.core, chat.id)[0]![0]!.path

    t.handle({ type: 'context.add', chatId: chat.id, section: 'files', path })
    expect(chatOf(t.core, chat.id)?.files).toEqual([path])
    t.handle({ type: 'context.remove', chatId: chat.id, section: 'files', path })
    expect(chatOf(t.core, chat.id)?.files).toEqual([])
  })

  it('keeps no files from a refused message, and deletes them with the chat', async () => {
    const t = setup(textScript)
    const chat = createChat(t, { name: 'Old' })
    const dir = attachmentsDir(t, chat.id)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi', attachments: [upload('a.txt', 'text/plain', 'a')] })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    t.handle({ type: 'chat.archive', chatId: chat.id, archived: true })
    const attachments = [upload('b.txt', 'text/plain', 'b')]
    expect(() => t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi', attachments })).toThrow('archived')
    expect(existsSync(join(dir, 'b.txt'))).toBe(false)
    t.handle({ type: 'chat.delete', chatId: chat.id })
    expect(existsSync(dir)).toBe(false)
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
    const chat = folderChat(t)
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
    const chat = folderChat(t)
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
    const chat = folderChat(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'go' })
    t.handle({ type: 'chat.interrupt', chatId: chat.id })
    expect(statusOf(t.core, chat.id)).toBe('stopping')
  })

  it('closes a session gently once the engine stops in time', async () => {
    const t = setup(permissionScript)
    const chat = folderChat(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'go' })
    await until(() => statusOf(t.core, chat.id) === 'waiting')
    t.handle({ type: 'chat.interrupt', chatId: chat.id })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    expect(t.calls[0]).toMatchObject({ closed: true })
    await new Promise((r) => setTimeout(r, TEST_STOP_GRACE_MS * 3))
    expect(entriesOf(t.core, chat.id).filter((e) => e.type === 'turn.completed')).toHaveLength(1)
  })

})

describe('memory', () => {
  const longReply = (id: number) => `reply ${id} `.padEnd(3000, '.')

  function writeLog(garage: string, chatId: string, count: number) {
    const dir = join(garage, 'chats', chatId)
    mkdirSync(dir, { recursive: true })
    const entries: ChatEntry[] = Array.from({ length: count }, (_, i) =>
      i % 2 ? { at, type: 'text.completed', text: longReply(i) } : { at, type: 'user.message', text: `question ${i}` },
    )
    writeFileSync(join(dir, 'log.jsonl'), entries.map((e) => JSON.stringify(e) + '\n').join(''))
  }

  function setupMemory(
    options: { garage?: string; script?: FakeStep[]; complete?: Adapter['complete']; others?: Adapter[] } = {},
  ) {
    const { garage = tempDir(), script = textScript, others = [] } = options
    const fake = createFakeAdapter(script, 0)
    const completions: CompleteOptions[] = []
    const complete = options.complete ?? fake.complete!
    const { adapter, calls } = recording({
      ...fake,
      complete(machine, request) {
        completions.push(request)
        return complete(machine, request)
      },
    })
    const adapters = [...others, adapter]
    const core = openCore({ garage, adapters, defaultEngine: 'fake', machine: localMachine, compactDebounceMs: 0 })
    cores.push(core)
    for (const { id } of adapters) core.handle({ type: 'engine.setEnabled', engine: id, enabled: true }, () => {})
    const messages: CoreMessage[] = []
    core.onMessage((m) => messages.push(m))
    const handle = (m: Parameters<Core['handle']>[0]) => core.handle(m, () => {})
    return { core, garage, calls, completions, messages, handle }
  }

  const summarized = (t: { core: Core; garage: string }, chatId: string) =>
    pendingOf(messagesOf(entriesOf(t.core, chatId)), openSummaries(join(t.garage, 'chats', chatId, 'summaries.jsonl')))
      .length === 0

  it('gives every chat the memory instructions after the role instructions', async () => {
    const t = setupMemory()
    writeFileSync(join(t.garage, 'AGENTS.md'), 'RULES')
    t.handle({ type: 'chat.send', chatId: 'main', text: 'hi' })
    expect(t.calls[0]?.options.instructions).toBe([HOME_INSTRUCTIONS, MEMORY_INSTRUCTIONS, 'RULES'].join('\n\n'))
    const chat = createChat({ ...t, replies: [] }, { name: 'App' })
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })
    expect(t.calls[1]?.options.instructions).toBe([MEMORY_INSTRUCTIONS, 'RULES'].join('\n\n'))
  })

  it('summarizes a backlog once engines are detected, and the next prompt shows the summary lines', async () => {
    const garage = tempDir()
    writeLog(garage, 'main', 40)
    const t = setupMemory({ garage })
    expect(t.completions).toHaveLength(0)
    await t.core.refreshEngines()
    await until(() => summarized(t, 'main'))

    expect(t.completions[0]).toMatchObject({ cwd: join(t.garage, 'home'), model: FAKE_DEFAULTS.cheapModel })
    expect(t.completions[0]?.prompt).toContain('<item key="39+1" kind="talk"')
    t.handle({ type: 'chat.send', chatId: 'main', text: 'next' })
    const prompt = t.calls[0]?.prompt ?? ''
    expect(prompt).toContain('\n0+1|user: question 0\n1+1|talk: summary of 1+1\n')
    expect(prompt).toContain('<message id="39" kind="talk">')
    expect(prompt.endsWith('New message from the user:\n\nnext')).toBe(true)
  })

  it('summarizes after a turn ends, but only once the messages pass COMPACT_MIN_CHARS', async () => {
    const reply = 'r'.repeat(COMPACT_MIN_CHARS / 4 - 'q'.length)
    const t = setupMemory({ script: [{ type: 'text.completed', text: reply }] })
    await t.core.refreshEngines()
    for (let i = 0; i < 4; i++) {
      t.handle({ type: 'chat.send', chatId: 'main', text: 'q' })
      await until(() => statusOf(t.core, 'main') === 'idle')
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(t.completions).toHaveLength(0)

    t.handle({ type: 'chat.send', chatId: 'main', text: 'q' })
    await until(() => statusOf(t.core, 'main') === 'idle')
    await until(() => t.completions.length > 0 && summarized(t, 'main'))
  })

  it('never makes a turn wait for summaries, and quits with a summary call still out', async () => {
    const garage = tempDir()
    writeLog(garage, 'main', 40)
    const t = setupMemory({ garage, complete: () => new Promise<string>(() => {}) })
    await t.core.refreshEngines()
    await until(() => t.completions.length === 1)
    t.handle({ type: 'chat.send', chatId: 'main', text: 'hi' })
    expect(t.calls).toHaveLength(1)
    await until(() => statusOf(t.core, 'main') === 'idle')
    await t.core.close()
    expect(t.completions).toHaveLength(1)
  })

  it('uses the summary engine and model that are set, saved in settings.json', async () => {
    const cannot = stubAdapter(() => {
      throw new Error('never started')
    })
    const script: FakeStep[] = [{ type: 'text.completed', text: 'r'.repeat(COMPACT_MIN_CHARS) }]
    const t = setupMemory({ script, others: [cannot] })
    await t.core.refreshEngines()
    expect(() => t.handle({ type: 'memory.set', engine: 'stub' })).toThrow(/can't write summaries/)
    expect(() => t.handle({ type: 'memory.set', engine: 'fake', model: 'nope' })).toThrow(/offers no model "nope"/)
    expect(() => t.handle({ type: 'memory.set', model: otherModel })).toThrow(/engine/)
    expect(t.core.memory()).toEqual({})

    t.handle({ type: 'memory.set', engine: 'fake', model: otherModel })
    const memory = { engine: 'fake', model: otherModel }
    expect(t.messages.at(-1)).toEqual({ type: 'memory.updated', memory })
    expect(JSON.parse(readFileSync(join(t.garage, 'settings.json'), 'utf8')).memory).toEqual(memory)
    t.handle({ type: 'chat.send', chatId: 'main', text: 'q' })
    await until(() => t.completions.length > 0 && summarized(t, 'main'))
    expect(new Set(t.completions.map((c) => c.model))).toEqual(new Set([otherModel]))

    t.handle({ type: 'memory.set' })
    expect(t.core.memory()).toEqual({})
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
    const chat = folderChat(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'go' })
    await until(() => statusOf(t.core, chat.id) === 'waiting')
    await t.core.close()
    expect(t.calls[0]).toMatchObject({ interrupted: true, closed: true })
    expect(entriesOf(t.core, chat.id).at(-1)).toMatchObject({ type: 'turn.completed', error: 'Interrupted' })
  })

  it('shows a busy chat as stopping and forces it after the stop grace', async () => {
    const t = setup(ignoresInterrupt())
    const chat = folderChat(t)
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
    const chat = folderChat(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'go' })
    await t.core.close(true)
    expect(t.calls[0]).toMatchObject({ closed: true })
    expect(t.calls[0]?.interrupted).toBeUndefined()
    expect(statusOf(t.core, chat.id)).toBe('idle')
  })

  it('ends a waiting quit when it is forced', async () => {
    const longGraceMs = 60_000
    const t = setup(ignoresInterrupt(), tempDir(), longGraceMs)
    const chat = folderChat(t)
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
    const busy = folderChat(t)
    const idle = folderChat(t)
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
    const chat = folderChat(t)
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
    const chat = folderChat(t)
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
    const chat = folderChat(t)
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
    const chat = folderChat(t)

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
      const chat = folderChat(t)
      t.handle({ type: 'account.use', engine: 'fake', accountId: 'billing' })
      t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })
      expect(t.calls[0]?.options).toMatchObject({ accountDir: accountDir(t.garage, 'billing'), apiKey: key })
      await until(() => statusOf(t.core, chat.id) === 'idle')
      const log = readFileSync(join(t.garage, 'chats', chat.id, 'log.jsonl'), 'utf8')
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
  const itemsOf = (t: ReturnType<typeof open>, chatId: string) => {
    t.handle({ type: 'context.get', chatId })
    const reply = t.replies.findLast((m) => m.type === 'chat.context')
    if (reply?.type !== 'chat.context' || reply.chatId !== chatId) throw new Error('no chat.context')
    return reply.items
  }
  const sessionOf = async (t: ReturnType<typeof setup>, chatId: string) => {
    t.handle({ type: 'chat.send', chatId, text: 'hi' })
    await until(() => statusOf(t.core, chatId) === 'idle')
    return t.calls.at(-1)!.options
  }
  const instructionsOf = async (t: ReturnType<typeof setup>, chatId: string) =>
    (await sessionOf(t, chatId)).instructions
      .split('\n\n')
      .filter((part) => part !== MEMORY_INSTRUCTIONS)
      .join('\n\n')
  const reopenWithSubagent = (t: ReturnType<typeof setup>, parentId: string) => {
    t.core.close()
    const id = 'subagent'
    const saved = { id, name: 'Sub', parentId, subagent: true, engine: 'fake', archived: false, createdAt: at }
    mkdirSync(join(t.garage, 'chats', id), { recursive: true })
    writeFileSync(join(t.garage, 'chats', id, 'chat.json'), JSON.stringify(saved))
    return { t: setup(textScript, t.garage), subagentId: id }
  }
  const folderWith = (rules: string) => {
    const dir = tempDir()
    writeFileSync(join(dir, 'AGENTS.md'), rules)
    return realpathSync(dir)
  }
  const fileWith = (text: string) => {
    const file = join(tempDir(), 'notes.md')
    writeFileSync(file, text)
    return realpathSync(file)
  }
  const add = (t: ReturnType<typeof open>, chatId: string, section: 'folders' | 'files', path: string) =>
    t.handle({ type: 'context.add', chatId, section, path })

  it("lists a chat's AGENTS.md, folders and files from the Workshop down to itself", () => {
    const t = setup(textScript)
    const repo = folderWith('REPO RULES')
    const notes = fileWith('NOTES')
    const chat = createChat(t, { name: 'App', folders: [repo], files: [notes] })
    const workshop = { section: 'agents', path: join(t.garage, 'AGENTS.md'), from: 'main', enabled: true, text: '' }
    const own = join(t.garage, 'chats', chat.id, 'AGENTS.md')

    expect(itemsOf(t, 'main')).toEqual([workshop])
    expect(itemsOf(t, chat.id)).toEqual([
      workshop,
      { section: 'folders', path: repo, from: chat.id, enabled: true, text: 'REPO RULES' },
      { section: 'agents', path: own, from: chat.id, enabled: true, text: '' },
      { section: 'files', path: notes, from: chat.id, enabled: true, text: 'NOTES' },
    ])
  })

  it(`injects enabled items root first, after the role instructions only ${WORKSHOP_NAME} gets`, async () => {
    const t = setup(textScript)
    const repo = folderWith('REPO RULES')
    const notes = fileWith('NOTES\n')
    expect(await instructionsOf(t, 'main')).toBe(HOME_INSTRUCTIONS)
    t.handle({ type: 'context.write', chatId: 'main', text: 'WORKSHOP RULES' })
    const chat = createChat(t, { name: 'App', folders: [repo], files: [notes] })
    const other = createChat(t, { name: 'Other' })
    t.handle({ type: 'context.write', chatId: chat.id, text: 'APP RULES' })
    t.handle({ type: 'context.write', chatId: other.id, text: 'OTHER RULES' })

    const file = `<file path="${notes}">\nNOTES\n</file>`
    expect(await instructionsOf(t, chat.id)).toBe(
      ['WORKSHOP RULES', 'REPO RULES', 'APP RULES', file].join('\n\n'),
    )
    expect(await instructionsOf(t, 'main')).toBe(`${HOME_INSTRUCTIONS}\n\nWORKSHOP RULES`)
    expect(await instructionsOf(t, other.id)).toBe('WORKSHOP RULES\n\nOTHER RULES')
    expect(itemsOf(t, 'main').map((item) => item.text)).toEqual(['WORKSHOP RULES'])
  })

  it("runs in its first enabled folder, else its nearest ancestor's, else home, with the rest as extras", async () => {
    const first = setup(textScript)
    const [a, b] = [folderWith(''), folderWith('')]
    const home = join(first.garage, 'home')
    const plain = createChat(first, { name: 'Plain' })
    expect(await sessionOf(first, plain.id)).toMatchObject({ cwd: home })
    expect(first.calls.at(-1)?.options).not.toHaveProperty('extraDirs')
    const app = createChat(first, { name: 'App', folders: [a, b] })
    expect(await sessionOf(first, app.id)).toMatchObject({ cwd: a, extraDirs: [b] })

    const { t, subagentId } = reopenWithSubagent(first, app.id)
    expect(await sessionOf(t, subagentId)).toMatchObject({ cwd: a, extraDirs: [b] })
    t.handle({ type: 'context.set', chatId: app.id, path: a, enabled: false })
    expect(await sessionOf(t, app.id)).toMatchObject({ cwd: b })
    expect(t.calls.at(-1)?.options).not.toHaveProperty('extraDirs')
    expect(await sessionOf(t, subagentId)).toMatchObject({ cwd: b })
    expect(await sessionOf(t, 'main')).toMatchObject({ cwd: home })
  })

  it('gives a file that is not text by path with read access, never pasted, down to the subagents', async () => {
    const first = setup(textScript)
    const chat = createChat(first, { name: 'App' })
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    const attachments = [
      { name: 'shot.png', mimeType: 'image/png', base64: png.toString('base64') },
      { name: 'notes.md', mimeType: 'text/markdown', base64: Buffer.from('NOTES').toString('base64') },
    ]
    first.handle({ type: 'chat.send', chatId: chat.id, text: '', attachments })
    await until(() => statusOf(first.core, chat.id) === 'idle')
    const sent = entriesOf(first.core, chat.id)[0]
    if (sent?.type !== 'user.message') throw new Error('no message')
    const [image, notes] = (sent.attachments ?? []).map((a) => a.path) as [string, string]
    add(first, chat.id, 'files', image)
    add(first, chat.id, 'files', notes)
    const { t, subagentId } = reopenWithSubagent(first, chat.id)

    expect(itemsOf(t, subagentId).filter((item) => item.section === 'files')).toEqual([
      { section: 'files', path: image, from: chat.id, enabled: true, text: '', binary: true },
      { section: 'files', path: notes, from: chat.id, enabled: true, text: 'NOTES' },
    ])
    const byPath = `The file ${image} is not text, so it isn't pasted here. Open it with your tools when you need it.`
    const own = await sessionOf(t, chat.id)
    const before = t.calls.length
    await sessionOf(t, subagentId)
    const subagent = t.calls[before]!.options
    for (const options of [own, subagent]) {
      const file = `<file path="${notes}">\nNOTES\n</file>`
      expect(options.instructions).toBe([MEMORY_INSTRUCTIONS, byPath, file].join('\n\n'))
      expect(options.readFiles).toEqual([image])
    }
    expect(subagent).not.toHaveProperty('extraDirs')
    await until(() => statusOf(t.core, chat.id) === 'idle')
    t.handle({ type: 'context.set', chatId: chat.id, path: image, enabled: false })
    expect(await sessionOf(t, chat.id)).not.toHaveProperty('readFiles')
  })

  it('adds and removes folders and files, checking each path, and tells the chat and the chats below it', () => {
    const first = setup(textScript)
    const chat = createChat(first, { name: 'App' })
    const { t, subagentId } = reopenWithSubagent(first, chat.id)
    const dir = realpathSync(tempDir())
    const file = fileWith('NOTES')
    let before = t.messages.length
    add(t, chat.id, 'folders', dir)
    const updated = { type: 'chat.updated', chat: expect.objectContaining({ folders: [dir] }) }
    expect(t.messages.slice(before)).toContainEqual(updated)
    expect(t.messages.slice(before).flatMap((m) => (m.type === 'chat.context' ? [m.chatId] : []))).toEqual([
      chat.id,
      subagentId,
    ])
    add(t, chat.id, 'files', file)
    expect(chatOf(t.core, chat.id)).toMatchObject({ folders: [dir], files: [file] })
    expect(JSON.parse(readFileSync(chatFile(t, chat.id), 'utf8'))).toMatchObject({ folders: [dir], files: [file] })

    expect(() => add(t, chat.id, 'folders', file)).toThrow(/Not a folder/)
    expect(() => add(t, chat.id, 'files', dir)).toThrow(/Not a file/)
    expect(() => add(t, chat.id, 'folders', join(dir, 'missing'))).toThrow(/Not a folder/)
    expect(() => add(t, chat.id, 'folders', 'relative/dir')).toThrow(/absolute/)
    expect(() => add(t, chat.id, 'folders', `${dir}/`)).toThrow(/already/)
    expect(() => add(t, chat.id, 'agents' as never, dir)).toThrow(/Only folders and files/)

    expect(() => add(t, subagentId, 'folders', dir)).toThrow(/already/)

    t.handle({ type: 'context.remove', chatId: chat.id, section: 'folders', path: dir })
    expect(chatOf(t.core, chat.id)).toMatchObject({ folders: [], files: [file] })
    expect(() => t.handle({ type: 'context.remove', chatId: chat.id, section: 'folders', path: dir })).toThrow(
      /not one of this chat's folders/,
    )
    expect(() =>
      t.handle({ type: 'context.remove', chatId: subagentId, section: 'files', path: file }),
    ).toThrow(/not one of this chat's files/)
    expect(existsSync(dir)).toBe(true)
  })

  it('turns an item off for one chat, saves it in chat.json and tells every client', async () => {
    const t = setup(textScript)
    const repo = folderWith('REPO RULES')
    t.handle({ type: 'context.write', chatId: 'main', text: 'WORKSHOP RULES' })
    const chat = createChat(t, { name: 'App', folders: [repo] })

    t.handle({ type: 'context.set', chatId: chat.id, path: repo, enabled: false })
    const updated = t.messages.at(-1)
    if (updated?.type !== 'chat.context') throw new Error('no chat.context')
    expect(updated.chatId).toBe(chat.id)
    expect(updated.items.find((i) => i.path === repo)?.enabled).toBe(false)
    expect(JSON.parse(readFileSync(chatFile(t, chat.id), 'utf8')).context).toEqual({ [repo]: false })
    expect(await instructionsOf(t, chat.id)).toBe('WORKSHOP RULES')

    t.handle({ type: 'context.set', chatId: 'main', path: join(t.garage, 'AGENTS.md'), enabled: false })
    expect(await instructionsOf(t, 'main')).toBe(HOME_INSTRUCTIONS)
    expect(await instructionsOf(t, chat.id)).toBe('WORKSHOP RULES')

    t.core.close()
    const reopened = setup(textScript, t.garage)
    expect(itemsOf(reopened, chat.id).find((i) => i.path === repo)?.enabled).toBe(false)
    expect(chatOf(reopened.core, chat.id)).not.toHaveProperty('context')
    expect(() => reopened.handle({ type: 'context.set', chatId: 'main', path: repo, enabled: false })).toThrow(
      /no context item/,
    )
  })

  it('starts inherited items from the defaults in settings.json and own items on, keeping other settings', () => {
    const garage = tempDir()
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ theme: 'dark', context: { repo: false } }))
    const t = setup(textScript, garage)
    expect(t.core.contextDefaults()).toEqual({ agents: true, folders: true, files: true })
    const chat = createChat(t, { name: 'App', folders: [folderWith('')] })

    t.handle({ type: 'context.setDefault', section: 'agents', enabled: false })
    t.handle({ type: 'context.setDefault', section: 'folders', enabled: false })
    const defaults = { agents: false, folders: false, files: true }
    expect(t.messages.at(-1)).toEqual({ type: 'context.defaults', defaults })
    expect(JSON.parse(readFileSync(join(garage, 'settings.json'), 'utf8'))).toEqual({
      theme: 'dark',
      engines: { fake: true },
      context: { repo: false, agents: false, folders: false },
    })
    const switches = (chatId: string) => itemsOf(t, chatId).map((i) => [i.from, i.section, i.enabled])
    expect(switches(chat.id)).toEqual([
      ['main', 'agents', false],
      [chat.id, 'folders', true],
      [chat.id, 'agents', true],
    ])
    expect(switches('main').map(([, , enabled]) => enabled)).toEqual([true])
    t.handle({ type: 'context.set', chatId: chat.id, path: join(garage, 'AGENTS.md'), enabled: true })
    expect(switches(chat.id)[0]).toEqual(['main', 'agents', true])
    expect(() => t.handle({ type: 'context.setDefault', section: 'nope', enabled: false } as never)).toThrow(
      /Unknown context section/,
    )

    t.core.close()
    expect(setup(textScript, garage).core.contextDefaults()).toEqual(defaults)
  })

  it("writes a chat's own AGENTS.md, creating its folder, and tells every client", () => {
    const t = setup(textScript)
    const chat = createChat(t, { name: 'App' })
    const file = join(t.garage, 'chats', chat.id, 'AGENTS.md')
    rmSync(join(t.garage, 'chats', chat.id), { recursive: true })

    t.handle({ type: 'context.write', chatId: chat.id, text: 'APP RULES\n' })
    expect(readFileSync(file, 'utf8')).toBe('APP RULES\n')
    expect(t.messages.at(-1)).toEqual({ type: 'context.file', path: file, text: 'APP RULES\n' })
    expect(itemsOf(t, chat.id).find((i) => i.path === file)?.text).toBe('APP RULES\n')
    t.handle({ type: 'context.write', chatId: 'main', text: 'WORKSHOP RULES' })
    expect(readFileSync(join(t.garage, 'AGENTS.md'), 'utf8')).toBe('WORKSHOP RULES')
  })

  it("never writes into a chat's folders, and keeps archived chats read-only", () => {
    const t = setup(textScript)
    const repo = folderWith('REPO RULES')
    const chat = createChat(t, { name: 'App', folders: [repo] })
    t.handle({ type: 'context.write', chatId: chat.id, text: 'APP RULES' })
    expect(readFileSync(join(repo, 'AGENTS.md'), 'utf8')).toBe('REPO RULES')

    t.handle({ type: 'chat.archive', chatId: chat.id, archived: true })
    expect(() => t.handle({ type: 'context.write', chatId: chat.id, text: 'x' })).toThrow(/archived/)
    expect(() => t.handle({ type: 'context.set', chatId: chat.id, path: repo, enabled: false })).toThrow(/archived/)
    expect(() => add(t, chat.id, 'files', fileWith('x'))).toThrow(/archived/)
    expect(() => t.handle({ type: 'context.remove', chatId: chat.id, section: 'folders', path: repo })).toThrow(
      /archived/,
    )
    expect(itemsOf(t, chat.id)).toHaveLength(3)
  })
})

describe('models', () => {
  const [newest, older] = FAKE_MODELS.map((m) => m.id) as [string, string]
  const { defaultModel, defaultThinking } = FAKE_DEFAULTS
  const settingsFile = (t: { garage: string }) => join(t.garage, 'settings.json')
  const sendAndWait = async (t: ReturnType<typeof setup>, chatId = 'main') => {
    t.handle({ type: 'chat.send', chatId, text: 'hi' })
    await until(() => statusOf(t.core, chatId) === 'idle')
    return t.calls.at(-1)!.options.model
  }

  it('saves a list per engine and role in settings.json, tells every client and keeps it after a restart', () => {
    const garage = tempDir()
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ theme: 'dark' }))
    const t = setup(textScript, garage)
    const empty = { chat: [], planning: [], searching: [], subagents: [] }
    expect(t.core.modelLists()).toEqual({ fake: empty })

    t.handle({ type: 'models.setList', engine: 'fake', role: 'planning', models: [older, newest] })
    const lists = { ...empty, planning: [older, newest] }
    expect(t.messages.at(-1)).toEqual({ type: 'models.updated', engine: 'fake', lists })
    expect(JSON.parse(readFileSync(settingsFile(t), 'utf8'))).toMatchObject({
      theme: 'dark',
      models: { fake: { planning: [older, newest] } },
    })

    expect(() => t.handle({ type: 'models.setList', engine: 'nope', role: 'chat', models: [] })).toThrow(/engine/)
    expect(() => t.handle({ type: 'models.setList', engine: 'fake', role: 'nope', models: [] } as never)).toThrow(
      /role/,
    )
    for (const models of ['x', [1], ['']]) {
      expect(() => t.handle({ type: 'models.setList', engine: 'fake', role: 'chat', models } as never)).toThrow(
        /model ids/,
      )
    }
    t.core.close()
    expect(setup(textScript, garage).core.modelLists()).toEqual({ fake: lists })
  })

  it('starts an unpinned chat on the first listed model the engine offers', async () => {
    const t = setup(textScript)
    await t.core.refreshEngines()
    t.handle({ type: 'models.setList', engine: 'fake', role: 'chat', models: ['gone', older, newest] })
    expect(await sendAndWait(t)).toBe(older)
  })

  it("keeps a chat's own pick over the list, and treats a pick the engine no longer offers as unpinned", async () => {
    const t = setup(textScript)
    await t.core.refreshEngines()
    t.handle({ type: 'models.setList', engine: 'fake', role: 'chat', models: [older] })
    t.handle({ type: 'chat.setModel', chatId: 'main', model: newest })
    expect(await sendAndWait(t)).toBe(newest)

    const chatFile = join(t.garage, 'chats', 'main', 'chat.json')
    writeFileSync(chatFile, JSON.stringify({ ...JSON.parse(readFileSync(chatFile, 'utf8')), model: 'opus' }))
    t.core.close()
    const reopened = setup(textScript, t.garage)
    await reopened.core.refreshEngines()
    expect(await sendAndWait(reopened)).toBe(older)
  })

  it("passes the engine's default model and thinking level when the chat and its lists pick none", async () => {
    const t = setup(textScript)
    await t.core.refreshEngines()
    expect(await sendAndWait(t)).toBe(defaultModel)
    expect(t.calls.at(-1)!.options.thinking).toBe(defaultThinking)
    t.handle({ type: 'models.setList', engine: 'fake', role: 'chat', models: ['gone'] })
    expect(await sendAndWait(t)).toBe(defaultModel)
  })

  it('unpins a model or thinking level the chat would run anyway, so it keeps following Settings', async () => {
    const t = setup(textScript)
    await t.core.refreshEngines()
    const saved = () => JSON.parse(readFileSync(join(t.garage, 'chats', 'main', 'chat.json'), 'utf8'))
    t.handle({ type: 'chat.setModel', chatId: 'main', model: otherModel, thinking: otherThinking })
    expect(saved()).toMatchObject({ model: otherModel, thinking: otherThinking })
    t.handle({ type: 'chat.setModel', chatId: 'main', model: defaultModel, thinking: defaultThinking })
    expect(saved()).not.toHaveProperty('model')
    expect(saved()).not.toHaveProperty('thinking')

    t.handle({ type: 'models.setList', engine: 'fake', role: 'chat', models: [otherModel] })
    t.handle({ type: 'chat.setModel', chatId: 'main', model: defaultModel })
    expect(chatOf(t.core, 'main')?.model).toBe(defaultModel)
    t.handle({ type: 'chat.setModel', chatId: 'main', model: otherModel })
    expect(chatOf(t.core, 'main')?.model).toBeUndefined()
  })

  it("starts each engine's default thinking at the engine's own, and saves a change in settings.json", async () => {
    const garage = tempDir()
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ theme: 'dark' }))
    const t = setup(textScript, garage)
    const fakeInfo = (core: Core) => core.engines().find((e) => e.id === 'fake')
    await t.core.refreshEngines()
    expect(fakeInfo(t.core)).toMatchObject({ defaultModel, defaultThinking })

    t.handle({ type: 'engine.setDefaultThinking', engine: 'fake', thinking: otherThinking })
    expect(t.messages.at(-1)).toMatchObject({
      type: 'engine.updated',
      engine: { id: 'fake', defaultThinking: otherThinking },
    })
    expect(JSON.parse(readFileSync(settingsFile(t), 'utf8'))).toMatchObject({
      theme: 'dark',
      defaultThinking: { fake: otherThinking },
    })
    await sendAndWait(t)
    expect(t.calls.at(-1)!.options.thinking).toBe(otherThinking)
    t.handle({ type: 'chat.setModel', chatId: 'main', thinking: otherThinking })
    expect(chatOf(t.core, 'main')?.thinking).toBeUndefined()

    expect(() => t.handle({ type: 'engine.setDefaultThinking', engine: 'nope', thinking: otherThinking })).toThrow(
      /Unknown engine/,
    )
    expect(() => t.handle({ type: 'engine.setDefaultThinking', engine: 'fake', thinking: 'nope' })).toThrow(
      /thinking level "nope"/,
    )
    t.core.close()
    const reopened = setup(textScript, garage)
    await reopened.core.refreshEngines()
    expect(fakeInfo(reopened.core)?.defaultThinking).toBe(otherThinking)
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
