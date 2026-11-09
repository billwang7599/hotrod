import { execFileSync } from 'node:child_process'
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
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { LimitReached, Mod, ModChat, ModHost, ModSession } from '@hotrod/mod-api'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeAdapter, FAKE_DEFAULTS, FAKE_MODELS, FAKE_THINKING, type FakeStep } from './adapters/fake.ts'
import { sandboxingMachine } from './adapters/test-machine.ts'
import { CHECKOUT_RULES, openCore, SUMMARY_MODELS, WRITE_RULES, type Core } from './core.ts'
import { SUBAGENTS_MOD } from './hotrod-mcp.ts'
import { localMachine } from './machine.ts'
import {
  COMPACT_MIN_CHARS,
  COMPLETE_TIMEOUT_MS,
  MEMORY_INSTRUCTIONS,
  MESSAGE_MAX_CHARS,
  messagesOf,
  openSummaries,
  pendingOf,
} from './memory.ts'
import {
  ASK_FIRST_COMMANDS,
  bySpaceOrder,
  pickRun,
  snapLevel,
  isUnread,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  GLOBAL_CONTEXT,
  type Adapter,
  type ImageInput,
  type ChatEntry,
  type ChatState,
  type CompleteOptions,
  type CoreMessage,
  type EngineEvent,
  type Machine,
  type SessionOptions,
  type ThinkingLevel,
} from './shared.ts'

const TEST_STOP_GRACE_MS = 30
const MAIN: ModChat = { id: 'main', name: 'Main', instructions: 'MAIN ROLE', seesAll: true }
const mainMod: Mod = { id: 'main-mod', name: 'Main mod', description: '', enabledByDefault: true, chats: [MAIN] }
const at = '2026-11-06T00:00:00.000Z'
const otherModel = FAKE_MODELS.find((m) => m !== FAKE_DEFAULTS.defaultModel)!
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

function setup(
  source: FakeStep[] | Adapter,
  garage = tempDir(),
  stopGraceMs = TEST_STOP_GRACE_MS,
  mods: Mod[] = [mainMod],
) {
  const { adapter, calls } = recording(Array.isArray(source) ? createFakeAdapter(source, 0) : source)
  return { ...open(garage, [adapter], adapter.id, stopGraceMs, [adapter.id], mods), calls }
}

function open(
  garage: string,
  adapters: Adapter[],
  defaultEngine: string,
  stopGraceMs = TEST_STOP_GRACE_MS,
  enabled = adapters.map((a) => a.id),
  mods: Mod[] = [mainMod],
  machine: Machine = sandboxingMachine,
) {
  const core = openCore({ garage, adapters, defaultEngine, machine, stopGraceMs, mods })
  cores.push(core)
  for (const engine of enabled) core.handle({ type: 'engine.setEnabled', engine, enabled: true }, () => {})
  core.handle({ type: 'workFolder.set', path: join(garage, 'work') }, () => {})
  const messages: CoreMessage[] = []
  core.onMessage((m) => messages.push(m))
  const replies: CoreMessage[] = []
  const handle = (m: Parameters<Core['handle']>[0]) => core.handle(m, (r) => replies.push(r))
  return { core, garage, messages, replies, handle }
}

type NewChatFields = { name?: string; folders?: string[]; files?: string[]; engine?: string }

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

const withoutRules = (instructions = '') =>
  instructions
    .split('\n\n')
    .filter((part) => !part.startsWith(WRITE_RULES))
    .join('\n\n')
const chatOf = (core: Core, id: string) => core.chats().find((c) => c.id === id)
const statusOf = (core: Core, id: string) => core.chats().find((p) => p.id === id)?.status
// A subagent is removed when its turn ends, so it counts as idle once it's gone.
const settled = (core: Core, id: string) => (statusOf(core, id) ?? 'idle') === 'idle'
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

  it("opens each mod's chat first, permanent and running in the scratch folder with its instructions", async () => {
    const t = setup(textScript)
    const otherMod: Mod = { ...mainMod, id: 'other-mod', chats: [{ id: 'side', name: 'Side', instructions: '' }] }
    const both = setup(textScript, tempDir(), TEST_STOP_GRACE_MS, [mainMod, otherMod])
    expect(both.core.chats().map((c) => c.id)).toEqual(['main', 'side'])
    expect(t.core.chats()).toEqual([
      expect.objectContaining({ id: 'main', name: MAIN.name, mod: mainMod.id, engine: 'fake', folders: [], files: [] }),
    ])
    expect(chatOf(t.core, 'main')?.parentId).toBeUndefined()
    t.handle({ type: 'chat.send', chatId: 'main', text: 'hi' })
    await until(() => statusOf(t.core, 'main') === 'idle')
    expect(t.calls[0]?.options.cwd).toBe(join(t.garage, 'work', 'home'))
    expect(t.calls[0]?.options.instructions.split('\n\n')[0]).toBe(MAIN.instructions)
    expect(statSync(join(t.garage, 'work', 'home')).isDirectory()).toBe(true)
    const log = readFileSync(join(t.garage, 'chats', 'main', 'log.jsonl'), 'utf8')
    expect(log.trim().split('\n')).toHaveLength(4)

    expect(() => t.handle({ type: 'chat.archive', chatId: 'main', archived: true })).toThrow(MAIN.name)
    expect(() => t.handle({ type: 'chat.delete', chatId: 'main' })).toThrow(MAIN.name)
    expect(() => t.handle({ type: 'chat.rename', chatId: 'main', name: 'Mine' })).toThrow(MAIN.name)
    t.core.close()
    expect(entriesOf(setup(textScript, t.garage).core, 'main')).toHaveLength(4)
  })

  it("keeps a mod's chat free of folders, files and its own AGENTS.md, dropping any a garage saved", async () => {
    const garage = tempDir()
    const dir = realpathSync(tempDir())
    const file = join(dir, 'notes.md')
    writeFileSync(file, 'NOTES')
    mkdirSync(join(garage, 'chats', 'main'), { recursive: true })
    const saved = { id: 'main', name: 'Home', folders: [dir], files: [file], engine: 'fake', createdAt: at }
    writeFileSync(join(garage, 'chats', 'main', 'chat.json'), JSON.stringify(saved))
    const t = setup(textScript, garage)
    expect(chatOf(t.core, 'main')).toMatchObject({ name: MAIN.name, folders: [], files: [] })
    const rewritten = JSON.parse(readFileSync(join(garage, 'chats', 'main', 'chat.json'), 'utf8'))
    expect(rewritten).toMatchObject({ name: MAIN.name, folders: [], files: [] })
    for (const [section, path] of [['folders', dir], ['files', file]] as const) {
      expect(() => t.handle({ type: 'context.add', chatId: 'main', section, path })).toThrow(MAIN.name)
    }
    expect(() => t.handle({ type: 'context.write', chatId: 'main', text: 'MINE' })).toThrow(MAIN.name)
    expect(existsSync(join(garage, 'chats', 'main', 'AGENTS.md'))).toBe(false)
    t.handle({ type: 'chat.send', chatId: 'main', text: 'hi' })
    await until(() => statusOf(t.core, 'main') === 'idle')
    expect(t.calls[0]?.options.cwd).toBe(join(garage, 'work', 'home'))
    expect(t.calls[0]?.options).not.toHaveProperty('extraDirs')
  })

  it("hides an off mod's chat and its subagents, keeping their history, and shows them again once it is on", async () => {
    const first = setup(textScript)
    first.handle({ type: 'chat.send', chatId: 'main', text: 'hi' })
    await until(() => statusOf(first.core, 'main') === 'idle')
    first.core.close()
    mkdirSync(join(first.garage, 'chats', 'sub'), { recursive: true })
    const subagent = { id: 'sub', name: 'Sub', parentId: 'main', subagent: true, engine: 'fake', createdAt: at }
    writeFileSync(join(first.garage, 'chats', 'sub', 'chat.json'), JSON.stringify(subagent))
    const t = setup(textScript, first.garage)
    const space = createChat(t, { name: 'Space' })
    expect(t.core.chats().map((c) => c.id)).toEqual(['main', 'sub', space.id])

    t.handle({ type: 'mod.setEnabled', modId: mainMod.id, enabled: false })
    expect(t.messages.slice(-3)).toEqual([
      { type: 'mod.updated', mod: expect.objectContaining({ id: mainMod.id, enabled: false }) },
      { type: 'chat.removed', chatId: 'main' },
      { type: 'chat.removed', chatId: 'sub' },
    ])
    expect(t.core.chats().map((c) => c.id)).toEqual([space.id])
    expect(() => t.handle({ type: 'chat.send', chatId: 'main', text: 'hi' })).toThrow('Unknown chat "main"')
    expect(() => t.handle({ type: 'context.get', chatId: 'sub' })).toThrow('Unknown chat "sub"')
    expect(readFileSync(join(t.garage, 'chats', 'main', 'log.jsonl'), 'utf8')).toContain('hi')
    t.core.close()

    const reopened = setup(textScript, t.garage)
    expect(reopened.core.chats().map((c) => c.id)).toEqual([space.id])
    reopened.handle({ type: 'mod.setEnabled', modId: mainMod.id, enabled: true })
    expect(reopened.messages.slice(-2).map((m) => m.type === 'chat.added' && m.chat.id)).toEqual(['sub', 'main'])
    expect(reopened.core.chats().map((c) => c.id)).toEqual(['main', ...[space.id, 'sub'].sort()])
    expect(entriesOf(reopened.core, 'main')).toHaveLength(4)
  })

  it('refuses to turn a mod off while its chat or a subagent of it is busy', async () => {
    const t = setup(permissionScript)
    t.handle({ type: 'chat.send', chatId: 'main', text: 'go' })
    await until(() => statusOf(t.core, 'main') === 'waiting')
    expect(() => t.handle({ type: 'mod.setEnabled', modId: mainMod.id, enabled: false })).toThrow(
      `Stop "${MAIN.name}" before turning ${mainMod.name} off`,
    )
    expect(t.core.mods()[0]?.enabled).toBe(true)
    expect(chatOf(t.core, 'main')).toBeDefined()
  })

  it('opens with no chats when no mod has one, and makes spaces as usual', () => {
    const t = setup(textScript, tempDir(), TEST_STOP_GRACE_MS, [])
    expect(t.core.chats()).toEqual([])
    expect(createChat(t, { name: 'First' })).toMatchObject({ name: 'First', folders: [] })
  })

  it('refuses two mod chats with one id', () => {
    const twin: Mod = { ...mainMod, id: 'twin' }
    expect(() => setup(textScript, tempDir(), TEST_STOP_GRACE_MS, [mainMod, twin])).toThrow(
      'Two mod chats have the id "main"',
    )
  })

  it("always names a mod's chat as its mod does, even in a garage that saved another name", () => {
    for (const old of ['Main', 'Workshop', 'Home']) {
      const garage = tempDir()
      mkdirSync(join(garage, 'chats', 'main'), { recursive: true })
      const saved = { id: 'main', title: old, name: old, engine: 'fake', archived: false, createdAt: at }
      writeFileSync(join(garage, 'chats', 'main', 'chat.json'), JSON.stringify(saved))
      expect(chatOf(setup(textScript, garage).core, 'main')?.name).toBe(MAIN.name)
    }
  })

  it('creates named chats at the top, stored flat in the garage, and keeps their names', async () => {
    const t = setup(textScript)
    const chat = createChat(t, { name: '  Build speed ' })
    expect(chat).toMatchObject({ name: 'Build speed', engine: 'fake', folders: [], files: [] })
    expect(chat).not.toHaveProperty('parentId')
    expect(chat.id).toMatch(/^[0-9a-f]{8}$/)
    expect(JSON.parse(readFileSync(chatFile(t, chat.id), 'utf8'))).toEqual({
      id: chat.id,
      name: 'Build speed',
      folders: [],
      files: [],
      engine: 'fake',
      archived: false,
      createdAt: chat.createdAt,
    })

    t.handle({ type: 'chat.send', chatId: chat.id, text: 'Please look into why the build is slow on CI today' })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    expect(chatOf(t.core, chat.id)?.name).toBe('Build speed')
    expect(t.calls[0]?.options.cwd).toBe(join(t.garage, 'work', chat.id))
    const other = createChat(t, { name: 'Other', parentId: 'main' } as never)
    expect(other).not.toHaveProperty('parentId')

    expect(() => t.handle({ type: 'chat.create', name: '  ' })).toThrow(/name/i)
    expect(() => t.handle({ type: 'chat.create' } as never)).toThrow(/name/i)
    t.core.close()
    expect(byId(setup(textScript, t.garage).core.chats())).toEqual(byId(t.core.chats()))
  })

  it('moves named chats saved below another chat to the top, while subagents keep their parent', () => {
    const garage = tempDir()
    const save = (info: { id: string } & Record<string, unknown>) => {
      mkdirSync(join(garage, 'chats', info.id), { recursive: true })
      writeFileSync(join(garage, 'chats', info.id, 'chat.json'), JSON.stringify(info))
    }
    const base = { engine: 'fake', archived: false, createdAt: at }
    save({ id: 'aaaa0001', name: 'Old space', parentId: 'main', ...base })
    save({ id: 'aaaa0002', name: 'Deeper', parentId: 'aaaa0001', ...base })
    save({ id: 'aaaa0003', name: 'Sub', parentId: 'aaaa0001', subagent: true, ...base })
    const t = setup(textScript, garage)
    expect(chatOf(t.core, 'aaaa0001')).not.toHaveProperty('parentId')
    expect(chatOf(t.core, 'aaaa0002')).not.toHaveProperty('parentId')
    expect(chatOf(t.core, 'aaaa0003')).toMatchObject({ parentId: 'aaaa0001', subagent: true })
    expect(JSON.parse(readFileSync(chatFile(t, 'aaaa0001'), 'utf8'))).not.toHaveProperty('parentId')
  })

  it('removes a subagent left over from before, once it has worked, with its folder', () => {
    const first = setup(textScript)
    const space = createChat(first, { name: 'Space' })
    first.core.close()
    for (const id of ['done', 'fresh']) {
      mkdirSync(join(first.garage, 'chats', id), { recursive: true })
      const saved = { id, name: id, parentId: space.id, subagent: true, engine: 'fake', createdAt: at }
      writeFileSync(join(first.garage, 'chats', id, 'chat.json'), JSON.stringify(saved))
    }
    const entry = { at, type: 'user', text: 'Go' }
    writeFileSync(join(first.garage, 'chats', 'done', 'log.jsonl'), JSON.stringify(entry) + '\n')
    const t = setup(textScript, first.garage)
    expect(chatOf(t.core, 'done')).toBeUndefined()
    expect(existsSync(join(t.garage, 'chats', 'done'))).toBe(false)
    expect(chatOf(t.core, 'fresh')).toBeDefined()
    expect(chatOf(t.core, space.id)).toBeDefined()
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

  it('moves and pins spaces, and keeps their places across a restart', () => {
    const t = setup(textScript)
    const [a, b, c] = ['A', 'B', 'C'].map((name) => createChat(t, { name })) as [ChatState, ChatState, ChatState]
    const places = (core: Core) =>
      core
        .chats()
        .filter((x) => !x.mod && !x.parentId)
        .sort(bySpaceOrder)
        .map((x) => (x.pinned ? `${x.name}*` : x.name))
    t.handle({ type: 'chat.move', chatId: a.id, pinned: false, index: 0 })
    t.handle({ type: 'chat.move', chatId: b.id, pinned: false, index: 1 })
    t.handle({ type: 'chat.move', chatId: c.id, pinned: false, index: 2 })
    expect(places(t.core)).toEqual(['A', 'B', 'C'])
    t.handle({ type: 'chat.move', chatId: c.id, pinned: false, index: 0 })
    expect(places(t.core)).toEqual(['C', 'A', 'B'])
    t.handle({ type: 'chat.move', chatId: b.id, pinned: true, index: 0 })
    expect(places(t.core)).toEqual(['B*', 'C', 'A'])
    expect(JSON.parse(readFileSync(chatFile(t, b.id), 'utf8'))).toMatchObject({ pinned: true, order: 0 })
    t.handle({ type: 'chat.move', chatId: b.id, pinned: false, index: 0 })
    expect(places(t.core)).toEqual(['B', 'C', 'A'])
    expect(JSON.parse(readFileSync(chatFile(t, b.id), 'utf8'))).not.toHaveProperty('pinned')
    t.handle({ type: 'chat.move', chatId: a.id, pinned: true, index: 5 })
    expect(places(t.core)).toEqual(['A*', 'B', 'C'])
    expect(() => t.handle({ type: 'chat.move', chatId: 'main', pinned: true, index: 0 })).toThrow(/spaces/)
    expect(() => t.handle({ type: 'chat.move', chatId: a.id, pinned: true, index: 0.5 })).toThrow(/number/)
    t.core.close()

    const reopened = setup(textScript, t.garage)
    expect(places(reopened.core)).toEqual(['A*', 'B', 'C'])
    createChat(reopened, { name: 'D' })
    expect(places(reopened.core)).toEqual(['A*', 'D', 'B', 'C'])
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
    expect(chatOf(t.core, 'abcd0123')).toMatchObject({ name: 'Old subchat', folders: [], files: [] })
    expect(chatOf(t.core, 'abcd0123')).not.toHaveProperty('title')
    expect(existsSync(join(projectDir, 'project.json'))).toBe(true)
  })
})

