import { describe, expect, it } from 'vitest'
import type { ChatEntry, ChatState, ContextItem, CoreMessage } from '@hotrod/core/types'
import type { Account, EngineAccounts } from '@hotrod/core/types'
import {
  accountLabel,
  chatTree,
  COLUMN_PX,
  columnSlider,
  engineOptions,
  familyOf,
  folderName,
  folderOf,
  initialState,
  MAIN_CHAT_ID,
  modelMenu,
  reduce,
  storedColumn,
  storedFlag,
  type Action,
  type ChatView,
  type State,
} from './state.ts'

const at = '2026-11-06T00:00:00.000Z'
const engines = [{ id: 'fake', enabled: true, installed: true, signedIn: true }]
const chat = (id: string, entries: ChatEntry[] = [], change: Partial<ChatState> = {}): ChatState => ({
  id,
  name: id,
  ...(id !== MAIN_CHAT_ID && { parentId: MAIN_CHAT_ID }),
  folders: [],
  files: [],
  engine: 'fake',
  archived: false,
  createdAt: at,
  status: 'idle',
  entries,
  draft: '',
  queue: [],
  ...change,
})
const contextDefaults = { agents: true, folders: true, files: true }
const mods = { subagents: { enabled: false, limit: 4 } }
const noLists = { chat: [], planning: [], searching: [], subagents: [] }
const modelLists = { fake: noLists }
const snapshot = (chats: ChatState[]): Action =>
  ({ type: 'snapshot', engines, accounts: [], chats, contextDefaults, mods, modelLists })
type NewEntry = ChatEntry extends infer E ? (E extends unknown ? Omit<E, 'at'> : never) : never
const entry = (chatId: string, e: NewEntry): CoreMessage =>
  ({ type: 'chat.entry', chatId, entry: { at, ...e } as ChatEntry })
const run = (...actions: Action[]): State => actions.reduce(reduce, initialState)
const items = (state: State, id = 'a') => state.chats.find((c) => c.id === id)!.items

