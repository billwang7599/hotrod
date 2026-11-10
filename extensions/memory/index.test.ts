import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatEntry, MemoryMessage, Extension } from '@kothar/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import { startCore } from '@kothar/core/main'
import type { Adapter, CompleteOptions, CoreMessage, EngineEvent, SessionOptions } from '@kothar/core/shared'
import { sandboxingMachine } from '@kothar/core/test-machine'
import { createMemoryExtension, PARENT_ZOOM_INSTRUCTIONS } from './index.ts'
import { ROLLING_FILE, ROLLING_INSTRUCTIONS } from './rolling.ts'
import {
  COMPACT_MIN_CHARS,
  COMPLETE_TIMEOUT_MS,
  MEMORY_INSTRUCTIONS,
  MESSAGE_MAX_CHARS,
  openSummaries,
  pendingOf,
  ZOOM_INSTRUCTIONS,
} from './tree.ts'

// The first model the core picks for summaries (SUMMARY_MODELS in the core's models.ts).
const SUMMARY_MODEL = 'claude-haiku-5-5'
const at = '2026-11-06T00:00:00.000Z'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(check: () => boolean, timeoutMs = 5000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const tempGarage = () => {
  const garage = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-memory-')))
  cleanups.push(() => rmSync(garage, { recursive: true, force: true }))
  return garage
}

const longReply = (id: number) => `reply ${id} `.padEnd((MESSAGE_MAX_CHARS * 3) / 4, '.')
const logOf = (count: number): ChatEntry[] =>
  Array.from({ length: count }, (_, i) =>
    i % 2 ? { at, type: 'text.completed', text: longReply(i) } : { at, type: 'user.message', text: `question ${i}` },
  )
const messagesOfLog = (entries: ChatEntry[]): MemoryMessage[] =>
  entries.map((e, id) => ({ id, at, kind: e.type === 'user.message' ? 'user' : 'talk', text: 'text' in e ? e.text : '' }))

function writeLog(garage: string, chatId: string, count: number) {
  const dir = join(garage, 'chats', chatId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'log.jsonl'), logOf(count).map((e) => JSON.stringify(e) + '\n').join(''))
}

const summariesFile = (garage: string, chatId: string) => join(garage, 'chats', chatId, 'summaries.jsonl')
const treeOf = (garage: string, chatId: string) => {
  const path = summariesFile(garage, chatId)
  return openSummaries({ read: () => (existsSync(path) ? readFileSync(path, 'utf8') : undefined), append() {} })
}
const summarized = (garage: string, chatId: string, count: number) =>
  pendingOf(messagesOfLog(logOf(count)), treeOf(garage, chatId)).length === 0