describe('work folder', () => {
  const workOf = (t: { garage: string }) => join(t.garage, 'work')
  const sessionOf = async (t: ReturnType<typeof setup>, chatId: string) => {
    t.handle({ type: 'chat.send', chatId, text: 'hi' })
    await until(() => settled(t.core, chatId))
    return t.calls.at(-1)!.options
  }
  const saveSubagent = (garage: string, id: string, parentId: string) => {
    mkdirSync(join(garage, 'chats', id), { recursive: true })
    const saved = { id, name: id, parentId, subagent: true, engine: 'fake', archived: false, createdAt: at }
    writeFileSync(join(garage, 'chats', id, 'chat.json'), JSON.stringify(saved))
  }

  it('refuses to run any chat until a work folder is chosen', () => {
    const garage = tempDir()
    const { adapter, calls } = recording(createFakeAdapter(textScript, 0))
    const core = openCore({
      garage,
      adapters: [adapter],
      defaultEngine: 'fake',
      machine: sandboxingMachine,
      mods: [mainMod],
    })
    cores.push(core)
    core.handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true }, () => {})
    expect(core.workFolder()).toEqual({ defaultPath: join(garage, 'work'), canSandbox: true })
    const send = () => core.handle({ type: 'chat.send', chatId: 'main', text: 'hi' }, () => {})
    expect(send).toThrow('Choose a work folder first')
    expect(calls).toHaveLength(0)
    expect(entriesOf(core, 'main')).toEqual([])
  })

  it('makes the chosen folder, saves it and tells every client', () => {
    const t = setup(textScript)
    expect(t.core.workFolder()).toEqual({ path: workOf(t), defaultPath: workOf(t), canSandbox: true })
    const chosen = join(tempDir(), 'deep', 'work')
    t.handle({ type: 'workFolder.set', path: chosen })
    expect(statSync(chosen).isDirectory()).toBe(true)
    expect(t.core.workFolder()).toEqual({ path: chosen, defaultPath: workOf(t), canSandbox: true })
    expect(t.messages.at(-1)).toEqual({ type: 'workFolder.updated', workFolder: t.core.workFolder() })
    expect(JSON.parse(readFileSync(join(t.garage, 'settings.json'), 'utf8')).workFolder).toBe(chosen)
  })

  it('refuses a folder that would let agents write the garage, the home folder or the whole disk', () => {
    const t = setup(textScript)
    const file = join(tempDir(), 'file.txt')
    writeFileSync(file, '')
    const refused = ['/', homedir(), t.garage, dirname(t.garage), join(t.garage, 'chats'), 'relative/work', file]
    for (const path of refused) expect(() => t.handle({ type: 'workFolder.set', path })).toThrow()
    expect(t.core.workFolder().path).toBe(workOf(t))
  })

  it('runs each space in its own folder there, made at its first message and kept, and lets it write only there', async () => {
    const t = setup(textScript)
    const repo = tempDir()
    const chat = createChat(t, { name: 'App', folders: [repo] })
    expect(chat).not.toHaveProperty('workDir')
    const dir = join(workOf(t), chat.id)
    expect(existsSync(dir)).toBe(false)
    expect(await sessionOf(t, chat.id)).toMatchObject({
      cwd: dir,
      extraDirs: [repo],
      sandbox: { writable: [dir], tmpDir: join(dir, '.tmp') },
    })
    expect(statSync(dir).isDirectory()).toBe(true)
    expect(chatOf(t.core, chat.id)?.workDir).toBe(dir)
    expect(JSON.parse(readFileSync(chatFile(t, chat.id), 'utf8')).workDir).toBe(dir)
    expect(t.calls.at(-1)?.options.instructions).toContain(`${WRITE_RULES}\nYour work folder: ${dir}`)

    const moved = join(tempDir(), 'elsewhere')
    t.handle({ type: 'workFolder.set', path: moved })
    expect((await sessionOf(t, chat.id)).cwd).toBe(dir)
    const later = createChat(t, { name: 'Later' })
    expect((await sessionOf(t, later.id)).cwd).toBe(join(moved, later.id))
  })

  it("runs a mod's chat and its subagents in <work>/home, and a space's subagents in the space's folder", async () => {
    const first = setup(textScript)
    const space = createChat(first, { name: 'Space' })
    first.core.close()
    saveSubagent(first.garage, 'homesub', 'main')
    saveSubagent(first.garage, 'spacesub', space.id)
    const t = setup(textScript, first.garage)
    const home = join(workOf(t), 'home')
    for (const [chatId, dir] of [['main', home], ['homesub', home], ['spacesub', join(workOf(t), space.id)]]) {
      expect(await sessionOf(t, chatId!)).toMatchObject({ cwd: dir, sandbox: { writable: [dir] } })
    }
    expect(chatOf(t.core, 'main')).not.toHaveProperty('workDir')
    expect(chatOf(t.core, 'spacesub')).toBeUndefined()
    expect(chatOf(t.core, space.id)?.workDir).toBe(join(workOf(t), space.id))
  })

  it('on a machine that cannot sandbox, runs a chat only with edits anywhere on, and then unsandboxed', async () => {
    const t = setup(textScript)
    t.core.close()
    const { adapter, calls } = recording(createFakeAdapter(textScript, 0))
    const machine = { ...localMachine, canSandbox: false }
    const core = openCore({ garage: t.garage, adapters: [adapter], defaultEngine: 'fake', machine, mods: [mainMod] })
    cores.push(core)
    expect(core.workFolder().canSandbox).toBe(false)
    core.handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true }, () => {})
    const send = () => core.handle({ type: 'chat.send', chatId: 'main', text: 'hi' }, () => {})
    expect(send).toThrow(/can't sandbox engines.*Edits anywhere/)
    expect(entriesOf(core, 'main')).toEqual([])
    core.handle({ type: 'permission.setDefault', name: 'editAnywhere', enabled: true }, () => {})
    core.handle({ type: 'chat.setPermission', chatId: 'main', name: 'editAnywhere', enabled: false }, () => {})
    expect(send).toThrow(/can't sandbox engines.*Edits anywhere/)
    core.handle({ type: 'chat.setPermission', chatId: 'main', name: 'editAnywhere', enabled: true }, () => {})
    send()
    await until(() => statusOf(core, 'main') === 'idle')
    expect(calls[0]?.options.cwd).toBe(join(workOf(t), 'home'))
    expect(calls[0]?.options).not.toHaveProperty('sandbox')
    expect(calls[0]?.options.instructions).not.toContain(WRITE_RULES)
  })
})

describe('worktrees', () => {
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      encoding: 'utf8',
    }).trim()
  const gitRepo = (dir = tempDir()) => {
    mkdirSync(dir, { recursive: true })
    git(dir, 'init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'README.md'), 'committed\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'first')
    return dir
  }
  const branchesOf = (repo: string) => git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n')
  const sessionOf = async (t: ReturnType<typeof setup>, chatId: string) => {
    const before = t.calls.length
    t.handle({ type: 'chat.send', chatId, text: 'hi' })
    await until(() => statusOf(t.core, chatId) === 'idle')
    return t.calls.slice(before).at(-1)?.options
  }

  it('checks each git folder out in the space folder on a new branch from its last commit, and works there', async () => {
    const t = setup(textScript)
    const repo = gitRepo()
    writeFileSync(join(repo, 'README.md'), 'not committed\n')
    const chat = createChat(t, { name: 'Fix the Login!', folders: [repo] })
    const dir = join(t.garage, 'work', chat.id)
    const tree = join(dir, basename(repo))
    const branch = 'hotrod/fix-the-login'

    const options = await sessionOf(t, chat.id)
    expect(options).toMatchObject({ cwd: tree, extraDirs: [dir] })
    expect(readFileSync(join(tree, 'README.md'), 'utf8')).toBe('committed\n')
    expect(git(tree, 'branch', '--show-current')).toBe(branch)
    // from: the branch the folder was on.
    expect(chatOf(t.core, chat.id)?.worktrees).toEqual({ [repo]: { path: tree, branch, from: 'main' } })
    expect(JSON.parse(readFileSync(chatFile(t, chat.id), 'utf8')).worktrees).toEqual({
      [repo]: { path: tree, branch, from: 'main' },
    })
    expect(options?.instructions).toContain(`${CHECKOUT_RULES}\n- ${repo}: ${tree} (branch ${branch})`)

    await sessionOf(t, chat.id)
    expect(branchesOf(repo)).toEqual(['hotrod/fix-the-login', 'main'])
    rmSync(tree, { recursive: true })
    expect((await sessionOf(t, chat.id))?.cwd).toBe(tree)
    expect(git(tree, 'branch', '--show-current')).toBe(branch)
  })

  it("lets the session write its repo's objects and refs, but not hooks, config or a branch checked out elsewhere", async () => {
    const t = setup(textScript)
    const repo = gitRepo()
    const chat = createChat(t, { name: 'App', folders: [repo] })
    const dir = join(t.garage, 'work', chat.id)
    const gitDir = join(repo, '.git')
    expect((await sessionOf(t, chat.id))?.sandbox).toEqual({
      writable: [dir, ...['objects', 'refs', 'logs', 'worktrees', 'packed-refs*', 'FETCH_HEAD'].map((p) => join(gitDir, p))],
      readOnly: [join(gitDir, 'refs', 'heads', 'main'), join(gitDir, 'refs', 'heads', 'main.lock')],
      tmpDir: join(dir, '.tmp'),
    })
  })

  it.skipIf(process.platform !== 'darwin')(
    "lets an agent commit in its checkout but not touch the user's checkout, its branch or git hooks",
    async () => {
      const t = setup(textScript)
      // Outside the per-user temp folder, which a sandbox leaves writable.
      const repo = gitRepo(realpathSync(mkdtempSync('/tmp/hotrod-test-')))
      dirs.push(repo)
      const chat = createChat(t, { name: 'App', folders: [repo] })
      const options = (await sessionOf(t, chat.id))!
      const run = (command: string) =>
        localMachine.run('/bin/sh', ['-c', command], { cwd: options.cwd, sandbox: options.sandbox })
      const identity = '-c user.name=Agent -c user.email=agent@example.com'
      expect(await run(`echo change > README.md && git ${identity} commit -qam work`)).toMatchObject({ code: 0 })
      expect(git(repo, 'log', '-1', '--format=%s', 'hotrod/app')).toBe('work')
      for (const escape of [
        `git update-ref refs/heads/main HEAD`,
        `git -C ${JSON.stringify(repo)} checkout -q -b other`,
        `echo x > ${JSON.stringify(join(repo, 'README.md'))}`,
        `echo x > ${JSON.stringify(join(repo, '.git', 'hooks', 'post-checkout'))}`,
        `git config core.fsmonitor true`,
      ]) {
        expect((await run(escape)).code, escape).not.toBe(0)
      }
      expect(git(repo, 'log', '-1', '--format=%s', 'main')).toBe('first')
      expect(git(repo, 'status', '--porcelain')).toBe('')
    },
  )

  it('picks a free branch and a free folder name', async () => {
    const t = setup(textScript)
    const repo = gitRepo()
    const twin = gitRepo(join(tempDir(), basename(repo)))
    const first = createChat(t, { name: 'App', folders: [repo] })
    const second = createChat(t, { name: 'App', folders: [repo, twin] })
    await sessionOf(t, first.id)
    await sessionOf(t, second.id)
    const dir = join(t.garage, 'work', second.id)
    expect(chatOf(t.core, second.id)?.worktrees).toEqual({
      [repo]: { path: join(dir, basename(repo)), branch: 'hotrod/app-2', from: 'main' },
      [twin]: { path: join(dir, `${basename(repo)}-2`), branch: 'hotrod/app', from: 'main' },
    })
  })

  it("ends the turn with git's error when a folder can't be checked out", async () => {
    const t = setup(textScript)
    const empty = tempDir()
    git(empty, 'init', '-q')
    const chat = createChat(t, { name: 'App', folders: [empty] })
    expect(await sessionOf(t, chat.id)).toBeUndefined()
    const end = entriesOf(t.core, chat.id).at(-1)
    expect(end).toMatchObject({ type: 'turn.completed', error: expect.stringContaining(`Couldn't check out ${empty}`) })
  })

  it('ends the turn at once on Stop while a checkout is being made, and starts no engine', async () => {
    const slow: Machine = {
      ...sandboxingMachine,
      run: async (command, args, options) => {
        if (args.includes('add')) await new Promise((resolve) => setTimeout(resolve, 100))
        return localMachine.run(command, args, options)
      },
    }
    const { adapter, calls } = recording(createFakeAdapter(textScript, 0))
    const garage = tempDir()
    const core = openCore({ garage, adapters: [adapter], defaultEngine: 'fake', machine: slow, mods: [] })
    cores.push(core)
    const handle = (m: Parameters<Core['handle']>[0]) => core.handle(m, () => {})
    const t = { core, garage, messages: [] as CoreMessage[], replies: [] as CoreMessage[], handle }
    core.onMessage((m) => t.messages.push(m))
    core.handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true }, () => {})
    core.handle({ type: 'workFolder.set', path: join(garage, 'work') }, () => {})
    const chat = createChat(t, { name: 'App', folders: [gitRepo()] })
    core.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' }, () => {})
    expect(statusOf(core, chat.id)).toBe('running')
    core.handle({ type: 'chat.interrupt', chatId: chat.id }, () => {})
    expect(statusOf(core, chat.id)).toBe('idle')
    expect(entriesOf(core, chat.id).at(-1)).toMatchObject({ type: 'turn.completed', error: 'Interrupted' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(calls).toHaveLength(0)
    expect(statusOf(core, chat.id)).toBe('idle')
  })

  it('removes the checkouts and the space folder when the space is deleted, keeping the branch', async () => {
    const t = setup(textScript)
    const repo = gitRepo()
    const chat = createChat(t, { name: 'App', folders: [repo] })
    await sessionOf(t, chat.id)
    const dir = join(t.garage, 'work', chat.id)
    t.handle({ type: 'chat.delete', chatId: chat.id })
    await until(() => !existsSync(dir))
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(dir)
    expect(branchesOf(repo)).toEqual(['hotrod/app', 'main'])
  })

  describe('cleanup', () => {
    // A sweep runs git back to back, so a quiet spell means the one that started has finished.
    const quietMachine = (base = sandboxingMachine) => {
      let running = 0
      let lastEndMs = 0
      const machine: Machine = {
        ...base,
        run: async (command, args, options) => {
          running++
          try {
            return await base.run(command, args, options)
          } finally {
            running--
            lastEndMs = Date.now()
          }
        },
      }
      const quiet = async () => {
        while (running || Date.now() - lastEndMs < 200) await new Promise((r) => setTimeout(r, 20))
      }
      return { machine, quiet }
    }
    const repoWithOrigin = () => {
      const origin = tempDir()
      git(origin, 'init', '-q', '--bare', '-b', 'main')
      const repo = gitRepo()
      git(repo, 'remote', 'add', 'origin', origin)
      git(repo, 'push', '-q', '-u', 'origin', 'main')
      return { origin, repo }
    }
    const branchIn = (
      { origin, repo }: { origin: string; repo: string },
      path: string,
      branch: string,
      { push = true, merge = true, gone = true } = {},
    ) => {
      if (!existsSync(path)) git(repo, 'worktree', 'add', '-q', '-b', branch, path, 'main')
      writeFileSync(join(path, `${branch.replace('/', '-')}.txt`), 'work\n')
      git(path, 'add', '-A')
      git(path, 'commit', '-q', '-m', branch)
      if (push) git(path, 'push', '-q', '-u', 'origin', branch)
      if (merge) {
        git(repo, 'merge', '-q', '--no-ff', '-m', `Merge ${branch}`, branch)
        git(repo, 'push', '-q', 'origin', 'main')
      }
      if (push && gone) git(origin, 'update-ref', '-d', `refs/heads/${branch}`)
      return path
    }

    it("removes an agent's worktree in the space folder once its branch is merged and gone upstream", async () => {
      const { machine, quiet } = quietMachine()
      const { adapter, calls } = recording(createFakeAdapter(textScript, 0))
      const opened = open(tempDir(), [adapter], adapter.id, TEST_STOP_GRACE_MS, [adapter.id], [mainMod], machine)
      const t = { ...opened, calls }
      const remote = repoWithOrigin()
      const { repo } = remote
      const chat = createChat(t, { name: 'App', folders: [repo] })
      await sessionOf(t, chat.id)
      await quiet()
      const dir = join(t.garage, 'work', chat.id)

      const own = branchIn(remote, join(dir, basename(repo)), 'hotrod/app')
      const merged = branchIn(remote, join(dir, 'merged'), 'merged')
      const dirty = branchIn(remote, join(dir, 'dirty'), 'dirty')
      writeFileSync(join(dirty, 'notes.txt'), 'not committed\n')
      const unmerged = branchIn(remote, join(dir, 'unmerged'), 'unmerged', { merge: false })
      const local = branchIn(remote, join(dir, 'local'), 'local', { push: false })
      const outside = branchIn(remote, join(tempDir(), 'outside'), 'outside')
      expect(git(repo, 'branch', '-r')).toContain('origin/merged')

      await sessionOf(t, chat.id)
      await quiet()
      expect(existsSync(merged)).toBe(false)
      expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(merged)
      expect(branchesOf(repo)).toEqual(['dirty', 'hotrod/app', 'local', 'main', 'outside', 'unmerged'])
      for (const kept of [own, dirty, unmerged, local, outside]) expect(existsSync(kept), kept).toBe(true)
      expect(git(repo, 'branch', '-r')).not.toContain('origin/merged')
    })

    const stubSpace = async (baseMachine?: Machine) => {
      const { machine, quiet } = quietMachine(baseMachine)
      const emits: ((event: EngineEvent) => void)[] = []
      const adapter = stubAdapter((_machine, _options, emit) => {
        emits.push(emit)
        return { prompt() {}, interrupt() {}, respond() {}, close() {} }
      })
      const garage = tempDir()
      const remote = repoWithOrigin()
      const base = { engine: adapter.id, archived: false, createdAt: at, folders: [], files: [] }
      for (const info of [
        { id: 'aaaa0001', name: 'App', ...base, folders: [remote.repo] },
        { id: 'sub', name: 'Sub', parentId: 'aaaa0001', subagent: true, ...base },
      ]) {
        mkdirSync(join(garage, 'chats', info.id), { recursive: true })
        writeFileSync(join(garage, 'chats', info.id, 'chat.json'), JSON.stringify(info))
      }
      const t = open(garage, [adapter], adapter.id, TEST_STOP_GRACE_MS, [adapter.id], [mainMod], machine)
      const turn = async (chatId: string) => {
        const before = emits.length
        t.handle({ type: 'chat.send', chatId, text: 'go' })
        await until(() => emits.length > before)
        return emits.at(-1)!
      }
      const end = async (emit: (event: EngineEvent) => void, chatId: string) => {
        emit({ type: 'turn.completed' })
        await until(() => settled(t.core, chatId))
        await quiet()
      }
      await end(await turn('aaaa0001'), 'aaaa0001')
      const merged = branchIn(remote, join(garage, 'work', 'aaaa0001', 'merged'), 'merged')
      return { t, emits, turn, end, merged, quiet }
    }

    it('waits until no chat in the space is running, subagents included', async () => {
      const { t, emits, turn, end, merged } = await stubSpace()
      const sub = await turn('sub')
      await end(await turn('aaaa0001'), 'aaaa0001')
      expect(existsSync(merged)).toBe(true)

      const before = emits.length
      sub({ type: 'turn.completed' })
      await until(() => emits.length > before)
      await end(emits.at(-1)!, 'aaaa0001')
      expect(chatOf(t.core, 'sub')).toBeUndefined()
      expect(existsSync(merged)).toBe(false)
    })

    it('keeps a worktree when a turn starts while the sweep is checking it', async () => {
      let checking = false
      let check = () => {}
      const checked = new Promise<void>((resolve) => (check = resolve))
      const slow: Machine = {
        ...sandboxingMachine,
        run: async (command, args, options) => {
          if (args.includes('status')) {
            checking = true
            await checked
          }
          return sandboxingMachine.run(command, args, options)
        },
      }
      const { turn, end, merged, quiet } = await stubSpace(slow)
      const first = await turn('aaaa0001')
      first({ type: 'turn.completed' })
      await until(() => checking)
      const second = await turn('aaaa0001')
      check()
      await quiet()
      expect(existsSync(merged)).toBe(true)
      await end(second, 'aaaa0001')
      expect(existsSync(merged)).toBe(false)
    })
  })
})

