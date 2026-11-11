import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatDetail, Extension, ExtensionContext, ExtensionHost, ExtensionView, PermissionVerdict } from '@kothar/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeAdapter, type FakeStep } from './adapters/fake.ts'
import { sandboxingMachine } from './adapters/test-machine.ts'
import { openCore, type Core } from './core.ts'
import type { ClientMessage, CoreMessage, Machine, Sandbox, SessionOptions } from './shared.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-modapi-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
  if (!check()) throw new Error('timed out')
}

const replied: FakeStep[] = [{ type: 'text.completed', text: 'Done' }]

// A core on the fake engine with one extension, `test`, built from `parts`; `script` is what every session plays.
function start(
  parts: Partial<Extension>,
  script: FakeStep[] | ((options: SessionOptions) => FakeStep[]) = replied,
  machine: Machine = sandboxingMachine,
) {
  const garage = tempDir()
  const extension: Extension = { id: 'test', name: 'Test extension', description: '', enabledByDefault: true, ...parts }
  const base = createFakeAdapter(script, 0)
  const prompts: string[] = []
  const adapter: typeof base = {
    ...base,
    start(machine, options, emit) {
      const session = base.start(machine, options, emit)
      return { ...session, prompt: (text, images) => (prompts.push(text), session.prompt(text, images)) }
    },
  }
  const core = openCore({ garage, adapters: [adapter], defaultEngine: 'fake', machine, extensions: [extension] })
  cleanups.push(() => core.close(true))
  const messages: CoreMessage[] = []
  core.onMessage((m) => messages.push(m))
  const replies: CoreMessage[] = []
  const handle = (m: ClientMessage) => core.handle(m, (r) => replies.push(r))
  handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true })
  handle({ type: 'workFolder.set', path: join(garage, 'work') })
  const create = (name = 'Space', folders?: string[]) => {
    handle({ type: 'chat.create', name, ...(folders && { folders }) })
    return core.chats().findLast((c) => c.name === name)!.id
  }
  const chat = (id: string) => core.chats().find((c) => c.id === id)!
  const send = async (chatId: string, text = 'Go') => {
    handle({ type: 'chat.send', chatId, text })
    await until(() => chat(chatId).status === 'idle' && !chat(chatId).queue.length)
  }
  return { core, garage, messages, replies, handle, create, chat, send, prompts }
}

// An extension that keeps the host it was given, for tests that call the host directly.
function withHost(parts: Partial<Extension> = {}, script?: FakeStep[], machine?: Machine) {
  let host: ExtensionHost | undefined
  const t = start({ ...parts, onChatCreated: (_chat, context) => void (host = context.host) }, script, machine)
  return { ...t, host: () => host! }
}

