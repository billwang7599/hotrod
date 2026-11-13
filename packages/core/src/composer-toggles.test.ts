import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Extension, ExtensionHost } from '@kothar/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeAdapter } from './adapters/fake.ts'
import { sandboxingMachine } from './adapters/test-machine.ts'
import { openCore } from './core.ts'
import type { ClientMessage, CoreMessage } from './shared.ts'
import { until } from './test-wait.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-toggles-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// A core on the fake engine with one extension, `test`, built from `parts`; garage reopens an earlier one's.
function start(parts: Partial<Extension>, garage = tempDir()) {
  let host: ExtensionHost | undefined
  const extension: Extension = {
    id: 'test',
    name: 'Test extension',
    description: '',
    enabledByDefault: true,
    onChatCreated: (_chat, context) => void (host = context.host),
    onStart: (context) => void (host = context.host),
    ...parts,
  }
  const base = createFakeAdapter([{ type: 'text.completed', text: 'Done' }], 0)
  const prompts: string[] = []
  const adapter: typeof base = {
    ...base,
    start(machine, options, emit) {
      const session = base.start(machine, options, emit)
      return { ...session, prompt: (text, images) => (prompts.push(text), session.prompt(text, images)) }
    },
  }
  const core = openCore({ garage, adapters: [adapter], defaultEngine: 'fake', machine: sandboxingMachine, extensions: [extension] })
  let closed = false
  const close = async () => {
    if (!closed) await core.close(true)
    closed = true
  }
  cleanups.push(close)
  const messages: CoreMessage[] = []
  core.onMessage((m) => messages.push(m))
  const replies: CoreMessage[] = []
  const handle = (m: ClientMessage) => core.handle(m, (r) => replies.push(r)) as unknown as Promise<void> | undefined
  handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true })
  handle({ type: 'workFolder.set', path: join(garage, 'work') })
  const create = (name = 'Space') => {
    handle({ type: 'chat.create', name })
    return core.chats().findLast((c) => c.name === name)!.id
  }
  const chat = (id: string) => core.chats().find((c) => c.id === id)!
  const send = async (chatId: string, text = 'Go') => {
    handle({ type: 'chat.send', chatId, text })
    await until(() => chat(chatId).status === 'idle' && !chat(chatId).queue.length)
  }
  // The toggles the UI was last told the chat has.
  const listed = (chatId: string) => {
    handle({ type: 'context.get', chatId })
    const found = replies.findLast((m) => m.type === 'chat.extensions' && m.chatId === chatId)
    return found?.type === 'chat.extensions' ? found.toggles : undefined
  }
  const flip = (chatId: string, on: boolean, toggle = 'research') =>
    handle({ type: 'extension.toggle', chatId, extension: 'test', toggle, on })
  return { core, garage, messages, handle, create, chat, send, listed, flip, prompts, close, host: () => host! }
}

const research = { id: 'research', label: 'Deep research', icon: 'search' as const, hint: 'Research the next message' }

describe('composer toggles', () => {
  it('are listed with the chat’s extensions, off unless their default says on', () => {
    const t = start({ composerToggles: [research, { id: 'web', label: 'Web', default: true }] })
    const id = t.create()
    expect(t.listed(id)).toEqual([
      { extension: 'test', id: 'research', label: 'Deep research', icon: 'search', hint: 'Research the next message', on: false },
      { extension: 'test', id: 'web', label: 'Web', on: true },
    ])
  })

  it('keep each chat’s own state, without leaking to other chats, and call onChange after saving', async () => {
    const changes: string[] = []
    const t = start({
      composerToggles: [{ ...research, onChange: (on, chat, context) => void changes.push(`${chat.name} ${on} ${context.host.toggled(chat.id, 'research')}`) }],
    })
    const a = t.create('A')
    const b = t.create('B')
    await t.flip(a, true)
    expect(t.listed(a)).toMatchObject([{ id: 'research', on: true }])
    expect(t.listed(b)).toMatchObject([{ id: 'research', on: false }])
    expect(t.host().toggled(a, 'research')).toBe(true)
    expect(t.host().toggled(b, 'research')).toBe(false)
    expect(changes).toEqual(['A true true'])
    await t.flip(a, false)
    expect(t.host().toggled(a, 'research')).toBe(false)
    expect(changes).toEqual(['A true true', 'A false false'])
  })

  it('outlive a restart', async () => {
    const t = start({ composerToggles: [research] })
    const id = t.create()
    await t.flip(id, true)
    await t.close()
    const reopened = start({ composerToggles: [research] }, t.garage)
    expect(reopened.listed(id)).toMatchObject([{ id: 'research', on: true }])
  })

  it('go from the composer while the extension is off, and come back with their state', async () => {
    const t = start({ composerToggles: [research] })
    const id = t.create()
    await t.flip(id, true)
    t.handle({ type: 'extension.setEnabled', extensionId: 'test', enabled: false })
    expect(t.listed(id)).toBeUndefined()
    await expect(t.flip(id, false)).rejects.toThrow('Test extension is off')
    t.handle({ type: 'extension.setEnabled', extensionId: 'test', enabled: true })
    expect(t.listed(id)).toMatchObject([{ id: 'research', on: true }])
  })

  it('can be set by the extension without onChange, and redraw', async () => {
    const changes: boolean[] = []
    const t = start({ composerToggles: [{ ...research, onChange: (on) => void changes.push(on) }] })
    const id = t.create()
    t.host().setToggle(id, 'research', true)
    expect(t.host().toggled(id, 'research')).toBe(true)
    expect(t.messages.findLast((m) => m.type === 'chat.extensions' && m.chatId === id)).toMatchObject({ toggles: [{ on: true }] })
    expect(changes).toEqual([])
    expect(() => t.host().toggled(id, 'nope')).toThrow('Test extension has no composer toggle "nope"')
    expect(() => t.host().setToggle(id, 'research', 'yes' as unknown as boolean)).toThrow('on or off')
  })

  it('refuse an unknown toggle, a value that isn’t on or off, and one not shown in the chat', async () => {
    const t = start({ composerToggles: [research, { id: 'hidden', label: 'Hidden', shown: () => false }] })
    const id = t.create()
    await expect(t.flip(id, true, 'nope')).rejects.toThrow('Test extension has no composer toggle "nope"')
    await expect(t.flip(id, true, 'hidden')).rejects.toThrow('has no composer toggle "hidden" here')
    await expect(t.handle({ type: 'extension.toggle', chatId: id, extension: 'test', toggle: 'research', on: 'yes' as unknown as boolean })).rejects.toThrow(
      'on or off',
    )
    expect(t.listed(id)).toEqual([expect.objectContaining({ id: 'research', on: false })])
  })

  it('leave out a broken toggle and keep the others', () => {
    const t = start({ composerToggles: [{ id: 'bad', label: 'Bad', icon: 'nope' as 'search' }, research] })
    const id = t.create()
    expect(t.listed(id)).toEqual([expect.objectContaining({ id: 'research' })])
  })

  it('can shape what a message does when it is sent, such as through transformMessage', async () => {
    const t = start({
      composerToggles: [research],
      transformMessage: (text, chat, context) => (context.host.toggled(chat.id, 'research') ? `RESEARCH: ${text}` : text),
    })
    const on = t.create('On')
    const off = t.create('Off')
    await t.flip(on, true)
    await t.send(on, 'Why is the sky blue?')
    await t.send(off, 'Why is the sky blue?')
    expect(t.prompts.filter((p) => p.includes('RESEARCH: Why is the sky blue?'))).toHaveLength(1)
  })
})