describe('edits', () => {
  const editScript = (...paths: string[]): FakeStep[] => [
    ...paths.flatMap((path, i): FakeStep[] => {
      const call = { toolId: `e${i}`, name: 'Write', kind: 'edit' as const, summary: path, input: { file_path: path } }
      return [{ type: 'tool.started', ...call }, { type: 'permission', ...call, path, output: 'written' }]
    }),
    { type: 'text.completed', text: 'Done' },
  ]
  const run = async (garage: string, paths: string[]) => {
    const t = setup(editScript(...paths), garage)
    t.handle({ type: 'chat.send', chatId: 'main', text: 'edit' })
    await until(() => statusOf(t.core, 'main') !== 'running')
    return t
  }
  const resolved = (t: { core: Core }, chatId = 'main') =>
    entriesOf(t.core, chatId).flatMap((e) => (e.type === 'permission.resolved' ? [e] : []))
  const outputs = (t: { core: Core }) =>
    entriesOf(t.core, 'main').flatMap((e) => (e.type === 'tool.completed' ? [e.output] : []))

  it('allows an edit inside the work folder at once, logged as automatic, relative paths too', async () => {
    const garage = tempDir()
    const home = join(garage, 'work', 'home')
    const t = await run(garage, [join(home, 'src', 'a.ts'), 'notes.md'])
    expect(statusOf(t.core, 'main')).toBe('idle')
    expect(resolved(t).map((e) => [e.allow, e.auto])).toEqual([[true, true], [true, true]])
    expect(outputs(t)).toEqual(['written', 'written'])
    expect(t.messages.some((m) => m.type === 'chat.status' && m.status === 'waiting')).toBe(false)
  })

  it('denies an edit outside the work folder, through .. or a symlink too, and tells the engine why', async () => {
    const garage = tempDir()
    const home = join(garage, 'work', 'home')
    const outside = tempDir()
    mkdirSync(home, { recursive: true })
    symlinkSync(outside, join(home, 'link'))
    const t = await run(garage, [join(outside, 'a.ts'), join(home, '..', 'b.ts'), join(home, 'link', 'c.ts')])
    expect(statusOf(t.core, 'main')).toBe('idle')
    expect(resolved(t).map((e) => [e.allow, e.auto])).toEqual([[false, true], [false, true], [false, true]])
    for (const output of outputs(t)) expect(output).toContain(`Hotrod lets this chat edit only inside ${home}`)
  })

  it('with edits anywhere on, runs a chat unsandboxed from its next message, where an edit outside asks', async () => {
    const garage = tempDir()
    const outside = join(tempDir(), 'a.ts')
    const t = setup(editScript(outside), garage)
    t.handle({ type: 'chat.setPermission', chatId: 'main', name: 'editAnywhere', enabled: true })
    expect(t.messages.at(-1)).toEqual({ type: 'chat.updated', chat: expect.objectContaining({ editAnywhere: true }) })
    expect(JSON.parse(readFileSync(chatFile(t, 'main'), 'utf8')).editAnywhere).toBe(true)
    t.handle({ type: 'chat.send', chatId: 'main', text: 'edit' })
    await until(() => statusOf(t.core, 'main') === 'waiting')
    expect(t.calls[0]?.options).not.toHaveProperty('sandbox')
    expect(t.calls[0]?.options.instructions).not.toContain(WRITE_RULES)
    expect(resolved(t)).toEqual([])
    t.handle({ type: 'chat.interrupt', chatId: 'main', force: true })

    t.handle({ type: 'chat.setPermission', chatId: 'main', name: 'editAnywhere' })
    expect(chatOf(t.core, 'main')).not.toHaveProperty('editAnywhere')
    expect(JSON.parse(readFileSync(chatFile(t, 'main'), 'utf8'))).not.toHaveProperty('editAnywhere')
    t.handle({ type: 'chat.send', chatId: 'main', text: 'edit' })
    await until(() => statusOf(t.core, 'main') === 'idle')
    expect(t.calls[1]?.options.sandbox).toBeDefined()
  })

  it("runs a subagent on its space's permission switches, live, unless it has its own; new spaces start without", async () => {
    const first = setup(textScript)
    const space = createChat(first, { name: 'Space' })
    const file = join(tempDir(), 'a.ts')
    let t = first
    // A subagent is removed once its turn ends, so each run starts one afresh from what's saved.
    const freshSub = () => {
      t.core.close()
      mkdirSync(join(first.garage, 'chats', 'sub'), { recursive: true })
      const saved = { id: 'sub', name: 'Sub', parentId: space.id, subagent: true, engine: 'fake', createdAt: at }
      writeFileSync(join(first.garage, 'chats', 'sub', 'chat.json'), JSON.stringify(saved))
      t = setup(editScript(file), first.garage)
    }
    // The subagent's session, not the space's that its report wakes.
    const edit = async (until_: 'idle' | 'waiting') => {
      const before = t.calls.length
      t.handle({ type: 'chat.send', chatId: 'sub', text: 'edit' })
      await until(() => (until_ === 'idle' ? settled(t.core, 'sub') : statusOf(t.core, 'sub') === until_))
      return t.calls[before]!.options
    }
    freshSub()
    expect((await edit('idle')).sandbox?.writable).toEqual([join(first.garage, 'work', space.id)])

    // Switching edits anywhere on in the space applies to its subagent at once, which then asks the user.
    freshSub()
    t.handle({ type: 'chat.setPermission', chatId: space.id, name: 'editAnywhere', enabled: true })
    expect(chatOf(t.core, 'sub')).not.toHaveProperty('editAnywhere')
    expect(await edit('waiting')).not.toHaveProperty('sandbox')
    const request = entriesOf(t.core, 'sub').findLast((e) => e.type === 'permission.requested')
    if (request?.type !== 'permission.requested') throw new Error('no request')
    t.handle({ type: 'permission.respond', chatId: 'sub', requestId: request.requestId, allow: true })
    await until(() => settled(t.core, 'sub'))
    const sent = t.messages.flatMap((m) => (m.type === 'chat.entry' && m.chatId === 'sub' ? [m.entry] : []))
    expect(sent.findLast((e) => e.type === 'permission.resolved')).toMatchObject({ requestId: request.requestId, allow: true })
    expect(sent.findLast((e) => e.type === 'tool.completed')).toMatchObject({ output: 'written' })

    // Its own switch wins over the space's.
    freshSub()
    t.handle({ type: 'chat.setPermission', chatId: 'sub', name: 'editAnywhere', enabled: false })
    expect((await edit('idle')).sandbox).toBeDefined()

    expect(createChat(t, { name: 'Next' })).not.toHaveProperty('editAnywhere')
    const nope = { type: 'chat.setPermission' as const, chatId: 'nope', name: 'editAnywhere' as const, enabled: true }
    expect(() => t.handle(nope)).toThrow('Unknown chat')
  })

  it('with edits anywhere on by default, runs Home, spaces and subagents that follow it unsandboxed', async () => {
    const first = setup(textScript)
    const space = createChat(first, { name: 'Space' })
    first.handle({ type: 'permission.setDefault', name: 'editAnywhere', enabled: true })
    expect(first.core.workFolder()).toMatchObject({ editAnywhere: true })
    expect(first.messages.at(-1)).toEqual({ type: 'workFolder.updated', workFolder: first.core.workFolder() })
    expect(JSON.parse(readFileSync(join(first.garage, 'settings.json'), 'utf8')).editAnywhere).toBe(true)
    first.core.close()
    mkdirSync(join(first.garage, 'chats', 'sub'), { recursive: true })
    const saved = { id: 'sub', name: 'Sub', parentId: space.id, subagent: true, engine: 'fake', createdAt: at }
    writeFileSync(join(first.garage, 'chats', 'sub', 'chat.json'), JSON.stringify(saved))

    const t = setup(editScript(join(tempDir(), 'a.ts')), first.garage)
    expect(t.core.workFolder().editAnywhere).toBe(true)
    for (const chatId of ['main', space.id, 'sub']) {
      expect(chatOf(t.core, chatId)).not.toHaveProperty('editAnywhere')
      t.handle({ type: 'chat.send', chatId, text: 'edit' })
      await until(() => statusOf(t.core, chatId) === 'waiting')
      expect(t.calls.at(-1)?.options).not.toHaveProperty('sandbox')
      expect(t.calls.at(-1)?.options.instructions).not.toContain(WRITE_RULES)
      t.handle({ type: 'chat.interrupt', chatId, force: true })
      await until(() => settled(t.core, chatId))
    }

    t.handle({ type: 'permission.setDefault', name: 'editAnywhere', enabled: false })
    expect(t.core.workFolder()).toMatchObject({ editAnywhere: false })
    expect(JSON.parse(readFileSync(join(t.garage, 'settings.json'), 'utf8')).editAnywhere).toBe(false)
    t.handle({ type: 'chat.send', chatId: 'main', text: 'edit' })
    await until(() => statusOf(t.core, 'main') === 'idle')
    expect(t.calls.at(-1)?.options.sandbox).toBeDefined()
  })

  it('lets a space turn edits anywhere off while the default is on, and on while it is off', async () => {
    const t = setup(editScript(join(tempDir(), 'a.ts')))
    const space = createChat(t, { name: 'Space' })
    t.handle({ type: 'permission.setDefault', name: 'editAnywhere', enabled: true })
    t.handle({ type: 'chat.setPermission', chatId: space.id, name: 'editAnywhere', enabled: false })
    expect(JSON.parse(readFileSync(chatFile(t, space.id), 'utf8')).editAnywhere).toBe(false)
    t.handle({ type: 'chat.send', chatId: space.id, text: 'edit' })
    await until(() => statusOf(t.core, space.id) === 'idle')
    expect(t.calls.at(-1)?.options.sandbox).toBeDefined()
    expect(resolved(t, space.id).map((e) => [e.allow, e.auto])).toEqual([[false, true]])

    t.handle({ type: 'permission.setDefault', name: 'editAnywhere', enabled: false })
    t.handle({ type: 'chat.setPermission', chatId: space.id, name: 'editAnywhere', enabled: true })
    t.handle({ type: 'chat.send', chatId: space.id, text: 'edit' })
    await until(() => statusOf(t.core, space.id) === 'waiting')
    expect(t.calls.at(-1)?.options).not.toHaveProperty('sandbox')
  })

  it('reads edits anywhere saved on before the defaults as On', async () => {
    const garage = tempDir()
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ engines: {}, editAnywhere: true }))
    mkdirSync(join(garage, 'chats', 'old'), { recursive: true })
    const saved = { id: 'old', name: 'Old', engine: 'fake', archived: false, createdAt: at, editAnywhere: true }
    writeFileSync(join(garage, 'chats', 'old', 'chat.json'), JSON.stringify(saved))
    const t = setup(textScript, garage)
    expect(t.core.workFolder().editAnywhere).toBe(true)
    expect(chatOf(t.core, 'old')?.editAnywhere).toBe(true)
    t.handle({ type: 'chat.send', chatId: 'old', text: 'hi' })
    await until(() => statusOf(t.core, 'old') === 'idle')
    expect(t.calls.at(-1)?.options).not.toHaveProperty('sandbox')
  })

  it('with edits anywhere on by default, runs a chat where the machine cannot sandbox', async () => {
    const t = setup(textScript)
    t.handle({ type: 'permission.setDefault', name: 'editAnywhere', enabled: true })
    t.core.close()
    const { adapter, calls } = recording(createFakeAdapter(textScript, 0))
    const machine = { ...localMachine, canSandbox: false }
    const core = openCore({ garage: t.garage, adapters: [adapter], defaultEngine: 'fake', machine, mods: [mainMod] })
    cores.push(core)
    core.handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true }, () => {})
    core.handle({ type: 'chat.send', chatId: 'main', text: 'hi' }, () => {})
    await until(() => statusOf(core, 'main') === 'idle')
    expect(calls[0]?.options).not.toHaveProperty('sandbox')
  })
})

