import type {
  Account,
  ChatEntry,
  ChatInfo,
  ChatState,
  ChatStatus,
  CoreMessage,
  EngineAccounts,
  EngineInfo,
  Project,
} from '@hotrod/core/types'

export const MAIN_CHAT_ID = 'main'

export type Item =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
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

export type ChatView = ChatInfo & { status: ChatStatus; items: Item[]; draft: string }

export type State = {
  connected: boolean
  rejected: boolean
  engines: EngineInfo[]
  accounts: EngineAccounts[]
  projects: Project[]
  chats: ChatView[]
  selectedId: string
  toasts: { id: number; message: string }[]
  nextToastId: number
}

export type Action =
  | CoreMessage
  | { type: 'connection'; connected: boolean; rejected?: boolean }
  | { type: 'select'; chatId: string }
  | { type: 'toast.dismiss'; id: number }

export const initialState: State = {
  connected: false,
  rejected: false,
  engines: [],
  accounts: [],
  projects: [],
  chats: [],
  selectedId: MAIN_CHAT_ID,
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
      const settled = items.filter((i) => i.kind !== 'thinking').map((i): Item =>
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

const toView = ({ entries, ...chat }: ChatState): ChatView => ({ ...chat, items: entries.reduce(applyEntry, []) })

function updateChat(state: State, id: string, update: (c: ChatView) => ChatView): State {
  return { ...state, chats: state.chats.map((c) => (c.id === id ? update(c) : c)) }
}

const keepSelection = (state: State): State =>
  state.chats.some((c) => c.id === state.selectedId) ? state : { ...state, selectedId: MAIN_CHAT_ID }

const endsText = (entry: ChatEntry) =>
  entry.type === 'text.completed' || entry.type === 'turn.completed' || entry.type === 'session.ended'

export function reduce(state: State, action: Action): State {
  switch (action.type) {
    case 'snapshot':
      return keepSelection({
        ...state,
        engines: action.engines,
        accounts: action.accounts,
        projects: action.projects,
        chats: action.chats.map(toView),
      })
    case 'accounts.updated': {
      const { engine } = action.accounts
      const known = state.accounts.some((a) => a.engine === engine)
      const accounts = known
        ? state.accounts.map((a) => (a.engine === engine ? action.accounts : a))
        : [...state.accounts, action.accounts]
      return { ...state, accounts }
    }
    case 'project.added': {
      const { project, chat } = action
      const known = state.projects.some((p) => p.id === project.id)
      return {
        ...state,
        projects: known ? state.projects.map((p) => (p.id === project.id ? project : p)) : [...state.projects, project],
        chats: state.chats.some((c) => c.id === chat.id) ? state.chats : [...state.chats, toView(chat)],
        selectedId: chat.id,
      }
    }
    case 'project.updated':
      return { ...state, projects: state.projects.map((p) => (p.id === action.project.id ? action.project : p)) }
    case 'project.removed':
      return keepSelection({
        ...state,
        projects: state.projects.filter((p) => p.id !== action.projectId),
        chats: state.chats.filter((c) => c.projectId !== action.projectId),
      })
    case 'chat.added':
      return {
        ...state,
        chats: state.chats.some((c) => c.id === action.chat.id) ? state.chats : [...state.chats, toView(action.chat)],
        selectedId: action.chat.id,
      }
    case 'chat.updated':
      return updateChat(state, action.chat.id, (c) => ({ ...c, ...action.chat }))
    case 'chat.removed':
      return keepSelection({ ...state, chats: state.chats.filter((c) => c.id !== action.chatId) })
    case 'chat.entry':
      return updateChat(state, action.chatId, (c) => ({
        ...c,
        items: applyEntry(c.items, action.entry),
        draft: endsText(action.entry) ? '' : c.draft,
      }))
    case 'chat.delta':
      return updateChat(state, action.chatId, (c) => ({ ...c, draft: c.draft + action.text }))
    case 'chat.thinking':
      return updateChat(state, action.chatId, (c) => {
        const last = c.items.at(-1)
        const items: Item[] =
          last?.kind === 'thinking'
            ? [...c.items.slice(0, -1), { kind: 'thinking', text: last.text + action.text }]
            : [...c.items, { kind: 'thinking', text: action.text }]
        return { ...c, items }
      })
    case 'chat.status':
      return updateChat(state, action.chatId, (c) => ({ ...c, status: action.status }))
    case 'error':
      return {
        ...state,
        toasts: [...state.toasts, { id: state.nextToastId, message: action.message }],
        nextToastId: state.nextToastId + 1,
      }
    case 'connection':
      return { ...state, connected: action.connected, rejected: action.rejected ?? false }
    case 'select':
      return { ...state, selectedId: action.chatId }
    case 'toast.dismiss':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) }
  }
}

export function engineOptions(engines: EngineInfo[], current: string): { id: string; label: string }[] {
  const options = engines.map((e) => ({
    id: e.id,
    label: !e.installed ? `${e.id} (not installed)` : !e.signedIn ? `${e.id} (not signed in)` : e.id,
  }))
  return options.some((o) => o.id === current) ? options : [...options, { id: current, label: `${current} (unknown)` }]
}

export function accountLabel(account: Account) {
  const missing = account.kind === 'apiKey' ? 'key file missing' : 'signed out'
  if (account.signedIn === false) return `${account.name} (${missing})`
  return account.label ? `${account.name} (${account.label})` : account.name
}
