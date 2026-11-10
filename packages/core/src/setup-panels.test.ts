import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Extension } from '@kothar/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeAdapter } from './adapters/fake.ts'
import { sandboxingMachine } from './adapters/test-machine.ts'
import { openCore } from './core.ts'
import type { ClientMessage, CoreMessage } from './shared.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

// A core on the fake engine with one extension, `test`, that has its own chat, a panel and a command.
async function start() {
  const garage = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-setup-panels-')))
  cleanups.push(() => rmSync(garage, { recursive: true, force: true }))
  const ran: string[] = []
  const extension: Extension = {
    id: 'test',
    name: 'Test extension',
    description: '',
    enabledByDefault: true,
    chats: [{ id: 'own', name: 'Own', instructions: 'Role of the own chat' }],
    panels: [{ id: 'board', title: 'Board', render: () => ({ type: 'text', text: 'On the board' }) }],
    commands: [{ id: 'poke', label: 'Poke', run: (chat) => void ran.push(chat.id) }],
  }
  const core = openCore({
    garage,
    adapters: [createFakeAdapter(() => [])],
    defaultEngine: 'fake',
    machine: sandboxingMachine,
    extensions: [extension],
  })
  cleanups.push(() => core.close(true))
  const messages: CoreMessage[] = []
  core.onMessage((m) => messages.push(m))
  const replies: CoreMessage[] = []
  const handle = (m: ClientMessage) => core.handle(m, (answer) => replies.push(answer))
  handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true })
  await core.refreshEngines()
  const create = (name: string) => {
    handle({ type: 'chat.create', name })
    return core.chats().findLast((c) => c.name === name)!.id
  }
  // What the chat's panel tabs and commands are, as the UI last heard them (asked for, or sent on a change).
  const shown = (chatId: string) => {
    const last = [...replies, ...messages].filter(
      (m): m is Extract<CoreMessage, { type: 'chat.extensions' }> => m.type === 'chat.extensions' && m.chatId === chatId,
    )
    return last.length ? { panels: last.at(-1)!.panels.map((p) => p.id), commands: last.at(-1)!.commands.map((c) => c.id) } : undefined
  }
  const asked = (chatId: string) => {
    replies.length = 0
    messages.length = 0
    handle({ type: 'context.get', chatId })
    return shown(chatId)
  }
  const save = (setup: Record<string, unknown>) => {
    handle({ type: 'setup.save', setup: setup as never })
    return core.setups().find((s) => s.name === setup.name)!
  }
  return { core, messages, replies, handle, create, shown, asked, save, ran }
}

const all = { panels: ['board'], commands: ['poke'] }
const none = { panels: [], commands: [] }

describe("a setup's extensions in a chat's panels and commands", () => {
  it('leave out the panels and commands of the extensions the setup leaves out, in its chats only', async () => {
    const t = await start()
    const plain = t.create('Plain')
    const quiet = t.create('Quiet')
    t.save({ name: 'Quiet', extensionsOff: ['test'] })
    t.handle({ type: 'chat.setSetup', chatId: quiet, setup: 'Quiet' })
    expect(t.asked(quiet)).toEqual(none)
    expect(t.asked(plain)).toEqual(all)
  })

  it('refuse a left-out panel or command asked for by hand', async () => {
    const t = await start()
    const quiet = t.create('Quiet')
    t.save({ name: 'Quiet', extensionsOff: ['test'] })
    t.handle({ type: 'chat.setSetup', chatId: quiet, setup: 'Quiet' })
    const leftOut = 'Test extension is left out of this chat by its setup'
    expect(() => t.handle({ type: 'extension.command', chatId: quiet, extension: 'test', command: 'poke' })).toThrow(leftOut)
    expect(() => t.handle({ type: 'extension.panel.get', chatId: quiet, extension: 'test', panel: 'board' })).toThrow(leftOut)
    expect(t.ran).toEqual([])
  })

  it('are sent again when the chat picks a setup, the setup changes, or the setup is deleted', async () => {
    const t = await start()
    const quiet = t.create('Quiet')
    const setup = t.save({ name: 'Quiet' })
    t.messages.length = 0
    t.handle({ type: 'chat.setSetup', chatId: quiet, setup: 'Quiet' })
    expect(t.shown(quiet)).toEqual(all)
    t.save({ id: setup.id, name: 'Quiet', extensionsOff: ['test'] })
    expect(t.shown(quiet)).toEqual(none)
    t.handle({ type: 'setup.remove', id: setup.id })
    expect(t.shown(quiet)).toEqual(all)
    t.save({ name: 'Other', extensionsOff: ['test'] })
    t.handle({ type: 'chat.setSetup', chatId: quiet, setup: 'Other' })
    expect(t.shown(quiet)).toEqual(none)
    t.handle({ type: 'chat.setSetup', chatId: quiet })
    expect(t.shown(quiet)).toEqual(all)
  })

  it("keep an extension's panels and commands in its own chat", async () => {
    const t = await start()
    t.save({ name: 'Quiet', extensionsOff: ['test'] })
    t.handle({ type: 'chat.setSetup', chatId: 'own', setup: 'Quiet' })
    expect(t.asked('own')).toEqual(all)
    t.handle({ type: 'extension.command', chatId: 'own', extension: 'test', command: 'poke' })
    expect(t.ran).toEqual(['own'])
  })
})
