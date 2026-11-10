import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Extension } from '@kothar/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeAdapter, type FakeStep } from './adapters/fake.ts'
import { sandboxingMachine } from './adapters/test-machine.ts'
import { openCore } from './core.ts'
import type { ClientMessage, CoreMessage, SessionOptions } from './shared.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
  if (!check()) throw new Error('timed out')
}

const replied: FakeStep[] = [{ type: 'text.completed', text: 'Done' }]

// A core on the fake engine (models fake-large and fake-small, thinking low and high) with one extension, `test`,
// that adds instructions and rewrites messages. Every session's options are kept.
async function start() {
  const garage = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-setups-')))
  cleanups.push(() => rmSync(garage, { recursive: true, force: true }))
  const extension: Extension = {
    id: 'test',
    name: 'Test extension',
    description: '',
    enabledByDefault: true,
    instructions: () => 'From the test extension',
    transformMessage: (text) => `${text} (rewritten)`,
  }
  const sessions: SessionOptions[] = []
  const prompts: string[] = []
  const base = createFakeAdapter((options) => (sessions.push(options), replied), 0)
  const adapter: typeof base = {
    ...base,
    start(machine, options, emit) {
      const session = base.start(machine, options, emit)
      return { ...session, prompt: (text, images) => (prompts.push(text), session.prompt(text, images)) }
    },
  }
  const core = openCore({ garage, adapters: [adapter], defaultEngine: 'fake', machine: sandboxingMachine, extensions: [extension] })
  cleanups.push(() => core.close(true))
  const messages: CoreMessage[] = []
  core.onMessage((m) => messages.push(m))
  const errors: string[] = []
  const handle = (m: ClientMessage) => {
    try {
      core.handle(m, () => {})
    } catch (error) {
      errors.push((error as Error).message)
    }
  }
  handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true })
  handle({ type: 'workFolder.set', path: join(garage, 'work') })
  await core.refreshEngines()
  const create = (name = 'Space') => {
    handle({ type: 'chat.create', name })
    return core.chats().findLast((c) => c.name === name)!.id
  }
  const chat = (id: string) => core.chats().find((c) => c.id === id)!
  const send = async (chatId: string, text = 'Go') => {
    handle({ type: 'chat.send', chatId, text })
    await until(() => chat(chatId).status === 'idle' && !chat(chatId).queue.length)
  }
  const save = (setup: Record<string, unknown>) => {
    handle({ type: 'setup.save', setup: setup as never })
    return core.setups().find((s) => s.name === setup.name)
  }
  return { core, garage, messages, errors, handle, create, chat, send, save, sessions, prompts }
}