describe('commands', () => {
  const commandScript = (...commands: string[]): FakeStep[] => [
    ...commands.flatMap((command, i): FakeStep[] => {
      const call = { toolId: `c${i}`, name: 'Bash', kind: 'shell' as const, summary: command, input: { command } }
      return [{ type: 'tool.started', ...call }, { type: 'permission', ...call, command, output: 'ran' }]
    }),
    { type: 'text.completed', text: 'Done' },
  ]
  const resolved = (t: { core: Core }, chatId = 'main') =>
    entriesOf(t.core, chatId).flatMap((e) => (e.type === 'permission.resolved' ? [e] : []))
  const turn = async (t: ReturnType<typeof setup>, chatId = 'main') => {
    t.handle({ type: 'chat.send', chatId, text: 'run' })
    await until(() => statusOf(t.core, chatId) !== 'running')
    const status = statusOf(t.core, chatId)
    if (status === 'waiting') {
      t.handle({ type: 'chat.interrupt', chatId, force: true })
      await until(() => settled(t.core, chatId))
    }
    return status
  }

  it('by default runs a command in a sandboxed chat without asking, logged as automatic', async () => {
    const t = setup(commandScript('npm test', 'ls -la'))
    const space = createChat(t, { name: 'Space' })
    for (const chatId of ['main', space.id]) {
      expect(await turn(t, chatId)).toBe('idle')
      expect(resolved(t, chatId).map((e) => [e.allow, e.auto])).toEqual([[true, true], [true, true]])
      const outputs = entriesOf(t.core, chatId).flatMap((e) => (e.type === 'tool.completed' ? [e.output] : []))
      expect(outputs).toEqual(['ran', 'ran'])
    }
    expect(t.messages.some((m) => m.type === 'chat.status' && m.status === 'waiting')).toBe(false)
  })

  it('still asks before a command that publishes or reaches the network, anywhere in the command', async () => {
    for (const command of ASK_FIRST_COMMANDS) {
      const t = setup(commandScript(`cd app && ${command} origin`))
      expect(await turn(t), command).toBe('waiting')
      expect(resolved(t)).toEqual([])
    }
    const t = setup(commandScript('git status', 'ghost --help'))
    expect(await turn(t)).toBe('idle')
  })

  it('runs network commands without asking too once that default is off', async () => {
    const t = setup(commandScript(`${ASK_FIRST_COMMANDS[0]} origin`))
    t.handle({ type: 'permission.setDefault', name: 'askNetworkCommands', enabled: false })
    expect(await turn(t)).toBe('idle')
    expect(resolved(t).map((e) => e.auto)).toEqual([true])
  })

  it('asks before every command once the default is off, and saves the default in settings.json', async () => {
    const t = setup(commandScript('ls'))
    t.handle({ type: 'permission.setDefault', name: 'autoRunCommands', enabled: false })
    expect(t.core.workFolder()).toMatchObject({ autoRunCommands: false })
    expect(t.messages.at(-1)).toEqual({ type: 'workFolder.updated', workFolder: t.core.workFolder() })
    expect(JSON.parse(readFileSync(join(t.garage, 'settings.json'), 'utf8')).autoRunCommands).toBe(false)
    expect(await turn(t)).toBe('waiting')
    t.handle({ type: 'permission.setDefault', name: 'autoRunCommands', enabled: true })
    expect(await turn(t)).toBe('idle')
  })

  it("lets a space, Home too, turn a default off or on for itself, saved in its chat.json", async () => {
    const t = setup(commandScript('ls'))
    const space = createChat(t, { name: 'Space' })
    t.handle({ type: 'chat.setPermission', chatId: 'main', name: 'autoRunCommands', enabled: false })
    expect(t.messages.at(-1)).toEqual({
      type: 'chat.updated',
      chat: expect.objectContaining({ id: 'main', autoRunCommands: false }),
    })
    expect(JSON.parse(readFileSync(chatFile(t, 'main'), 'utf8')).autoRunCommands).toBe(false)
    expect(await turn(t, 'main')).toBe('waiting')
    expect(await turn(t, space.id)).toBe('idle')

    t.handle({ type: 'permission.setDefault', name: 'autoRunCommands', enabled: false })
    t.handle({ type: 'chat.setPermission', chatId: space.id, name: 'autoRunCommands', enabled: true })
    expect(await turn(t, space.id)).toBe('idle')

    t.handle({ type: 'chat.setPermission', chatId: space.id, name: 'autoRunCommands' })
    expect(chatOf(t.core, space.id)).not.toHaveProperty('autoRunCommands')
    expect(JSON.parse(readFileSync(chatFile(t, space.id), 'utf8'))).not.toHaveProperty('autoRunCommands')
    expect(await turn(t, space.id)).toBe('waiting')
  })

  it('lets a space ask before network commands while the default runs them', async () => {
    const t = setup(commandScript(`${ASK_FIRST_COMMANDS.at(-1)} x`))
    t.handle({ type: 'permission.setDefault', name: 'askNetworkCommands', enabled: false })
    t.handle({ type: 'chat.setPermission', chatId: 'main', name: 'askNetworkCommands', enabled: true })
    expect(await turn(t)).toBe('waiting')
  })

  const fetchScript: FakeStep[] = [
    ...(['WebFetch', 'WebSearch'] as const).flatMap((name, i): FakeStep[] => {
      const call = { toolId: `f${i}`, name, kind: 'fetch' as const, summary: 'example.com', input: { url: 'https://example.com' } }
      return [{ type: 'tool.started', ...call }, { type: 'permission', ...call, output: 'page' }]
    }),
    { type: 'text.completed', text: 'Done' },
  ]

  it('fetches web pages without asking by default, even without the sandbox, and asks once the switch is off', async () => {
    const t = setup(fetchScript)
    const space = createChat(t, { name: 'Space' })
    expect(await turn(t, space.id)).toBe('idle')
    expect(resolved(t, space.id).map((e) => e.auto)).toEqual([true, true])

    t.handle({ type: 'chat.setPermission', chatId: space.id, name: 'editAnywhere', enabled: true })
    expect(await turn(t, space.id)).toBe('idle')

    t.handle({ type: 'permission.setDefault', name: 'autoFetch', enabled: false })
    expect(JSON.parse(readFileSync(join(t.garage, 'settings.json'), 'utf8')).autoFetch).toBe(false)
    expect(await turn(t, space.id)).toBe('waiting')
    t.handle({ type: 'chat.setPermission', chatId: space.id, name: 'autoFetch', enabled: true })
    expect(await turn(t, space.id)).toBe('idle')
  })

  it("asks before a subagent fetches while its space's fetch switch is off", async () => {
    const first = setup(textScript)
    const space = createChat(first, { name: 'Space' })
    first.handle({ type: 'chat.setPermission', chatId: space.id, name: 'autoFetch', enabled: false })
    first.core.close()
    mkdirSync(join(first.garage, 'chats', 'sub'), { recursive: true })
    const saved = { id: 'sub', name: 'Sub', parentId: space.id, subagent: true, engine: 'fake', createdAt: new Date().toISOString() }
    writeFileSync(join(first.garage, 'chats', 'sub', 'chat.json'), JSON.stringify(saved))
    const t = setup(fetchScript, first.garage)
    t.handle({ type: 'chat.send', chatId: 'sub', text: 'fetch' })
    await until(() => statusOf(t.core, 'sub') !== 'running')
    expect(statusOf(t.core, 'sub')).toBe('waiting')
    t.handle({ type: 'chat.interrupt', chatId: 'sub', force: true })
    await until(() => settled(t.core, 'sub'))
  })

  it('asks before every command while a chat runs without the sandbox', async () => {
    const t = setup(commandScript('ls'))
    t.handle({ type: 'chat.setPermission', chatId: 'main', name: 'editAnywhere', enabled: true })
    t.handle({ type: 'chat.setPermission', chatId: 'main', name: 'autoRunCommands', enabled: true })
    t.handle({ type: 'chat.setPermission', chatId: 'main', name: 'askNetworkCommands', enabled: false })
    expect(await turn(t)).toBe('waiting')
    expect(t.calls.at(-1)?.options).not.toHaveProperty('sandbox')

    t.core.close()
    const { adapter, calls } = recording(createFakeAdapter(commandScript('ls'), 0))
    const machine = { ...localMachine, canSandbox: false }
    const core = openCore({ garage: t.garage, adapters: [adapter], defaultEngine: 'fake', machine, mods: [mainMod] })
    cores.push(core)
    core.handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true }, () => {})
    const unsandboxed = { ...t, core, calls, handle: (m: Parameters<Core['handle']>[0]) => core.handle(m, () => {}) }
    expect(await turn(unsandboxed)).toBe('waiting')
  })

  it('asks when the engine gives no command, and refuses an unknown switch', async () => {
    const t = setup(permissionScript)
    expect(await turn(t)).toBe('waiting')
    const unknown = { name: 'everything', enabled: true } as unknown as { name: 'autoRunCommands'; enabled: boolean }
    const messages = [{ type: 'permission.setDefault' as const }, { type: 'chat.setPermission' as const, chatId: 'main' }]
    for (const message of messages) {
      expect(() => t.handle({ ...message, ...unknown })).toThrow('Unknown permission switch')
    }
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
    expect(t.calls[0]?.options.extraDirs).toEqual([chat.path])
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

    const instructions = withoutRules(t.calls[1]?.options.instructions)
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

describe('read state', () => {
  const finish = async (t: ReturnType<typeof setup>, chatId: string) => {
    t.handle({ type: 'chat.send', chatId, text: 'hi' })
    await until(() => statusOf(t.core, chatId) === 'idle')
  }

  it('marks a chat unread when a turn ends, until the user reads it', async () => {
    const t = setup(textScript)
    const chat = folderChat(t)
    expect(isUnread(chatOf(t.core, chat.id)!)).toBe(false)
    await finish(t, chat.id)
    const done = chatOf(t.core, chat.id)!
    expect(done.doneAt).toBe(entriesOf(t.core, chat.id).at(-1)?.at)
    expect(isUnread(done)).toBe(true)
    // Every window hears it, after the status.
    const types = t.messages.map((m) => m.type)
    expect(types.lastIndexOf('chat.updated')).toBeGreaterThan(types.lastIndexOf('chat.status'))

    t.handle({ type: 'chat.read', chatId: chat.id })
    expect(isUnread(chatOf(t.core, chat.id)!)).toBe(false)
    expect(t.messages.at(-1)).toMatchObject({ type: 'chat.updated', chat: { id: chat.id, readAt: expect.any(String) } })
    // Reading it again changes nothing.
    const count = t.messages.length
    t.handle({ type: 'chat.read', chatId: chat.id })
    expect(t.messages).toHaveLength(count)

    await finish(t, chat.id)
    expect(isUnread(chatOf(t.core, chat.id)!)).toBe(true)
  })

  it('keeps read state across a restart', async () => {
    const t = setup(textScript)
    const read = folderChat(t)
    const unread = folderChat(t)
    await finish(t, read.id)
    await finish(t, unread.id)
    t.handle({ type: 'chat.read', chatId: read.id })
    t.core.close()

    const reopened = setup(textScript, t.garage)
    expect(isUnread(chatOf(reopened.core, read.id)!)).toBe(false)
    expect(isUnread(chatOf(reopened.core, unread.id)!)).toBe(true)
    const file = JSON.parse(readFileSync(join(t.garage, 'chats', unread.id, 'chat.json'), 'utf8'))
    expect(file).toMatchObject({ doneAt: expect.any(String) })
    expect(file.readAt).toBeUndefined()
  })

  it("doesn't mark chats from before read state existed unread, only their next turn", async () => {
    const t = setup(textScript)
    const chat = folderChat(t)
    await finish(t, chat.id)
    t.core.close()
    // An older Hotrod wrote neither time.
    const file = join(t.garage, 'chats', chat.id, 'chat.json')
    const { doneAt: _done, readAt: _read, ...old } = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify(old))

    const reopened = setup(textScript, t.garage)
    expect(isUnread(chatOf(reopened.core, chat.id)!)).toBe(false)
    await finish(reopened, chat.id)
    expect(isUnread(chatOf(reopened.core, chat.id)!)).toBe(true)
  })
})

describe('questions', () => {
  const format = 'How should I format it?'
  const questionScript: FakeStep[] = [
    { type: 'tool.started', toolId: 'q1', name: 'AskUserQuestion', kind: 'other', summary: 'ask', input: {} },
    {
      type: 'question',
      toolId: 'q1',
      questions: [
        {
          header: 'Format',
          question: format,
          options: [
            { label: 'Summary', description: 'Brief' },
            { label: 'Detailed', description: 'Long' },
          ],
          multiSelect: false,
        },
      ],
    },
    { type: 'text.completed', text: 'Done' },
  ]
  const asked = async (t: ReturnType<typeof setup>, chatId = 'main') => {
    t.handle({ type: 'chat.send', chatId, text: 'go' })
    await until(() => statusOf(t.core, chatId) === 'waiting')
    const question = entriesOf(t.core, chatId).findLast((e) => e.type === 'question.asked')
    if (question?.type !== 'question.asked') throw new Error('no question')
    return question.requestId
  }

  it('waits for the answer, even where commands and edits are allowed without asking, then sends it on', async () => {
    const t = setup(questionScript)
    const requestId = await asked(t)
    expect(entriesOf(t.core, 'main').some((e) => e.type === 'permission.resolved')).toBe(false)

    t.handle({ type: 'question.respond', chatId: 'main', requestId, answers: { [format]: ['Detailed'] } })
    expect(statusOf(t.core, 'main')).not.toBe('waiting')
    await until(() => statusOf(t.core, 'main') === 'idle')
    const entries = entriesOf(t.core, 'main')
    expect(entries.find((e) => e.type === 'question.resolved')).toEqual({
      at: expect.any(String),
      type: 'question.resolved',
      requestId,
      answers: { [format]: ['Detailed'] },
    })
    expect(entries.find((e) => e.type === 'tool.completed')).toMatchObject({ isError: false })
    expect(entries.find((e) => e.type === 'tool.completed')).toMatchObject({ output: expect.stringContaining('Detailed') })
    const log = readFileSync(join(t.garage, 'chats', 'main', 'log.jsonl'), 'utf8')
    expect(log).toContain('"question.asked"')
    expect(log).toContain('"question.resolved"')
  })

  it('tells the engine the user declined when they skip', async () => {
    const t = setup(questionScript)
    const requestId = await asked(t)
    t.handle({ type: 'question.respond', chatId: 'main', requestId })
    await until(() => statusOf(t.core, 'main') === 'idle')
    const entries = entriesOf(t.core, 'main')
    const resolved = entries.find((e) => e.type === 'question.resolved')
    expect(resolved).toEqual({ at: expect.any(String), type: 'question.resolved', requestId })
    expect(entries.find((e) => e.type === 'tool.completed')).toMatchObject({ isError: true })
  })

  it('refuses an answer to anything but a pending question, and answers that are not lists of text', async () => {
    const t = setup([...permissionScript, ...questionScript])
    t.handle({ type: 'chat.send', chatId: 'main', text: 'go' })
    await until(() => statusOf(t.core, 'main') === 'waiting')
    const permission = entriesOf(t.core, 'main').find((e) => e.type === 'permission.requested')
    if (permission?.type !== 'permission.requested') throw new Error('no request')
    const answer = { type: 'question.respond' as const, chatId: 'main', requestId: permission.requestId }
    expect(() => t.handle(answer)).toThrow('No pending question')
    t.handle({ type: 'permission.respond', chatId: 'main', requestId: permission.requestId, allow: true })

    await until(() => entriesOf(t.core, 'main').some((e) => e.type === 'question.asked'))
    const question = entriesOf(t.core, 'main').find((e) => e.type === 'question.asked')
    if (question?.type !== 'question.asked') throw new Error('no question')
    const { requestId } = question
    expect(() => t.handle({ type: 'permission.respond', chatId: 'main', requestId, allow: true })).toThrow()
    for (const answers of [{ [format]: 'Summary' }, { [format]: [1] }, ['Summary'], 'Summary']) {
      expect(() => t.handle({ ...answer, requestId, answers } as never)).toThrow('Answers')
    }
    expect(statusOf(t.core, 'main')).toBe('waiting')
    expect(() => t.handle({ ...answer, requestId: 'nope' })).toThrow('No pending question')
  })

  it('drops a question left open when the turn stops, and keeps it unanswered across a restart', async () => {
    const t = setup(questionScript)
    const requestId = await asked(t)
    t.handle({ type: 'chat.interrupt', chatId: 'main' })
    await until(() => statusOf(t.core, 'main') === 'idle')
    expect(() => t.handle({ type: 'question.respond', chatId: 'main', requestId })).toThrow('No pending question')
    t.core.close()

    const reopened = setup(questionScript, t.garage)
    const entries = entriesOf(reopened.core, 'main')
    expect(types(entries).slice(-2)).toEqual(['question.asked', 'turn.completed'])
    expect(() => reopened.handle({ type: 'question.respond', chatId: 'main', requestId })).toThrow()
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

  it("pins a chat to a model on another engine, saves it and tells every client", async () => {
    const t = setupEngines()
    await t.core.refreshEngines()
    const chat = folderChat(t)
    const other = createChat(t)
    t.handle({ type: 'chat.setModel', chatId: chat.id, engine: 'beta', model: otherModel })
    const { status, entries, draft, queue, ...info } = chatOf(t.core, chat.id)!
    expect(t.messages.at(-1)).toEqual({ type: 'chat.updated', chat: { ...info, engine: 'beta', model: otherModel } })
    expect(engineOf(t.core, chat.id)).toBe('beta')
    expect(engineOf(t.core, other.id)).toBe('alpha')
    t.core.close()
    expect(chatOf(setupEngines(t.garage).core, chat.id)).toMatchObject({ engine: 'beta', model: otherModel })
  })

  it('rejects an unknown engine and a change while a turn runs', async () => {
    const t = setupEngines()
    await t.core.refreshEngines()
    const chat = folderChat(t)
    expect(() => t.handle({ type: 'chat.setModel', chatId: chat.id, engine: 'nope', model: otherModel })).toThrow(
      /Unknown engine "nope"/,
    )
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })
    expect(() => t.handle({ type: 'chat.setModel', chatId: chat.id, engine: 'beta', model: otherModel })).toThrow(/turn/)
    expect(engineOf(t.core, chat.id)).toBe('alpha')
    expect(JSON.parse(readFileSync(chatFile(t, chat.id), 'utf8')).engine).toBe('alpha')
  })

  it('continues a chat on another engine with the whole conversation', async () => {
    const t = setupEngines()
    await t.core.refreshEngines()
    const chat = folderChat(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'first question' })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    t.handle({ type: 'chat.setModel', chatId: chat.id, engine: 'beta', model: otherModel })
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
    expect(() => t.handle({ type: 'chat.setModel', chatId: chat.id, thinking: 'nope' as never })).toThrow(
      /thinking level "nope"/,
    )
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })
    expect(() => t.handle({ type: 'chat.setModel', chatId: chat.id, model: FAKE_MODELS[0]! })).toThrow(/turn/)
    expect(chatOf(t.core, chat.id)?.model).toBeUndefined()
  })

  it("keeps the chat's own thinking level on another engine only where that model takes it", async () => {
    const alpha = createFakeAdapter([], 0)
    const betaOffers = { models: FAKE_MODELS, thinking: ['low', 'medium'] as ThinkingLevel[] }
    const detect = async () => ({ installed: true, signedIn: true, ...betaOffers })
    const beta: Adapter = { ...alpha, id: 'beta', detect }
    const t = open(tempDir(), [{ ...alpha, id: 'alpha' }, beta], 'alpha')
    await t.core.refreshEngines()
    t.handle({ type: 'chat.setModel', chatId: 'main', thinking: 'low' })
    t.handle({ type: 'chat.setModel', chatId: 'main', engine: 'beta', model: otherModel, thinking: 'low' })
    expect(chatOf(t.core, 'main')).toMatchObject({ engine: 'beta', model: otherModel, thinking: 'low' })
    expect(() => t.handle({ type: 'chat.setModel', chatId: 'main', engine: 'beta', model: otherModel, thinking: 'high' })).toThrow(
      /offers no thinking level "high"/,
    )
  })

  it('keeps a chat whose saved engine is gone, refuses to send, then follows the Chat list once it can run', async () => {
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
    // Once the engines are detected, the Chat list holds the default engine's model, and the chat moves onto it.
    await reopened.core.refreshEngines()
    expect(engineOf(reopened.core, chat.id)).toBe('alpha')
    reopened.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })
    expect(reopened.alpha).toHaveLength(1)
  })

})