describe('reduce', () => {
  it('loads a snapshot, folding saved entries into items and selecting Main', () => {
    const state = run(
      snapshot([
        chat(MAIN_CHAT_ID),
        chat('a', [
          { at, type: 'user.message', text: 'hi' },
          { at, type: 'turn.started' },
          { at, type: 'text.completed', text: 'hello' },
          { at, type: 'tool.started', toolId: 't1', name: 'Bash', kind: 'shell', summary: 'ls', input: { command: 'ls' } },
          { at, type: 'tool.completed', toolId: 't1', output: 'README.md', isError: false },
          { at, type: 'turn.completed', error: 'boom' },
        ]),
        chat('b'),
      ]),
    )
    expect(state.engines).toEqual(engines)
    expect(state.selectedId).toBe(MAIN_CHAT_ID)
    expect(state.chats.map((c) => c.id)).toEqual([MAIN_CHAT_ID, 'a', 'b'])
    expect(items(state)).toEqual([
      { kind: 'user', text: 'hi' },
      { kind: 'text', text: 'hello' },
      { kind: 'tool', toolId: 't1', name: 'Bash', summary: 'ls', state: 'done', output: 'README.md' },
      { kind: 'error', text: 'boom' },
    ])
  })

  it('keeps the selection across a reconnect snapshot, and falls back to Main once it is gone', () => {
    const both = snapshot([chat(MAIN_CHAT_ID), chat('a'), chat('b')])
    const state = run(both, { type: 'select', chatId: 'b' }, { type: 'connection', connected: false }, both)
    expect(state.selectedId).toBe('b')
    expect(reduce(state, snapshot([chat(MAIN_CHAT_ID), chat('a')])).selectedId).toBe(MAIN_CHAT_ID)
    expect(run({ type: 'select', chatId: 'gone' }, snapshot([chat(MAIN_CHAT_ID)])).selectedId).toBe(MAIN_CHAT_ID)
  })

  it('adds a chat once and selects it, then follows its name, folders and archive flag', () => {
    const added: Action = { type: 'chat.added', chat: chat('c', [], { name: 'Build' }) }
    const state = run(
      snapshot([chat(MAIN_CHAT_ID)]),
      added,
      entry('c', { type: 'user.message', text: 'hi' }),
      { type: 'select', chatId: MAIN_CHAT_ID },
      added,
    )
    expect(state.chats.map((c) => c.id)).toEqual([MAIN_CHAT_ID, 'c'])
    expect(state.selectedId).toBe('c')
    const { status, entries, draft, queue, ...info } = chat('c')
    const change = { name: 'Renamed', folders: ['/code/app'], archived: true }
    const updated = reduce(state, { type: 'chat.updated', chat: { ...info, ...change } })
    expect(updated.chats[1]).toMatchObject({ ...change, items: [{ kind: 'user', text: 'hi' }] })
  })

  it('sets and clears a chat model and thinking level, since JSON drops the cleared field', () => {
    const { status, entries, draft, ...info } = chat('c')
    const state = run(snapshot([chat(MAIN_CHAT_ID), chat('c')]), {
      type: 'chat.updated',
      chat: { ...info, model: 'large', thinking: 'high' },
    })
    expect(state.chats[1]).toMatchObject({ model: 'large', thinking: 'high' })
    const cleared = reduce(state, { type: 'chat.updated', chat: { ...info, thinking: 'high' } })
    expect(cleared.chats[1]?.model).toBeUndefined()
    expect(cleared.chats[1]?.thinking).toBe('high')
  })

  it('removes a chat and selects the Workshop if the selection went with it', () => {
    const state = run(snapshot([chat(MAIN_CHAT_ID), chat('s'), chat('c')]), { type: 'select', chatId: 's' })
    expect(reduce(state, { type: 'chat.removed', chatId: 'c' }).selectedId).toBe('s')
    const removed = reduce(state, { type: 'chat.removed', chatId: 's' })
    expect(removed.chats.map((c) => c.id)).toEqual([MAIN_CHAT_ID, 'c'])
    expect(removed.selectedId).toBe(MAIN_CHAT_ID)
  })

  it('lists only engines that are on, keeping the chat engine when it is off or unknown', () => {
    const listed = [
      { id: 'claude-code', enabled: true, installed: true, signedIn: true },
      { id: 'pi', enabled: true, installed: true, signedIn: false },
      { id: 'codex', enabled: true, installed: false, signedIn: false },
      { id: 'fake', enabled: false, installed: true, signedIn: true },
    ]
    expect(engineOptions(listed, 'pi')).toEqual([
      { id: 'claude-code', label: 'claude-code' },
      { id: 'pi', label: 'pi (not signed in)' },
      { id: 'codex', label: 'codex (not installed)' },
    ])
    expect(engineOptions(listed, 'fake').at(-1)).toEqual({ id: 'fake', label: 'fake (off)', disabled: true })
    expect(engineOptions(listed, 'gone').at(-1)).toEqual({ id: 'gone', label: 'gone (unknown)', disabled: true })
  })

  it('replaces an engine when it is turned on or off', () => {
    const state = run(
      { type: 'snapshot', engines, accounts: [], chats: [], contextDefaults, mods, modelLists },
      { type: 'engine.updated', engine: { ...engines[0]!, enabled: false } },
    )
    expect(state.engines).toEqual([{ id: 'fake', enabled: false, installed: true, signedIn: true }])
  })

  it('loads accounts from the snapshot and replaces one engine on update', () => {
    const accounts: Account[] = [{ id: 'default', name: 'Default', kind: 'login' }]
    const fake: EngineAccounts = { engine: 'fake', active: 'default', apiKeys: true, accounts }
    const other: EngineAccounts = { ...fake, engine: 'other' }
    const work: Account = { id: 'work', name: 'Work', kind: 'login', label: 'me@work.test', signedIn: true }
    const state = run(
      { type: 'snapshot', engines, accounts: [fake, other], chats: [], contextDefaults, mods, modelLists },
      { type: 'accounts.updated', accounts: { ...fake, active: 'work', accounts: [...fake.accounts, work] } },
      { type: 'accounts.updated', accounts: { ...fake, engine: 'new' } },
    )
    expect(state.accounts.map((a) => [a.engine, a.active])).toEqual([
      ['fake', 'work'],
      ['other', 'default'],
      ['new', 'default'],
    ])
  })

  it('labels an account with its email or key ending and sign-in state', () => {
    const work: Account = { id: 'work', name: 'Work', kind: 'login', label: 'me@work.test', signedIn: true }
    expect(accountLabel(work)).toBe('Work (me@work.test)')
    expect(accountLabel({ id: 'default', name: 'Default', kind: 'login' })).toBe('Default')
    expect(accountLabel({ ...work, id: 'old', name: 'Old', signedIn: false })).toBe('Old (signed out)')
    const billing: Account = { id: 'billing', name: 'Billing', kind: 'apiKey', label: 'API key ••••abcd', signedIn: true }
    expect(accountLabel(billing)).toBe('Billing (API key ••••abcd)')
    expect(accountLabel({ ...billing, signedIn: false })).toBe('Billing (key file missing)')
  })

  it('shows a tool as waiting while its permission is pending', () => {
    const requested = run(
      snapshot([chat('a')]),
      entry('a', { type: 'tool.started', toolId: 't1', name: 'Bash', kind: 'shell', summary: '', input: {} }),
      entry('a', { type: 'permission.requested', requestId: 'r1', toolId: 't1', name: 'Bash', kind: 'shell', summary: '', input: {} }),
    )
    expect(items(requested)[0]).toMatchObject({ toolId: 't1', state: 'waiting' })
    const allowed = reduce(requested, entry('a', { type: 'permission.resolved', requestId: 'r1', allow: true }))
    expect(items(allowed)[0]).toMatchObject({ toolId: 't1', state: 'running' })
    const ended = reduce(requested, entry('a', { type: 'turn.completed' }))
    expect(items(ended)[0]).toMatchObject({ toolId: 't1', state: 'stopped' })
  })

  it('appends entries to the right chat', () => {
    const state = run(
      snapshot([chat('a'), chat('b')]),
      entry('b', { type: 'user.message', text: 'hi' }),
      entry('b', { type: 'tool.started', toolId: 't1', name: 'Edit', kind: 'edit', summary: '/x', input: { file_path: '/x' } }),
      entry('b', { type: 'tool.completed', toolId: 't1', output: 'no such file', isError: true }),
    )
    expect(items(state, 'a')).toEqual([])
    expect(items(state, 'b')).toEqual([
      { kind: 'user', text: 'hi' },
      { kind: 'tool', toolId: 't1', name: 'Edit', summary: '/x', state: 'error', output: 'no such file' },
    ])
  })

  it('accumulates deltas and clears them when the text completes', () => {
    const streaming = run(
      snapshot([chat('a')]),
      { type: 'chat.delta', chatId: 'a', text: 'Hel' },
      { type: 'chat.delta', chatId: 'a', text: 'lo' },
    )
    expect(streaming.chats[0]!.draft).toBe('Hello')
    const done = reduce(streaming, entry('a', { type: 'text.completed', text: 'Hello' }))
    expect(done.chats[0]!.draft).toBe('')
    expect(items(done)).toEqual([{ kind: 'text', text: 'Hello' }])
  })

  it('continues the draft a snapshot carries from a turn in progress', () => {
    const state = run(
      snapshot([{ ...chat('a'), status: 'running', draft: 'Hel' }]),
      { type: 'chat.delta', chatId: 'a', text: 'lo' },
    )
    expect(state.chats[0]!.draft).toBe('Hello')
  })

  it('shows the queue a snapshot carries and replaces it on every change', () => {
    const queued = [{ id: 'q1', text: 'next' }]
    const state = run(snapshot([{ ...chat('a'), status: 'running', queue: queued }]))
    expect(state.chats[0]!.queue).toEqual(queued)
    const more = reduce(state, { type: 'chat.queue', chatId: 'a', queue: [...queued, { id: 'q2', text: 'then' }] })
    expect(more.chats[0]!.queue.map((q) => q.text)).toEqual(['next', 'then'])
    expect(reduce(more, { type: 'chat.queue', chatId: 'a', queue: [] }).chats[0]!.queue).toEqual([])
  })

  it('streams thinking into the turn in order and drops it when the turn ends', () => {
    const state = run(
      snapshot([chat('a')]),
      { type: 'chat.thinking', chatId: 'a', text: 'Let me ' },
      { type: 'chat.thinking', chatId: 'a', text: 'look.' },
      entry('a', { type: 'tool.started', toolId: 't1', name: 'Bash', kind: 'shell', summary: 'ls', input: {} }),
      { type: 'chat.thinking', chatId: 'a', text: 'Found it.' },
      entry('a', { type: 'text.completed', text: 'Done' }),
    )
    expect(items(state).map((i) => (i.kind === 'thinking' ? i.text : i.kind))).toEqual([
      'Let me look.',
      'tool',
      'Found it.',
      'text',
    ])
    const ended = reduce(state, entry('a', { type: 'turn.completed' }))
    expect(items(ended).map((i) => i.kind)).toEqual(['tool', 'text'])
  })

  it('tracks chat status', () => {
    const state = run(
      snapshot([chat('a')]),
      { type: 'chat.status', chatId: 'a', status: 'running' },
    )
    expect(state.chats[0]!.status).toBe('running')
    expect(reduce(state, { type: 'chat.status', chatId: 'a', status: 'waiting' }).chats[0]!.status).toBe('waiting')
  })

  it('moves a permission from pending to resolved', () => {
    const requested = run(
      snapshot([chat('a')]),
      entry('a', { type: 'permission.requested', requestId: 'r1', name: 'Bash', kind: 'shell', summary: 'rm x', input: { command: 'rm x' } }),
    )
    expect(items(requested)).toEqual([
      { kind: 'permission', requestId: 'r1', name: 'Bash', summary: 'rm x', input: { command: 'rm x' }, outcome: 'pending' },
    ])
    const denied = reduce(requested, entry('a', { type: 'permission.resolved', requestId: 'r1', allow: false }))
    expect(items(denied)[0]).toMatchObject({ requestId: 'r1', outcome: 'denied' })
    const allowed = reduce(requested, entry('a', { type: 'permission.resolved', requestId: 'r1', allow: true }))
    expect(items(allowed)[0]).toMatchObject({ requestId: 'r1', outcome: 'allowed' })
  })

  it('stops unfinished tools and permissions when the turn ends', () => {
    const state = run(
      snapshot([chat('a')]),
      { type: 'chat.delta', chatId: 'a', text: 'half' },
      entry('a', { type: 'tool.started', toolId: 't1', name: 'Bash', kind: 'shell', summary: '', input: {} }),
      entry('a', { type: 'permission.requested', requestId: 'r1', name: 'Bash', kind: 'shell', summary: '', input: {} }),
      entry('a', { type: 'turn.completed' }),
    )
    expect(items(state).map((i) => ('state' in i ? i.state : 'outcome' in i ? i.outcome : i.kind))).toEqual([
      'stopped',
      'cancelled',
    ])
    expect(state.chats[0]!.draft).toBe('')
  })

  it('shows errors as toasts until dismissed', () => {
    const state = run({ type: 'error', message: 'a' }, { type: 'error', message: 'b' })
    expect(state.toasts.map((t) => t.message)).toEqual(['a', 'b'])
    const dismissed = reduce(state, { type: 'toast.dismiss', id: state.toasts[0]!.id })
    expect(dismissed.toasts.map((t) => t.message)).toEqual(['b'])
  })

  it('tracks the connection', () => {
    expect(initialState.connected).toBe(false)
    expect(run({ type: 'connection', connected: true }).connected).toBe(true)
  })

  it('remembers that the core rejected the token until a connection opens', () => {
    const rejected = run({ type: 'connection', connected: false, rejected: true })
    expect(rejected).toMatchObject({ connected: false, rejected: true })
    expect(reduce(rejected, { type: 'connection', connected: true })).toMatchObject({ connected: true, rejected: false })
  })

  it('keeps the context of the selected chat and follows file and default changes', () => {
    const item = (section: ContextItem['section'], path: string, from: string, text = ''): ContextItem =>
      ({ section, path, from, enabled: true, text })
    const items = [
      item('agents', '/g/AGENTS.md', MAIN_CHAT_ID),
      item('folders', '/code/app', 'a', 'REPO'),
      item('agents', '/g/chats/a/AGENTS.md', 'a'),
    ]
    const loaded = run(
      snapshot([chat(MAIN_CHAT_ID), chat('a'), chat('b')]),
      { type: 'select', chatId: 'a' },
      { type: 'chat.context', chatId: 'a', items },
      { type: 'chat.context', chatId: 'b', items: [] },
    )
    expect(loaded.contextDefaults).toEqual(contextDefaults)
    expect(loaded.context).toEqual({ chatId: 'a', items })

    const written = reduce(loaded, { type: 'context.file', path: '/g/AGENTS.md', text: 'rules' })
    expect(written.context?.items.map((i) => i.text)).toEqual(['rules', 'REPO', ''])

    const defaults = { ...contextDefaults, files: false }
    expect(reduce(written, { type: 'context.defaults', defaults }).contextDefaults).toEqual(defaults)
    expect(reduce(written, { type: 'select', chatId: 'b' }).context).toBeUndefined()
  })

  it('loads the mods from the snapshot and follows their updates', () => {
    const loaded = run(snapshot([chat(MAIN_CHAT_ID)]))
    expect(loaded.mods).toEqual(mods)
    const on = { subagents: { enabled: true, limit: -1 } }
    expect(reduce(loaded, { type: 'mods.updated', mods: on }).mods).toEqual(on)
  })

  it('loads the model lists from the snapshot and replaces one engine on update', () => {
    const lists = { ...noLists, chat: ['b'] }
    const state = run(snapshot([chat(MAIN_CHAT_ID)]), { type: 'models.updated', engine: 'pi', lists })
    expect(state.modelLists).toEqual({ fake: noLists, pi: lists })
  })

  it('remembers the model that last ran, from the log and from live turns', () => {
    const ran = (id: string) => ({ at, type: 'turn.completed' as const, model: id })
    const loaded = run(snapshot([chat('a', [ran('x'), { at, type: 'turn.completed' }])]))
    expect(loaded.chats[0]?.ranModel).toBe('x')
    expect(reduce(loaded, entry('a', { type: 'turn.completed', model: 'y' })).chats[0]?.ranModel).toBe('y')
  })
})

