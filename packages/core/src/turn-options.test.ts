import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Extension, ExtensionHost, TurnOptions } from '@kothar/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeAdapter, type FakeStep } from './adapters/fake.ts'
import { sandboxingMachine } from './adapters/test-machine.ts'
import { openCore } from './core.ts'
import { READ_ONLY_REASON, verdictOf } from './permissions.ts'
import type { Adapter, ClientMessage, SessionOptions } from './shared.ts'
import { until } from './test-wait.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const ask = (toolId: string, kind: 'edit' | 'shell', detail: { path?: string; command?: string }): FakeStep[] => {
  const call = { toolId, name: kind === 'edit' ? 'Edit' : 'Bash', kind, summary: detail.path ?? detail.command ?? '', input: detail }
  return [{ type: 'tool.started', ...call }, { type: 'permission', ...call, ...detail, output: 'ok' }]
}

// Each request the turn makes: an edit in the work folder (which the core allows on its own), a command that writes,
// and one that only reads.
const STEPS: FakeStep[] = [
  ...ask('e1', 'edit', { path: 'notes.md' }),
  ...ask('s1', 'shell', { command: 'touch x' }),
  ...ask('s2', 'shell', { command: 'git log --oneline' }),
  { type: 'text.completed', text: 'Done' },
]

// A core on two fake engines (alpha, beta) with extensions built from `parts`, each one's sessions' options kept.
async function start(...parts: Partial<Extension>[]) {
  const garage = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-turn-options-')))
  cleanups.push(() => rmSync(garage, { recursive: true, force: true }))
  let host: ExtensionHost | undefined
  const extensions: Extension[] = parts.map((part, i) => ({
    id: `test${i}`,
    name: `Test ${i}`,
    description: '',
    enabledByDefault: true,
    onChatCreated: (_chat, context) => void (host = context.host),
    ...part,
  }))
  const started: { engine: string; options: SessionOptions }[] = []
  const engine = (id: string): Adapter => {
    const base = { ...createFakeAdapter(STEPS, 0), id }
    return { ...base, start: (machine, options, emit) => (started.push({ engine: id, options }), base.start(machine, options, emit)) }
  }
  const core = openCore({ garage, adapters: [engine('alpha'), engine('beta')], defaultEngine: 'alpha', machine: sandboxingMachine, extensions })
  cleanups.push(() => core.close(true))
  const handle = (m: ClientMessage) => core.handle(m, () => {})
  handle({ type: 'engine.setEnabled', engine: 'alpha', enabled: true })
  handle({ type: 'engine.setEnabled', engine: 'beta', enabled: true })
  handle({ type: 'workFolder.set', path: join(garage, 'work') })
  await core.refreshEngines()
  handle({ type: 'chat.create', name: 'Space' })
  const id = core.chats().findLast((c) => c.name === 'Space')!.id
  const chat = () => core.chats().find((c) => c.id === id)!
  const send = async () => {
    handle({ type: 'chat.send', chatId: id, text: 'Go' })
    await until(() => chat().status === 'idle')
  }
  const resolved = () => chat().entries.flatMap((e) => (e.type === 'permission.resolved' ? [e.allow] : []))
  const toolOutputs = () => chat().entries.flatMap((e) => (e.type === 'tool.completed' ? [e.output] : []))
  return { core, handle, id, chat, send, started, resolved, toolOutputs, garage, host: () => host! }
}