describe('settings', () => {
  const settingsFile = (t: { garage: string }) => join(t.garage, 'settings.json')
  const engineInfo = (core: Core, id: string) => core.engines().find((e) => e.id === id)

  it('starts with every engine off, refuses to send, and points at Settings', () => {
    const fake = recording(createFakeAdapter(textScript, 0))
    const t = open(tempDir(), [fake.adapter], 'fake', TEST_STOP_GRACE_MS, [])
    expect(t.core.engines()).toEqual([{ id: 'fake', name: 'Fake', enabled: false, installed: false, signedIn: false }])
    expect(JSON.parse(readFileSync(settingsFile(t), 'utf8')).engines).toEqual({})
    expect(() => t.handle({ type: 'chat.send', chatId: 'main', text: 'hi' })).toThrow(/"fake" is off.*Settings/)
    expect(fake.calls).toHaveLength(0)
    expect(entriesOf(t.core, 'main')).toEqual([])
    expect(createChat(t).engine).toBe('fake')
    expect(() => t.handle({ type: 'chat.create', name: 'Named', engine: 'fake' })).toThrow(/"fake" is off/)
  })

  it('turns an engine on, saves it in settings.json and tells every client', async () => {
    const garage = tempDir()
    const work = join(garage, 'work')
    const t = open(garage, [createFakeAdapter(textScript, 0)], 'fake', TEST_STOP_GRACE_MS, [])
    t.handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true })
    expect(t.messages.at(-1)).toEqual({
      type: 'engine.updated',
      engine: { id: 'fake', name: 'Fake', enabled: true, installed: false, signedIn: false },
    })
    expect(JSON.parse(readFileSync(settingsFile(t), 'utf8'))).toEqual({ engines: { fake: true }, workFolder: work })
    t.handle({ type: 'chat.send', chatId: 'main', text: 'hi' })
    await until(() => statusOf(t.core, 'main') === 'idle')
    expect(types(entriesOf(t.core, 'main'))).toContain('text.completed')

    t.core.close()
    const reopened = open(garage, [createFakeAdapter(textScript, 0)], 'fake', TEST_STOP_GRACE_MS, [])
    expect(engineInfo(reopened.core, 'fake')?.enabled).toBe(true)
    reopened.handle({ type: 'engine.setEnabled', engine: 'fake', enabled: false })
    expect(JSON.parse(readFileSync(settingsFile(t), 'utf8'))).toEqual({ engines: { fake: false }, workFolder: work })
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
      workFolder: join(garage, 'work'),
    })
  })

  it('lets a chat pick a model only on an engine that is on', async () => {
    const alpha = createFakeAdapter([], 0)
    const t = open(tempDir(), [{ ...alpha, id: 'alpha' }, { ...alpha, id: 'beta' }], 'alpha', TEST_STOP_GRACE_MS, [
      'alpha',
    ])
    await t.core.refreshEngines()
    const pick = { type: 'chat.setModel', chatId: 'main', engine: 'beta', model: otherModel } as const
    expect(() => t.handle(pick)).toThrow(/"beta" is off/)
    t.handle({ type: 'engine.setEnabled', engine: 'beta', enabled: true })
    t.handle(pick)
    expect(chatOf(t.core, 'main')).toMatchObject({ engine: 'beta', model: otherModel })
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

  it('names and orders each engine\'s models, newest Claude first per provider, snapshots hidden', async () => {
    const session = () => ({ prompt() {}, interrupt() {}, respond() {}, close() {} })
    const listing = (id: string, models: string[], defaultModel: string): Adapter => ({
      ...stubAdapter(session),
      id,
      detect: async () => ({ installed: true, signedIn: true, models, defaultModel }),
    })
    const prefixed = [
      'openai/gpt-5',
      'anthropic/claude-haiku-4-5',
      'anthropic/claude-haiku-4-5-20251001',
      'anthropic/claude-opus-4-8',
      'anthropic/claude-haiku-5-5',
      'anthropic/claude-fable-5',
      'anthropic/claude-opus-5',
      'anthropic/claude-opus-5-5',
    ]
    const engines = [
      listing('pi', prefixed, 'anthropic/claude-haiku-4-5-20251001'),
      listing('claude-code', ['claude-haiku-4-5', 'claude-opus-5-5', 'claude-sonnet-5'], 'claude-opus-5-5'),
    ]
    const t = open(tempDir(), engines, 'pi', TEST_STOP_GRACE_MS, [])
    await t.core.refreshEngines()
    const [pi, claude] = t.core.engines()
    expect(pi).toMatchObject({
      models: [
        { id: 'openai/gpt-5', label: 'openai/gpt-5' },
        { id: 'anthropic/claude-fable-5', label: 'Fable 5' },
        { id: 'anthropic/claude-opus-5-5', label: 'Opus 5.5' },
        { id: 'anthropic/claude-opus-5', label: 'Opus 5' },
        { id: 'anthropic/claude-opus-4-8', label: 'Opus 4.8' },
        { id: 'anthropic/claude-haiku-5-5', label: 'Haiku 5.5' },
        { id: 'anthropic/claude-haiku-4-5', label: 'Haiku 4.5' },
      ],
      defaultModel: 'openai/gpt-5',
    })
    expect(claude).toMatchObject({
      models: [
        { id: 'claude-opus-5-5', label: 'Opus 5.5' },
        { id: 'claude-sonnet-5', label: 'Sonnet 5' },
        { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
      ],
      defaultModel: 'claude-opus-5-5',
    })
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

describe('steering', () => {
  const steerer = (script: FakeStep[]) => setup(createFakeAdapter(script, 0, { steering: true }))
  const queued = (core: Core, id: string) => chatOf(core, id)?.queue ?? []
  const users = (core: Core, id: string) =>
    entriesOf(core, id).flatMap((e) => (e.type === 'user.message' ? [{ text: e.text, midTurn: e.midTurn }] : []))
  const replyOnly: FakeStep[] = [{ type: 'text.completed', text: 'Done' }]

  it('logs a steered message where the turn took it in, after the tool result, and starts no other turn', async () => {
    const t = steerer(permissionScript)
    const chat = folderChat(t)
    expect(t.core.engines()[0]).toMatchObject({ steering: true })
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'one' })
    await until(() => statusOf(t.core, chat.id) === 'waiting')
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'use y instead', steer: true })
    expect(queued(t.core, chat.id)).toMatchObject([{ text: 'use y instead', steering: true }])
    expect(() => t.handle({ type: 'chat.unqueue', chatId: chat.id, id: queued(t.core, chat.id)[0]!.id })).toThrow(
      /already with the engine/,
    )

    const request = entriesOf(t.core, chat.id).find((e) => e.type === 'permission.requested')
    if (request?.type !== 'permission.requested') throw new Error('no request')
    t.handle({ type: 'permission.respond', chatId: chat.id, requestId: request.requestId, allow: true })
    await until(() => statusOf(t.core, chat.id) === 'idle')

    expect(types(entriesOf(t.core, chat.id)).slice(-4)).toEqual([
      'tool.completed',
      'user.message',
      'text.completed',
      'turn.completed',
    ])
    expect(users(t.core, chat.id)).toEqual([
      { text: 'one', midTurn: undefined },
      { text: 'use y instead', midTurn: true },
    ])
    expect(queued(t.core, chat.id)).toEqual([])
    expect(t.calls).toHaveLength(1)
    const log = readFileSync(join(t.garage, 'chats', chat.id, 'log.jsonl'), 'utf8')
    expect(log).toContain('"text":"use y instead","midTurn":true')
  })

  it('puts a steer the turn never took in back at the front of the queue and sends it after the turn', async () => {
    const t = steerer(replyOnly)
    const chat = folderChat(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'one' })
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'later' })
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'nudge', steer: true })
    expect(queued(t.core, chat.id).map((q) => [q.text, q.steering])).toEqual([
      ['later', undefined],
      ['nudge', true],
    ])
    await until(() => t.calls.length === 2)
    expect(t.calls[1]?.prompt?.endsWith('nudge\n\nlater')).toBe(true)
    expect(users(t.core, chat.id)).toEqual([
      { text: 'one', midTurn: undefined },
      { text: 'nudge\n\nlater', midTurn: undefined },
    ])
  })

  it('queues without steer (Alt+Enter), and on Enter when the engine cannot steer', async () => {
    for (const t of [steerer(permissionScript), setup(permissionScript)]) {
      const chat = folderChat(t)
      t.handle({ type: 'chat.send', chatId: chat.id, text: 'one' })
      await until(() => statusOf(t.core, chat.id) === 'waiting')
      const steer = t.core.engines()[0]?.steering !== true
      t.handle({ type: 'chat.send', chatId: chat.id, text: 'two', ...(steer && { steer }) })
      expect(queued(t.core, chat.id)).toMatchObject([{ text: 'two' }])
      expect(queued(t.core, chat.id)[0]?.steering).toBeUndefined()
      const request = entriesOf(t.core, chat.id).find((e) => e.type === 'permission.requested')
      if (request?.type !== 'permission.requested') throw new Error('no request')
      t.handle({ type: 'permission.respond', chatId: chat.id, requestId: request.requestId, allow: true })
      await until(() => t.calls.length === 2)
      expect(users(t.core, chat.id).map((u) => u.midTurn)).toEqual([undefined, undefined])
    }
  })

  it('returns a pending steer to the queue on Stop, which sends it next like any queued message', async () => {
    const t = steerer(permissionScript)
    const chat = folderChat(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'one' })
    await until(() => statusOf(t.core, chat.id) === 'waiting')
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'nudge', steer: true })
    t.handle({ type: 'chat.interrupt', chatId: chat.id })
    await until(() => t.calls.length === 2)
    expect(users(t.core, chat.id)).toEqual([
      { text: 'one', midTurn: undefined },
      { text: 'nudge', midTurn: undefined },
    ])
  })

  it('returns pending steers when the session dies without saying', async () => {
    const emits: ((event: EngineEvent) => void)[] = []
    const steered: string[] = []
    const t = setup({
      ...stubAdapter((_machine, _options, emit) => {
        emits.push(emit)
        return { prompt() {}, interrupt() {}, respond() {}, close() {}, steer: (_id, text) => steered.push(text) }
      }),
      steering: true,
    })
    const chat = folderChat(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'go' })
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'nudge', steer: true })
    expect(steered).toEqual(['nudge'])
    emits[0]?.({ type: 'session.ended', error: 'crashed' })
    expect(users(t.core, chat.id).map((u) => u.text)).toEqual(['go', 'nudge'])
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
  const longReply = (id: number) => `reply ${id} `.padEnd((MESSAGE_MAX_CHARS * 3) / 4, '.')

  function writeLog(garage: string, chatId: string, count: number) {
    const dir = join(garage, 'chats', chatId)
    mkdirSync(dir, { recursive: true })
    const entries: ChatEntry[] = Array.from({ length: count }, (_, i) =>
      i % 2 ? { at, type: 'text.completed', text: longReply(i) } : { at, type: 'user.message', text: `question ${i}` },
    )
    writeFileSync(join(dir, 'log.jsonl'), entries.map((e) => JSON.stringify(e) + '\n').join(''))
  }

  function setupMemory(
    options: {
      garage?: string
      script?: FakeStep[]
      complete?: Adapter['complete']
      others?: Adapter[]
      models?: string[]
      work?: false
    } = {},
  ) {
    const { garage = tempDir(), script = textScript, others = [] } = options
    const models = options.models ?? [...FAKE_MODELS, SUMMARY_MODELS[0]!]
    const plain = createFakeAdapter(script, 0)
    const fake: Adapter = { ...plain, detect: async (machine) => ({ ...(await plain.detect(machine)), models }) }
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
    const core = openCore({
      garage,
      adapters,
      defaultEngine: 'fake',
      machine: sandboxingMachine,
      mods: [mainMod],
      compactDebounceMs: 0,
    })
    cores.push(core)
    for (const { id } of adapters) core.handle({ type: 'engine.setEnabled', engine: id, enabled: true }, () => {})
    if (options.work !== false) core.handle({ type: 'workFolder.set', path: join(garage, 'work') }, () => {})
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
    const home = join(t.garage, 'work', 'home')
    const rules = `${WRITE_RULES}\nYour work folder: ${home}`
    expect(t.calls[0]?.options.instructions).toBe([MAIN.instructions, rules, MEMORY_INSTRUCTIONS, 'RULES'].join('\n\n'))
    const chat = createChat({ ...t, replies: [] }, { name: 'App' })
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'hi' })
    expect(withoutRules(t.calls[1]?.options.instructions)).toBe([MEMORY_INSTRUCTIONS, 'RULES'].join('\n\n'))
  })

  it('summarizes a backlog once engines are detected, and the next prompt shows the summary lines', async () => {
    const garage = tempDir()
    writeLog(garage, 'main', 40)
    const t = setupMemory({ garage })
    expect(t.completions).toHaveLength(0)
    await t.core.refreshEngines()
    await until(() => summarized(t, 'main'))

    expect(t.completions[0]).toMatchObject({
      cwd: join(t.garage, 'work', 'home'),
      model: SUMMARY_MODELS[0],
      timeoutMs: COMPLETE_TIMEOUT_MS,
    })
    expect(t.completions[0]?.prompt).toContain('<item key="39+1" kind="talk"')
    t.handle({ type: 'chat.send', chatId: 'main', text: 'next' })
    const prompt = t.calls[0]?.prompt ?? ''
    expect(prompt).toContain('\n0+1|user: question 0\n1+1|talk: summary of 1+1\n')
    expect(prompt).toContain('<message id="39" kind="talk">')
    expect(prompt.endsWith('New message from the user:\n\nnext')).toBe(true)
  })

  it('waits for a work folder, then writes summaries in <work>/home, sandboxed there', async () => {
    const garage = tempDir()
    writeLog(garage, 'main', 40)
    const t = setupMemory({ garage, work: false })
    await t.core.refreshEngines()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(t.completions).toHaveLength(0)
    t.handle({ type: 'workFolder.set', path: join(garage, 'work') })
    await until(() => summarized(t, 'main'))
    const home = join(garage, 'work', 'home')
    expect(t.completions[0]).toMatchObject({ cwd: home, sandbox: { writable: [home], tmpDir: join(home, '.tmp') } })
    expect(t.messages.filter((m) => m.type === 'error')).toEqual([])
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

  it('writes summaries with the first listed model an engine that is on offers, with or without a provider', async () => {
    const garage = tempDir()
    writeLog(garage, 'main', 40)
    const models = [`x/${SUMMARY_MODELS[1]}`, `x/${SUMMARY_MODELS[0]}`, ...FAKE_MODELS]
    const offersNone = stubAdapter(() => ({ prompt() {}, interrupt() {}, respond() {}, close() {} }))
    const t = setupMemory({ garage, models, others: [offersNone] })
    await t.core.refreshEngines()
    await until(() => t.completions.length > 0)
    expect(t.completions[0]?.model).toBe(`x/${SUMMARY_MODELS[0]}`)
  })

  it('shows one error when summaries fail', async () => {
    const garage = tempDir()
    writeLog(garage, 'main', 40)
    const t = setupMemory({
      garage,
      complete: async () => {
        throw new Error('usage limit reached')
      },
    })
    await t.core.refreshEngines()
    await until(() => t.messages.some((m) => m.type === 'error'))
    expect(t.messages.filter((m) => m.type === 'error')).toEqual([
      { type: 'error', message: 'Memory summaries are failing: usage limit reached. Retrying.' },
    ])
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
    await until(() => settled(t.core, chatId))
    return t.calls.at(-1)!.options
  }
  const instructionsOf = async (t: ReturnType<typeof setup>, chatId: string) =>
    withoutRules((await sessionOf(t, chatId)).instructions)
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

  it("lists the global AGENTS.md, then a chat's folders, AGENTS.md and files from the top down to itself", () => {
    const t = setup(textScript)
    const repo = folderWith('REPO RULES')
    const notes = fileWith('NOTES')
    const chat = createChat(t, { name: 'App', folders: [repo], files: [notes] })
    const global = { section: 'agents', path: join(t.garage, 'AGENTS.md'), from: GLOBAL_CONTEXT, enabled: true, text: '' }
    const own = join(t.garage, 'chats', chat.id, 'AGENTS.md')

    expect(itemsOf(t, 'main')).toEqual([global])
    expect(itemsOf(t, chat.id)).toEqual([
      global,
      { section: 'folders', path: repo, from: chat.id, enabled: true, text: 'REPO RULES' },
      { section: 'agents', path: own, from: chat.id, enabled: true, text: '' },
      { section: 'files', path: notes, from: chat.id, enabled: true, text: 'NOTES' },
    ])
  })

  it("injects enabled items global first, after the instructions a mod's own chat gets", async () => {
    const t = setup(textScript)
    const repo = folderWith('REPO RULES')
    const notes = fileWith('NOTES\n')
    expect(await instructionsOf(t, 'main')).toBe(MAIN.instructions)
    t.handle({ type: 'instructions.write', text: 'GLOBAL RULES' })
    const chat = createChat(t, { name: 'App', folders: [repo], files: [notes] })
    const other = createChat(t, { name: 'Other' })
    t.handle({ type: 'context.write', chatId: chat.id, text: 'APP RULES' })
    t.handle({ type: 'context.write', chatId: other.id, text: 'OTHER RULES' })

    const file = `<file path="${notes}">\nNOTES\n</file>`
    expect(await instructionsOf(t, chat.id)).toBe(
      ['GLOBAL RULES', 'REPO RULES', 'APP RULES', file].join('\n\n'),
    )
    expect(await instructionsOf(t, 'main')).toBe(`${MAIN.instructions}\n\nGLOBAL RULES`)
    expect(await instructionsOf(t, other.id)).toBe('GLOBAL RULES\n\nOTHER RULES')
    expect(itemsOf(t, 'main').map((item) => item.text)).toEqual(['GLOBAL RULES'])
  })

  it("runs in its space's work folder, with every enabled folder from the space down as an extra", async () => {
    const first = setup(textScript)
    const [a, b] = [folderWith(''), folderWith('')]
    const work = join(first.garage, 'work')
    const plain = createChat(first, { name: 'Plain' })
    expect(await sessionOf(first, plain.id)).toMatchObject({ cwd: join(work, plain.id) })
    expect(first.calls.at(-1)?.options).not.toHaveProperty('extraDirs')
    const app = createChat(first, { name: 'App', folders: [a, b] })
    expect(await sessionOf(first, app.id)).toMatchObject({ cwd: join(work, app.id), extraDirs: [a, b] })

    const { t, subagentId } = reopenWithSubagent(first, app.id)
    expect(await sessionOf(t, subagentId)).toMatchObject({ cwd: join(work, app.id), extraDirs: [a, b] })
    t.handle({ type: 'context.set', chatId: app.id, path: a, enabled: false })
    expect(await sessionOf(t, app.id)).toMatchObject({ extraDirs: [b] })
    const again = reopenWithSubagent(t, app.id)
    expect(await sessionOf(again.t, subagentId)).toMatchObject({ extraDirs: [b] })
    expect(await sessionOf(again.t, 'main')).toMatchObject({ cwd: join(work, 'home') })
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
      expect(withoutRules(options.instructions)).toBe([MEMORY_INSTRUCTIONS, byPath, file].join('\n\n'))
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
    t.handle({ type: 'instructions.write', text: 'GLOBAL RULES' })
    const chat = createChat(t, { name: 'App', folders: [repo] })

    t.handle({ type: 'context.set', chatId: chat.id, path: repo, enabled: false })
    // Mods' tabs follow, since a folder can change which a chat gets.
    expect(t.messages.at(-1)).toMatchObject({ type: 'chat.mods', chatId: chat.id })
    const updated = t.messages.at(-2)
    if (updated?.type !== 'chat.context') throw new Error('no chat.context')
    expect(updated.chatId).toBe(chat.id)
    expect(updated.items.find((i) => i.path === repo)?.enabled).toBe(false)
    expect(JSON.parse(readFileSync(chatFile(t, chat.id), 'utf8')).context).toEqual({ [repo]: false })
    expect(await instructionsOf(t, chat.id)).toBe('GLOBAL RULES')

    t.handle({ type: 'context.set', chatId: 'main', path: join(t.garage, 'AGENTS.md'), enabled: false })
    expect(await instructionsOf(t, 'main')).toBe(MAIN.instructions)
    expect(await instructionsOf(t, chat.id)).toBe('GLOBAL RULES')

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
      workFolder: join(garage, 'work'),
      context: { repo: false, agents: false, folders: false },
    })
    const switches = (chatId: string) => itemsOf(t, chatId).map((i) => [i.from, i.section, i.enabled])
    expect(switches(chat.id)).toEqual([
      [GLOBAL_CONTEXT, 'agents', false],
      [chat.id, 'folders', true],
      [chat.id, 'agents', true],
    ])
    expect(switches('main').map(([, , enabled]) => enabled)).toEqual([false])
    t.handle({ type: 'context.set', chatId: chat.id, path: join(garage, 'AGENTS.md'), enabled: true })
    expect(switches(chat.id)[0]).toEqual([GLOBAL_CONTEXT, 'agents', true])
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
  })

  it('writes the global AGENTS.md, given to every chat with or without a mod chat', async () => {
    const t = setup(textScript, tempDir(), TEST_STOP_GRACE_MS, [])
    const global = join(t.garage, 'AGENTS.md')
    t.handle({ type: 'instructions.write', text: 'EVERY CHAT' })
    expect(readFileSync(global, 'utf8')).toBe('EVERY CHAT')
    expect(t.messages.at(-1)).toEqual({ type: 'context.file', path: global, text: 'EVERY CHAT' })
    const chat = createChat(t, { name: 'App' })
    expect(itemsOf(t, chat.id)[0]).toMatchObject({ path: global, from: GLOBAL_CONTEXT, text: 'EVERY CHAT' })
    expect(await instructionsOf(t, chat.id)).toBe('EVERY CHAT')
    expect(() => t.handle({ type: 'instructions.write' } as never)).toThrow(/text/)
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
  const [newest, older] = FAKE_MODELS as [string, string]
  const { defaultModel, defaultThinking } = FAKE_DEFAULTS
  const settingsFile = (t: { garage: string }) => join(t.garage, 'settings.json')
  const sendAndWait = async (t: ReturnType<typeof setup>, chatId = 'main') => {
    t.handle({ type: 'chat.send', chatId, text: 'hi' })
    await until(() => settled(t.core, chatId))
    return t.calls.at(-1)!.options.model
  }

  const row = (model: string, thinking?: ThinkingLevel, engine = 'fake') => ({ engine, model, ...(thinking && { thinking }) })
  const seeded = { chat: [row(defaultModel, defaultThinking)], planning: [], searching: [], subagents: [] }

  it('fills an empty Chat list from what the engine runs by default, once the engines are detected', async () => {
    const garage = tempDir()
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ theme: 'dark' }))
    const t = setup(textScript, garage)
    expect(t.core.modelLists()).toEqual({ chat: [], planning: [], searching: [], subagents: [] })
    await t.core.refreshEngines()
    expect(t.core.modelLists()).toEqual(seeded)
    expect(t.messages).toContainEqual({ type: 'models.updated', lists: seeded })
    expect(JSON.parse(readFileSync(settingsFile(t), 'utf8'))).toMatchObject({ theme: 'dark', models: seeded })
    expect(await sendAndWait(t)).toBe(defaultModel)
    expect(t.calls.at(-1)!.options.thinking).toBe(defaultThinking)
  })

  it('saves one list per role in settings.json, tells every client and keeps it after a restart', async () => {
    const garage = tempDir()
    const t = setup(textScript, garage)
    await t.core.refreshEngines()
    const planning = [row(older, 'low'), row(newest, 'high')]
    t.handle({ type: 'models.setList', role: 'planning', models: [...planning, planning[0]!] })
    const lists = { ...seeded, planning }
    expect(t.messages.at(-1)).toEqual({ type: 'models.updated', lists })
    expect(JSON.parse(readFileSync(settingsFile(t), 'utf8')).models).toEqual(lists)

    expect(() => t.handle({ type: 'models.setList', role: 'nope', models: [] } as never)).toThrow(/role/)
    for (const models of ['x', [1], [newest], [{ model: newest }], [{ engine: 'fake', model: '' }], [row(newest, 'ultra' as never)]]) {
      expect(() => t.handle({ type: 'models.setList', role: 'chat', models } as never)).toThrow(/list of models/)
    }
    expect(() => t.handle({ type: 'models.setList', role: 'chat', models: [] })).toThrow(/Chat list needs/)
    t.core.close()
    expect(setup(textScript, garage).core.modelLists()).toEqual(lists)
  })

  it("migrates per-engine lists and default thinking into one list per role without losing a row", async () => {
    const garage = tempDir()
    const alpha = { ...createFakeAdapter(textScript, 0), id: 'alpha' }
    const beta = { ...createFakeAdapter(textScript, 0), id: 'beta' }
    const old = {
      theme: 'dark',
      engines: { alpha: true, beta: true },
      models: {
        beta: { chat: [newest], planning: [{ model: older, thinking: 'low' }] },
        alpha: { chat: [{ model: older }, newest], searching: ['gone-model'] },
        gone: { chat: ['x'] },
      },
      defaultThinking: { alpha: 'high', beta: 'minimal' },
    }
    writeFileSync(join(garage, 'settings.json'), JSON.stringify(old))
    const t = open(garage, [beta, alpha], 'alpha')
    // The default engine's rows come first; a row without a level takes its engine's old default, and one that isn't
    // a level Hotrod knows (pi's minimal) is filled in from the engine once it's detected.
    const migrated = {
      chat: [row(older, 'high', 'alpha'), row(newest, 'high', 'alpha'), row(newest, undefined, 'beta'), row('x', undefined, 'gone')],
      planning: [row(older, 'low', 'beta')],
      searching: [row('gone-model', 'high', 'alpha')],
      subagents: [],
    }
    expect(t.core.modelLists()).toEqual(migrated)
    const saved = JSON.parse(readFileSync(settingsFile(t), 'utf8'))
    expect(saved).toMatchObject({ theme: 'dark', models: migrated })
    expect(saved).not.toHaveProperty('defaultThinking')
    await t.core.refreshEngines()
    expect(t.core.modelLists().chat[2]).toEqual(row(newest, defaultThinking, 'beta'))
  })

  it('runs the next model in the list, on another engine, when the first one cannot run', async () => {
    const alpha = recording({ ...createFakeAdapter(textScript, 0), id: 'alpha' })
    const beta = recording({ ...createFakeAdapter(textScript, 0), id: 'beta' })
    const t = open(tempDir(), [alpha.adapter, beta.adapter], 'alpha', TEST_STOP_GRACE_MS, ['beta'])
    await t.core.refreshEngines()
    t.handle({ type: 'models.setList', role: 'chat', models: [row(newest, 'high', 'alpha'), row(older, 'low', 'beta')] })
    expect(chatOf(t.core, 'main')?.engine).toBe('beta')
    t.handle({ type: 'chat.send', chatId: 'main', text: 'hi' })
    await until(() => settled(t.core, 'main'))
    expect(beta.calls.at(-1)!.options).toMatchObject({ model: older, thinking: 'low' })

    t.handle({ type: 'engine.setEnabled', engine: 'alpha', enabled: true })
    expect(chatOf(t.core, 'main')?.engine).toBe('alpha')
    t.handle({ type: 'chat.send', chatId: 'main', text: 'again' })
    await until(() => settled(t.core, 'main'))
    expect(alpha.calls.at(-1)!.options).toMatchObject({ model: newest, thinking: 'high' })
    expect(beta.calls).toHaveLength(1)
  })

  // A fake engine whose small model takes only low, and whose model "none" takes no thinking at all.
  const perModel = () => {
    const base = createFakeAdapter(textScript, 0)
    const detect = async (machine: Machine) => ({
      ...(await base.detect(machine)),
      models: [...FAKE_MODELS, 'none'],
      modelThinking: { [older]: ['low'], none: [] } as Record<string, ThinkingLevel[]>,
    })
    return setup({ ...base, detect })
  }

  it("snaps a level the model doesn't take to its nearest one, and gives a model without levels none", async () => {
    const t = perModel()
    await t.core.refreshEngines()
    expect(t.core.engines()[0]?.models).toContainEqual({ id: older, label: older, thinking: ['low'] })
    t.handle({ type: 'models.setList', role: 'chat', models: [row(older, 'max'), row('none', 'low')] })
    expect(t.core.modelLists().chat).toEqual([row(older, 'low'), row('none')])
    expect(await sendAndWait(t)).toBe(older)
    expect(t.calls.at(-1)!.options.thinking).toBe('low')
    expect(() => t.handle({ type: 'chat.setModel', chatId: 'main', thinking: 'high' })).toThrow(
      /Model "fake-small" offers no thinking level "high"/,
    )
    t.handle({ type: 'models.setList', role: 'chat', models: [row('none', 'low')] })
    expect(await sendAndWait(t)).toBe('none')
    expect(t.calls.at(-1)!.options).not.toHaveProperty('thinking')
  })

  it('snaps to the nearest level, the cheaper one on a tie, and to none when the model takes none', () => {
    expect(snapLevel('xhigh', ['low', 'medium', 'high', 'max'])).toBe('high')
    expect(snapLevel('off', ['low', 'medium'])).toBe('low')
    expect(snapLevel('max', ['low', 'medium', 'high'])).toBe('high')
    expect(snapLevel('medium', ['off', 'max'])).toBe('off')
    expect(snapLevel('medium', [])).toBeUndefined()
  })

  it("runs a role's list, else the Chat list while the role's own is empty", async () => {
    const t = setup(textScript)
    await t.core.refreshEngines()
    const runs = (role: 'planning' | 'subagents') => pickRun(t.core.engines(), t.core.modelLists(), { engine: 'fake', role })
    expect(runs('subagents')).toMatchObject({ model: defaultModel, thinking: defaultThinking })
    t.handle({ type: 'models.setList', role: 'planning', models: [row(newest, 'low')] })
    expect(runs('planning')).toMatchObject({ model: newest, thinking: 'low' })
    expect(runs('subagents')).toMatchObject({ model: defaultModel })
  })

  it("runs at the row's level unless the chat picked its own, and picking the row's level follows it again", async () => {
    const t = setup(textScript)
    await t.core.refreshEngines()
    t.handle({ type: 'models.setList', role: 'chat', models: [row(newest, 'low')] })
    expect(await sendAndWait(t)).toBe(newest)
    expect(t.calls.at(-1)!.options.thinking).toBe('low')
    t.handle({ type: 'chat.setModel', chatId: 'main', thinking: 'high' })
    expect(chatOf(t.core, 'main')?.thinking).toBe('high')
    await sendAndWait(t)
    expect(t.calls.at(-1)!.options.thinking).toBe('high')
    t.handle({ type: 'chat.setModel', chatId: 'main', thinking: 'low' })
    expect(chatOf(t.core, 'main')?.thinking).toBeUndefined()
    expect(() => t.handle({ type: 'chat.setModel', chatId: 'main', thinking: 'ultra' as never })).toThrow(/Unknown thinking/)
  })

  it("keeps a chat's own pick over the list, and refuses to send while that pick can't run", async () => {
    const t = setup(textScript)
    await t.core.refreshEngines()
    t.handle({ type: 'models.setList', role: 'chat', models: [row(older, 'low')] })
    t.handle({ type: 'chat.setModel', chatId: 'main', engine: 'fake', model: newest })
    expect(await sendAndWait(t)).toBe(newest)
    // Its own model runs at the level the list gives it there, else the engine's default.
    expect(t.calls.at(-1)!.options.thinking).toBe(defaultThinking)

    const chatFile = join(t.garage, 'chats', 'main', 'chat.json')
    writeFileSync(chatFile, JSON.stringify({ ...JSON.parse(readFileSync(chatFile, 'utf8')), model: 'opus' }))
    t.core.close()
    const reopened = setup(textScript, t.garage)
    await reopened.core.refreshEngines()
    expect(() => reopened.handle({ type: 'chat.send', chatId: 'main', text: 'hi' })).toThrow(/no longer offers "opus"/)
    reopened.handle({ type: 'chat.setModel', chatId: 'main' })
    expect(await sendAndWait(reopened)).toBe(older)
  })

  it('says which list has nothing that can run', async () => {
    const t = setup(textScript)
    await t.core.refreshEngines()
    t.handle({ type: 'models.setList', role: 'chat', models: [row('gone', 'low')] })
    expect(() => t.handle({ type: 'chat.send', chatId: 'main', text: 'hi' })).toThrow(/Nothing in the Chat model list/)
  })

  it('follows the list again when the chat picks the model the list would run anyway', async () => {
    const t = setup(textScript)
    await t.core.refreshEngines()
    const saved = () => JSON.parse(readFileSync(join(t.garage, 'chats', 'main', 'chat.json'), 'utf8'))
    t.handle({ type: 'chat.setModel', chatId: 'main', engine: 'fake', model: otherModel, thinking: otherThinking })
    expect(saved()).toMatchObject({ model: otherModel, thinking: otherThinking })
    t.handle({ type: 'chat.setModel', chatId: 'main', engine: 'fake', model: defaultModel, thinking: defaultThinking })
    expect(saved()).not.toHaveProperty('model')
    expect(saved()).not.toHaveProperty('thinking')

    t.handle({ type: 'models.setList', role: 'chat', models: [row(otherModel, 'low')] })
    t.handle({ type: 'chat.setModel', chatId: 'main', engine: 'fake', model: defaultModel })
    expect(chatOf(t.core, 'main')?.model).toBe(defaultModel)
    t.handle({ type: 'chat.setModel', chatId: 'main', engine: 'fake', model: otherModel })
    expect(chatOf(t.core, 'main')?.model).toBeUndefined()
  })
})