async function start(
  options: {
    garage?: string
    work?: boolean
    complete?: Adapter['complete']
    extensions?: Extension[]
    memory?: Extension
    // A mode the user saved in Settings; without one the extension's default (Rolling summary) applies.
    mode?: 'tree' | 'rolling'
  } = {},
) {
  const garage = options.garage ?? tempGarage()
  if (options.mode) writeFileSync(join(garage, 'settings.json'), JSON.stringify({ extensions: { memory: { mode: options.mode } } }))
  const memory = options.memory ?? createMemoryExtension({ debounceMs: 0 })
  const sessions: { options: SessionOptions; prompt?: string; end(reply?: string): void }[] = []
  const completions: CompleteOptions[] = []
  const held: Adapter = {
    id: 'held',
    kotharMcp: true,
    detect: async () => ({ installed: true, signedIn: true, models: ['large', SUMMARY_MODEL] }),
    async complete(machine, request) {
      completions.push(request)
      if (options.complete) return options.complete(machine, request)
      const keys = [...request.prompt.matchAll(/<item key="([^"]+)"/g)].map(([, key]) => key)
      if (!keys.length) return `rolled ${completions.length}`
      return JSON.stringify({ summaries: keys.map((key) => ({ key, text: `summary of ${key}` })) })
    },
    start(_machine, sessionOptions, emit: (event: EngineEvent) => void) {
      const session: (typeof sessions)[number] = {
        options: sessionOptions,
        end(reply) {
          if (reply !== undefined) emit({ type: 'text.completed', text: reply })
          emit({ type: 'turn.completed' })
        },
      }
      sessions.push(session)
      return {
        prompt(text) {
          session.prompt = text
          emit({ type: 'turn.started' })
        },
        interrupt: () => emit({ type: 'turn.completed', error: 'Interrupted' }),
        respond() {},
        close() {},
      }
    },
  }
  const env = {
    KOTHAR_ENGINE: 'held',
    KOTHAR_GARAGE: garage,
    KOTHAR_PORT: '0',
    ...(options.work !== false && { KOTHAR_WORK: join(garage, 'work') }),
  }
  const messages: CoreMessage[] = []
  const kothar = await startCore({ env, adapters: [held], extensions: [...(options.extensions ?? []), memory], machine: sandboxingMachine })
  kothar.core.onMessage((m) => messages.push(m))
  cleanups.push(() => kothar.close(true))
  const handle = (message: Parameters<typeof kothar.core.handle>[0]) => kothar.core.handle(message, () => {})
  const send = (chatId: string, text: string) => {
    handle({ type: 'chat.send', chatId, text })
    return sessions.at(-1)!
  }
  const rpc = async (token: string, method: string, params: object) => {
    const response = await fetch(`http://127.0.0.1:${kothar.port}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    return response.json()
  }
  const tool = async (token: string, name: string, args: object = {}) => {
    const { result, error } = await rpc(token, 'tools/call', { name, arguments: args })
    if (error) return { isError: true, text: String(error.message) }
    return { isError: result.isError === true, text: result.content[0].text as string }
  }
  const names = async (token: string) =>
    (await rpc(token, 'tools/list', {})).result.tools.map((t: { name: string }) => t.name).sort()
  const space = (name = 'App') => {
    handle({ type: 'chat.create', name })
    return kothar.core.chats().find((c) => c.name === name)!.id
  }
  return { ...kothar, garage, sessions, completions, messages, handle, send, tool, names, space }
}

describe('Summary tree mode, saved by the user', () => {
  it('seeds every session with the zoomable view and its instructions, and zoom brings a cut message back', async () => {
    const t = await start({ mode: 'tree' })
    const chatId = t.space()
    const long = 'x'.repeat(MESSAGE_MAX_CHARS + 10)
    t.send(chatId, long).end('ok')
    const next = t.send(chatId, 'next')
    expect(next.options.instructions.split('\n\n')).toEqual(expect.arrayContaining([MEMORY_INSTRUCTIONS, ZOOM_INSTRUCTIONS]))
    expect(next.prompt).toContain(`cut at ${MESSAGE_MAX_CHARS} of ${long.length} chars; zoom(0) for the rest`)
    const token = next.options.kotharMcp!.token
    expect(await t.names(token)).toEqual(expect.arrayContaining(['date', 'zoom']))
    expect((await t.tool(token, 'zoom', { id: 0 })).text).toMatch(new RegExp(`\\n\\n${long}$`))
    expect((await t.tool(token, 'date', { id: 0 })).isError).toBe(false)
    expect((await t.tool(token, 'zoom', { id: 9 })).text).toBe('No message 9; this chat has messages 0 to 2')
  })

  it('summarizes a backlog at start with the summary model, in the scratch folder, and the next prompt shows the lines', async () => {
    const garage = tempGarage()
    writeLog(garage, 'aaaa0001', 40)
    writeFileSync(join(garage, 'chats', 'aaaa0001', 'chat.json'), JSON.stringify({ id: 'aaaa0001', name: 'Old', folders: [], files: [], engine: 'held', archived: false, createdAt: at }))
    const t = await start({ garage, mode: 'tree' })
    await until(() => summarized(garage, 'aaaa0001', 40))
    expect(t.completions[0]).toMatchObject({ cwd: join(garage, 'work', 'home'), model: SUMMARY_MODEL, timeoutMs: COMPLETE_TIMEOUT_MS })
    expect(t.completions[0]?.prompt).toContain('<item key="39+1" kind="talk"')
    const prompt = t.send('aaaa0001', 'next').prompt ?? ''
    expect(prompt).toContain('\n0+1|user: question 0\n1+1|talk: summary of 1+1\n')
    expect(prompt).toContain('<message id="39" kind="talk">')
    expect(prompt.endsWith('New message from the user:\n\nnext')).toBe(true)
  })

  it('waits for a work folder before summarizing', async () => {
    const garage = tempGarage()
    writeLog(garage, 'aaaa0001', 40)
    writeFileSync(join(garage, 'chats', 'aaaa0001', 'chat.json'), JSON.stringify({ id: 'aaaa0001', name: 'Old', folders: [], files: [], engine: 'held', archived: false, createdAt: at }))
    const t = await start({ garage, work: false, mode: 'tree' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(t.completions).toHaveLength(0)
    t.handle({ type: 'workFolder.set', path: join(garage, 'work') })
    await until(() => summarized(garage, 'aaaa0001', 40))
    const home = join(garage, 'work', 'home')
    expect(t.completions[0]).toMatchObject({ cwd: home, sandbox: { writable: [home], tmpDir: join(home, '.tmp') } })
  })

  it('summarizes after a turn ends, once the chat passes COMPACT_MIN_CHARS', async () => {
    const t = await start({ mode: 'tree' })
    const chatId = t.space()
    t.send(chatId, 'q').end('r'.repeat(COMPACT_MIN_CHARS / 2))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(t.completions).toHaveLength(0)
    t.send(chatId, 'q').end('r'.repeat(COMPACT_MIN_CHARS / 2))
    await until(() => t.completions.length > 0)
  })

  it('shows one error, under its name, when summaries keep failing', async () => {
    const garage = tempGarage()
    writeLog(garage, 'aaaa0001', 40)
    writeFileSync(join(garage, 'chats', 'aaaa0001', 'chat.json'), JSON.stringify({ id: 'aaaa0001', name: 'Old', folders: [], files: [], engine: 'held', archived: false, createdAt: at }))
    const t = await start({
      garage,
      memory: createMemoryExtension({ debounceMs: 30, retryBaseMs: 5 }),
      complete: async () => {
        throw new Error('usage limit reached')
      },
    })
    await until(() => t.completions.length >= 3)
    expect(t.messages.filter((m) => m.type === 'error')).toEqual([
      { type: 'error', message: 'Memory: summaries are failing: usage limit reached. Retrying.' },
    ])
  })

  it("gives a worker its parent's view frozen at launch, with read-only zoom and date into it", async () => {
    const t = await start({ mode: 'tree' })
    const chatId = t.space()
    const lead = t.send(chatId, 'Plan the release')
    await t.tool(lead.options.kotharMcp!.token, 'spawn_worker', { task: 'Check the changelog' })
    const first = t.sessions.at(-1)!
    expect(first.options.instructions).toContain(
      `Your parent chat's memory when it started you:\n\n<message id="0" kind="user">\nPlan the release\n</message>`,
    )
    expect(first.options.instructions).toContain(PARENT_ZOOM_INSTRUCTIONS)
    const token = first.options.kotharMcp!.token
    expect((await t.tool(token, 'zoom', { id: 0, parent: true })).text).toMatch(/\n\nPlan the release$/)
    expect((await t.tool(token, 'date', { id: 0, parent: true })).isError).toBe(false)
    expect(await t.tool(token, 'zoom', { id: 1, parent: true })).toEqual({
      isError: true,
      text: 'No message 1; this chat has messages 0 to 0',
    })
    expect(await t.tool(lead.options.kotharMcp!.token, 'zoom', { id: 0, parent: true })).toEqual({
      isError: true,
      text: "Only a worker can read its parent chat's memory",
    })
    first.end('Checked')
  })
})