describe('lifecycle hooks', () => {
  it('hear when chats are created, archived, unarchived and removed', async () => {
    const heard: string[] = []
    const t = start({
      onChatCreated: (chat) => void heard.push(`created ${chat.name} ${chat.status}`),
      onChatArchived: (chat, archived) => void heard.push(`${archived ? 'archived' : 'unarchived'} ${chat.name}`),
      onChatRemoved: (chat) => void heard.push(`removed ${chat.name}`),
    })
    const id = t.create('Alpha')
    t.handle({ type: 'chat.archive', chatId: id, archived: true })
    t.handle({ type: 'chat.archive', chatId: id, archived: false })
    t.handle({ type: 'chat.delete', chatId: id })
    expect(heard).toEqual(['created Alpha idle', 'archived Alpha', 'unarchived Alpha', 'removed Alpha'])
  })

  it('hear a turn start and end with what it did, the statuses it went through and every event', async () => {
    const heard: string[] = []
    const events: string[] = []
    const script: FakeStep[] = [
      { type: 'thinking.delta', text: 'Hmm' },
      { type: 'tool.started', toolId: 'e1', name: 'Edit', kind: 'edit', summary: 'a.ts', input: {}, path: '/x/a.ts' },
      { type: 'tool.completed', toolId: 'e1', output: 'ok', isError: false },
      { type: 'tool.started', toolId: 'e2', name: 'Edit', kind: 'edit', summary: 'a.ts', input: {}, path: '/x/a.ts' },
      { type: 'tool.completed', toolId: 'e2', output: 'ok', isError: false },
      { type: 'tool.started', toolId: 's1', name: 'Bash', kind: 'shell', summary: 'false', input: {} },
      { type: 'tool.completed', toolId: 's1', output: 'failed', isError: true },
      { type: 'text.delta', text: 'Do' },
      { type: 'text.completed', text: 'Done' },
    ]
    let summary: unknown
    const t = start(
      {
        onTurnStarted: ({ chat, text, continued }) => void heard.push(`started ${chat.name}: ${text} ${continued}`),
        onStatusChanged: (_chat, status) => void heard.push(status),
        onSessionEnded: ({ error }) => void heard.push(`session ended ${error ?? 'cleanly'}`),
        onTurnCompleted: (turn) => {
          heard.push('turn completed')
          summary = turn
        },
        onEvent: (_chat, event) => void events.push(event.type),
      },
      script,
    )
    const id = t.create()
    await t.send(id, 'Fix it')
    expect(heard).toEqual(['running', 'started Space: Fix it false', 'idle', 'session ended cleanly', 'turn completed'])
    expect(summary).toMatchObject({
      chat: { id, name: 'Space', status: 'idle' },
      text: 'Done',
      files: ['/x/a.ts'],
      tools: [
        { name: 'Edit', kind: 'edit', summary: 'a.ts', path: '/x/a.ts' },
        { name: 'Edit', kind: 'edit', summary: 'a.ts', path: '/x/a.ts' },
        { name: 'Bash', kind: 'shell', summary: 'false', isError: true },
      ],
    })
    expect(events).toEqual([
      'turn.started',
      'thinking.delta',
      'tool.started',
      'tool.completed',
      'tool.started',
      'tool.completed',
      'tool.started',
      'tool.completed',
      'text.delta',
      'text.completed',
      'turn.completed',
    ])
  })

  it('carry a turn error, and an early session end, to the extension', async () => {
    const ended: unknown[] = []
    const t = start(
      {
        onSessionEnded: ({ error }) => void ended.push(error),
        onTurnCompleted: ({ error }) => void ended.push(error),
      },
      [{ type: 'session.ended', error: 'The engine quit' }],
    )
    const id = t.create()
    await t.send(id)
    expect(ended).toEqual(['The engine quit', 'The engine quit'])
  })

  it("carry why a turn failed, as the engine's adapter labelled it, without logging it", async () => {
    const turns: unknown[] = []
    const t = start(
      { onTurnCompleted: ({ error, errorKind }) => void turns.push({ error, errorKind }) },
      [{ type: 'turn.completed', error: 'socket hang up', errorKind: 'network' }],
    )
    const id = t.create()
    await t.send(id)
    expect(turns).toEqual([{ error: 'socket hang up', errorKind: 'network' }])
    const log = readFileSync(join(t.garage, 'chats', id, 'log.jsonl'), 'utf8')
    expect(log).toContain('socket hang up')
    expect(log).not.toContain('errorKind')
  })

  it('show a hook that throws or rejects as an error, and the chat carries on', async () => {
    const t = start({
      onTurnStarted() {
        throw new Error('broken start')
      },
      onTurnCompleted: async () => {
        throw new Error('broken end')
      },
    })
    const id = t.create()
    await t.send(id)
    await until(() => t.messages.filter((m) => m.type === 'error').length === 2)
    const errors = t.messages.flatMap((m) => (m.type === 'error' ? [m.message] : []))
    expect(errors).toEqual(['Test extension: broken start', 'Test extension: broken end'])
    expect(t.chat(id).entries.some((e) => e.type === 'text.completed' && e.text === 'Done')).toBe(true)
  })

  it("don't run for an extension that is off", async () => {
    const heard: string[] = []
    const t = start({ enabledByDefault: false, onChatCreated: (chat) => void heard.push(chat.name) })
    t.create('Quiet')
    t.handle({ type: 'extension.setEnabled', extensionId: 'test', enabled: true })
    t.create('Heard')
    expect(heard).toEqual(['Heard'])
  })
})

describe('permission policies', () => {
  const asking: FakeStep[] = [
    { type: 'tool.started', toolId: 't1', name: 'Bash', kind: 'shell', summary: 'rm x', input: {} },
    { type: 'permission', toolId: 't1', name: 'Bash', kind: 'shell', summary: 'rm x', input: {}, output: 'removed' },
    { type: 'text.completed', text: 'Done' },
  ]
  // Run without asking off, so the core itself would ask the user.
  const asked = (verdict: PermissionVerdict | undefined | Promise<PermissionVerdict | undefined>) => {
    const t = start({ onPermissionRequested: () => verdict }, asking)
    t.handle({ type: 'permission.setDefault', name: 'autoRunCommands', enabled: false })
    return t
  }

  it('let an extension deny a request, with a message for the agent', async () => {
    const t = asked({ allow: false, message: 'Not here' })
    const id = t.create()
    await t.send(id)
    const entries = t.chat(id).entries
    expect(entries).toContainEqual(expect.objectContaining({ type: 'permission.resolved', allow: false, auto: true }))
    expect(entries).toContainEqual(expect.objectContaining({ type: 'tool.completed', output: 'Not here', isError: true }))
  })

  it('wait for an extension that answers later', async () => {
    const t = asked(new Promise((resolve) => setTimeout(() => resolve({ allow: true }), 20)))
    const id = t.create()
    await t.send(id)
    const entries = t.chat(id).entries
    expect(entries).toContainEqual(expect.objectContaining({ type: 'permission.resolved', allow: true, auto: true }))
    expect(entries).toContainEqual(expect.objectContaining({ type: 'tool.completed', output: 'removed' }))
    expect(t.messages.some((m) => m.type === 'chat.status' && m.status === 'waiting')).toBe(false)
  })

  it('leave the user to answer when the extension has no verdict', async () => {
    const t = asked(undefined)
    const id = t.create()
    t.handle({ type: 'chat.send', chatId: id, text: 'Go' })
    await until(() => t.chat(id).status === 'waiting')
    const request = t.chat(id).entries.find((e) => e.type === 'permission.requested')!
    if (request.type !== 'permission.requested') throw new Error('no request')
    t.handle({ type: 'permission.respond', chatId: id, requestId: request.requestId, allow: true })
    await until(() => t.chat(id).status === 'idle')
  })

  it("can't allow what the core denies: an edit outside the work folder of a sandboxed chat", async () => {
    const outside: FakeStep[] = [
      { type: 'permission', toolId: 'w', name: 'Write', kind: 'edit', summary: '/etc/x', path: '/etc/x', input: {}, output: '' },
    ]
    const t = start({ onPermissionRequested: () => ({ allow: true }) }, outside)
    const id = t.create()
    await t.send(id)
    expect(t.chat(id).entries).toContainEqual(expect.objectContaining({ type: 'permission.resolved', allow: false }))
  })
})