describe('mods', () => {
  const tester: Mod = {
    id: 'tester',
    name: 'Tester',
    description: 'For tests',
    enabledByDefault: true,
    settings: [
      {
        key: 'size',
        label: 'Size',
        type: 'select',
        options: [
          { value: 768, label: 'Small' },
          { value: 'full', label: 'Full' },
        ],
        default: 768,
      },
      { key: 'count', label: 'Count', type: 'number', default: 2, min: -1, max: 10, integer: true },
      { key: 'loud', label: 'Loud', type: 'boolean', default: false },
      { key: 'notes', label: 'Notes', type: 'text', default: 'Be brief.', rows: 3 },
    ],
  }
  const defaultsOf = (mod: Mod) => Object.fromEntries((mod.settings ?? []).map((s) => [s.key, s.default]))
  const infoOf = (mod: Mod, enabled: boolean, values = defaultsOf(mod)) => {
    const { id, name, description, settings = [] } = mod
    return { id, name, description, enabled, settings, values }
  }
  const savedMods = (garage: string) => JSON.parse(readFileSync(join(garage, 'settings.json'), 'utf8')).mods

  it('lists every mod with its switch and declared defaults, the subagents mod on', () => {
    const t = setup(textScript, tempDir(), TEST_STOP_GRACE_MS, [tester])
    expect(t.core.mods()).toEqual([infoOf(tester, true), infoOf(SUBAGENTS_MOD, true)])
  })

  it('saves switches and values flat in settings.json, broadcasts each and keeps them across a restart', () => {
    const garage = tempDir()
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ theme: 'dark' }))
    const t = setup(textScript, garage, TEST_STOP_GRACE_MS, [tester])
    t.handle({ type: 'mod.setEnabled', modId: 'tester', enabled: false })
    expect(t.messages.at(-1)).toEqual({ type: 'mod.updated', mod: infoOf(tester, false) })
    t.handle({ type: 'mod.setValue', modId: 'tester', key: 'size', value: 'full' })
    t.handle({ type: 'mod.setValue', modId: 'tester', key: 'count', value: -1 })
    t.handle({ type: 'mod.setValue', modId: 'tester', key: 'loud', value: true })
    t.handle({ type: 'mod.setValue', modId: 'tester', key: 'notes', value: 'Be thorough.\nCite files.' })
    const values = { size: 'full', count: -1, loud: true, notes: 'Be thorough.\nCite files.' }
    expect(t.messages.at(-1)).toEqual({ type: 'mod.updated', mod: infoOf(tester, false, values) })
    expect(JSON.parse(readFileSync(join(garage, 'settings.json'), 'utf8'))).toMatchObject({
      theme: 'dark',
      mods: { tester: { enabled: false, ...values } },
    })
    t.core.close()
    expect(setup(textScript, garage, TEST_STOP_GRACE_MS, [tester]).core.mods()[0]).toEqual(
      infoOf(tester, false, values),
    )
  })

  it('refuses a value its declaration rules out, an unknown mod or key, and the reserved key', () => {
    const t = setup(textScript, tempDir(), TEST_STOP_GRACE_MS, [tester])
    const set = (key: string, value: unknown) => () =>
      t.handle({ type: 'mod.setValue', modId: 'tester', key, value } as never)
    expect(set('size', '768')).toThrow('Size must be one of: Small, Full')
    expect(set('count', 1.5)).toThrow('Count must be a whole number')
    expect(set('count', -2)).toThrow('Count must be at least -1')
    expect(set('count', 11)).toThrow('Count must be at most 10')
    expect(set('count', '3')).toThrow('Count must be a number')
    expect(set('loud', 'yes')).toThrow('Loud must be on or off')
    expect(set('notes', 3)).toThrow('Notes must be text')
    expect(set('nope', 1)).toThrow('Tester has no setting "nope"')
    expect(set('enabled', false)).toThrow('Tester has no setting "enabled"')
    expect(() => t.handle({ type: 'mod.setEnabled', modId: 'nope', enabled: true })).toThrow('Unknown mod "nope"')
    expect(() => t.handle({ type: 'mod.setValue', modId: 'nope', key: 'x', value: 1 })).toThrow('Unknown mod "nope"')
    expect(t.core.mods()[0]).toEqual(infoOf(tester, true))
    expect(existsSync(join(t.garage, 'settings.json')) && savedMods(t.garage)).toBeFalsy()
  })

  it('falls back to the declared default for a saved value its declaration rules out', () => {
    const garage = tempDir()
    const saved = { tester: { enabled: 'yes', size: 1024, count: 4, loud: 'no', notes: 7 } }
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ mods: saved }))
    const t = setup(textScript, garage, TEST_STOP_GRACE_MS, [tester])
    expect(t.core.mods()[0]).toEqual(infoOf(tester, true, { ...defaultsOf(tester), count: 4 }))
  })

  it('takes a blank text value as its default, so saving one resets it', () => {
    const t = setup(textScript, tempDir(), TEST_STOP_GRACE_MS, [tester])
    t.handle({ type: 'mod.setValue', modId: 'tester', key: 'notes', value: 'Custom' })
    expect(t.core.mods()[0]?.values.notes).toBe('Custom')
    t.handle({ type: 'mod.setValue', modId: 'tester', key: 'notes', value: ' \n' })
    expect(t.messages.at(-1)).toEqual({ type: 'mod.updated', mod: infoOf(tester, true) })
  })

  it('reads the subagents switch and limit saved before mods had declarations', () => {
    const garage = tempDir()
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ mods: { subagents: { enabled: true, limit: -1 } } }))
    expect(setup(textScript, garage, TEST_STOP_GRACE_MS, []).core.mods()).toEqual([
      infoOf(SUBAGENTS_MOD, true, { ...defaultsOf(SUBAGENTS_MOD), limit: -1 }),
    ])
  })

  it("lists a mod that didn't load, off with why, and won't turn it on or change its saved switch", () => {
    const garage = tempDir()
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ mods: { browser: { enabled: true } } }))
    const loadError = "@playwright/mcp isn't installed."
    const core = openCore({
      garage,
      adapters: [createFakeAdapter()],
      defaultEngine: 'fake',
      machine: sandboxingMachine,
      mods: [tester],
      brokenMods: [{ id: 'browser', loadError }],
    })
    cores.push(core)
    expect(core.mods()).toEqual([
      infoOf(tester, true),
      infoOf(SUBAGENTS_MOD, true),
      { id: 'browser', name: 'browser', description: '', enabled: false, settings: [], values: {}, loadError },
    ])
    expect(() => core.handle({ type: 'mod.setEnabled', modId: 'browser', enabled: true }, () => {})).toThrow(loadError)
    expect(savedMods(garage)).toEqual({ browser: { enabled: true } })
  })

  it('refuses two mods with one id', () => {
    expect(() => setup(textScript, tempDir(), TEST_STOP_GRACE_MS, [tester, { ...tester, name: 'Again' }])).toThrow(
      'Two mods have the id "tester"',
    )
  })

  describe('MCP servers', () => {
    const sessions: ModSession[] = []
    const web: Mod = {
      id: 'web',
      name: 'Web',
      description: '',
      enabledByDefault: true,
      settings: [{ key: 'ask', label: 'Ask', type: 'boolean', default: false }],
      mcpServers(session) {
        sessions.push(session)
        return [{ name: 'web', command: 'web-mcp', args: [session.workDir], allowTools: !session.values.ask }]
      },
    }
    const takesMcp: Adapter = { ...createFakeAdapter(textScript, 0), hotrodMcp: true }
    const turn = async (t: ReturnType<typeof setup>, chatId: string) => {
      t.handle({ type: 'chat.send', chatId, text: 'Hi' })
      await until(() => statusOf(t.core, chatId) === 'idle')
      return t.calls.at(-1)!.options
    }
    beforeEach(() => sessions.splice(0))

    it("gives each session the servers of mods that are on, from its chat, work folder and mod's values", async () => {
      const t = setup(takesMcp, tempDir(), TEST_STOP_GRACE_MS, [web])
      const chat = createChat(t, { name: 'Space' })
      const workDir = join(t.garage, 'work', chat.id)
      const server = { name: 'web', command: 'web-mcp', args: [workDir] }
      expect((await turn(t, chat.id)).mcpServers).toEqual([{ ...server, allowTools: true }])
      expect(sessions).toEqual([
        { chat: { id: chat.id, name: 'Space', engine: 'fake' }, workDir, sandboxed: true, values: { ask: false } },
      ])
      t.handle({ type: 'mod.setValue', modId: 'web', key: 'ask', value: true })
      t.handle({ type: 'chat.setPermission', chatId: chat.id, name: 'editAnywhere', enabled: true })
      expect((await turn(t, chat.id)).mcpServers).toEqual([{ ...server, allowTools: false }])
      expect(sessions.at(-1)?.sandboxed).toBe(false)
      t.handle({ type: 'mod.setEnabled', modId: 'web', enabled: false })
      expect((await turn(t, chat.id)).mcpServers).toBeUndefined()
    })

    it('gives none to an engine that takes no MCP servers', async () => {
      const t = setup(textScript, tempDir(), TEST_STOP_GRACE_MS, [web])
      expect((await turn(t, createChat(t).id)).mcpServers).toBeUndefined()
      expect(sessions).toEqual([])
    })

    it("ends the turn when two servers share a name, Hotrod's included", async () => {
      const named = (id: string, name: string): Mod => ({ ...web, id, mcpServers: () => [{ name, command: name }] })
      for (const [name, mods] of [
        ['web', [web, named('again', 'web')]],
        ['hotrod', [named('hotrod', 'hotrod')]],
      ] as const) {
        const t = setup(takesMcp, tempDir(), TEST_STOP_GRACE_MS, [...mods])
        const chat = createChat(t)
        t.handle({ type: 'chat.send', chatId: chat.id, text: 'Hi' })
        expect(entriesOf(t.core, chat.id).at(-1)).toMatchObject({
          type: 'turn.completed',
          error: `Error: Two MCP servers are named "${name}"`,
        })
        expect(t.calls).toEqual([])
      }
    })
  })

  describe('setup', () => {
    const description = 'Downloads the tool.'
    const tool: Mod = {
      id: 'tool',
      name: 'Tool',
      description: '',
      enabledByDefault: true,
      mcpServers: () => [{ name: 'tool', command: 'tool-mcp' }],
      setup: {
        description,
        async check(run) {
          const { code } = await run('check', [])
          return { ready: code === 0, message: code === 0 ? 'Tool installed' : 'Tool not installed' }
        },
        async install(run, report) {
          const onStdout = (chunk: string) =>
            report({ text: `Got ${chunk.trim()}`, progress: parseInt(chunk) / 100 })
          const { code, stderr } = await run('install', ['--all'], { timeoutMs: 1000, onStdout })
          if (code !== 0) throw new Error(stderr)
        },
      },
    }

    function start() {
      const state = { installed: false, finish: (_code: number | null, _stderr?: string) => {} }
      const runs: { command: string; args: string[]; options: Parameters<Machine['run']>[2] }[] = []
      const machine: Machine = {
        ...sandboxingMachine,
        async run(command, args, options) {
          runs.push({ command, args, options })
          if (command === 'check') return { code: state.installed ? 0 : 1, stdout: '', stderr: '' }
          options.onStdout?.('10%\n')
          options.onStdout?.('60%\n')
          return new Promise((resolve) => {
            state.finish = (code, stderr = '') => {
              if (code === 0) state.installed = true
              resolve({ code, stdout: '', stderr })
            }
            options.signal?.addEventListener('abort', () => state.finish(null, 'killed'))
          })
        },
      }
      const { adapter, calls } = recording({ ...createFakeAdapter(textScript, 0), hotrodMcp: true })
      const t = open(tempDir(), [adapter], adapter.id, TEST_STOP_GRACE_MS, [adapter.id], [tool], machine)
      const setupOf = () => t.core.mods()[0]!.setup!
      const turn = async () => {
        const chat = createChat(t)
        t.handle({ type: 'chat.send', chatId: chat.id, text: 'Hi' })
        await until(() => statusOf(t.core, chat.id) === 'idle')
        return calls.at(-1)!.options
      }
      return { ...t, state, runs, setupOf, turn }
    }

    it('checks each mod that is on at start, then installs it with progress and checks again', async () => {
      const t = start()
      expect(t.setupOf()).toEqual({ description, status: 'checking' })
      await until(() => t.setupOf().status === 'missing')
      expect(t.setupOf()).toEqual({ description, status: 'missing', message: 'Tool not installed' })
      expect(t.runs[0]).toMatchObject({ command: 'check', args: [], options: { cwd: '/' } })

      t.handle({ type: 'mod.install', modId: 'tool' })
      const progress = t.messages.flatMap((m) => (m.type === 'mod.updated' ? [m.mod.setup?.progress] : []))
      expect(progress).toEqual([undefined, undefined, 0.1, 0.6])
      const installing = { status: 'installing', message: 'Tool not installed', progressText: 'Got 60%', progress: 0.6 }
      expect(t.setupOf()).toEqual({ description, ...installing })
      const install = t.runs.at(-1)!
      expect(install).toMatchObject({ command: 'install', args: ['--all'], options: { cwd: '/', timeoutMs: 1000 } })
      expect(install.options).not.toHaveProperty('sandbox')
      expect(() => t.handle({ type: 'mod.install', modId: 'tool' })).toThrow('Tool is already installing')

      t.state.finish(0)
      await until(() => t.setupOf().status === 'ready')
      expect(t.setupOf()).toEqual({ description, status: 'ready', message: 'Tool installed' })
      expect(() => t.handle({ type: 'mod.install', modId: 'tool' })).toThrow('Tool is already installed')
    })

    it('stops an install on cancel, and shows why one failed', async () => {
      const t = start()
      await until(() => t.setupOf().status === 'missing')
      t.handle({ type: 'mod.cancelInstall', modId: 'tool' })
      t.handle({ type: 'mod.install', modId: 'tool' })
      t.handle({ type: 'mod.cancelInstall', modId: 'tool' })
      expect(t.runs.at(-1)!.options.signal?.aborted).toBe(true)
      await until(() => t.setupOf().status === 'missing')
      expect(t.setupOf()).toEqual({ description, status: 'missing', message: 'Tool not installed' })

      t.handle({ type: 'mod.install', modId: 'tool' })
      t.state.finish(1, 'Disk full')
      await until(() => t.setupOf().status === 'missing')
      expect(t.setupOf()).toEqual({ description, status: 'missing', message: 'Tool not installed', error: 'Disk full' })
    })

    it("offers a mod's MCP servers only once it is set up, and checks again when it is turned on", async () => {
      const t = start()
      await until(() => t.setupOf().status === 'missing')
      expect((await t.turn()).mcpServers).toBeUndefined()
      t.state.installed = true
      t.handle({ type: 'mod.setEnabled', modId: 'tool', enabled: false })
      t.handle({ type: 'mod.setEnabled', modId: 'tool', enabled: true })
      expect(t.setupOf().status).toBe('checking')
      await until(() => t.setupOf().status === 'ready')
      expect((await t.turn()).mcpServers).toEqual([{ name: 'tool', command: 'tool-mcp' }])
    })

    it('checks a mod that is off once it is turned on, and refuses to install one with no setup', async () => {
      const garage = tempDir()
      writeFileSync(join(garage, 'settings.json'), JSON.stringify({ mods: { tool: { enabled: false } } }))
      const checks: string[] = []
      const check = async () => (checks.push('check'), { ready: true })
      const quiet: Mod = { ...tool, setup: { ...tool.setup!, check } }
      const t = open(garage, [createFakeAdapter(textScript, 0)], 'fake', TEST_STOP_GRACE_MS, ['fake'], [quiet, tester])
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(checks).toEqual([])
      t.handle({ type: 'mod.setEnabled', modId: 'tool', enabled: true })
      await until(() => t.core.mods()[0]?.setup?.status === 'ready')
      expect(checks).toEqual(['check'])
      expect(() => t.handle({ type: 'mod.install', modId: 'tester' })).toThrow('Tester has nothing to install')
      expect(() => t.handle({ type: 'mod.install', modId: 'nope' })).toThrow('Unknown mod "nope"')
    })

    it("gives a setup the mod's values, describes it by them, and checks again when one changes", async () => {
      const seen: unknown[] = []
      const picky: Mod = {
        ...tool,
        settings: [
          {
            key: 'kind',
            label: 'Kind',
            type: 'select',
            options: [
              { value: 'a', label: 'A' },
              { value: 'b', label: 'B' },
            ],
            default: 'a',
          },
        ],
        setup: {
          description: (values) => `Sets up ${values.kind}.`,
          check: async (_run, values) => (seen.push(values.kind), { ready: values.kind === 'b' }),
          install: async () => {},
        },
      }
      const t = open(tempDir(), [createFakeAdapter(textScript, 0)], 'fake', TEST_STOP_GRACE_MS, ['fake'], [picky])
      const setupOf = () => t.core.mods()[0]!.setup!
      await until(() => setupOf().status === 'missing')
      expect(setupOf().description).toBe('Sets up a.')
      t.handle({ type: 'mod.setValue', modId: 'tool', key: 'kind', value: 'b' })
      await until(() => setupOf().status === 'ready')
      expect(setupOf().description).toBe('Sets up b.')
      expect(seen).toEqual(['a', 'b'])
    })

    it('stops a setup that runs several commands at its next one once cancelled', async () => {
      const runs: string[] = []
      let next = () => {}
      const machine: Machine = {
        ...sandboxingMachine,
        async run(command) {
          runs.push(command)
          if (command === 'step') await new Promise<void>((resolve) => (next = resolve))
          return { code: 1, stdout: '', stderr: '' }
        },
      }
      const steps: Mod = {
        ...tool,
        setup: {
          description,
          check: async (run) => ({ ready: (await run('check', [])).code === 0 }),
          async install(run) {
            for (;;) await run('step', [])
          },
        },
      }
      const adapter = createFakeAdapter(textScript, 0)
      const t = open(tempDir(), [adapter], adapter.id, TEST_STOP_GRACE_MS, [adapter.id], [steps], machine)
      const setupOf = () => t.core.mods()[0]!.setup!
      await until(() => setupOf().status === 'missing')
      t.handle({ type: 'mod.install', modId: 'tool' })
      await until(() => runs.at(-1) === 'step')
      t.handle({ type: 'mod.cancelInstall', modId: 'tool' })
      next()
      await until(() => setupOf().status === 'missing')
      expect(setupOf().error).toBeUndefined()
      expect(runs).toEqual(['check', 'step', 'check'])
    })
  })
})