describe('Memory extension off', () => {
  it('sends the window, offers no zoom, and leaves summaries.jsonl as it was for when it is on again', async () => {
    const garage = tempGarage()
    writeLog(garage, 'aaaa0001', 40)
    writeFileSync(join(garage, 'chats', 'aaaa0001', 'chat.json'), JSON.stringify({ id: 'aaaa0001', name: 'Old', folders: [], files: [], engine: 'held', archived: false, createdAt: at }))
    const t = await start({ garage, mode: 'tree' })
    await until(() => summarized(garage, 'aaaa0001', 40))
    const saved = readFileSync(summariesFile(garage, 'aaaa0001'), 'utf8')
    const callsBefore = t.completions.length

    t.handle({ type: 'extension.setEnabled', extensionId: 'memory', enabled: false })
    const off = t.send('aaaa0001', 'next')
    expect(off.prompt).not.toMatch(/^\d+\+\d+\|/m)
    expect(off.prompt).toContain('<message id="0" kind="user">\nquestion 0\n</message>')
    expect(off.options.instructions).not.toContain(MEMORY_INSTRUCTIONS)
    expect(off.options.instructions).not.toContain('zoom')
    expect(await t.names(off.options.kotharMcp!.token)).not.toContain('zoom')
    off.end('fine')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(t.completions).toHaveLength(callsBefore)
    expect(readFileSync(summariesFile(garage, 'aaaa0001'), 'utf8')).toBe(saved)

    t.handle({ type: 'extension.setEnabled', extensionId: 'memory', enabled: true })
    const on = t.send('aaaa0001', 'again')
    expect(on.prompt).toContain('\n1+1|talk: summary of 1+1\n')
    expect(on.options.instructions).toContain(MEMORY_INSTRUCTIONS)
  })

  it("gives a worker its parent's latest messages frozen at launch, with no zoom", async () => {
    const t = await start({ mode: 'tree' })
    t.handle({ type: 'extension.setEnabled', extensionId: 'memory', enabled: false })
    const chatId = t.space()
    const lead = t.send(chatId, 'Plan the release')
    await t.tool(lead.options.kotharMcp!.token, 'spawn_worker', { task: 'Check the changelog' })
    const first = t.sessions.at(-1)!
    expect(first.options.instructions).toContain(
      `Your parent chat's memory when it started you:\n\n<message id="0" kind="user">\nPlan the release\n</message>`,
    )
    expect(first.options.instructions).not.toContain('zoom')
    expect(first.options.kotharMcp).toBeUndefined()
    first.end('Checked')
  })
})

