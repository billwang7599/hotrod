import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActivityEvent, Extension, ExtensionHost, ExtensionView } from '@kothar/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import { startCore } from '@kothar/core/main'
import { createFakeAdapter, type FakeStep } from '@kothar/core/fake'
import type { ClientMessage, CoreMessage } from '@kothar/core/shared'
import { sandboxingMachine } from '@kothar/core/test-machine'
import { until } from '@kothar/core/test-wait'
import { ACTIVITY_FILE, ACTIVITY_TEXT_DIR, keptOf, MAX_EVENTS, parseEvents, type StoredEvent } from './activity.ts'
import { createInspectorExtension } from './index.ts'

// The first model the core picks for summaries (SUMMARY_MODELS in the core's models.ts).
const SUMMARY_MODEL = 'claude-haiku-5-5'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

// An extension that does things through the host on its own, as built-in ones do.
let helperHost: ExtensionHost | undefined
const helper: Extension = {
  id: 'helper',
  name: 'Helper',
  description: '',
  enabledByDefault: true,
  onStart: ({ host }) => void (helperHost = host),
  tools: [
    {
      name: 'echo_back',
      description: 'Echoes.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      offered: () => true,
      run: ({ text }) => `echo: ${String(text)}`,
    },
  ],
}

async function core(script: FakeStep[] = [{ type: 'text.completed', text: 'Done' }], extensions: Extension[] = []) {
  helperHost = undefined
  const garage = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-activity-')))
  const env = { KOTHAR_ENGINE: 'fake', KOTHAR_GARAGE: garage, KOTHAR_WORK: join(garage, 'work'), KOTHAR_PORT: '0' }
  // With a model Kothar picks for summaries, so host.complete runs.
  const fake = createFakeAdapter(script, 0)
  const adapter = { ...fake, detect: async (machine: Parameters<typeof fake.detect>[0]) => {
    const found = await fake.detect(machine)
    return { ...found, models: [...(found.models ?? []), SUMMARY_MODEL] }
  } }
  const kothar = await startCore({
    env,
    adapters: [adapter],
    extensions: [createInspectorExtension(), helper, ...extensions],
    machine: sandboxingMachine,
  })
  cleanups.push(async () => {
    await kothar.close(true)
    rmSync(garage, { recursive: true, force: true })
  })
  const messages: CoreMessage[] = []
  kothar.core.onMessage((m) => messages.push(m))
  const handle = (m: ClientMessage) => kothar.core.handle(m, (r) => messages.push(r))
  handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true })
  handle({ type: 'workFolder.set', path: join(garage, 'work') })
  await until(() => helperHost !== undefined)
  const chat = (id: string) => kothar.core.chats().find((c) => c.id === id)
  const create = (name = 'Space') => {
    handle({ type: 'chat.create', name })
    return kothar.core.chats().findLast((c) => c.name === name)!.id
  }
  const idle = (chatId: string) => until(() => chat(chatId)!.status === 'idle' && !chat(chatId)!.queue.length)
  const send = async (chatId: string, text: string) => {
    handle({ type: 'chat.send', chatId, text })
    await idle(chatId)
  }
  const events = (chatId?: string): StoredEvent[] => {
    const file = chatId ? join(garage, 'chats', chatId, ACTIVITY_FILE) : join(garage, 'extensions', 'inspector', ACTIVITY_FILE)
    return existsSync(file) ? parseEvents(readFileSync(file, 'utf8')) : []
  }
  const text = (chatId: string, hash: string) => readFileSync(join(garage, 'chats', chatId, ACTIVITY_TEXT_DIR, `${hash}.txt`), 'utf8')
  const texts = (chatId: string) => readdirSync(join(garage, 'chats', chatId, ACTIVITY_TEXT_DIR))
  const panel = (chatId: string, id: string) => {
    const drawn = messages.findLast((m) => m.type === 'extension.panel' && m.chatId === chatId && m.panel === id)
    return drawn?.type === 'extension.panel' ? drawn.view : undefined
  }
  return { garage, messages, handle, chat, create, send, idle, events, text, texts, panel, host: () => helperHost! }
}

const find = (view: ExtensionView | undefined, match: (v: ExtensionView) => boolean): ExtensionView[] => {
  if (!view) return []
  const children =
    'children' in view && Array.isArray(view.children) ? view.children : view.type === 'split' ? [view.side, view.main] : []
  return [...(match(view) ? [view] : []), ...children.flatMap((child) => find(child, match))]
}

