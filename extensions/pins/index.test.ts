import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startCore } from '@kothar/core/main'
import { createFakeAdapter } from '@kothar/core/fake'
import type { ClientMessage, CoreMessage } from '@kothar/core/shared'
import { sandboxingMachine } from '@kothar/core/test-machine'
import { until } from '@kothar/core/test-wait'
import { authorOf, createPinsExtension, parsePins, PINS_FILE, pinsText, toggled } from './index.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('pins.json', () => {
  it('reads pins oldest message first, skipping broken ones and repeats', () => {
    const text = JSON.stringify({
      pins: [
        { entry: 9, pinnedAt: 'b' },
        { entry: 2, pinnedAt: 'a' },
        { entry: 2, pinnedAt: 'again' },
        { entry: -1, pinnedAt: 'x' },
        { entry: 1.5, pinnedAt: 'x' },
        { entry: 3 },
        'nope',
      ],
    })
    expect(parsePins(text)).toEqual([
      { entry: 2, pinnedAt: 'a' },
      { entry: 9, pinnedAt: 'b' },
    ])
  })

  it('has no pins when the file is missing or broken', () => {
    expect(parsePins(undefined)).toEqual([])
    expect(parsePins('{oops')).toEqual([])
    expect(parsePins('{"pins": 3}')).toEqual([])
  })

  it('round-trips', () => {
    const pins = [{ entry: 4, pinnedAt: '2026-01-01T00:00:00.000Z' }]
    expect(parsePins(pinsText(pins))).toEqual(pins)
  })

  it('toggles a pin on and off, keeping message order', () => {
    const now = new Date('2026-02-03T04:05:06.000Z')
    const one = toggled([{ entry: 7, pinnedAt: 'x' }], 3, now)
    expect(one).toEqual([
      { entry: 3, pinnedAt: now.toISOString() },
      { entry: 7, pinnedAt: 'x' },
    ])
    expect(toggled(one, 3, now)).toEqual([{ entry: 7, pinnedAt: 'x' }])
  })

  it('names who wrote a message', () => {
    expect([authorOf('user'), authorOf('talk'), authorOf('work')]).toEqual(['You', 'Agent', 'Worker report'])
  })
})

