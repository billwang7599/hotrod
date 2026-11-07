import { describe, expect, it } from 'vitest'
import type { ChatEntry, ChatState, ContextLayer, CoreMessage, Project } from '@hotrod/core/types'
import type { Account, EngineAccounts } from '@hotrod/core/types'
import { accountLabel, engineOptions, initialState, MAIN_CHAT_ID, reduce, type Action, type State } from './state.ts'

const at = '2026-11-06T00:00:00.000Z'
const engines = [{ id: 'fake', enabled: true, installed: true, signedIn: true }]
const chat = (id: string, entries: ChatEntry[] = [], projectId?: string): ChatState => ({
  id,
  ...(projectId ? { projectId } : {}),
  main: id === MAIN_CHAT_ID || id.endsWith('/main'),
  title: id,
  engine: 'fake',
  archived: false,
  createdAt: at,
  status: 'idle',
  entries,
  draft: '',
  queue: [],
})
const project = (id: string): Project => ({ id, name: id, path: `/tmp/${id}`, archived: false })
const contextDefaults = { workshop: true, repo: true, project: true, own: true }
const snapshot = (chats: ChatState[], projects: Project[] = []): Action =>
  ({ type: 'snapshot', engines, accounts: [], projects, chats, contextDefaults })
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

  it('adds a project with its main chat and selects the chat, once', () => {
    const added: Action = { type: 'project.added', project: project('p'), chat: chat('p/main', [], 'p') }
    const state = run(snapshot([chat(MAIN_CHAT_ID)]), added, { type: 'select', chatId: MAIN_CHAT_ID }, added)
    expect(state.projects).toEqual([project('p')])
    expect(state.chats.map((c) => c.id)).toEqual([MAIN_CHAT_ID, 'p/main'])
    expect(state.selectedId).toBe('p/main')
  })

  it('adds a chat and selects it, then updates its title and archive flag', () => {
    const state = run(
      snapshot([chat(MAIN_CHAT_ID)]),
      { type: 'chat.added', chat: { ...chat('c'), title: 'New chat' } },
      entry('c', { type: 'user.message', text: 'hi' }),
    )
    expect(state.selectedId).toBe('c')
    const { status, entries, draft, ...info } = chat('c')
    const updated = reduce(state, { type: 'chat.updated', chat: { ...info, title: 'hi', archived: true } })
    expect(updated.chats[1]).toMatchObject({ title: 'hi', archived: true, items: [{ kind: 'user', text: 'hi' }] })
  })

  it('removes a chat, or a project with all its chats, and selects Main if the selection went with it', () => {
    const state = run(snapshot([chat(MAIN_CHAT_ID), chat('p/main', [], 'p'), chat('s', [], 'p'), chat('c')], [project('p')]))
    const onSub = reduce(state, { type: 'select', chatId: 's' })
    expect(reduce(onSub, { type: 'chat.removed', chatId: 'c' }).selectedId).toBe('s')
    expect(reduce(onSub, { type: 'chat.removed', chatId: 's' }).selectedId).toBe(MAIN_CHAT_ID)
    const removed = reduce(onSub, { type: 'project.removed', projectId: 'p' })
    expect(removed.projects).toEqual([])
    expect(removed.chats.map((c) => c.id)).toEqual([MAIN_CHAT_ID, 'c'])
    expect(removed.selectedId).toBe(MAIN_CHAT_ID)
    const archived = reduce(state, { type: 'project.updated', project: { ...project('p'), archived: true } })
    expect(archived.projects[0]?.archived).toBe(true)
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
      { type: 'snapshot', engines, accounts: [], projects: [], chats: [], contextDefaults },
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
      { type: 'snapshot', engines, accounts: [fake, other], projects: [], chats: [], contextDefaults },
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
    const layer = (kind: ContextLayer['kind'], path: string, text = ''): ContextLayer =>
      ({ kind, path, enabled: true, writable: kind !== 'repo', text })
    const layers = [layer('workshop', '/g/AGENTS.md'), layer('own', '/g/chats/a/AGENTS.md')]
    const loaded = run(
      snapshot([chat(MAIN_CHAT_ID), chat('a'), chat('b')]),
      { type: 'select', chatId: 'a' },
      { type: 'chat.context', chatId: 'a', layers },
      { type: 'chat.context', chatId: 'b', layers: [] },
    )
    expect(loaded.contextDefaults).toEqual(contextDefaults)
    expect(loaded.context).toEqual({ chatId: 'a', layers })

    const written = reduce(loaded, { type: 'context.file', path: '/g/AGENTS.md', text: 'rules' })
    expect(written.context?.layers.map((l) => l.text)).toEqual(['rules', ''])

    const defaults = { ...contextDefaults, own: false }
    expect(reduce(written, { type: 'context.defaults', defaults }).contextDefaults).toEqual(defaults)
    expect(reduce(written, { type: 'select', chatId: 'b' }).context).toBeUndefined()
  })
})