describe('chat tree', () => {
  const view = (id: string, change: Partial<ChatState> = {}, createdAt = at) =>
    reduce(initialState, snapshot([chat(id, [], { createdAt, ...change })])).chats[0]!
  const rows = (list: { chat: ChatView; depth: number }[]) => list.map(({ chat, depth }) => `${depth} ${chat.id}`)
  const later = '2026-11-07T00:00:00.000Z'
  const chats = [
    view('old'),
    view('new', {}, later),
    view(MAIN_CHAT_ID),
    view('s1', { parentId: 'old', subagent: true }),
    view('s0', { parentId: MAIN_CHAT_ID, subagent: true }),
    view('gone', { archived: true }),
    view('gone-s', { parentId: 'gone', subagent: true, archived: true }),
    view('orphan', { parentId: 'nope' }, '2026-11-06T12:00:00.000Z'),
  ]

  it("shows the Workshop first, then each chat's subagents and named chats below it, newest first", () => {
    expect(rows(chatTree(chats).active)).toEqual(['0 main', '1 s0', '1 new', '1 orphan', '1 old', '2 s1'])
  })

  it('lists archived chats apart, each with the archived chats below it', () => {
    expect(rows(chatTree(chats).archived)).toEqual(['0 gone', '1 gone-s'])
  })

  it('finds a chat with every chat below it', () => {
    expect(familyOf(chats, 'old').map((c) => c.id)).toEqual(['old', 's1'])
    expect(familyOf(chats, MAIN_CHAT_ID).map((c) => c.id).sort()).toEqual(
      chats.filter((c) => c.parentId !== 'nope').map((c) => c.id).sort(),
    )
  })

  it("names a chat's working folder: its own first folder, else the nearest one above it", () => {
    const tree = [
      view(MAIN_CHAT_ID),
      view('a', { folders: ['/code/app', '/code/lib'] }),
      view('s', { parentId: 'a', subagent: true }),
      view('b'),
    ]
    expect(folderOf(tree, tree[1]!)).toBe('/code/app')
    expect(folderOf(tree, tree[2]!)).toBe('/code/app')
    expect(folderOf(tree, tree[3]!)).toBeUndefined()
  })

  it('names a chat after the last part of its folder', () => {
    expect(folderName('/Users/me/code/app')).toBe('app')
    expect(folderName('/Users/me/code/app/')).toBe('app')
    expect(folderName('/')).toBe('/')
  })
})