describe('instructions', () => {
  it('join every session’s instructions, saying whether the session has the extension’s tools', async () => {
    const seen: string[] = []
    const t = start(
      { instructions: ({ chat, tools }) => `Use the test tools in ${chat.name} (${tools ? 'offered' : 'not offered'})` },
      (options) => (seen.push(options.instructions), replied),
    )
    const id = t.create()
    await t.send(id)
    expect(seen.at(-1)).toContain('Use the test tools in Space (not offered)')
  })

  it('leave out an extension that returns nothing or throws, and show its error', async () => {
    const seen: string[] = []
    const t = start(
      {
        instructions() {
          throw new Error('nope')
        },
      },
      (options) => (seen.push(options.instructions), replied),
    )
    const id = t.create()
    await t.send(id)
    expect(t.chat(id).status).toBe('idle')
    expect(t.messages).toContainEqual({ type: 'error', message: 'Test extension: nope' })
  })

  it('come from extensions that are on only', async () => {
    const seen: string[] = []
    const t = start({ instructions: () => 'From the test extension' }, (options) => (seen.push(options.instructions), replied))
    t.handle({ type: 'extension.setEnabled', extensionId: 'test', enabled: false })
    const id = t.create()
    await t.send(id)
    expect(seen.at(-1)).not.toContain('From the test extension')
  })
})

describe('transforms', () => {
  it('rewrite a message on its way to the engine, keeping the original in the log', async () => {
    const t = start({ transformMessage: (text, chat) => `${text} (for ${chat.name})` })
    const id = t.create()
    await t.send(id, 'Hello')
    expect(t.prompts.at(-1)).toContain('Hello (for Space)')
    expect(t.chat(id).entries.find((e) => e.type === 'user.message')).toMatchObject({ text: 'Hello' })
  })

  it('rewrite a finished reply before it is logged, and text left unfinished when the turn ends', async () => {
    const t = start({ transformOutput: (text) => text.toUpperCase() }, [
      { type: 'text.completed', text: 'first' },
      { type: 'text.delta', text: 'second' },
      { type: 'turn.completed' },
    ])
    const id = t.create()
    await t.send(id)
    const texts = t.chat(id).entries.flatMap((e) => (e.type === 'text.completed' ? [e.text] : []))
    expect(texts).toEqual(['FIRST', 'SECOND'])
  })

  it('pass the text through unchanged when a transform throws', async () => {
    const t = start({
      transformOutput() {
        throw new Error('nope')
      },
    })
    const id = t.create()
    await t.send(id)
    expect(t.chat(id).entries).toContainEqual(expect.objectContaining({ type: 'text.completed', text: 'Done' }))
    expect(t.messages).toContainEqual({ type: 'error', message: 'Test extension: nope' })
  })
})