describe('setups', () => {
  it('are saved as one plain file each in the garage, and removed', async () => {
    const t = await start()
    const setup = t.save({ name: 'Reviewer', engine: 'fake', model: 'fake-large', thinking: 'low', instructions: ' Review only. ' })!
    expect(setup).toEqual({ id: setup.id, name: 'Reviewer', engine: 'fake', model: 'fake-large', thinking: 'low', instructions: 'Review only.' })
    const file = join(t.garage, 'setups', `${setup.id}.json`)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      name: 'Reviewer',
      engine: 'fake',
      model: 'fake-large',
      thinking: 'low',
      instructions: 'Review only.',
    })
    expect(t.messages).toContainEqual({ type: 'setups.updated', setups: [setup] })
    t.save({ id: setup.id, name: 'Reviewer' })
    expect(t.core.setups()).toEqual([{ id: setup.id, name: 'Reviewer' }])
    t.handle({ type: 'setup.remove', id: setup.id })
    expect(existsSync(file)).toBe(false)
    expect(t.core.setups()).toEqual([])
  })

  it('refuse a missing or taken name, an unknown engine, model or extension, and a model without its engine', async () => {
    const t = await start()
    t.save({ name: 'Reviewer' })
    for (const bad of [
      { name: ' ' },
      { name: 'reviewer' },
      { name: 'A', engine: 'nope' },
      { name: 'B', engine: 'fake', model: 'fake-huge' },
      { name: 'C', model: 'fake-large' },
      { name: 'D', thinking: 'loud' },
      { name: 'E', extensionsOff: ['nope'] },
    ]) {
      t.handle({ type: 'setup.save', setup: bad as never })
    }
    expect(t.errors).toEqual([
      'A setup needs a name',
      'A setup named "reviewer" already exists',
      'Unknown engine "nope". Pick one of: fake',
      'Engine "fake" offers no model "fake-huge"',
      'A setup with a model needs its engine',
      'Unknown thinking level "loud"',
      'Unknown extension "nope"',
    ])
    expect(t.core.setups().map((s) => s.name)).toEqual(['Reviewer'])
  })

  it("skip a file that isn't a setup", async () => {
    const t = await start()
    t.save({ name: 'Good' })
    writeFileSync(join(t.garage, 'setups', 'broken.json'), '{ not json')
    writeFileSync(join(t.garage, 'setups', 'nameless.json'), '{}')
    expect(t.core.setups().map((s) => s.name)).toEqual(['Good'])
  })

  it("run a chat on the setup's model and thinking level from its next message, shown as its run", async () => {
    const t = await start()
    const id = t.create()
    await t.send(id)
    expect(t.sessions.at(-1)).toMatchObject({ model: 'fake-small', thinking: 'high' })
    const setup = t.save({ name: 'Big', engine: 'fake', model: 'fake-large', thinking: 'low' })!
    t.handle({ type: 'chat.setSetup', chatId: id, setup: 'big' })
    expect(t.chat(id)).toMatchObject({ setup: setup.id, run: { engine: 'fake', model: 'fake-large', thinking: 'low' } })
    await t.send(id)
    expect(t.sessions.at(-1)).toMatchObject({ model: 'fake-large', thinking: 'low' })
    t.handle({ type: 'chat.setSetup', chatId: id })
    expect(t.chat(id).setup).toBeUndefined()
    await t.send(id)
    expect(t.sessions.at(-1)).toMatchObject({ model: 'fake-small', thinking: 'high' })
  })

  it("lose to the chat's own model and thinking picks", async () => {
    const t = await start()
    const id = t.create()
    t.save({ name: 'Big', engine: 'fake', model: 'fake-large', thinking: 'low' })
    t.handle({ type: 'chat.setSetup', chatId: id, setup: 'Big' })
    t.handle({ type: 'chat.setModel', chatId: id, thinking: 'high' })
    expect(t.chat(id)).toMatchObject({ thinking: 'high', run: { model: 'fake-large', thinking: 'high' } })
    t.handle({ type: 'chat.setModel', chatId: id, engine: 'fake', model: 'fake-small', thinking: 'high' })
    expect(t.chat(id)).toMatchObject({ model: 'fake-small', run: { model: 'fake-small', thinking: 'high' } })
    // Picking what the setup runs follows the setup again.
    t.handle({ type: 'chat.setModel', chatId: id, engine: 'fake', model: 'fake-large', thinking: 'low' })
    expect(t.chat(id).model).toBeUndefined()
    expect(t.chat(id).thinking).toBeUndefined()
  })

  it('apply an edit on the next message, and leave chats on Settings once removed', async () => {
    const t = await start()
    const id = t.create()
    const setup = t.save({ name: 'Big', engine: 'fake', model: 'fake-large' })!
    t.handle({ type: 'chat.setSetup', chatId: id, setup: setup.id })
    t.save({ id: setup.id, name: 'Big', engine: 'fake', model: 'fake-small', thinking: 'low' })
    expect(t.chat(id).run).toEqual({ engine: 'fake', model: 'fake-small', thinking: 'low' })
    t.handle({ type: 'setup.remove', id: setup.id })
    expect(t.chat(id).setup).toBeUndefined()
    expect(t.chat(id).run).toEqual({ engine: 'fake', model: 'fake-small', thinking: 'high' })
  })

  it('refuse an unknown setup on a chat, naming the ones there are', async () => {
    const t = await start()
    const id = t.create()
    t.handle({ type: 'chat.setSetup', chatId: id, setup: 'Nope' })
    t.save({ name: 'Big' })
    t.handle({ type: 'chat.setSetup', chatId: id, setup: 'Nope' })
    expect(t.errors).toEqual(['Unknown setup "Nope". There are no setups.', 'Unknown setup "Nope". The setups are "Big".'])
  })

  it('add their instructions after the extensions’ and before the context items', async () => {
    const t = await start()
    writeFileSync(join(t.garage, 'AGENTS.md'), 'Global rules')
    const id = t.create()
    t.save({ name: 'Reviewer', instructions: 'Review only, never edit.' })
    t.handle({ type: 'chat.setSetup', chatId: id, setup: 'Reviewer' })
    await t.send(id)
    const text = t.sessions.at(-1)!.instructions
    const at = (part: string) => text.indexOf(part)
    expect(at('Instructions from the setup "Reviewer":\n\nReview only, never edit.')).toBeGreaterThan(at('From the test extension'))
    expect(at('Global rules')).toBeGreaterThan(at('Review only'))
  })

  it("leave the extensions they switch off out of their chats' sessions only", async () => {
    const t = await start()
    const plain = t.create('Plain')
    const quiet = t.create('Quiet')
    t.save({ name: 'Quiet', extensionsOff: ['test'] })
    t.handle({ type: 'chat.setSetup', chatId: quiet, setup: 'Quiet' })
    await t.send(quiet, 'Hello')
    expect(t.sessions.at(-1)!.instructions).not.toContain('From the test extension')
    expect(t.prompts.at(-1)).not.toContain('(rewritten)')
    await t.send(plain, 'Hello')
    expect(t.sessions.at(-1)!.instructions).toContain('From the test extension')
    expect(t.prompts.at(-1)).toContain('Hello (rewritten)')
  })
})
