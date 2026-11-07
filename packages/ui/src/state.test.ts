import { describe, expect, it } from 'vitest'
import type { ChatEntry, CoreMessage, ProjectState } from '@hotrod/core/types'
import { engineOptions, initialState, reduce, type Action, type State } from './state.ts'

const at = '2026-11-06T00:00:00.000Z'
const engines = [{ id: 'fake', installed: true, signedIn: true }]
const project = (id: string, entries: ChatEntry[] = []): ProjectState => ({
  id,
  name: id,
  path: `/tmp/${id}`,
  engine: 'fake',
  status: 'idle',
  entries,
  draft: '',
})
type NewEntry = ChatEntry extends infer E ? (E extends unknown ? Omit<E, 'at'> : never) : never
const entry = (projectId: string, e: NewEntry): CoreMessage =>
  ({ type: 'chat.entry', projectId, entry: { at, ...e } as ChatEntry })
const run = (...actions: Action[]): State => actions.reduce(reduce, initialState)
const items = (state: State, id = 'a') => state.projects.find((p) => p.id === id)!.items

describe('reduce', () => {
  it('loads a snapshot, folding saved entries into items and selecting the first project', () => {
    const state = run({
      type: 'snapshot',
      engines,
      projects: [
        project('a', [
          { at, type: 'user.message', text: 'hi' },
          { at, type: 'turn.started' },
          { at, type: 'text.completed', text: 'hello' },
          { at, type: 'tool.started', toolId: 't1', name: 'Bash', kind: 'shell', summary: 'ls', input: { command: 'ls' } },
          { at, type: 'tool.completed', toolId: 't1', output: 'README.md', isError: false },
          { at, type: 'turn.completed', error: 'boom' },
        ]),
        project('b'),
      ],
    })
    expect(state.engines).toEqual(engines)
    expect(state.selectedId).toBe('a')
    expect(state.projects.map((p) => p.id)).toEqual(['a', 'b'])
    expect(items(state)).toEqual([
      { kind: 'user', text: 'hi' },
      { kind: 'text', text: 'hello' },
      { kind: 'tool', toolId: 't1', name: 'Bash', summary: 'ls', state: 'done', output: 'README.md' },
      { kind: 'error', text: 'boom' },
    ])
  })

  it('keeps the selection across a reconnect snapshot', () => {
    const snapshot: Action = { type: 'snapshot', engines, projects: [project('a'), project('b')] }
    const state = run(snapshot, { type: 'select', projectId: 'b' }, { type: 'connection', connected: false }, snapshot)
    expect(state.selectedId).toBe('b')
  })

  it('adds a project and selects it', () => {
    const state = run(
      { type: 'snapshot', engines, projects: [project('a')] },
      { type: 'project.added', project: project('b') },
    )
    expect(state.projects.map((p) => p.id)).toEqual(['a', 'b'])
    expect(state.selectedId).toBe('b')
  })

  it('updates a project engine and keeps its chat', () => {
    const state = run(
      { type: 'snapshot', engines, projects: [project('a', [{ at, type: 'user.message', text: 'hi' }])] },
      { type: 'project.updated', project: { id: 'a', name: 'a', path: '/tmp/a', engine: 'pi' } },
    )
    expect(state.projects[0]?.engine).toBe('pi')
    expect(items(state)).toEqual([{ kind: 'user', text: 'hi' }])
  })

  it('lists engine options with their problems, keeping an unknown saved engine', () => {
    const listed = [
      { id: 'claude-code', installed: true, signedIn: true },
      { id: 'pi', installed: true, signedIn: false },
      { id: 'codex', installed: false, signedIn: false },
    ]
    expect(engineOptions(listed, 'pi')).toEqual([
      { id: 'claude-code', label: 'claude-code' },
      { id: 'pi', label: 'pi (not signed in)' },
      { id: 'codex', label: 'codex (not installed)' },
    ])
    expect(engineOptions(listed, 'gone').at(-1)).toEqual({ id: 'gone', label: 'gone (unknown)' })
  })

  it('selects a re-added project instead of adding it twice', () => {
    const state = run(
      { type: 'snapshot', engines, projects: [project('a'), project('b')] },
      { type: 'project.added', project: project('a') },
    )
    expect(state.projects.map((p) => p.id)).toEqual(['a', 'b'])
    expect(state.selectedId).toBe('a')
  })

  it('shows a tool as waiting while its permission is pending', () => {
    const requested = run(
      { type: 'snapshot', engines, projects: [project('a')] },
      entry('a', { type: 'tool.started', toolId: 't1', name: 'Bash', kind: 'shell', summary: '', input: {} }),
      entry('a', { type: 'permission.requested', requestId: 'r1', toolId: 't1', name: 'Bash', kind: 'shell', summary: '', input: {} }),
    )
    expect(items(requested)[0]).toMatchObject({ toolId: 't1', state: 'waiting' })
    const allowed = reduce(requested, entry('a', { type: 'permission.resolved', requestId: 'r1', allow: true }))
    expect(items(allowed)[0]).toMatchObject({ toolId: 't1', state: 'running' })
    const ended = reduce(requested, entry('a', { type: 'turn.completed' }))
    expect(items(ended)[0]).toMatchObject({ toolId: 't1', state: 'stopped' })
  })

  it('appends entries to the right project', () => {
    const state = run(
      { type: 'snapshot', engines, projects: [project('a'), project('b')] },
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
      { type: 'snapshot', engines, projects: [project('a')] },
      { type: 'chat.delta', projectId: 'a', text: 'Hel' },
      { type: 'chat.delta', projectId: 'a', text: 'lo' },
    )
    expect(streaming.projects[0]!.draft).toBe('Hello')
    const done = reduce(streaming, entry('a', { type: 'text.completed', text: 'Hello' }))
    expect(done.projects[0]!.draft).toBe('')
    expect(items(done)).toEqual([{ kind: 'text', text: 'Hello' }])
  })

  it('continues the draft a snapshot carries from a turn in progress', () => {
    const state = run(
      { type: 'snapshot', engines, projects: [{ ...project('a'), status: 'running', draft: 'Hel' }] },
      { type: 'chat.delta', projectId: 'a', text: 'lo' },
    )
    expect(state.projects[0]!.draft).toBe('Hello')
  })

  it('tracks chat status', () => {
    const state = run(
      { type: 'snapshot', engines, projects: [project('a')] },
      { type: 'chat.status', projectId: 'a', status: 'running' },
    )
    expect(state.projects[0]!.status).toBe('running')
    expect(reduce(state, { type: 'chat.status', projectId: 'a', status: 'waiting' }).projects[0]!.status).toBe('waiting')
  })

  it('moves a permission from pending to resolved', () => {
    const requested = run(
      { type: 'snapshot', engines, projects: [project('a')] },
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
      { type: 'snapshot', engines, projects: [project('a')] },
      { type: 'chat.delta', projectId: 'a', text: 'half' },
      entry('a', { type: 'tool.started', toolId: 't1', name: 'Bash', kind: 'shell', summary: '', input: {} }),
      entry('a', { type: 'permission.requested', requestId: 'r1', name: 'Bash', kind: 'shell', summary: '', input: {} }),
      entry('a', { type: 'turn.completed' }),
    )
    expect(items(state).map((i) => ('state' in i ? i.state : 'outcome' in i ? i.outcome : i.kind))).toEqual([
      'stopped',
      'cancelled',
    ])
    expect(state.projects[0]!.draft).toBe('')
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
})