describe('a wait as the turn ends', () => {
  const wait = { text: 'Hold on', buttons: [{ id: 'go', label: 'Go' }] }

  it('holds the chat waiting, queues messages behind it, and ends the turn when it ends', async () => {
    let host: ExtensionHost | undefined
    let late: unknown
    let held = 0
    const t = start({
      onChatCreated: (_chat, context) => void (host = context.host),
      onTurnCompleted({ chat }, { host }) {
        if (chat.name === 'Space' && !held++) host.wait(chat.id, wait)
      },
      // Only as the turn ends: after an await it's too late.
      async onSessionEnded({ chat }, { host }) {
        await Promise.resolve()
        if (chat.name !== 'Late') return
        try {
          host.wait(chat.id, wait)
        } catch (error) {
          late = error
        }
      },
    })
    const other = t.create('Late')
    await t.send(other)
    await until(() => late !== undefined)
    expect(String(late)).toContain('only while its turn runs')
    const id = t.create()
    t.handle({ type: 'chat.send', chatId: id, text: 'Go' })
    await until(() => t.chat(id).status === 'waiting')
    expect(t.chat(id).waits).toEqual([expect.objectContaining({ extension: 'test', text: 'Hold on' })])
    host!.send(id, 'Next')
    expect(t.chat(id).queue.map((q) => q.text)).toEqual(['Next'])
    host!.endWait(id)
    await until(() => t.chat(id).status === 'idle' && !t.chat(id).queue.length)
    // Late's turn, Space's, then the queued message.
    expect(t.prompts).toHaveLength(3)
    expect(t.prompts[2]).toContain('Next')
  })

  it('lets a continuation carry the turn on, and Stop ends it', async () => {
    let host: ExtensionHost | undefined
    let holds = 2
    const t = start({
      onChatCreated: (_chat, context) => void (host = context.host),
      onTurnCompleted({ chat }, { host }) {
        if (holds-- > 0) host.wait(chat.id, wait)
      },
    })
    const id = t.create()
    t.handle({ type: 'chat.send', chatId: id, text: 'Go' })
    await until(() => t.chat(id).status === 'waiting')
    host!.continue(id, 'Carry on')
    await until(() => t.prompts.length === 2 && t.chat(id).status === 'waiting')
    t.handle({ type: 'chat.interrupt', chatId: id })
    expect(t.chat(id).status).toBe('idle')
    expect(t.chat(id).waits ?? []).toEqual([])
  })

  it('keeps a worker from reporting until it ends', async () => {
    let holding = true
    const t = withHost({
      onTurnCompleted({ chat }, { host }) {
        if (chat.worker && holding) host.wait(chat.id, wait)
      },
    })
    const space = t.create()
    const worker = t.host().createChat({ name: 'Helper', parentId: space })
    t.host().send(worker.id, 'Task')
    await until(() => t.chat(worker.id)?.status === 'waiting')
    expect(t.chat(space).entries.some((e) => e.type === 'worker.report')).toBe(false)
    holding = false
    t.host().endWait(worker.id)
    await until(() => !t.core.chats().some((c) => c.id === worker.id))
    await until(() => t.chat(space).status === 'idle')
    expect(t.chat(space).entries.filter((e) => e.type === 'worker.report')).toHaveLength(1)
  })
})

