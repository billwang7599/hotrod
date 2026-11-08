import { DEFAULT_SUBAGENT_LIMIT, looksBinary, pickModel, pickThinking, WORKSHOP_ID } from '@hotrod/core/shared'
import type {
  Account,
  Attachment,
  ChatEntry,
  ChatInfo,
  ChatState,
  ChatStatus,
  ContextItem,
  ContextSection,
  CoreMessage,
  EngineAccounts,
  EngineInfo,
  ModelLists,
  Mods,
  QueuedMessage,
} from '@hotrod/core/shared'

export const MAIN_CHAT_ID = WORKSHOP_ID

export type Item =
  | { kind: 'user'; text: string; attachments?: Attachment[] }
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

export type ChatView = ChatInfo & {
  status: ChatStatus
  items: Item[]
  draft: string
  queue: QueuedMessage[]
}

export type State = {
  connected: boolean
  rejected: boolean
  engines: EngineInfo[]
  accounts: EngineAccounts[]
  chats: ChatView[]
  selectedId: string
  contextDefaults: Record<ContextSection, boolean>
  mods: Mods
  modelLists: Record<string, ModelLists>
  context?: { chatId: string; items: ContextItem[] }
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
  chats: [],
  selectedId: MAIN_CHAT_ID,
  contextDefaults: { agents: true, folders: true, files: true },
  mods: { subagents: { enabled: false, limit: DEFAULT_SUBAGENT_LIMIT } },
  modelLists: {},
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
    case 'user.message': {
      const { text, attachments } = entry
      return [...items, { kind: 'user', text, ...(attachments && { attachments }) }]
    }
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
        chats: action.chats.map(toView),
        contextDefaults: action.contextDefaults,
        mods: action.mods,
        modelLists: action.modelLists,
      })
    case 'engine.updated':
      return { ...state, engines: state.engines.map((e) => (e.id === action.engine.id ? action.engine : e)) }
    case 'accounts.updated': {
      const { engine } = action.accounts
      const known = state.accounts.some((a) => a.engine === engine)
      const accounts = known
        ? state.accounts.map((a) => (a.engine === engine ? action.accounts : a))
        : [...state.accounts, action.accounts]
      return { ...state, accounts }
    }
    case 'chat.added':
      return {
        ...state,
        chats: state.chats.some((c) => c.id === action.chat.id) ? state.chats : [...state.chats, toView(action.chat)],
        selectedId: action.chat.id,
      }
    case 'chat.updated':
      return updateChat(state, action.chat.id, (c) => ({
        ...c,
        model: undefined,
        thinking: undefined,
        ...action.chat,
      }))
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
    case 'chat.queue':
      return updateChat(state, action.chatId, (c) => ({ ...c, queue: action.queue }))
    case 'chat.context':
      if (action.chatId !== state.selectedId) return state
      return { ...state, context: { chatId: action.chatId, items: action.items } }
    case 'context.file': {
      const { context } = state
      if (!context) return state
      const items = context.items.map((i) => (i.path === action.path ? { ...i, text: action.text } : i))
      return { ...state, context: { ...context, items } }
    }
    case 'context.defaults':
      return { ...state, contextDefaults: action.defaults }
    case 'mods.updated':
      return { ...state, mods: action.mods }
    case 'models.updated':
      return { ...state, modelLists: { ...state.modelLists, [action.engine]: action.lists } }
    case 'memory.updated':
      return state
    case 'error':
      return {
        ...state,
        toasts: [...state.toasts, { id: state.nextToastId, message: action.message }],
        nextToastId: state.nextToastId + 1,
      }
    case 'connection':
      return { ...state, connected: action.connected, rejected: action.rejected ?? false }
    case 'select':
      return { ...state, selectedId: action.chatId, context: undefined }
    case 'toast.dismiss':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) }
  }
}

const newestFirst = (a: ChatView, b: ChatView) => b.createdAt.localeCompare(a.createdAt)

export type TreeRow = { chat: ChatView; depth: number }

export function chatTree(chats: ChatView[]) {
  const parentOf = (c: ChatView) => (chats.some((p) => p.id === c.parentId) ? c.parentId : MAIN_CHAT_ID)
  const below = (chat: ChatView, archived: boolean) =>
    chats
      .filter((c) => c.id !== MAIN_CHAT_ID && parentOf(c) === chat.id && c.archived === archived)
      .sort((a, b) => Number(!!b.subagent) - Number(!!a.subagent) || newestFirst(a, b))
  const walk = (chat: ChatView, depth: number, archived: boolean): TreeRow[] => [
    { chat, depth },
    ...below(chat, archived).flatMap((c) => walk(c, depth + 1, archived)),
  ]
  const main = chats.find((c) => c.id === MAIN_CHAT_ID)
  const archivedRoots = chats.filter((c) => c.archived && !chats.find((p) => p.id === c.parentId)?.archived)
  return {
    active: main ? walk(main, 0, false) : [],
    archived: archivedRoots.sort(newestFirst).flatMap((c) => walk(c, 0, true)),
  }
}

