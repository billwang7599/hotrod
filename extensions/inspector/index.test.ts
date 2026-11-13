import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Extension, ExtensionView } from '@kothar/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import { startCore } from '@kothar/core/main'
import { createFakeAdapter } from '@kothar/core/fake'
import type { ClientMessage, CoreMessage } from '@kothar/core/shared'
import { sandboxingMachine } from '@kothar/core/test-machine'
import { until } from '@kothar/core/test-wait'
import { createInspectorExtension, parseTurns, SENT_FILE, TEXT_DIR, tokensOf, turnsByEntry } from './index.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

// An extension that sends a named prompt, as the built-in ones do.
const prompted: Extension = {
  id: 'prompted',
  name: 'Prompted',
  description: '',
  enabledByDefault: true,
  prompts: [{ id: 'tone', label: 'How to sound', text: 'Be brief.', where: 'instructions' }],
  instructions: (_session, { host }) => host.prompt('tone'),
}

async function core() {
  const garage = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-inspector-')))
  const env = { KOTHAR_ENGINE: 'fake', KOTHAR_GARAGE: garage, KOTHAR_WORK: join(garage, 'work'), KOTHAR_PORT: '0' }
  const kothar = await startCore({
    env,
    adapters: [createFakeAdapter([{ type: 'text.completed', text: 'Done' }], 0)],
    extensions: [createInspectorExtension(), prompted],
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
  const chat = (id: string) => kothar.core.chats().find((c) => c.id === id)
  const create = (name = 'Space') => {
    handle({ type: 'chat.create', name })
    return kothar.core.chats().findLast((c) => c.name === name)!.id
  }
  const send = async (chatId: string, text: string) => {
    handle({ type: 'chat.send', chatId, text })
    await until(() => chat(chatId)!.status === 'idle' && !chat(chatId)!.queue.length)
  }
  // A chat's storage is the chat's own folder.
  const storeDir = (chatId: string) => join(garage, 'chats', chatId)
  const turns = (chatId: string) => parseTurns(readFileSync(join(storeDir(chatId), SENT_FILE), 'utf8'))
  const texts = (chatId: string) => readdirSync(join(storeDir(chatId), TEXT_DIR))
  const text = (chatId: string, hash: string) => readFileSync(join(storeDir(chatId), TEXT_DIR, `${hash}.txt`), 'utf8')
  const panel = (chatId: string, id: string) => {
    const drawn = messages.findLast((m) => m.type === 'extension.panel' && m.chatId === chatId && m.panel === id)
    return drawn?.type === 'extension.panel' ? drawn.view : undefined
  }
  // A message detail as the UI asks for it when the user unfolds the row.
  const detail = async (chatId: string, entry: number) => {
    await kothar.core.handle({ type: 'extension.detail.get', chatId, extension: 'inspector', detail: 'sent', entry }, (r) => messages.push(r))
    const drawn = messages.findLast((m) => m.type === 'extension.detail' && m.chatId === chatId && m.entry === entry)
    return drawn?.type === 'extension.detail' ? drawn : undefined
  }
  const listed = (chatId: string) => {
    handle({ type: 'context.get', chatId })
    const found = messages.findLast((m) => m.type === 'chat.extensions' && m.chatId === chatId)
    return found?.type === 'chat.extensions' ? found : undefined
  }
  return { garage, messages, handle, chat, create, send, turns, texts, text, panel, detail, listed }
}

const find = (view: ExtensionView | undefined, match: (v: ExtensionView) => boolean): ExtensionView[] => {
  if (!view) return []
  const children =
    'children' in view && Array.isArray(view.children) ? view.children : view.type === 'split' ? [view.side, view.main] : []
  return [...(match(view) ? [view] : []), ...children.flatMap((child) => find(child, match))]
}

describe('the Inspector', () => {
  it('records each turn in labelled sections, in order, with the edited text when a prompt is changed', async () => {
    const t = await core()
    const id = t.create()
    await t.send(id, 'Hello there')
    let [turn] = t.turns(id)
    expect(turn).toMatchObject({ engine: 'fake', continued: false, chat: { id } })
    const sources = turn!.sections.map((s) => s.source)
    expect(sources[0]).toBe('core')
    expect(sources.indexOf('extension')).toBeLessThan(sources.indexOf('you'))
    expect(sources.at(-1)).toBe('engine')
    const mine = turn!.sections.find((s) => s.extension === 'prompted')!
    expect(mine).toMatchObject({ label: 'Prompted: instructions', extensionName: 'Prompted', editable: true, prompts: [{ id: 'tone', edited: false }] })
    expect(t.text(id, mine.hash)).toBe('Be brief.')
    expect(t.text(id, turn!.sections.find((s) => s.source === 'you')!.hash)).toBe('Hello there')
    expect(turn!.sections.at(-1)!.label).toContain('not visible to Kothar')

    t.handle({ type: 'extension.prompt.set', extensionId: 'prompted', promptId: 'tone', text: 'Be thorough.' })
    await t.send(id, 'Again')
    turn = t.turns(id).at(-1)
    const edited = turn!.sections.find((s) => s.extension === 'prompted')!
    expect(edited.prompts).toEqual([{ id: 'tone', label: 'How to sound', edited: true }])
    expect(t.text(id, edited.hash)).toBe('Be thorough.')
  })

  it('keeps only the latest turns, and each distinct text once', async () => {
    const t = await core()
    t.handle({ type: 'extension.setValue', extensionId: 'inspector', key: 'keep', value: 2 })
    const id = t.create()
    for (const text of ['one', 'two', 'three', 'four']) await t.send(id, text)
    const turns = t.turns(id)
    expect(turns).toHaveLength(2)
    const hashes = new Set(turns.flatMap((turn) => turn.sections.map((s) => `${s.hash}.txt`)))
    // Every file is used, and every used text has one file: the shared instructions aren't stored twice.
    expect(new Set(t.texts(id))).toEqual(hashes)
    const instructions = turns.map((turn) => turn.sections.find((s) => s.extension === 'prompted')!.hash)
    expect(instructions[0]).toBe(instructions[1])
    // Sent as Kothar sends a message that follows others: after the conversation so far.
    expect(turns.flatMap((turn) => turn.sections.filter((s) => s.source === 'you').map((s) => t.text(id, s.hash)))).toEqual([
      'New message from the user:\n\nthree',
      'New message from the user:\n\nfour',
    ])
  })

  it("goes with the chat's folder when the chat is deleted", async () => {
    const t = await core()
    const id = t.create()
    await t.send(id, 'Hello')
    expect(t.turns(id)).toHaveLength(1)
    t.handle({ type: 'chat.delete', chatId: id })
    await until(() => !t.chat(id))
    expect(existsSync(join(t.garage, 'chats', id))).toBe(false)
  })

  it('records nothing while it is off, and nothing is built for it', async () => {
    const t = await core()
    const id = t.create()
    t.handle({ type: 'extension.setEnabled', extensionId: 'inspector', enabled: false })
    await t.send(id, 'Hello')
    expect(existsSync(join(t.garage, 'chats', id, SENT_FILE))).toBe(false)
    t.handle({ type: 'extension.setEnabled', extensionId: 'inspector', enabled: true })
    await t.send(id, 'Again')
    expect(t.turns(id)).toHaveLength(1)
  })

  it('folds what each message was sent with under it, labelled, with Edit links, Copy all and the engine part marked', async () => {
    const t = await core()
    const id = t.create()
    await t.send(id, 'First')
    await t.send(id, 'Second')
    const users = t.chat(id)!.entries.flatMap((e, i) => (e.type === 'user.message' ? [i] : []))
    const listed = t.listed(id)!
    // A folded row on each of the user's messages, and no Sent tab, beside-the-chat view or eye button.
    expect(listed.messageDetails).toEqual([
      { extension: 'inspector', id: 'sent', label: 'What was sent', hint: expect.any(String), kinds: ['user'], entries: users },
    ])
    expect(listed.panels.filter((p) => p.extension === 'inspector').map((p) => p.id)).toEqual(['activity'])
    expect(listed.messageActions?.some((a) => a.extension === 'inspector')).toBeFalsy()
    // Nothing is drawn until a row is opened.
    expect(t.messages.some((m) => m.type === 'extension.detail')).toBe(false)

    const view = (await t.detail(id, users[0]!))!.view
    const codes = find(view, (v) => v.type === 'code').map((v) => (v as { text: string }).text)
    expect(codes).toContain('First')
    expect(codes.some((code) => code.includes('Second'))).toBe(false)
    expect(find(view, (v) => v.type === 'text' && v.text.includes('turn 1 of 2'))).toHaveLength(1)
    const links = find(view, (v) => v.type === 'link') as { text: string; url: string }[]
    expect(links).toContainEqual({ type: 'link', text: 'Edit “How to sound”', url: 'kothar:settings/extension:prompted#prompt-prompted-tone' })
    const cards = find(view, (v) => v.type === 'card') as Extract<ExtensionView, { type: 'card' }>[]
    expect(cards.find((c) => c.badges?.some((b) => b.text === 'Engine-added, not visible'))).toBeDefined()
    expect(cards.find((c) => c.title === 'Prompted: instructions')!.badges![0]).toMatchObject({ text: 'Prompted' })
    const copy = find(view, (v) => v.type === 'copy')[0] as { text: string }
    expect(copy.text).toContain('### Prompted: instructions\n\nBe brief.')

    const second = (await t.detail(id, users[1]!))!.view
    expect(find(second, (v) => v.type === 'code').map((v) => (v as { text: string }).text)).toContain('New message from the user:\n\nSecond')
    // A reply isn't a message it offers the row on.
    const reply = t.chat(id)!.entries.findIndex((e) => e.type === 'text.completed')
    expect((await t.detail(id, reply))!.error).toContain('isn’t offered on that message')
  })

  it('gives no row to a message older than the turns it keeps', async () => {
    const t = await core()
    t.handle({ type: 'extension.setValue', extensionId: 'inspector', key: 'keep', value: 1 })
    const id = t.create()
    await t.send(id, 'Old')
    await t.send(id, 'New')
    const users = t.chat(id)!.entries.flatMap((e, i) => (e.type === 'user.message' ? [i] : []))
    expect(t.listed(id)!.messageDetails![0]!.entries).toEqual([users[1]])
    expect((await t.detail(id, users[0]!))!.view).toMatchObject({ type: 'empty' })
  })

  it('matches each message to the turn it went out in: a queued or a steered one too, and one message a turn', () => {
    const turns = [
      { turn: 'a', at: '2026-01-01T00:00:01Z', continued: false, sections: [{ hash: 'first', source: 'you', part: 'prompt', label: '', chars: 1 }] },
      {
        turn: 'b',
        at: '2026-01-01T00:00:05Z',
        continued: false,
        sections: [
          { hash: 'queued', source: 'you', part: 'prompt', label: '', chars: 1 },
          { hash: 'steer', at: '2026-01-01T00:00:06Z', source: 'you', part: 'prompt', label: '', chars: 3 },
        ],
      },
      // A turn no message of the user's started (a worker's report, say).
      { turn: 'c', at: '2026-01-01T00:00:10Z', continued: false, sections: [{ hash: 'report', source: 'core', part: 'prompt', label: '', chars: 1 }] },
    ] as unknown as Parameters<typeof turnsByEntry>[0]
    const texts: Record<string, string> = { first: 'one', queued: 'New message from the user:\n\ntwo', steer: 'and this', report: 'A report' }
    const found = turnsByEntry(
      turns,
      [
        { entry: 0, at: '2026-01-01T00:00:00Z', text: 'older, not kept' },
        { entry: 1, at: '2026-01-01T00:00:00Z', text: 'one' },
        // Queued while a ran: sent before b started.
        { entry: 2, at: '2026-01-01T00:00:03Z', text: 'two' },
        { entry: 3, at: '2026-01-01T00:00:07Z', text: 'and this' },
      ],
      (hash) => texts[hash] ?? '',
    )
    expect(Object.fromEntries([...found].map(([entry, turn]) => [entry, turn.turn]))).toEqual({ 1: 'a', 2: 'b', 3: 'b' })
    expect(tokensOf(9)).toBe(3)
  })
})