describe('turnOptions', () => {
  it('leaves a turn as it was when no extension asks for anything', async () => {
    const t = await start({ turnOptions: () => undefined })
    await t.send()
    expect(t.resolved()).toEqual([true, true, true])
    expect(t.started[0]!.options.readOnly).toBeUndefined()
    expect(t.started[0]!.options.sandbox?.writable.length).toBeGreaterThan(0)
  })

  it('makes a turn read only: nothing writable, edits and changing commands refused, reads allowed', async () => {
    const reason = 'Plan first is on: plan, then the user approves.'
    const t = await start({ turnOptions: () => ({ readOnly: true, reason }) })
    await t.send()
    const { options } = t.started[0]!
    expect(options.readOnly).toBe(true)
    expect(options.sandbox?.writable).toEqual([])
    expect(options.sandbox?.tmpDir).toBeDefined()
    expect(t.resolved()).toEqual([false, false, true])
    expect(t.toolOutputs().slice(0, 2)).toEqual([reason, reason])
  })

  it('reads every extension: one saying read only is enough', async () => {
    const t = await start({ turnOptions: () => ({}) }, { turnOptions: () => ({ readOnly: true }) })
    await t.send()
    expect(t.resolved()).toEqual([false, false, true])
    expect(t.toolOutputs()[0]).toBe(READ_ONLY_REASON)
  })

  it('can’t be loosened by another extension’s permission policy', async () => {
    const t = await start({ onPermissionRequested: () => ({ allow: true }) }, { turnOptions: () => ({ readOnly: true }) })
    await t.send()
    expect(t.resolved()).toEqual([false, false, true])
  })

  it('has no way to loosen a turn: readOnly false is the same as nothing', async () => {
    const t = await start({ turnOptions: () => ({ readOnly: false }) as TurnOptions })
    await t.send()
    expect(t.started[0]!.options.readOnly).toBeUndefined()
    expect(t.resolved()).toEqual([true, true, true])
  })

  it('applies from the next turn: turning it off gives the turn after its usual permissions', async () => {
    let on = true
    const t = await start({ turnOptions: () => (on ? { readOnly: true } : undefined) })
    await t.send()
    on = false
    await t.send()
    expect(t.resolved()).toEqual([false, false, true, true, true, true])
    expect(t.started[1]!.options.sandbox?.writable.length).toBeGreaterThan(0)
  })

  it('shows a throwing extension’s error and runs the turn as usual', async () => {
    const t = await start({
      turnOptions: () => {
        throw new Error('broken')
      },
    })
    await t.send()
    expect(t.resolved()).toEqual([true, true, true])
  })

  it('runs the turn on its role’s list when that has models, without changing the chat’s engine', async () => {
    const t = await start({ turnOptions: () => ({ role: 'planning' }) })
    t.handle({ type: 'models.setList', role: 'chat', models: [{ engine: 'alpha', model: 'fake-small' }] })
    t.handle({ type: 'models.setList', role: 'planning', models: [{ engine: 'beta', model: 'fake-large' }] })
    await t.send()
    expect(t.started.at(-1)).toMatchObject({ engine: 'beta', options: { model: 'fake-large' } })
    expect(t.chat().engine).toBe('alpha')
  })

  it('runs on the chat’s own model when the role’s list is empty', async () => {
    const t = await start({ turnOptions: () => ({ role: 'planning' }) })
    t.handle({ type: 'models.setList', role: 'chat', models: [{ engine: 'alpha', model: 'fake-small' }] })
    await t.send()
    expect(t.started.at(-1)).toMatchObject({ engine: 'alpha', options: { model: 'fake-small' } })
  })
})

describe('verdictOf, read only', () => {
  const base = { cwd: '/w', workDir: '/w', sandboxed: true, switches: [], home: '/h', garage: '/g' }
  const request = (kind: 'edit' | 'shell' | 'read' | 'fetch', extra: object) =>
    ({ type: 'permission.requested', requestId: 'r', name: 'x', kind, summary: '', input: {}, ...extra }) as const

  it('refuses edits anywhere, even in the work folder', () => {
    expect(verdictOf(request('edit', { path: '/w/a.ts' }), { ...base, readOnly: {} })).toEqual({ allow: false, message: READ_ONLY_REASON })
    expect(verdictOf(request('edit', { path: '/w/a.ts' }), base)).toEqual({ allow: true })
  })

  it('refuses commands that may change something, with the reason given', () => {
    const readOnly = { reason: 'Plan first' }
    expect(verdictOf(request('shell', { command: 'rm -rf src' }), { ...base, readOnly })).toEqual({ allow: false, message: 'Plan first' })
    expect(verdictOf(request('shell', { command: 'npm install' }), { ...base, readOnly })?.allow).toBe(false)
    expect(verdictOf(request('shell', { command: 'git diff' }), { ...base, readOnly })).toEqual({ allow: true })
  })

  it('never allows reading a key', () => {
    expect(verdictOf(request('shell', { command: 'cat /h/.ssh/id_rsa' }), { ...base, readOnly: {} })?.allow).not.toBe(true)
  })

  it('answers reads and fetches as usual', () => {
    expect(verdictOf(request('read', { path: '/w/a.ts' }), { ...base, readOnly: {} })).toEqual({ allow: true })
    expect(verdictOf(request('fetch', {}), { ...base, readOnly: {} })).toEqual(verdictOf(request('fetch', {}), base))
  })
})