describe('Rolling summary mode (the default)', () => {
  it('folds what leaves the tail into one summary, shown before the latest messages', async () => {
    const garage = tempGarage()
    writeLog(garage, 'aaaa0001', 120)
    writeFileSync(join(garage, 'chats', 'aaaa0001', 'chat.json'), JSON.stringify({ id: 'aaaa0001', name: 'Old', folders: [], files: [], engine: 'held', archived: false, createdAt: at }))
    // No saved mode: Rolling summary is the default.
    const t = await start({ garage })
    const rolling = join(garage, 'chats', 'aaaa0001', ROLLING_FILE)
    await until(() => existsSync(rolling) && t.completions.length >= 2)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(t.completions.every((c) => !c.prompt.includes('<item key='))).toBe(true)
    expect(existsSync(summariesFile(garage, 'aaaa0001'))).toBe(false)
    const { upTo, text } = JSON.parse(readFileSync(rolling, 'utf8'))
    const next = t.send('aaaa0001', 'next')
    expect(next.prompt).toContain(`<summary of="0-${upTo - 1}">\n${text}\n</summary>`)
    expect(next.prompt).toContain('<message id="119" kind="talk">')
    expect(next.options.instructions).toContain(ROLLING_INSTRUCTIONS)
    expect(next.options.instructions).not.toContain(MEMORY_INSTRUCTIONS)
  })
})