describe('modelMenu', () => {
  const catalog = [
    { id: 'opus-5-5', label: 'Opus 5.5' },
    { id: 'opus-4-8', label: 'Opus 4.8' },
    { id: 'haiku-5-5', label: 'Haiku 5.5' },
  ]
  const offers = { ...engines[0]!, models: catalog }
  const view = (extra: object = {}) => ({ ...reduce(initialState, snapshot([chat('a')])).chats[0]!, ...extra })

  it('lists Auto with the model it would run, then every offered model by its label', () => {
    const lists = { ...noLists, chat: ['gone', 'opus-4-8'] }
    expect(modelMenu(view(), offers, lists)).toEqual({
      value: '',
      options: [{ id: '', label: 'Auto · Opus 4.8' }, ...catalog],
    })
    expect(modelMenu(view({ model: 'haiku-5-5' }), offers, lists).value).toBe('haiku-5-5')
  })

  it("uses a subagent's role list, falling back to the Chat list when it is empty", () => {
    const lists = { ...noLists, chat: ['opus-5-5'], planning: ['haiku-5-5'] }
    expect(modelMenu(view({ role: 'planning' }), offers, lists).options[0]?.label).toBe('Auto · Haiku 5.5')
    expect(modelMenu(view({ role: 'subagents' }), offers, lists).options[0]?.label).toBe('Auto · Opus 5.5')
  })

  it('shows a pick the engine no longer offers as Auto, and the model that last ran when nothing is listed', () => {
    expect(modelMenu(view({ model: 'opus' }), offers, noLists)).toEqual({
      value: '',
      options: [{ id: '', label: 'Auto' }, ...catalog],
    })
    expect(modelMenu(view({ ranModel: 'opus-5-5' }), offers, noLists).options[0]?.label).toBe('Auto · Opus 5.5')
    expect(modelMenu(view({ ranModel: 'other/x' }), offers, undefined).options[0]?.label).toBe('Auto · other/x')
    expect(modelMenu(view(), undefined, undefined)).toEqual({ value: '', options: [{ id: '', label: 'Auto' }] })
  })
})

