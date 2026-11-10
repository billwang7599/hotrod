import { describe, expect, it } from 'vitest'
import type { ChatEntry, CoreMessage } from '@kothar/core/shared'
import { createNotifier, DEFAULT_NOTIFICATIONS, excerpt, merged, type NotificationPrefs, type Seen } from './notifications.ts'
import type { ChatView } from './state.ts'

const chat = (id: string, name: string, parent?: string): ChatView => ({
  id,
  name,
  engine: 'fake',
  folders: [],
  files: [],
  archived: false,
  createdAt: '2026-11-10T00:00:00Z',
  status: 'running',
  items: [],
  draft: '',
  queue: [],
  ...(parent && { parentId: parent, worker: true }),
})

const chats = [chat('a', 'Alpha'), chat('b', 'Beta'), chat('w', 'Fixer', 'a'), chat('main', 'Home')]
const away: Seen = { chats, selectedId: 'a', looking: false }
const here: Seen = { ...away, looking: true }

type Unstamped = ChatEntry extends infer E ? (E extends ChatEntry ? Omit<E, 'at'> : never) : never
const entry = (chatId: string, e: Unstamped): CoreMessage =>
  ({ type: 'chat.entry', chatId, entry: { at: '2026-11-10T00:00:01Z', ...e } }) as CoreMessage
const reply = (chatId: string, text: string) => entry(chatId, { type: 'text.completed', text })
const done = (chatId: string, error?: string) => entry(chatId, { type: 'turn.completed', ...(error && { error }) })
const asks = (chatId: string) =>
  entry(chatId, {
    type: 'permission.requested',
    requestId: 'r1',
    name: 'Bash',
    kind: 'shell',
    summary: 'npm test',
    command: 'npm test',
    input: {},
  })

// A notifier on a hand-run timer: flush() fires the burst's timer.
function harness(prefs: Partial<NotificationPrefs> = {}) {
  const shown: { title: string; body: string; open?: string }[] = []
  let pending: (() => void) | undefined
  const notifier = createNotifier((s) => shown.push(s), {
    timer: { set: (run) => ((pending = run), 1), clear: () => (pending = undefined) },
    settings: () => ({ ...DEFAULT_NOTIFICATIONS, ...prefs }),
  })
  const flush = () => {
    const run = pending
    pending = undefined
    run?.()
  }
  return { shown, notifier, flush }
}

describe('notifications', () => {
  it('tell of a space finishing while the window is away, with its last reply', () => {
    const t = harness()
    t.notifier.observe(reply('b', 'All tests pass.\n\nShipped it.'), away)
    t.notifier.observe(done('b'), away)
    t.flush()
    expect(t.shown).toEqual([{ title: 'Beta', body: 'All tests pass. Shipped it.', open: 'b' }])
  })

  it('never tell of a worker finishing, but do of its error and its requests, opening its space', () => {
    const t = harness()
    t.notifier.observe(done('w'), away)
    t.flush()
    expect(t.shown).toEqual([])
    t.notifier.observe(entry('w', { type: 'turn.started' }), away)
    t.notifier.observe(done('w', 'API Error: 500'), away)
    t.flush()
    expect(t.shown).toEqual([{ title: 'Alpha: Fixer', body: 'API Error: 500', open: 'a' }])
  })

  it('say nothing of a turn the user stopped, or of a session ending after its turn', () => {
    const t = harness()
    t.notifier.observe(done('b', 'Interrupted'), away)
    t.notifier.observe(done('a'), away)
    t.notifier.observe(entry('a', { type: 'session.ended', error: 'exit 1' }), away)
    t.flush()
    expect(t.shown).toEqual([{ title: 'Alpha', body: 'Finished', open: 'a' }])
  })

  it('with the window in front: nothing about the open space or its workers, nothing finished, but another space asking', () => {
    const t = harness()
    t.notifier.observe(asks('a'), here)
    t.notifier.observe(asks('w'), here)
    t.notifier.observe(done('b'), here)
    t.flush()
    expect(t.shown).toEqual([])
    t.notifier.observe(asks('b'), here)
    t.flush()
    expect(t.shown).toEqual([{ title: 'Beta', body: 'Asks to npm test', open: 'b' }])
  })

  it('turn a burst into one, opening the most urgent', () => {
    const t = harness()
    t.notifier.observe(done('a'), away)
    t.notifier.observe(done('main'), away)
    t.notifier.observe(asks('b'), away)
    t.flush()
    expect(t.shown).toEqual([{ title: '3 updates in Kothar', body: 'Alpha, Home, Beta', open: 'b' }])
  })

  it('keep the more urgent of two about one chat: a hold after an error asks instead', () => {
    const t = harness()
    t.notifier.observe(done('b', 'Connection error'), away)
    t.notifier.observe(
      { type: 'chat.waits', chatId: 'b', waits: [{ extension: 'reconnect', text: 'Offline: will continue', buttons: [] }] },
      away,
    )
    t.flush()
    expect(t.shown).toEqual([{ title: 'Beta', body: 'Offline: will continue', open: 'b' }])
  })

  it('tell of a wait only when it is new', () => {
    const t = harness()
    const waiting = { ...away, chats: chats.map((c) => (c.id === 'b' ? { ...c, waits: [{ extension: 'x', text: 'Log in', buttons: [] }] } : c)) }
    t.notifier.observe({ type: 'chat.waits', chatId: 'b', waits: [{ extension: 'x', text: 'Log in', buttons: [] }] }, waiting)
    t.flush()
    expect(t.shown).toEqual([])
  })

  it('follow the settings: all off, or one kind off', () => {
    const off = harness({ enabled: false })
    off.notifier.observe(asks('b'), away)
    off.notifier.observe({ type: 'notify', extension: 'x', title: 'Hi', body: '' }, away)
    off.flush()
    expect(off.shown).toEqual([])
    const noFinished = harness({ finished: false })
    noFinished.notifier.observe(done('b'), away)
    noFinished.notifier.observe(done('a', 'Boom'), away)
    noFinished.flush()
    expect(noFinished.shown).toEqual([{ title: 'Alpha', body: 'Boom', open: 'a' }])
  })

  it("show an extension's own, opening the chat it names", () => {
    const t = harness()
    t.notifier.observe({ type: 'notify', extension: 'reconnect', title: 'Reconnect gave up', body: 'Still offline', chatId: 'w' }, away)
    t.notifier.observe({ type: 'notify', extension: 'x', title: 'Updated', body: '' }, away)
    t.flush()
    expect(t.shown).toEqual([{ title: '2 notifications', body: 'Reconnect gave up, Updated', open: 'a' }])
  })

  it('cut long lines', () => {
    expect(excerpt('a'.repeat(200))).toHaveLength(140)
    expect(merged([{ kind: 'finished', title: 'A', body: 'x' }])).toEqual({ title: 'A', body: 'x' })
  })
})