describe('Storage: where summaries live, and cleaning them up', () => {
  const oldChat = (garage: string, chatId: string, count: number) => {
    writeLog(garage, chatId, count)
    writeFileSync(join(garage, 'chats', chatId, 'chat.json'), JSON.stringify({ id: chatId, name: chatId, folders: [], files: [], engine: 'held', archived: false, createdAt: at }))
  }
  const rollingFile = (garage: string, chatId: string) => join(garage, 'chats', chatId, ROLLING_FILE)
  const memoryInfo = (t: Awaited<ReturnType<typeof start>>) => {
    t.handle({ type: 'extension.settingsView.get', extensionId: 'memory' })
    const updates = t.messages.filter((m) => m.type === 'extension.updated' && m.extension.id === 'memory')
    const last = updates.at(-1) as Extract<CoreMessage, { type: 'extension.updated' }>
    return last.extension
  }
  const texts = (view: unknown): string[] => JSON.stringify(view).match(/"text":"[^"]*"/g)!.map((t) => t.slice(8, -1))
  const deleteButton = (view: unknown, mode: string) => {
    const find = (node: any): any =>
      node?.type === 'button' && node.action?.value === mode ? node : (node?.children ?? []).map(find).find(Boolean)
    return find(view)
  }

  it('catches up every chat on a mode switch at once, without waiting for a turn, and drops the old queue', async () => {
    const garage = tempGarage()
    oldChat(garage, 'aaaa0001', 40)
    oldChat(garage, 'aaaa0002', 40)
    const t = await start({ garage, mode: 'rolling' })
    await until(() => existsSync(rollingFile(garage, 'aaaa0001')) && existsSync(rollingFile(garage, 'aaaa0002')))
    expect(existsSync(summariesFile(garage, 'aaaa0001'))).toBe(false)

    t.handle({ type: 'extension.setValue', extensionId: 'memory', key: 'mode', value: 'tree' })
    await until(() => summarized(garage, 'aaaa0001', 40) && summarized(garage, 'aaaa0002', 40))
    expect(t.sessions).toHaveLength(0)
  })

  it('shows the chats folder, each mode file and its disk use, with only the mode not in use deletable', async () => {
    const garage = tempGarage()
    oldChat(garage, 'aaaa0001', 40)
    mkdirSync(join(garage, 'chats', 'main'), { recursive: true })
    writeFileSync(join(garage, 'chats', 'main', 'summaries.jsonl'), 'x'.repeat(1500))
    const t = await start({ garage, mode: 'rolling' })
    await until(() => existsSync(rollingFile(garage, 'aaaa0001')))
    await new Promise((resolve) => setTimeout(resolve, 30))
    const { view, error } = memoryInfo(t).settingsView!
    expect(error).toBeUndefined()
    const shown = texts(view)
    expect(shown).toContain(join(garage, 'chats'))
    expect(shown).toContain(join('<id>', 'summaries.jsonl'))
    expect(shown).toContain(join('<id>', ROLLING_FILE))
    expect(shown).toContain('1.5 KB in 1 chat')
    expect(shown).toContain('In use')
    expect(deleteButton(view, 'rolling').disabled).toBe(true)
    expect(deleteButton(view, 'tree').disabled).toBe(false)
    expect(deleteButton(view, 'tree').confirm.body).toContain('model calls on your logins')
  })

  it("deletes only the unused mode's files, refuses the mode in use, and never touches logs", async () => {
    const garage = tempGarage()
    oldChat(garage, 'aaaa0001', 40)
    const t = await start({ garage, mode: 'rolling' })
    await until(() => existsSync(rollingFile(garage, 'aaaa0001')))
    t.handle({ type: 'extension.setValue', extensionId: 'memory', key: 'mode', value: 'tree' })
    await until(() => summarized(garage, 'aaaa0001', 40))
    const log = readFileSync(join(garage, 'chats', 'aaaa0001', 'log.jsonl'), 'utf8')

    await t.core.handle({ type: 'extension.settingsView.action', extensionId: 'memory', action: { name: 'delete', value: 'tree' } }, () => {})
    expect(t.messages.some((m) => m.type === 'error' && m.message.includes("can't be deleted"))).toBe(true)
    expect(existsSync(summariesFile(garage, 'aaaa0001'))).toBe(true)

    await t.core.handle({ type: 'extension.settingsView.action', extensionId: 'memory', action: { name: 'delete', value: 'rolling' } }, () => {})
    expect(existsSync(rollingFile(garage, 'aaaa0001'))).toBe(false)
    expect(existsSync(summariesFile(garage, 'aaaa0001'))).toBe(true)
    expect(readFileSync(join(garage, 'chats', 'aaaa0001', 'log.jsonl'), 'utf8')).toBe(log)
    expect(texts(memoryInfo(t).settingsView!.view)).toContain('No files')
  })

  it('with Memory off, deletes either mode and forgets the summaries it had read', async () => {
    const garage = tempGarage()
    oldChat(garage, 'aaaa0001', 40)
    let hold = false
    const t = await start({
      garage,
      mode: 'tree',
      complete: async (_machine, request) => {
        if (hold) return new Promise<string>(() => {})
        const keys = [...request.prompt.matchAll(/<item key="([^"]+)"/g)].map(([, key]) => key)
        return JSON.stringify({ summaries: keys.map((key) => ({ key, text: `summary of ${key}` })) })
      },
    })
    await until(() => summarized(garage, 'aaaa0001', 40))
    const before = t.send('aaaa0001', 'next')
    expect(before.prompt).toContain('summary of 1+1')
    before.end('fine')

    t.handle({ type: 'extension.setEnabled', extensionId: 'memory', enabled: false })
    expect(deleteButton(memoryInfo(t).settingsView!.view, 'tree').disabled).toBe(false)
    await t.core.handle({ type: 'extension.settingsView.action', extensionId: 'memory', action: { name: 'delete', value: 'tree' } }, () => {})
    expect(existsSync(summariesFile(garage, 'aaaa0001'))).toBe(false)

    hold = true
    t.handle({ type: 'extension.setEnabled', extensionId: 'memory', enabled: true })
    const after = t.send('aaaa0001', 'again')
    expect(after.prompt).not.toContain('summary of')
  })
})