describe('storedFlag', () => {
  it('reads a saved true or false, and falls back when nothing usable is saved', () => {
    expect(storedFlag('true', false)).toBe(true)
    expect(storedFlag('false', true)).toBe(false)
    expect(storedFlag(null, true)).toBe(true)
    expect(storedFlag(null, false)).toBe(false)
    expect(storedFlag('yes', true)).toBe(true)
  })
})

describe('chat width', () => {
  it('reads the saved width, falling back to the default and never going below the minimum', () => {
    expect(storedColumn(null)).toBe(COLUMN_PX.default)
    expect(storedColumn('wide')).toBe(COLUMN_PX.default)
    expect(storedColumn(String(COLUMN_PX.min + 100))).toBe(COLUMN_PX.min + 100)
    expect(storedColumn(String(COLUMN_PX.min - 100))).toBe(COLUMN_PX.min)
  })

  it('runs the slider from the minimum to the full pane, clamping the saved width into it', () => {
    const pane = COLUMN_PX.default + 200
    expect(columnSlider(COLUMN_PX.default, pane)).toEqual({ min: COLUMN_PX.min, max: pane, value: COLUMN_PX.default })
    expect(columnSlider(pane + 500, pane).value).toBe(pane)
    expect(columnSlider(COLUMN_PX.default, COLUMN_PX.min - 50)).toEqual({
      min: COLUMN_PX.min,
      max: COLUMN_PX.min,
      value: COLUMN_PX.min,
    })
  })
})