describe('the host', () => {
  it('lists and reads chats', async () => {
    const t = withHost()
    const id = t.create('Alpha')
    await t.send(id, 'Hi')
    const host = t.host()
    expect(host.chats().map((c: ChatDetail) => c.name)).toContain('Alpha')
    expect(host.chat(id)).toMatchObject({ id, name: 'Alpha', status: 'idle', archived: false, folders: [] })
    expect(host.chat('nope')).toBeUndefined()
    expect(host.read(id).map((e) => e.type)).toEqual(['user.message', 'turn.started', 'text.completed', 'turn.completed'])
    expect(host.read(id, { last: 1 }).map((e) => e.type)).toEqual(['turn.completed'])
  })

  it('makes a space, or a child of a chat when given parentId; a role only for a child', async () => {
    const t = withHost()
    const space = t.create('Space')
    const host = t.host()
    const made = host.createChat({ name: 'Other' })
    expect(host.chat(made.id)).toMatchObject({ name: 'Other' })
    expect(host.chat(made.id)!.parentId).toBeUndefined()
    expect(() => host.createChat({ name: 'Odd', role: 'planning' })).toThrow('Only a child chat (with parentId) takes a role')
    const child = host.createChat({ name: 'Helper', parentId: space })
    expect(host.chat(child.id)).toMatchObject({ parentId: space, worker: true })
    expect(host.chats().filter((c) => c.parentId === space).map((c) => c.id)).toEqual([child.id])
    expect(() => host.createChat({ name: 'Lost', parentId: 'nope' })).toThrow()
  })

  it('sends a message, queued behind a running turn, and interrupts a turn', async () => {
    const slow = createFakeAdapter([{ type: 'text.completed', text: 'Done' }], 30)
    const garage = tempDir()
    let host: ExtensionHost | undefined
    const extension: Extension = { id: 'test', name: 'Test', description: '', enabledByDefault: true }
    extension.onChatCreated = (_chat, context) => void (host = context.host)
    const core: Core = openCore({ garage, adapters: [slow], defaultEngine: 'fake', machine: sandboxingMachine, extensions: [extension] })
    cleanups.push(() => core.close(true))
    core.handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true }, () => {})
    core.handle({ type: 'workFolder.set', path: join(garage, 'work') }, () => {})
    core.handle({ type: 'chat.create', name: 'Space' }, () => {})
    const id = core.chats()[0]!.id
    const chat = () => core.chats().find((c) => c.id === id)!
    host!.send(id, 'One')
    host!.send(id, 'Two')
    expect(chat().queue.map((q) => q.text)).toEqual(['Two'])
    host!.interrupt(id)
    await until(() => chat().status === 'idle' && !chat().queue.length)
    const said = chat().entries.flatMap((e) => (e.type === 'user.message' ? [e.text] : []))
    expect(said).toEqual(['One', 'Two'])
    expect(chat().entries).toContainEqual(expect.objectContaining({ type: 'turn.completed', error: 'Interrupted' }))
  })

  it("gives a space's work folder, folders and checkouts, with the branch each came from", async () => {
    const repo = tempDir()
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    git('init', '-q', '-b', 'trunk')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    git('add', '.')
    git('-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first')
    const plain = tempDir()
    const t = withHost()
    const id = t.create('Repo', [repo, plain])
    expect(t.host().space(id)).toEqual({
      id,
      name: 'Repo',
      folders: [
        { path: repo, git: true },
        { path: plain, git: false },
      ],
      checkouts: [],
    })
    await t.send(id)
    const space = t.host().space(id)!
    expect(space.workDir).toBe(join(t.garage, 'work', id))
    expect(space.checkouts).toEqual([
      { folder: repo, path: join(t.garage, 'work', id, realpathSync(repo).split('/').at(-1)!), branch: 'kothar/repo', from: 'trunk' },
    ])
  })

  it('stores plain files of its own in the garage, and only there', () => {
    const t = withHost()
    t.create()
    const { storage } = t.host()
    expect(storage.dir).toBe(join(t.garage, 'extensions', 'test'))
    expect(storage.read('state.json')).toBeUndefined()
    storage.write('nested/state.json', '{"a":1}')
    expect(readFileSync(join(storage.dir, 'nested', 'state.json'), 'utf8')).toBe('{"a":1}')
    expect(storage.read('nested/state.json')).toBe('{"a":1}')
    storage.remove('nested/state.json')
    expect(existsSync(join(storage.dir, 'nested', 'state.json'))).toBe(false)
    expect(() => storage.write('../settings.json', 'x')).toThrow("outside Test extension's storage")
    expect(() => storage.read('/etc/hosts')).toThrow("outside Test extension's storage")
  })

  it('notes in a chat, optionally opening one of its panels', () => {
    const t = withHost({ panels: [{ id: 'info', title: 'Info', render: () => ({ type: 'empty', text: '' }) }] })
    const id = t.create()
    t.host().note(id, 'Plain')
    t.host().note(id, 'Look', { panel: 'info' })
    const notes = t.chat(id).entries.filter((e) => e.type === 'extension.note')
    expect(notes).toEqual([
      expect.objectContaining({ text: 'Plain' }),
      expect.objectContaining({ text: 'Look', extension: 'test', panel: 'info' }),
    ])
    expect(notes[0]).not.toHaveProperty('panel')
    expect(() => t.host().note(id, 'Bad', { panel: 'nope' })).toThrow('Test extension has no panel "nope"')
  })

  it('runs commands through the Machine', async () => {
    const t = withHost()
    t.create()
    const result = await t.host().run('sh', ['-c', 'echo hi; echo oops >&2; exit 3'], { cwd: tempDir() })
    expect(result).toEqual({ code: 3, stdout: 'hi\n', stderr: 'oops\n' })
  })

  // Processes really run, unsandboxed; the machine notes the sandbox each was given.
  function recording() {
    const spawned: { command: string; cwd: string; sandbox?: Sandbox }[] = []
    const machine: Machine = {
      ...sandboxingMachine,
      spawn(command, args, { sandbox, ...rest }) {
        spawned.push({ command, cwd: rest.cwd, ...(sandbox && { sandbox }) })
        return sandboxingMachine.spawn(command, args, rest)
      },
    }
    return { machine, spawned }
  }

  it('spawns a long-running process and hears its output and exit', async () => {
    const { machine } = recording()
    const t = withHost({}, undefined, machine)
    t.create()
    const proc = await t.host().spawn('sh', ['-c', 'echo hi; echo oops >&2; exit 3'], { cwd: tempDir() })
    let out = ''
    proc.onOutput((chunk) => (out += chunk))
    const exit = await new Promise<[number | null, string]>((resolve) => proc.onExit((...a) => resolve(a)))
    expect([out, ...exit]).toEqual(['hi\n', 3, 'oops\n'])
  })

  it('spawns as a chat in its sandbox, in its work folder, unless the chat may edit anywhere', async () => {
    const { machine, spawned } = recording()
    const t = withHost({}, undefined, machine)
    const id = t.create()
    await t.send(id)
    const workDir = join(t.garage, 'work', id)
    const proc = await t.host().spawn('sleep', ['30'], { chat: id })
    proc.stop()
    const sandbox = { writable: [workDir], tmpDir: join(workDir, '.tmp') }
    expect(spawned.at(-1)).toEqual({ command: 'sleep', cwd: workDir, sandbox })
    t.handle({ type: 'chat.setPermission', chatId: id, name: 'editAnywhere', enabled: true })
    ;(await t.host().spawn('sleep', ['30'], { chat: id })).stop()
    expect(spawned.at(-1)).toEqual({ command: 'sleep', cwd: workDir })
    ;(await t.host().spawn('sleep', ['30'])).stop()
    expect(spawned.at(-1)).toEqual({ command: 'sleep', cwd: '/' })
  })

  it('stops what an extension spawned when the extension is turned off, and spawns nothing while it is off', async () => {
    const { machine } = recording()
    const t = withHost({}, undefined, machine)
    t.create()
    const proc = await t.host().spawn('sleep', ['30'], { cwd: tempDir() })
    const exited = new Promise<void>((resolve) => proc.onExit(() => resolve()))
    t.handle({ type: 'extension.setEnabled', extensionId: 'test', enabled: false })
    await exited
    await expect(t.host().spawn('sleep', ['30'])).rejects.toThrow('Test extension is off')
  })

  it('is one per extension, so each tool call gets its own extension’s host', () => {
    const t = withHost()
    t.create()
    expect(t.host().storage.dir.endsWith(join('extensions', 'test'))).toBe(true)
  })
})

