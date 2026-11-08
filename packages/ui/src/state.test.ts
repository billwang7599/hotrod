import { describe, expect, it } from 'vitest'
import type { ChatEntry, ChatState, ContextItem, CoreMessage, ModInfo } from '@hotrod/core/shared'
import type { Account, EngineAccounts } from '@hotrod/core/shared'
import {
  accountLabel,
  chatTree,
  COLUMN_PX,
  columnSlider,
  dockedPanels,
  engineOptions,
  familyOf,
  folderName,
  folderOf,
  formatBytes,
  initialState,
  listedAccounts,
  MAX_PREVIEW_BYTES,
  MIN_WINDOW_PX,
  modelMenu,
  PANEL_PX,
  pinState,
  previewText,
  reduce,
  storedColumn,
  storedFlag,
  type Action,
  type ChatView,
  type State,
} from './state.ts'

const MAIN_CHAT_ID = 'main'
const at = '2026-11-06T00:00:00.000Z'
const engines = [{ id: 'fake', enabled: true, installed: true, signedIn: true }]
const chat = (id: string, entries: ChatEntry[] = [], change: Partial<ChatState> = {}): ChatState => ({
  id,
  name: id,
  ...(id === MAIN_CHAT_ID && { mod: 'home' }),
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
const modInfo = (id: string, enabled = false): ModInfo => ({
  id,
  name: id,
  description: '',
  enabled,
  settings: [{ key: 'limit', label: 'Limit', type: 'number', default: 4 }],
  values: { limit: 4 },
})
const mods = [modInfo('subagents'), modInfo('other')]
const noLists = { chat: [], planning: [], searching: [], subagents: [] }
const modelLists = { fake: noLists }
const instructions = { path: '/g/AGENTS.md', text: 'RULES' }
const snapshot = (chats: ChatState[]): Action =>
  ({
    type: 'snapshot',
    engines,
    accounts: [],
    chats,
    contextDefaults,
    instructions,
    mods,
    modelLists,
    memory: {},
    workFolder: { defaultPath: '/g/work', canSandbox: true },
  })
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
    expect(state).toMatchObject({ loaded: true, instructions })
    expect(initialState.loaded).toBe(false)
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

  it('falls back to the newest space without a pinned chat, and selects nothing without spaces', () => {
    const later = '2026-11-07T00:00:00.000Z'
    const spaces = [chat('a'), chat('b', [], { createdAt: later }), chat('c', [], { createdAt: later, archived: true })]
    expect(run({ type: 'select', chatId: MAIN_CHAT_ID }, snapshot(spaces)).selectedId).toBe('b')
    expect(run({ type: 'select', chatId: 'a' }, snapshot(spaces)).selectedId).toBe('a')
    expect(run(snapshot([chat('c', [], { archived: true })])).selectedId).toBe('')
    expect(run(snapshot([chat('a')]), { type: 'chat.removed', chatId: 'a' }).selectedId).toBe('')
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

  it('removes a chat and selects the pinned chat if the selection went with it', () => {
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
      snapshot([]),
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
      { ...(snapshot([]) as Extract<Action, { type: 'snapshot' }>), accounts: [fake, other] },
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
    expect(accountLabel({ id: 'default', name: 'Default', kind: 'login', label: 'me@home.test', signedIn: true })).toBe(
      'me@home.test',
    )
    expect(accountLabel({ id: 'default', name: 'Default', kind: 'login' })).toBe('Not signed in')
    expect(accountLabel({ id: 'default', name: 'Default', kind: 'login', label: 'me@home.test', signedIn: false })).toBe(
      'Not signed in',
    )
    expect(accountLabel({ ...work, id: 'old', name: 'Old', signedIn: false })).toBe('Old (signed out)')
    const billing: Account = { id: 'billing', name: 'Billing', kind: 'apiKey', label: 'API key ••••abcd', signedIn: true }
    expect(accountLabel(billing)).toBe('Billing (API key ••••abcd)')
    expect(accountLabel({ ...billing, signedIn: false })).toBe('Billing (key file missing)')
  })

  it("lists the engine's own login once when a saved account is the same login", () => {
    const own: Account = { id: 'default', name: 'Default', kind: 'login', label: 'me@work.test', signedIn: true }
    const work: Account = { id: 'work', name: 'Work', kind: 'login', label: 'me@work.test', signedIn: true }
    const home: Account = { id: 'home', name: 'Home', kind: 'login', label: 'me@home.test', signedIn: true }
    const engine = (active: string, accounts: Account[]): EngineAccounts => ({ engine: 'fake', active, apiKeys: false, accounts })

    expect(listedAccounts(engine('default', [own, work, home]))).toEqual({ active: 'work', accounts: [work, home] })
    expect(listedAccounts(engine('home', [own, work, home]))).toEqual({ active: 'home', accounts: [work, home] })
    expect(listedAccounts(engine('default', [own, home]))).toEqual({ active: 'default', accounts: [own, home] })
    const signedOut = { ...work, signedIn: false }
    expect(listedAccounts(engine('default', [own, signedOut])).accounts).toEqual([own, signedOut])
    const key: Account = { id: 'key', name: 'Key', kind: 'apiKey', label: 'me@work.test', signedIn: true }
    expect(listedAccounts(engine('default', [own, key])).accounts).toEqual([own, key])
    const ownSignedOut: Account = { id: 'default', name: 'Default', kind: 'login' }
    expect(listedAccounts(engine('default', [ownSignedOut, work])).accounts).toEqual([ownSignedOut, work])
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

  it("keeps a message's attachments, sent and queued", () => {
    const shot = { name: 'shot.png', path: '/g/chats/a/attachments/shot.png', mimeType: 'image/png', size: 2048 }
    const state = run(
      snapshot([chat(MAIN_CHAT_ID), chat('a')]),
      entry('a', { type: 'user.message', text: '', attachments: [shot] }),
      { type: 'chat.queue', chatId: 'a', queue: [{ id: 'q1', text: 'next', attachments: [shot] }] },
    )
    expect(items(state)).toEqual([{ kind: 'user', text: '', attachments: [shot] }])
    expect(state.chats[1]?.queue).toEqual([{ id: 'q1', text: 'next', attachments: [shot] }])
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
    expect(items(allowed)[0]).not.toHaveProperty('auto')
    const auto = reduce(requested, entry('a', { type: 'permission.resolved', requestId: 'r1', allow: false, auto: true }))
    expect(items(auto)[0]).toMatchObject({ requestId: 'r1', outcome: 'denied', auto: true })
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
    expect(written.instructions).toEqual({ path: '/g/AGENTS.md', text: 'rules' })
    const own = reduce(loaded, { type: 'context.file', path: '/g/chats/a/AGENTS.md', text: 'mine' })
    expect(own.instructions).toEqual(instructions)
    expect(reduce(run(snapshot([])), { type: 'context.file', path: '/g/AGENTS.md', text: 'x' }).instructions.text).toBe('x')

    const defaults = { ...contextDefaults, files: false }
    expect(reduce(written, { type: 'context.defaults', defaults }).contextDefaults).toEqual(defaults)
    expect(reduce(written, { type: 'select', chatId: 'b' }).context).toBeUndefined()
  })

  it('loads the mods from the snapshot and replaces only the one that changed', () => {
    const loaded = run(snapshot([chat(MAIN_CHAT_ID)]))
    expect(loaded.mods).toEqual(mods)
    const on = { ...modInfo('subagents', true), values: { limit: -1 } }
    expect(reduce(loaded, { type: 'mod.updated', mod: on }).mods).toEqual([on, mods[1]])
  })

  it('loads the model lists from the snapshot and replaces one engine on update', () => {
    const lists = { ...noLists, chat: ['b'] }
    const state = run(snapshot([chat(MAIN_CHAT_ID)]), { type: 'models.updated', engine: 'pi', lists })
    expect(state.modelLists).toEqual({ fake: noLists, pi: lists })
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

  it("shows a mod's chat first, then the spaces newest first, each with its subagents below it", () => {
    expect(rows(chatTree(chats).active)).toEqual(['0 main', '1 s0', '0 new', '0 orphan', '0 old', '1 s1'])
    const spaces = chats.filter((c) => c.id !== MAIN_CHAT_ID && c.parentId !== MAIN_CHAT_ID)
    expect(rows(chatTree(spaces).active)).toEqual(['0 new', '0 orphan', '0 old', '1 s1'])
  })

  it('lists archived chats apart, each with the archived chats below it', () => {
    expect(rows(chatTree(chats).archived)).toEqual(['0 gone', '1 gone-s'])
  })

  it('finds a chat with every chat below it', () => {
    expect(familyOf(chats, 'old').map((c) => c.id)).toEqual(['old', 's1'])
    expect(familyOf(chats, MAIN_CHAT_ID).map((c) => c.id)).toEqual([MAIN_CHAT_ID, 's0'])
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
  const levels = ['low', 'medium', 'high']
  const [model, thinking] = ['opus-4-8', 'medium']
  const offers = { ...engines[0]!, models: catalog, thinking: levels, defaultModel: model, defaultThinking: thinking }
  const view = (extra: object = {}) => ({ ...reduce(initialState, snapshot([chat('a')])).chats[0]!, ...extra })

  it("selects the engine's default model and thinking level, and offers only real ones", () => {
    expect(modelMenu(view(), offers, noLists)).toEqual({ model, models: catalog, thinking, levels })
  })

  it("selects the chat's own picks, else the first listed model the engine offers", () => {
    const lists = { ...noLists, chat: ['gone', 'haiku-5-5'] }
    expect(modelMenu(view(), offers, lists).model).toBe('haiku-5-5')
    const picked = modelMenu(view({ model: 'opus-5-5', thinking: 'high' }), offers, lists)
    expect(picked).toMatchObject({ model: 'opus-5-5', thinking: 'high' })
  })

  it("uses a subagent's role list, falling back to the Chat list when it is empty", () => {
    const lists = { ...noLists, chat: ['opus-5-5'], planning: ['haiku-5-5'] }
    expect(modelMenu(view({ role: 'planning' }), offers, lists).model).toBe('haiku-5-5')
    expect(modelMenu(view({ role: 'subagents' }), offers, lists).model).toBe('opus-5-5')
  })

  it('selects what will run instead of a pick the engine no longer offers', () => {
    expect(modelMenu(view({ model: 'opus', thinking: 'ultra' }), offers, noLists)).toMatchObject({ model, thinking })
    expect(modelMenu(view(), undefined, undefined)).toEqual({ models: [], levels: [] })
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

describe('dockedPanels', () => {
  it('docks a panel only while the chat keeps at least the minimum window width', () => {
    const sidebar = PANEL_PX.sidebar + MIN_WINDOW_PX.width
    const both = sidebar + PANEL_PX.context
    expect(dockedPanels(MIN_WINDOW_PX.width)).toBe('none')
    expect(dockedPanels(sidebar - 1)).toBe('none')
    expect(dockedPanels(sidebar)).toBe('sidebar')
    expect(dockedPanels(both - 1)).toBe('sidebar')
    expect(dockedPanels(both)).toBe('both')
  })
})

describe('formatBytes', () => {
  it('shows sizes in decimal units, with one decimal below ten', () => {
    expect([0, 999, 1500, 20_480, 2_500_000, 20_000_000].map(formatBytes)).toEqual([
      '0 B',
      '999 B',
      '1.5 KB',
      '20 KB',
      '2.5 MB',
      '20 MB',
    ])
  })
})

describe('attachments', () => {
  const view = (id: string, change: Partial<ChatState> = {}) =>
    reduce(initialState, snapshot([chat(id, [], change)])).chats[0]!
  const path = '/g/chats/a/attachments/shot.png'
  const file = (from: string, filePath = path): ContextItem =>
    ({ section: 'files', path: filePath, from, enabled: false, text: '', binary: true })

  it('offers a pin outside Home and archived chats, pinned while the chat itself lists the file', () => {
    expect(pinState(view('a'), [file('a')], path)).toBe('pinned')
    expect(pinState(view('a'), [file('a', '/g/other.png'), file(MAIN_CHAT_ID)], path)).toBe('unpinned')
    expect(pinState(view('a'), undefined, path)).toBeUndefined()
    expect(pinState(view(MAIN_CHAT_ID), [], path)).toBeUndefined()
    expect(pinState(view('a', { archived: true }), [file('a')], path)).toBeUndefined()
  })

  it('previews text up to the cap without a broken last character, and nothing for a file that is not text', () => {
    const bytes = (text: string) => new TextEncoder().encode(text)
    expect(previewText(bytes('hello <b>'))).toBe('hello <b>')
    expect(previewText(new Uint8Array([104, 105, 0, 33]))).toBeUndefined()
    const long = 'a'.repeat(MAX_PREVIEW_BYTES - 1)
    expect(previewText(bytes(`${long}éz`))).toBe(long)
  })
})
