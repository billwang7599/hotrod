import type { ChatEntry, ChatStatus, CoreMessage, EngineStatus, ProjectState } from '@hotrod/core/types'

export type Item =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | {
      kind: 'tool'
      toolId: string
      name: string
      summary: string
      state: 'running' | 'waiting' | 'done' | 'error' | 'stopped'
      output: string
    }
  | {
      kind: 'permission'
      requestId: string
      toolId?: string
      name: string
      summary: string
      input: unknown
      outcome: 'pending' | 'allowed' | 'denied' | 'cancelled'
    }
  | { kind: 'error'; text: string }

export type ProjectView = { id: string; name: string; path: string; status: ChatStatus; items: Item[]; draft: string }

export type State = {
  connected: boolean
  engine: ({ id: string } & EngineStatus) | null
  projects: ProjectView[]
  selectedId: string | null
  toasts: { id: number; message: string }[]
  nextToastId: number
}

export type Action =
  | CoreMessage
  | { type: 'connection'; connected: boolean }
  | { type: 'select'; projectId: string }
  | { type: 'toast.dismiss'; id: number }

export const initialState: State = {
  connected: false,
  engine: null,
  projects: [],
  selectedId: null,
  toasts: [],
  nextToastId: 1,
}

function setToolState(items: Item[], toolId: string | undefined, state: 'running' | 'waiting'): Item[] {
  return items.map((i) =>
    i.kind === 'tool' && i.toolId === toolId && (i.state === 'running' || i.state === 'waiting') ? { ...i, state } : i,
  )
}

function applyEntry(items: Item[], entry: ChatEntry): Item[] {
  switch (entry.type) {
    case 'user.message':
      return [...items, { kind: 'user', text: entry.text }]
    case 'text.completed':
      return [...items, { kind: 'text', text: entry.text }]
    case 'tool.started':
      return [
        ...items,
        {
          kind: 'tool',
          toolId: entry.toolId,
          name: entry.name,
          summary: entry.summary,
          state: 'running',
          output: '',
        },
      ]
    case 'tool.completed':
      return items.map((i) =>
        i.kind === 'tool' && i.toolId === entry.toolId
          ? { ...i, state: entry.isError ? 'error' : 'done', output: entry.output }
          : i,
      )
    case 'permission.requested':
      return [
        ...setToolState(items, entry.toolId, 'waiting'),
        {
          kind: 'permission',
          requestId: entry.requestId,
          ...(entry.toolId ? { toolId: entry.toolId } : {}),
          name: entry.name,
          summary: entry.summary,
          input: entry.input,
          outcome: 'pending',
        },
      ]
    case 'permission.resolved': {
      const request = items.find((i) => i.kind === 'permission' && i.requestId === entry.requestId)
      const toolId = request?.kind === 'permission' ? request.toolId : undefined
      return setToolState(items, toolId, 'running').map((i) =>
        i.kind === 'permission' && i.requestId === entry.requestId
          ? { ...i, outcome: entry.allow ? 'allowed' : 'denied' }
          : i,
      )
    }
    case 'turn.completed':
    case 'session.ended': {
      const settled = items.map((i): Item =>
        i.kind === 'tool' && (i.state === 'running' || i.state === 'waiting')
          ? { ...i, state: 'stopped' }
          : i.kind === 'permission' && i.outcome === 'pending'
            ? { ...i, outcome: 'cancelled' }
            : i,
      )
      return entry.error ? [...settled, { kind: 'error', text: entry.error }] : settled
    }
    case 'turn.started':
      return items
  }
}

const toView = (p: ProjectState): ProjectView => ({
  id: p.id,
  name: p.name,
  path: p.path,
  status: p.status,
  items: p.entries.reduce(applyEntry, []),
  draft: '',
})

function updateProject(state: State, id: string, update: (p: ProjectView) => ProjectView): State {
  return { ...state, projects: state.projects.map((p) => (p.id === id ? update(p) : p)) }
}

const endsText = (entry: ChatEntry) =>
  entry.type === 'text.completed' || entry.type === 'turn.completed' || entry.type === 'session.ended'

export function reduce(state: State, action: Action): State {
  switch (action.type) {
    case 'snapshot': {
      const projects = action.projects.map(toView)
      const selectedId = projects.some((p) => p.id === state.selectedId) ? state.selectedId : (projects[0]?.id ?? null)
      return { ...state, engine: action.engine, projects, selectedId }
    }
    case 'project.added': {
      const known = state.projects.some((p) => p.id === action.project.id)
      const projects = known ? state.projects : [...state.projects, toView(action.project)]
      return { ...state, projects, selectedId: action.project.id }
    }
    case 'chat.entry':
      return updateProject(state, action.projectId, (p) => ({
        ...p,
        items: applyEntry(p.items, action.entry),
        draft: endsText(action.entry) ? '' : p.draft,
      }))
    case 'chat.delta':
      return updateProject(state, action.projectId, (p) => ({ ...p, draft: p.draft + action.text }))
    case 'chat.status':
      return updateProject(state, action.projectId, (p) => ({ ...p, status: action.status }))
    case 'error':
      return {
        ...state,
        toasts: [...state.toasts, { id: state.nextToastId, message: action.message }],
        nextToastId: state.nextToastId + 1,
      }
    case 'connection':
      return { ...state, connected: action.connected }
    case 'select':
      return { ...state, selectedId: action.projectId }
    case 'toast.dismiss':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) }
  }
}