describe('notify', () => {
  it('sends the UI a notification from the extension, cut to size, about a chat it names', () => {
    const t = withHost()
    const id = t.create()
    t.host().notify({ chatId: id, title: 'Gave up', body: 'x'.repeat(1000) })
    t.host().notify({ title: 'No chat' })
    const sent = t.messages.filter((m) => m.type === 'notify')
    expect(sent).toEqual([
      { type: 'notify', extension: 'test', title: 'Gave up', body: 'x'.repeat(400), chatId: id },
      { type: 'notify', extension: 'test', title: 'No chat', body: '' },
    ])
    expect(() => t.host().notify({ chatId: 'nope', title: 'Hi' })).toThrow('Unknown chat "nope"')
  })
})

describe('showPanel', () => {
  const panels: Extension['panels'] = [
    { id: 'side', title: 'Side', placement: 'dock', render: () => ({ type: 'empty', text: '' }) },
    { id: 'tab', title: 'Tab', render: () => ({ type: 'empty', text: '' }) },
    { id: 'pop', title: 'Pop', placement: 'popup', render: () => ({ type: 'empty', text: '' }) },
  ]

  it('asks the UI to open a dock or a tab for a chat, never a popup', () => {
    const t = withHost({ panels })
    const id = t.create()
    t.host().showPanel(id, 'side')
    t.host().showPanel(id, 'tab')
    t.host().showPanel(id, 'pop')
    expect(t.messages.filter((m) => m.type === 'extension.panel.show')).toEqual([
      { type: 'extension.panel.show', chatId: id, extension: 'test', panel: 'side', placement: 'dock' },
      { type: 'extension.panel.show', chatId: id, extension: 'test', panel: 'tab', placement: 'tab' },
    ])
    expect(() => t.host().showPanel(id, 'nope')).toThrow('Test extension has no panel "nope"')
    expect(() => t.host().showPanel('nope', 'side')).toThrow('Unknown chat "nope"')
  })

  it('keeps a dock placement for the UI', () => {
    const t = withHost({ panels })
    const id = t.create()
    t.handle({ type: 'context.get', chatId: id })
    const listed = t.replies.find((m) => m.type === 'chat.extensions')
    expect(listed).toMatchObject({ panels: [{ id: 'side', placement: 'dock' }, { id: 'tab' }, { id: 'pop', placement: 'popup' }] })
  })
})