async function core() {
  const garage = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-pins-')))
  const env = { KOTHAR_ENGINE: 'fake', KOTHAR_GARAGE: garage, KOTHAR_WORK: join(garage, 'work'), KOTHAR_PORT: '0' }
  const kothar = await startCore({
    env,
    adapters: [createFakeAdapter([{ type: 'text.completed', text: 'Done **here**' }], 0)],
    extensions: [createPinsExtension()],
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
  const chat = (id: string) => kothar.core.chats().find((c) => c.id === id)!
  const create = (name = 'Space') => {
    handle({ type: 'chat.create', name })
    return kothar.core.chats().findLast((c) => c.name === name)!.id
  }
  const send = async (chatId: string, text: string) => {
    handle({ type: 'chat.send', chatId, text })
    await until(() => chat(chatId).status === 'idle' && !chat(chatId).queue.length)
  }
  const marks = (chatId: string) => {
    const listed = messages.findLast((m) => m.type === 'chat.extensions' && m.chatId === chatId)
    return listed?.type === 'chat.extensions' ? listed.messageActions?.find((a) => a.id === 'pin')?.marked : undefined
  }
  const panel = (chatId: string) => {
    const drawn = messages.findLast((m) => m.type === 'extension.panel' && m.chatId === chatId && m.panel === 'pinned')
    return drawn?.type === 'extension.panel' ? drawn.view : undefined
  }
  const pinsFile = (chatId: string) => join(garage, 'chats', chatId, PINS_FILE)
  return { garage, messages, handle, chat, create, send, marks, panel, pinsFile }
}

describe('the Pins extension', () => {
  it('offers Pin on every message and starts with an empty Pinned tab', async () => {
    const t = await core()
    const id = t.create()
    t.handle({ type: 'context.get', chatId: id })
    const listed = t.messages.findLast((m) => m.type === 'chat.extensions' && m.chatId === id)
    expect(listed).toMatchObject({
      panels: expect.arrayContaining([expect.objectContaining({ extension: 'pins', id: 'pinned', title: 'Pinned' })]),
      messageActions: [{ extension: 'pins', id: 'pin', label: 'Pin', activeLabel: 'Unpin', icon: 'pin', kinds: ['user', 'work', 'talk'], marked: [] }],
    })
    await t.handle({ type: 'extension.panel.get', chatId: id, extension: 'pins', panel: 'pinned' })
    await until(() => t.panel(id)?.type === 'empty')
  })

  it('pins and unpins messages, keeping them in a file and quoting them oldest first', async () => {
    const t = await core()
    const id = t.create()
    await t.send(id, 'First question')
    await t.send(id, 'Second question')
    const entries = t.chat(id).entries
    const asked = entries.findIndex((e) => e.type === 'user.message')
    const reply = entries.findLastIndex((e) => e.type === 'text.completed')
    await t.handle({ type: 'extension.panel.get', chatId: id, extension: 'pins', panel: 'pinned' })
    await t.handle({ type: 'extension.message.action', chatId: id, extension: 'pins', action: 'pin', entry: reply })
    await t.handle({ type: 'extension.message.action', chatId: id, extension: 'pins', action: 'pin', entry: asked })
    expect(t.marks(id)).toEqual([asked, reply])
    // Only where the message is and when it was pinned: the text stays in the log.
    const saved = readFileSync(t.pinsFile(id), 'utf8')
    expect(parsePins(saved).map((p) => p.entry)).toEqual([asked, reply])
    expect(saved).not.toContain('First question')
    await until(() => t.panel(id)?.type === 'stack')
    expect(t.panel(id)).toMatchObject({
      type: 'stack',
      children: [
        { type: 'message', entry: asked, author: 'You', text: 'First question', buttons: [{ type: 'copy', text: 'First question' }, { type: 'button', label: 'Unpin' }] },
        { type: 'message', entry: reply, author: 'Agent', text: 'Done **here**' },
      ],
    })
    // Clicking the message action again unpins.
    await t.handle({ type: 'extension.message.action', chatId: id, extension: 'pins', action: 'pin', entry: reply })
    expect(t.marks(id)).toEqual([asked])
    // So does Unpin in the tab, and the mark in the transcript goes too.
    await t.handle({ type: 'extension.panel.action', chatId: id, extension: 'pins', panel: 'pinned', action: { name: 'unpin', value: asked } })
    expect(t.marks(id)).toEqual([])
    expect(t.panel(id)).toMatchObject({ type: 'empty' })
    expect(existsSync(t.pinsFile(id))).toBe(false)
  })

  it('keeps pins per chat', async () => {
    const t = await core()
    const a = t.create('A')
    const b = t.create('B')
    await t.send(a, 'In A')
    await t.send(b, 'In B')
    const entry = t.chat(a).entries.findIndex((e) => e.type === 'user.message')
    await t.handle({ type: 'extension.message.action', chatId: a, extension: 'pins', action: 'pin', entry })
    t.handle({ type: 'context.get', chatId: b })
    expect(t.marks(a)).toEqual([entry])
    expect(t.marks(b)).toEqual([])
  })

  it('drops a pin whose message is gone, quietly', async () => {
    const t = await core()
    const id = t.create()
    await t.send(id, 'Hello')
    const entry = t.chat(id).entries.findIndex((e) => e.type === 'user.message')
    await t.handle({ type: 'extension.message.action', chatId: id, extension: 'pins', action: 'pin', entry })
    writeFileSync(t.pinsFile(id), pinsText([{ entry, pinnedAt: 'x' }, { entry: 9999, pinnedAt: 'y' }]))
    t.handle({ type: 'context.get', chatId: id })
    expect(t.marks(id)).toEqual([entry])
    expect(parsePins(readFileSync(t.pinsFile(id), 'utf8')).map((p) => p.entry)).toEqual([entry])
    expect(t.messages.some((m) => m.type === 'error')).toBe(false)
  })

  it('goes away with its tab and buttons when turned off', async () => {
    const t = await core()
    const id = t.create()
    t.handle({ type: 'extension.setEnabled', extensionId: 'pins', enabled: false })
    const listed = t.messages.findLast((m) => m.type === 'chat.extensions' && m.chatId === id)
    expect(listed).toMatchObject({ panels: [] })
    expect(listed && 'messageActions' in listed ? listed.messageActions : undefined).toBeUndefined()
  })
})
