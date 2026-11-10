import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Extension } from '@kothar/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeAdapter } from './adapters/fake.ts'
import { sandboxingMachine } from './adapters/test-machine.ts'
import { openCore } from './core.ts'
import type { Adapter, ClientMessage, CoreMessage, SessionOptions } from './shared.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const extension: Extension = {
  id: 'test',
  name: 'Test extension',
  description: '',
  enabledByDefault: true,
  panels: [{ id: 'board', title: 'Board', render: () => ({ type: 'text', text: 'On the board' }) }],
  commands: [{ id: 'poke', label: 'Poke', run: () => {} }],
}

const until = async (done: () => boolean) => {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(done()).toBe(true)
}

function open(garage: string) {
  const sessions: SessionOptions[] = []
  const fake = createFakeAdapter(() => [{ type: 'text.completed', text: 'Done' }], 0)
  const adapter: Adapter = { ...fake, start: (machine, options, emit) => (sessions.push(options), fake.start(machine, options, emit)) }
  const core = openCore({ garage, adapters: [adapter], defaultEngine: 'fake', machine: sandboxingMachine, extensions: [extension] })
  cleanups.push(() => core.close(true))
  const messages: CoreMessage[] = []
  core.onMessage((m) => messages.push(m))
  const handle = (m: ClientMessage) => core.handle(m, (answer) => messages.push(answer))
  handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true })
  handle({ type: 'workFolder.set', path: join(garage, 'work') })
  // The panels of a chat as the UI last heard them.
  const panels = (chatId: string) =>
    messages
      .filter((m): m is Extract<CoreMessage, { type: 'chat.extensions' }> => m.type === 'chat.extensions' && m.chatId === chatId)
      .at(-1)
      ?.panels.map((p) => p.id)
  const asked = (chatId: string) => {
    messages.length = 0
    handle({ type: 'context.get', chatId })
    return panels(chatId)
  }
  const save = (setup: Record<string, unknown>) => {
    handle({ type: 'setup.save', setup: setup as never })
    return core.setups().find((s) => s.name === setup.name)!
  }
  // The instructions of the chat's next session.
  const instructions = async (chatId: string) => {
    await core.refreshEngines()
    const before = sessions.length
    messages.length = 0
    handle({ type: 'chat.send', chatId, text: 'go' })
    await until(() => messages.some((m) => m.type === 'chat.status' && m.chatId === chatId && m.status === 'idle'))
    return sessions.slice(before).map((options) => options.instructions).join('\n')
  }
  return { core, messages, handle, panels, asked, save, instructions }
}

// A space with a worker below it and a worker below that one, saved as an older Kothar would have: the first worker
// with a setup of its own, which it no longer gets.
async function family() {
  const garage = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-worker-setup-')))
  cleanups.push(() => rmSync(garage, { recursive: true, force: true }))
  const first = open(garage)
  first.handle({ type: 'chat.create', name: 'Space' })
  const space = first.core.chats().findLast((c) => c.name === 'Space')!.id
  const quiet = first.save({ name: 'Quiet', extensionsOff: ['test'], instructions: 'Quiet rules' })
  const own = first.save({ name: 'Own', instructions: 'Own rules' })
  first.handle({ type: 'chat.setSetup', chatId: space, setup: 'Quiet' })
  await first.core.close(true)
  const write = (id: string, parentId: string, extra = {}) => {
    mkdirSync(join(garage, 'chats', id), { recursive: true })
    const saved = { id, name: id, parentId, worker: true, engine: 'fake', createdAt: new Date().toISOString(), ...extra }
    writeFileSync(join(garage, 'chats', id, 'chat.json'), JSON.stringify(saved))
  }
  write('sub', space, { setup: own.id })
  write('subsub', 'sub')
  return { t: open(garage), space, quiet, own, garage }
}

describe("a worker's setup", () => {
  it("is its space's, for panels and instructions, whatever setup it saved itself", async () => {
    const { t, space } = await family()
    expect(t.asked(space)).toEqual([])
    expect(t.asked('sub')).toEqual([])
    const text = await t.instructions('sub')
    expect(text).toContain('Quiet rules')
    expect(text).not.toContain('Own rules')
  })

  it('reaches a worker below a worker through its worker parent', async () => {
    const { t } = await family()
    expect(t.asked('subsub')).toEqual([])
    expect(await t.instructions('subsub')).toContain('Quiet rules')
  })

  it("follows a change to the space's setup, sent to its workers and used from their next message", async () => {
    const { t, space, own } = await family()
    t.messages.length = 0
    t.handle({ type: 'chat.setSetup', chatId: space, setup: 'Own' })
    expect(t.panels('sub')).toEqual(['board'])
    expect(t.panels('subsub')).toEqual(['board'])
    t.save({ id: own.id, name: 'Own', extensionsOff: ['test'], instructions: 'Own rules' })
    expect(t.panels('subsub')).toEqual([])
    t.handle({ type: 'setup.remove', id: own.id })
    expect(t.panels('sub')).toEqual(['board'])
    expect(t.panels('subsub')).toEqual(['board'])
    t.handle({ type: 'chat.setSetup', chatId: space, setup: 'Quiet' })
    expect(t.panels('subsub')).toEqual([])
    expect(await t.instructions('subsub')).toContain('Quiet rules')
  })

  it("can't be picked for a worker", async () => {
    const { t, garage } = await family()
    expect(() => t.handle({ type: 'chat.setSetup', chatId: 'sub', setup: 'Quiet' })).toThrow("uses its space's setup")
    expect(JSON.parse(readFileSync(join(garage, 'chats', 'subsub', 'chat.json'), 'utf8'))).not.toHaveProperty('setup')
  })
})