describe('panels and commands', () => {
  const view = (text: string): ExtensionView => ({ type: 'stack', children: [{ type: 'text', text }] })

  function panelled(extra: Partial<Extension> = {}) {
    let count = 0
    const actions: unknown[] = []
    const ran: string[] = []
    let context: ExtensionContext | undefined
    const t = start({
      onChatCreated: (_chat, c) => void (context = c),
      panels: [
        {
          id: 'count',
          title: 'Count',
          render: (chat) => view(`${chat.name}: ${++count}`),
          onAction: (action) => void actions.push(action),
        },
        { id: 'hidden', title: 'Hidden', shown: (chat) => chat.name === 'Special', render: () => view('special') },
        {
          id: 'broken',
          title: 'Broken',
          render: () => {
            throw new Error('Cannot draw')
          },
        },
      ],
      commands: [
        { id: 'hello', label: 'Say hello', hint: 'Notes hello', run: (chat, c) => void (ran.push(chat.name), c.host.note(chat.id, 'hello')) },
        { id: 'never', label: 'Never', shown: () => false, run: () => {} },
      ],
      ...extra,
    })
    const views = () => t.messages.filter((m) => m.type === 'extension.panel')
    return { ...t, actions, ran, views, context: () => context! }
  }

  it('list the tabs and commands a chat gets, with the context', () => {
    const t = panelled()
    const id = t.create('Plain')
    const special = t.create('Special')
    t.handle({ type: 'context.get', chatId: id })
    t.handle({ type: 'context.get', chatId: special })
    const listed = t.replies.filter((m) => m.type === 'chat.extensions')
    expect(listed).toEqual([
      {
        type: 'chat.extensions',
        chatId: id,
        panels: [
          { extension: 'test', id: 'count', title: 'Count' },
          { extension: 'test', id: 'broken', title: 'Broken' },
        ],
        commands: [{ extension: 'test', id: 'hello', label: 'Say hello', hint: 'Notes hello' }],
      },
      expect.objectContaining({ chatId: special, panels: expect.arrayContaining([expect.objectContaining({ id: 'hidden' })]) }),
    ])
  })

  it('draw a panel when asked, again on refresh, and show a render error', async () => {
    const t = panelled()
    const id = t.create()
    t.handle({ type: 'extension.panel.get', chatId: id, extension: 'test', panel: 'count' })
    await until(() => t.views().length === 1)
    expect(t.views()[0]).toEqual({ type: 'extension.panel', chatId: id, extension: 'test', panel: 'count', view: view('Space: 1') })
    t.context().host.refresh(id)
    await until(() => t.views().length === 2)
    expect(t.views()[1]).toMatchObject({ view: view('Space: 2') })
    expect(t.messages.filter((m) => m.type === 'chat.extensions' && m.chatId === id)).toHaveLength(1)
    t.handle({ type: 'extension.panel.get', chatId: id, extension: 'test', panel: 'broken' })
    await until(() => t.views().length === 3)
    expect(t.views()[2]).toMatchObject({ panel: 'broken', error: 'Cannot draw' })
  })

  it('send actions back to the panel, then draw it again', async () => {
    const t = panelled()
    const id = t.create()
    t.handle({ type: 'extension.panel.action', chatId: id, extension: 'test', panel: 'count', action: { name: 'open', value: 'a.ts' } })
    await until(() => t.views().length === 1)
    expect(t.actions).toEqual([{ name: 'open', value: 'a.ts' }])
    expect(() =>
      t.handle({ type: 'extension.panel.action', chatId: id, extension: 'test', panel: 'nope', action: { name: 'x' } }),
    ).toThrow('Test extension has no panel "nope"')
  })

  it('run a command, but not one the chat is not offered', () => {
    const t = panelled()
    const id = t.create()
    t.handle({ type: 'extension.command', chatId: id, extension: 'test', command: 'hello' })
    expect(t.ran).toEqual(['Space'])
    expect(t.chat(id).entries.at(-1)).toMatchObject({ type: 'extension.note', text: 'hello' })
    expect(() => t.handle({ type: 'extension.command', chatId: id, extension: 'test', command: 'never' })).toThrow(
      'Test extension has no command "never" here',
    )
  })

  it('go when the extension is turned off, and come back when it is on', () => {
    const t = panelled()
    const id = t.create()
    t.handle({ type: 'extension.setEnabled', extensionId: 'test', enabled: false })
    expect(t.messages.findLast((m) => m.type === 'chat.extensions' && m.chatId === id)).toMatchObject({ panels: [], commands: [] })
    expect(() => t.handle({ type: 'extension.panel.get', chatId: id, extension: 'test', panel: 'count' })).toThrow('Test extension is off')
    t.handle({ type: 'extension.setEnabled', extensionId: 'test', enabled: true })
    expect(t.messages.findLast((m) => m.type === 'chat.extensions' && m.chatId === id)).toMatchObject({
      panels: expect.arrayContaining([expect.objectContaining({ id: 'count' })]),
    })
  })
})

describe('space settings', () => {
  const spaceSettings: Extension['spaceSettings'] = [
    { key: 'auto', label: 'Run on its own', type: 'boolean', default: false },
    { key: 'size', label: 'Size', type: 'select', options: [{ value: 1, label: 'Small' }, { value: 2, label: 'Large' }], default: 1 },
  ]
  const controls: ExtensionView = {
    type: 'stack',
    children: [
      { type: 'switch', setting: 'auto' },
      { type: 'card', title: 'More', children: [{ type: 'picker', setting: 'size', label: 'How big' }] },
    ],
  }
  const panels: Extension['panels'] = [{ id: 'p', title: 'P', render: () => controls }]

  it('keeps values per space, a worker reads its space’s, and they’re checked as Settings checks', () => {
    const t = withHost({ spaceSettings })
    const a = t.create('A')
    const b = t.create('B')
    const host = t.host()
    expect(host.spaceValues(a)).toEqual({ auto: false, size: 1 })
    host.setSpaceValue(a, 'auto', true)
    const child = host.createChat({ name: 'Helper', parentId: a }).id
    host.setSpaceValue(child, 'size', 2)
    expect(host.spaceValues(a)).toEqual({ auto: true, size: 2 })
    expect(host.spaceValues(child)).toEqual({ auto: true, size: 2 })
    expect(host.spaceValues(b)).toEqual({ auto: false, size: 1 })
    const saved = JSON.parse(readFileSync(join(t.garage, 'chats', a, 'chat.json'), 'utf8'))
    expect(saved.extensionValues).toEqual({ test: { auto: true, size: 2 } })
    expect(existsSync(join(t.garage, 'chats', child, 'chat.json')) && JSON.parse(readFileSync(join(t.garage, 'chats', child, 'chat.json'), 'utf8')).extensionValues).toBeFalsy()
    expect(() => host.setSpaceValue(a, 'nope', 1)).toThrow('Test extension has no space setting "nope"')
    expect(() => host.setSpaceValue(a, 'size', 3)).toThrow(/^Size /)
    expect(() => host.setSpaceValue(a, 'auto', 'yes')).toThrow(/^Run on its own /)
  })

  it('fills in a panel’s switch and picker, and a change from the UI saves and draws the panel again', async () => {
    const t = start({ spaceSettings, panels })
    const id = t.create('A')
    const views = () => t.messages.filter((m) => m.type === 'extension.panel')
    t.handle({ type: 'extension.panel.get', chatId: id, extension: 'test', panel: 'p' })
    await until(() => views().length === 1)
    const options = [{ value: 1, label: 'Small' }, { value: 2, label: 'Large' }]
    expect(views()[0]).toMatchObject({
      view: {
        children: [
          { type: 'switch', setting: 'auto', label: 'Run on its own', value: false },
          { type: 'card', children: [{ type: 'picker', setting: 'size', label: 'How big', value: 1, options }] },
        ],
      },
    })
    t.handle({ type: 'extension.space.set', chatId: id, extension: 'test', key: 'auto', value: true })
    await until(() => views().length === 2)
    const redrawn = views()[1]!
    expect(redrawn.type === 'extension.panel' && redrawn.view?.type === 'stack' && redrawn.view.children[0]).toMatchObject({ type: 'switch', value: true })
  })

  it('shows an error in place of a panel whose control names no such setting', async () => {
    const t = start({ spaceSettings, panels: [{ id: 'p', title: 'P', render: () => ({ type: 'switch', setting: 'size' }) }] })
    const id = t.create('A')
    t.handle({ type: 'extension.panel.get', chatId: id, extension: 'test', panel: 'p' })
    await until(() => t.messages.some((m) => m.type === 'extension.panel'))
    expect(t.messages.find((m) => m.type === 'extension.panel')).toMatchObject({
      error: 'Test extension has no boolean space setting "size"',
    })
  })
})