describe('Activity', () => {
  it('lists a model call an extension makes, under its chat, with the model, what was sent and the reply', async () => {
    const t = await core()
    const id = t.create()
    const reply = await t.host().complete({ system: 'Summarize.', prompt: '<item key="a">x</item>', timeoutMs: 5000, chatId: id })
    await until(() => t.events(id).length === 1)
    const [event] = t.events(id)
    expect(event).toMatchObject({ kind: 'model', by: { extension: 'helper', name: 'Helper' }, chatId: id })
    expect(event!.model).toBeTruthy()
    expect(event!.sections!.map((s) => [s.label, t.text(id, s.hash)])).toEqual([
      ['Instructions (system)', 'Summarize.'],
      ['Prompt', '<item key="a">x</item>'],
    ])
    expect(t.text(id, event!.result!.hash)).toBe(reply)

    // A call no chat asked for is kept in the Inspector's own storage.
    await t.host().complete({ system: 'S', prompt: 'P', timeoutMs: 5000 })
    await until(() => t.events().length === 1)
    expect(t.events()[0]).toMatchObject({ kind: 'model', by: { name: 'Helper' } })
    expect(t.events()[0]!.chatId).toBeUndefined()
  })

  it('stores each distinct text once, and keeps the last turns', async () => {
    const t = await core()
    const id = t.create()
    for (const prompt of ['one', 'two', 'three']) await t.host().complete({ system: 'Same instructions.', prompt, timeoutMs: 5000, chatId: id })
    await until(() => t.events(id).length === 3)
    // One file for the shared instructions, one per prompt, and one for the shared reply.
    expect(t.texts(id)).toHaveLength(5)

    const at = (n: number) => `2026-01-01T00:00:0${n}.000Z`
    const e = (n: number, turn?: string) => ({ id: String(n), at: at(n), kind: 'model', by: { name: 'K' }, title: 't', ...(turn && { turn }) }) as StoredEvent
    const list = [e(1, 'a'), e(2, 'a'), e(3), e(4, 'b'), e(5, 'c'), e(6)]
    expect(keptOf(list, 2).map((x) => x.id)).toEqual(['4', '5', '6'])
    expect(keptOf(list, 5).map((x) => x.id)).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(keptOf(Array.from({ length: MAX_EVENTS + 5 }, (_, n) => e(n % 9)), 30)).toHaveLength(MAX_EVENTS)
  })

  it('lists every permission answer with the rule that gave it: a switch, the sandbox, an extension, or you', async () => {
    const policy: Extension = {
      id: 'policy',
      name: 'Policy',
      description: '',
      enabledByDefault: true,
      onPermissionRequested: (request) => (request.command === 'echo blocked' ? { allow: false, message: 'Not that.' } : undefined),
    }
    const step = (toolId: string, kind: 'read' | 'edit' | 'shell', more: { path?: string; command?: string }): FakeStep[] => [
      { type: 'tool.started', toolId, name: kind, kind, summary: `${kind} ${more.path ?? more.command}`, input: {} },
      { type: 'permission', toolId, name: kind, kind, summary: `${kind} ${more.path ?? more.command}`, input: {}, output: 'ok', ...more },
    ]
    const t = await core(
      [
        ...step('r', 'read', { path: 'README.md' }),
        ...step('e', 'edit', { path: '/etc/hosts' }),
        ...step('b', 'shell', { command: 'echo blocked' }),
        ...step('n', 'shell', { command: 'curl https://example.com' }),
        { type: 'text.completed', text: 'Done' },
      ],
      [policy],
    )
    const id = t.create()
    t.handle({ type: 'chat.send', chatId: id, text: 'go' })
    // The network command asks the user.
    await until(() => t.chat(id)!.status === 'waiting')
    const asked = t.chat(id)!.entries.findLast((entry) => entry.type === 'permission.requested')
    t.handle({ type: 'permission.respond', chatId: id, requestId: (asked as { requestId: string }).requestId, allow: true })
    await t.idle(id)
    const answers = t.events(id).filter((event) => event.kind === 'permission')
    expect(answers.map((a) => [a.decision, a.rule])).toEqual([
      ['allowed', 'Switch: Read anywhere without asking'],
      ['denied', 'Kothar core: the sandbox keeps edits in the work folder'],
      ['denied', 'Extension: Policy'],
      ['allowed', 'You'],
    ])
    expect(answers[2]!.detail).toContain('Told the agent: Not that.')
    expect(answers[3]!.detail).toContain('Command: curl https://example.com')
    expect(answers.every((a) => a.turn)).toBe(true)
  })

  it('lists how extensions changed a turn: read only, a toggle that was on, and a rewritten message', async () => {
    const planner: Extension = {
      id: 'planner',
      name: 'Planner',
      description: '',
      enabledByDefault: true,
      composerToggles: [{ id: 'careful', label: 'Careful', icon: 'book', hint: 'h' }],
      turnOptions: (chat, { host }) => (host.toggled(chat.id, 'careful') ? { readOnly: true, reason: 'Careful is on.' } : undefined),
      transformMessage: (text, chat, { host }) => (host.toggled(chat.id, 'careful') ? `[careful] ${text}` : text),
    }
    const t = await core(undefined, [planner])
    const id = t.create()
    t.handle({ type: 'extension.toggle', chatId: id, extension: 'planner', toggle: 'careful', on: true })
    await until(() => t.chat(id)!.toggles?.planner?.careful === true)
    await t.send(id, 'hello')
    const changes = t.events(id).filter((event) => event.kind === 'turn')
    expect(changes.map((c) => [c.by.name, c.title])).toEqual([
      ['Planner', 'Rewrote your message before it was sent'],
      ['Planner', 'Made this turn read only'],
      ['Planner', 'On for this turn: Careful'],
    ])
    expect(changes[0]!.sections!.map((s) => t.text(id, s.hash))).toEqual(['hello', '[careful] hello'])
    expect(changes[1]!.detail).toContain('Careful is on.')
  })

  it('lists quiet workers, messages, tool calls, carrying a turn on and an extension’s own events, and the space filter gathers them', async () => {
    const t = await core()
    const id = t.create()
    await t.send(id, 'first')
    const host = t.host()
    const worker = host.createChat({ name: 'Researcher', parentId: id, quiet: true })
    host.send(worker.id, 'Find the facts.')
    await until(() => t.events(id).length === 2)
    expect(await host.callTool(id, 'echo_back', { text: 'hi' })).toBe('echo: hi')
    host.activity({ kind: 'browser', chatId: id, title: 'Launched the browser', detail: 'On Kothar’s Chromium' })
    host.continue(id, 'Carry on, please.')
    await t.idle(id)
    expect(t.events(id).map((e) => [e.kind, e.title])).toEqual([
      ['worker', 'Started a quiet worker: Researcher'],
      ['worker', 'Sent Researcher a message'],
      ['tool', 'Called its own tool echo_back'],
      ['browser', 'Launched the browser'],
      ['retry', 'Carried the turn on'],
    ])
    expect(t.events(id)[2]!.result).toBeDefined()
    expect(() => host.activity({ kind: 'nope' as ActivityEvent['kind'], chatId: id, title: 'x' })).toThrow('Unknown activity kind')

    // The Activity tab: this chat, then the whole space with the worker's, labelled with where it happened.
    t.handle({ type: 'extension.panel.get', chatId: id, extension: 'inspector', panel: 'activity' })
    await until(() => t.panel(id, 'activity')?.type === 'stack')
    const titles = (view: ExtensionView | undefined) =>
      (find(view, (v) => v.type === 'card') as { title: string }[]).map((c) => c.title).filter((title) => !['Input', 'Result', 'The message', 'Sent to carry it on'].includes(title))
    expect(titles(t.panel(id, 'activity'))).toEqual([
      'Carried the turn on',
      'Launched the browser',
      'Called its own tool echo_back',
      'Sent Researcher a message',
      'Started a quiet worker: Researcher',
    ])
    // The whole space gathers what happened in chats under it, saying where.
    const child = host.createChat({ name: 'Child', parentId: id })
    host.activity({ kind: 'other', chatId: child.id, title: 'Something in the child' })
    t.handle({ type: 'extension.panel.action', chatId: id, extension: 'inspector', panel: 'activity', action: { name: 'scope', value: 'space' } })
    t.handle({ type: 'extension.panel.get', chatId: id, extension: 'inspector', panel: 'activity' })
    await until(() => titles(t.panel(id, 'activity')).includes('Something in the child'))
    expect(find(t.panel(id, 'activity'), (v) => v.type === 'text' && v.text.startsWith('Other · in Child · '))).toHaveLength(1)
  })

  it('records nothing, and builds nothing, while the Inspector is off; and goes with the chat', async () => {
    const t = await core()
    const id = t.create()
    await t.host().complete({ system: 'S', prompt: 'P', timeoutMs: 5000, chatId: id })
    await until(() => t.events(id).length === 1)
    t.handle({ type: 'chat.delete', chatId: id })
    await until(() => !existsSync(join(t.garage, 'chats', id)))

    const other = t.create('Other')
    t.handle({ type: 'extension.setEnabled', extensionId: 'inspector', enabled: false })
    await t.host().complete({ system: 'S', prompt: 'P', timeoutMs: 5000, chatId: other })
    await t.send(other, 'hello')
    expect(t.events(other)).toEqual([])
  })
})