export const familyOf = (chats: ChatView[], chatId: string): ChatView[] => [
  ...chats.filter((c) => c.id === chatId),
  ...chats.filter((c) => c.parentId === chatId).flatMap((c) => familyOf(chats, c.id)),
]

export function folderOf(chats: ChatView[], chat: ChatView): string | undefined {
  const parent = chats.find((c) => c.id === chat.parentId)
  return chat.folders[0] ?? (parent && folderOf(chats, parent))
}

export const MIN_WINDOW_PX = { width: 375, height: 600 }
export const PANEL_PX = { sidebar: 232, context: 320 }
const PANE_PADDING_PX = 24
export const COLUMN_PX = { min: MIN_WINDOW_PX.width - 2 * PANE_PADDING_PX, default: 760 }

export function dockedPanels(windowPx: number) {
  const sidebar = PANEL_PX.sidebar + MIN_WINDOW_PX.width
  if (windowPx >= sidebar + PANEL_PX.context) return 'both'
  return windowPx >= sidebar ? 'sidebar' : 'none'
}

export function storedColumn(value: string | null) {
  const px = Number(value ?? NaN)
  return Number.isFinite(px) ? Math.max(Math.round(px), COLUMN_PX.min) : COLUMN_PX.default
}

export function columnSlider(savedPx: number, paneColumnPx: number) {
  const max = Math.max(Math.floor(paneColumnPx), COLUMN_PX.min)
  return { min: COLUMN_PX.min, max, value: Math.min(Math.max(savedPx, COLUMN_PX.min), max) }
}

export const storedFlag = (value: string | null, fallback: boolean) =>
  value === 'true' || value === 'false' ? value === 'true' : fallback

export const folderName = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path

export const engineProblem = (engine: EngineInfo) =>
  !engine.installed ? 'not installed' : !engine.signedIn ? 'not signed in' : undefined

export function engineOptions(engines: EngineInfo[], current: string) {
  const options: { id: string; label: string; disabled?: true }[] = engines
    .filter((e) => e.enabled)
    .map((e) => ({ id: e.id, label: engineProblem(e) ? `${e.id} (${engineProblem(e)})` : e.id }))
  if (options.some((o) => o.id === current)) return options
  const known = engines.some((e) => e.id === current)
  return [...options, { id: current, label: `${current} (${known ? 'off' : 'unknown'})`, disabled: true as const }]
}

export const NO_LISTS: ModelLists = { chat: [], planning: [], searching: [], subagents: [] }

export const modelMenu = (chat: ChatView, engine?: EngineInfo, lists = NO_LISTS) => ({
  model: pickModel(engine, lists, chat),
  models: engine?.models ?? [],
  thinking: pickThinking(engine, chat),
  levels: engine?.thinking ?? [],
})

export function formatBytes(bytes: number) {
  if (bytes < 1000) return `${bytes} B`
  const [value, unit] = bytes < 1_000_000 ? [bytes / 1000, 'KB'] : [bytes / 1_000_000, 'MB']
  return `${value < 10 ? Number(value.toFixed(1)) : Math.round(value)} ${unit}`
}

export const MAX_PREVIEW_BYTES = 1_000_000

export function pinState(chat: ChatView, items: ContextItem[] | undefined, path: string) {
  if (chat.id === MAIN_CHAT_ID || chat.archived || !items) return undefined
  const pinned = items.some((i) => i.section === 'files' && i.from === chat.id && i.path === path)
  return pinned ? 'pinned' : 'unpinned'
}

export const previewText = (bytes: Uint8Array) =>
  looksBinary(bytes) ? undefined : new TextDecoder().decode(bytes.subarray(0, MAX_PREVIEW_BYTES), { stream: true })

export function accountLabel(account: Account) {
  if (account.id === 'default') return (account.signedIn && account.label) || 'Not signed in'
  const missing = account.kind === 'apiKey' ? 'key file missing' : 'signed out'
  if (account.signedIn === false) return `${account.name} (${missing})`
  return account.label ? `${account.name} (${account.label})` : account.name
}

export function listedAccounts({ active, accounts }: EngineAccounts) {
  const own = accounts.find((a) => a.id === 'default')
  const sameLogin = (a: Account) => a !== own && a.kind === 'login' && a.signedIn && a.label === own?.label
  const twin = own?.signedIn && own.label && accounts.find(sameLogin)
  if (!own || !twin) return { active, accounts }
  return { active: active === own.id ? twin.id : active, accounts: accounts.filter((a) => a !== own) }
}