describe('usage limits', () => {
  const limitedScript: FakeStep[] = [
    { type: 'text.delta', text: 'Work' },
    { type: 'limit.reached', message: 'Out of usage', resetsAt: at },
    { type: 'text.completed', text: 'Working on it anyway' },
  ]
  type Seen = { limit: LimitReached; status?: string; host: ModHost }

  // Chats whose work folder is listed wait on a permission; the rest run out of usage on every account but `spare`.
  const asking = new Set<string>()
  const byAccount = (options: SessionOptions) =>
    asking.has(basename(options.cwd))
      ? permissionScript
      : basename(options.accountDir ?? '') === 'spare'
        ? textScript
        : limitedScript

  function setupLimits(onLimit?: (seen: Seen, t: ReturnType<typeof setup>) => void) {
    const seen: Seen[] = []
    const watcher: Mod = {
      id: 'watcher',
      name: 'Watcher',
      description: '',
      enabledByDefault: true,
      onLimitReached(limit, { host }) {
        const entry = { limit, status: statusOf(t.core, limit.chat.id), host }
        seen.push(entry)
        onLimit?.(entry, t)
      },
    }
    const t = setup(createFakeAdapter(byAccount, 0), tempDir(), TEST_STOP_GRACE_MS, [watcher])
    return { ...t, seen }
  }

  it('logs the limit and lets the turn run its course while no mod watches for limits', async () => {
    const t = setup(limitedScript, tempDir(), TEST_STOP_GRACE_MS, [])
    const chat = createChat(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'Go' })
    await until(() => statusOf(t.core, chat.id) === 'idle')
    expect(types(entriesOf(t.core, chat.id))).toEqual([
      'user.message',
      'turn.started',
      'limit.reached',
      'text.completed',
      'turn.completed',
    ])
    expect(t.calls[0]!.interrupted).toBeUndefined()
  })

  it('stops the turn and tells each mod that watches, with the chat idle and the account it ran on', async () => {
    const t = setupLimits()
    const chat = createChat(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'Go' })
    await until(() => t.seen.length > 0)
    expect(t.calls[0]!.interrupted).toBe(true)
    expect(t.seen).toEqual([
      {
        limit: {
          chat: { id: chat.id, name: 'Chat', engine: 'fake' },
          engine: 'fake',
          account: 'default',
          message: 'Out of usage',
          resetsAt: at,
          output: true,
        },
        status: 'idle',
        host: expect.anything(),
      },
    ])
    const end = entriesOf(t.core, chat.id).at(-1)
    expect(end).toMatchObject({ type: 'turn.completed', error: 'Out of usage' })
    expect(entriesOf(t.core, chat.id).filter((e) => e.type === 'text.completed')).toEqual([
      { at: expect.any(String), type: 'text.completed', text: 'Work' },
    ])
  })

  it("lets a mod list accounts, switch while other chats run, note it and send the message again", async () => {
    const t = setupLimits(({ limit, host }) => {
      const { accounts } = host.accounts('fake')!
      const next = accounts.find((a) => a.id !== limit.account)!
      host.useAccount('fake', next.id)
      host.note(limit.chat.id, `Switched to ${next.name}`)
      host.retry(limit.chat.id)
    })
    t.handle({ type: 'account.addApiKey', engine: 'fake', name: 'Spare', key: 'sk-spare' })
    const busy = createChat(t, { name: 'Busy' })
    const chat = createChat(t)
    asking.add(busy.id)
    t.handle({ type: 'chat.send', chatId: busy.id, text: 'Ask first' })
    // Busy waits on a permission it never gets, so it runs throughout.
    await until(() => statusOf(t.core, busy.id) === 'waiting')
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'Go' })
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'And then this' })
    const done = () => statusOf(t.core, chat.id) === 'idle' && !chatOf(t.core, chat.id)?.queue.length
    await until(() => t.seen.length > 0 && done())

    expect(t.seen[0]!.host.accounts('fake')).toEqual({
      engine: 'fake',
      active: 'spare',
      accounts: [
        { id: 'default', name: 'Default', signedIn: true },
        { id: 'spare', name: 'Spare', signedIn: true },
      ],
    })
    expect(t.seen[0]!.host.accounts('nope')).toBeUndefined()
    const entries = entriesOf(t.core, chat.id)
    const shown = entries.flatMap((e) =>
      e.type === 'user.message' || e.type === 'mod.note' ? [`${e.type}: ${e.text}`] : [],
    )
    expect(shown).toEqual([
      'user.message: Go',
      'mod.note: Switched to Spare',
      'user.message: Go\n\nAnd then this',
    ])
    expect(entries.at(-1)).toEqual({ at: expect.any(String), type: 'turn.completed' })
    expect(basename(t.calls.at(-1)!.options.accountDir!)).toBe('spare')
    expect(statusOf(t.core, busy.id)).toBe('waiting')
    expect(t.calls[0]!.options.accountDir).toBeUndefined()
  })

  it('says whether the engine had done anything since the last message, counting continued turns', async () => {
    const outputs: boolean[] = []
    // The first session runs out at once, the second after a tool call, the third (a continuation) at once.
    const scripts: FakeStep[][] = [
      [],
      [{ type: 'tool.started', toolId: 't', name: 'Bash', kind: 'shell', summary: 'ls', input: {} }],
      [],
    ]
    let sessions = 0
    const limited = (): FakeStep[] => [...(scripts[sessions++] ?? []), { type: 'limit.reached', message: 'Out' }]
    const watcher: Mod = {
      id: 'w',
      name: 'W',
      description: '',
      enabledByDefault: true,
      onLimitReached({ chat, output }, { host }) {
        outputs.push(output)
        if (outputs.length === 2) host.continue(chat.id, 'Carry on')
      },
    }
    const t = setup(createFakeAdapter(limited, 0), tempDir(), TEST_STOP_GRACE_MS, [watcher])
    const chat = createChat(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'Go' })
    await until(() => outputs.length === 1 && statusOf(t.core, chat.id) === 'idle')
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'Go again' })
    await until(() => outputs.length === 3 && statusOf(t.core, chat.id) === 'idle')
    expect(outputs).toEqual([false, true, true])
  })

  it('lets a mod continue a stopped turn as a turn of its own, ahead of queued messages', async () => {
    let continued = false
    const t = setupLimits(({ limit, host }) => {
      host.useAccount('fake', 'spare')
      expect(() => host.continue(limit.chat.id, ' ')).toThrow('A continuation needs a prompt')
      continued = true
      host.continue(limit.chat.id, 'Carry on')
    })
    t.handle({ type: 'account.addApiKey', engine: 'fake', name: 'Spare', key: 'sk-spare' })
    t.handle({ type: 'account.use', engine: 'fake', accountId: 'default' })
    const chat = createChat(t)
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'Go' })
    t.handle({ type: 'chat.send', chatId: chat.id, text: 'And then this' })
    await until(() => continued && t.calls.length === 3 && statusOf(t.core, chat.id) === 'idle')

    const entries = entriesOf(t.core, chat.id)
    expect(entries.flatMap((e) => (e.type === 'user.message' ? [e.text] : []))).toEqual(['Go', 'And then this'])
    // The partial reply is kept, then the continued turn's, then the queued message's.
    expect(entries.flatMap((e) => (e.type === 'text.completed' ? [e.text] : []))).toEqual(['Work', 'Hello', 'Hello'])
    expect(t.calls[1]!.prompt).toMatch(/Work[\s\S]*From Hotrod:\n\nCarry on$/)
    expect(t.calls[1]!.prompt).not.toContain('New message from the user')
    expect(t.calls[2]!.prompt).toContain('New message from the user:\n\nAnd then this')
  })
})