describe('settings migration', () => {
  // A garage saved by version 1 of the extension: one global value and one space's.
  function oldGarage() {
    const garage = tempDir()
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ extensions: { test: { colour: 'red' } } }))
    const dir = join(garage, 'chats', 'aaaa0001')
    mkdirSync(dir, { recursive: true })
    const chat = { id: 'aaaa0001', name: 'Old', folders: [], files: [], engine: 'fake', archived: false, createdAt: '2026-01-01T00:00:00.000Z' }
    writeFileSync(join(dir, 'chat.json'), JSON.stringify({ ...chat, extensionValues: { test: { size: 'big' } } }))
    return garage
  }
  const open = (garage: string, extension: Partial<Extension>) => {
    const full: Extension = {
      id: 'test',
      name: 'Test extension',
      description: '',
      enabledByDefault: true,
      settings: [{ key: 'tint', label: 'Tint', type: 'text', default: '' }],
      spaceSettings: [{ key: 'size', label: 'Size', type: 'number', default: 1 }],
      ...extension,
    }
    const core = openCore({ garage, adapters: [createFakeAdapter(replied, 0)], defaultEngine: 'fake', machine: sandboxingMachine, extensions: [full] })
    cleanups.push(() => core.close(true))
    return core
  }
  const read = (garage: string, ...path: string[]) => JSON.parse(readFileSync(join(garage, ...path), 'utf8'))

  it('runs once at load on the global values and each space’s, then saves them with the new version', () => {
    const garage = oldGarage()
    const calls: unknown[] = []
    const migrateSettings = (saved: Record<string, unknown>, from: number, where: { spaceId?: string }) => {
      calls.push([saved, from, where])
      return where.spaceId ? { size: saved.size === 'big' ? 3 : 1 } : { tint: saved.colour }
    }
    const core = open(garage, { settingsVersion: 2, migrateSettings })
    expect(calls).toEqual([
      [{ colour: 'red' }, 0, {}],
      [{ size: 'big' }, 0, { spaceId: 'aaaa0001' }],
    ])
    expect(read(garage, 'settings.json')).toMatchObject({ extensions: { test: { tint: 'red' } }, extensionVersions: { test: 2 } })
    expect(read(garage, 'chats', 'aaaa0001', 'chat.json').extensionValues).toEqual({ test: { size: 3 } })
    expect(core.extensions().find((m) => m.id === 'test')).toMatchObject({ values: { tint: 'red' } })
    expect(core.extensions().find((m) => m.id === 'test')!.loadError).toBeUndefined()
    void core.close(true)
    open(garage, { settingsVersion: 2, migrateSettings })
    expect(calls).toHaveLength(2)
  })

  it('saves nothing when migrate throws, says so on the extension, and tries again next launch', () => {
    const garage = oldGarage()
    const core = open(garage, {
      settingsVersion: 2,
      migrateSettings: () => {
        throw new Error('Unknown colour')
      },
    })
    expect(core.extensions().find((m) => m.id === 'test')!.loadError).toBe("Its saved settings couldn't be updated: Unknown colour")
    expect(read(garage, 'settings.json')).toEqual({ extensions: { test: { colour: 'red' } } })
    expect(read(garage, 'chats', 'aaaa0001', 'chat.json').extensionValues).toEqual({ test: { size: 'big' } })
  })
})
