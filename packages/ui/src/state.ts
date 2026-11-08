import { looksBinary, pickModel, pickThinking } from '@hotrod/core/shared'
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
  ModInfo,
  QueuedMessage,
  ToolKind,
  WorkFolder,
} from '@hotrod/core/shared'

export type Permission = {
  requestId: string
  name: string
  toolKind: ToolKind
  summary: string
  input: unknown
  outcome: 'pending' | 'allowed' | 'denied' | 'cancelled'
  auto?: true
}

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
      permission?: Permission
    }
  | ({ kind: 'permission' } & Permission)
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
  loaded: boolean
  engines: EngineInfo[]
  accounts: EngineAccounts[]
  chats: ChatView[]
  selectedId: string
  contextDefaults: Record<ContextSection, boolean>
  mods: ModInfo[]
  modelLists: Record<string, ModelLists>
  workFolder: WorkFolder
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
  loaded: false,
  engines: [],
  accounts: [],
  chats: [],
  selectedId: '',
  contextDefaults: { agents: true, folders: true, files: true },
  mods: [],
  modelLists: {},
  workFolder: { defaultPath: '', canSandbox: true },
  toasts: [],
  nextToastId: 1,
}

const cancel = <P extends Permission>(p: P): P => (p.outcome === 'pending' ? { ...p, outcome: 'cancelled' } : p)

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
    case 'permission.requested': {
      const { requestId, name, kind: toolKind, summary, input, toolId } = entry
      const permission: Permission = { requestId, name, toolKind, summary, input, outcome: 'pending' }
      const own = (i: Item) => i.kind === 'tool' && i.toolId === toolId
      if (!items.some(own)) return [...items, { kind: 'permission', ...permission }]
      return items.map((i) =>
        i.kind === 'tool' && own(i) ? { ...i, state: i.state === 'running' ? 'waiting' : i.state, permission } : i,
      )
    }
    case 'permission.resolved': {
      const resolve = <P extends Permission>(p: P): P => ({
        ...p,
        outcome: entry.allow ? 'allowed' : 'denied',
        ...(entry.auto && { auto: true }),
      })
      return items.map((i) =>
        i.kind === 'permission' && i.requestId === entry.requestId
          ? resolve(i)
          : i.kind === 'tool' && i.permission?.requestId === entry.requestId
            ? { ...i, state: i.state === 'waiting' ? 'running' : i.state, permission: resolve(i.permission) }
            : i,
      )
    }
    case 'turn.completed':
    case 'session.ended': {
      const settled = items.filter((i) => i.kind !== 'thinking').map((i): Item =>
        i.kind === 'tool'
          ? {
              ...i,
              ...((i.state === 'running' || i.state === 'waiting') && { state: 'stopped' }),
              ...(i.permission && { permission: cancel(i.permission) }),
            }
          : i.kind === 'permission'
            ? cancel(i)
            : i,
      )
      return entry.error ? [...settled, { kind: 'error', text: entry.error }] : settled
    }
    case 'turn.started':
      return items
  }
}

const toView = ({ entries, ...chat }: ChatState): ChatView => ({ ...chat, items: entries.reduce(applyEntry, []) })

type Shown = { at: number; item: Item }
type TranscriptRow = Shown | { at: number; steps: Item[] }

const waiting = (item: Item) =>
  (item.kind === 'permission' && item.outcome === 'pending') ||
  (item.kind === 'tool' && (item.state === 'waiting' || item.permission?.outcome === 'pending'))

// The last turn folds too unless `unfoldLast`; it never folds while a permission request in it waits.
export function foldSteps(items: Item[], unfoldLast: boolean): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  let turn: Shown[] = []
  const endTurn = (live: boolean) => {
    let end = turn.length
    while (turn[end - 1]?.item.kind === 'error') end--
    if (turn[end - 1]?.item.kind === 'text') end--
    if (live || end < 2) rows.push(...turn)
    else rows.push({ at: turn[0]!.at, steps: turn.slice(0, end).map((s) => s.item) }, ...turn.slice(end))
    turn = []
  }
  items.forEach((item, at) => {
    if (item.kind !== 'user') turn.push({ at, item })
    else {
      endTurn(false)
      rows.push({ at, item })
    }
  })
  endTurn(unfoldLast || turn.some((s) => waiting(s.item)))
  return rows
}

function updateChat(state: State, id: string, update: (c: ChatView) => ChatView): State {
  return { ...state, chats: state.chats.map((c) => (c.id === id ? update(c) : c)) }
}

const keepSelection = (state: State): State =>
  state.chats.some((c) => c.id === state.selectedId)
    ? state
    : { ...state, selectedId: chatTree(state.chats).active[0]?.chat.id ?? '' }

const endsText = (entry: ChatEntry) =>
  entry.type === 'text.completed' || entry.type === 'turn.completed' || entry.type === 'session.ended'

export function reduce(state: State, action: Action): State {
  switch (action.type) {
    case 'snapshot':
      return keepSelection({
        ...state,
        loaded: true,
        engines: action.engines,
        accounts: action.accounts,
        chats: action.chats.map(toView),
        contextDefaults: action.contextDefaults,
        mods: action.mods,
        modelLists: action.modelLists,
        workFolder: action.workFolder,
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
        // A subagent appears under its space without taking the view from the chat the user is reading.
        selectedId: action.chat.parentId ? state.selectedId : action.chat.id,
      }
    case 'chat.updated':
      return updateChat(state, action.chat.id, (c) => ({
        ...c,
        model: undefined,
        thinking: undefined,
        ...action.chat,
      }))
    case 'chat.removed': {
      const chats = state.chats.filter((c) => c.id !== action.chatId)
      const removed = familyOf(state.chats, action.chatId)
      if (!removed.some((c) => c.id === state.selectedId)) return keepSelection({ ...state, chats })
      // A subagent goes once it's done, with any below it; whoever was watching lands on the chat above them.
      const parentId = removed[0]?.parentId
      return keepSelection({ ...state, chats, selectedId: parentId ?? state.selectedId })
    }
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
    case 'mod.updated':
      return { ...state, mods: state.mods.map((m) => (m.id === action.mod.id ? action.mod : m)) }
    case 'models.updated':
      return { ...state, modelLists: { ...state.modelLists, [action.engine]: action.lists } }
    case 'memory.updated':
      return state
    case 'workFolder.updated':
      return { ...state, workFolder: action.workFolder }
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
  const below = (chat: ChatView, archived: boolean) =>
    chats
      .filter((c) => c.parentId === chat.id && c.archived === archived)
      .sort((a, b) => Number(!!b.subagent) - Number(!!a.subagent) || newestFirst(a, b))
  const walk = (chat: ChatView, depth: number, archived: boolean): TreeRow[] => [
    { chat, depth },
    ...below(chat, archived).flatMap((c) => walk(c, depth + 1, archived)),
  ]
  const activeRoots = chats.filter((c) => !c.archived && !chats.some((p) => p.id === c.parentId))
  const archivedRoots = chats.filter((c) => c.archived && !chats.find((p) => p.id === c.parentId)?.archived)
  return {
    active: activeRoots
      .sort((a, b) => Number(!!b.mod) - Number(!!a.mod) || newestFirst(a, b))
      .flatMap((c) => walk(c, 0, false)),
    archived: archivedRoots.sort(newestFirst).flatMap((c) => walk(c, 0, true)),
  }
}

export const familyOf = (chats: ChatView[], chatId: string): ChatView[] => [
  ...chats.filter((c) => c.id === chatId),
  ...chats.filter((c) => c.parentId === chatId).flatMap((c) => familyOf(chats, c.id)),
]

/** The chat and the chats above it, nearest first, ending at its space. */
export function lineOf(chats: ChatView[], chat: ChatView): ChatView[] {
  const parent = chats.find((c) => c.id === chat.parentId)
  return parent ? [chat, ...lineOf(chats, parent)] : [chat]
}

const pendingIn = (chat: ChatView): Permission[] =>
  chat.status !== 'waiting'
    ? []
    : chat.items.flatMap((i) =>
        i.kind === 'permission' && i.outcome === 'pending'
          ? [i]
          : i.kind === 'tool' && i.permission?.outcome === 'pending'
            ? [i.permission]
            : [],
      )

export type SubagentRequest = { chat: ChatView; permission: Permission }

/** Permission requests waiting in the subagents below a chat, which the user answers from that chat. */
export const subagentRequests = (chats: ChatView[], chatId: string): SubagentRequest[] =>
  familyOf(chats, chatId)
    .slice(1)
    .filter((c) => c.subagent && !c.archived)
    .flatMap((chat) => pendingIn(chat).map((permission) => ({ chat, permission })))

export function folderOf(chats: ChatView[], chat: ChatView): string | undefined {
  const parent = chats.find((c) => c.id === chat.parentId)
  return chat.folders[0] ?? (parent && folderOf(chats, parent))
}

export const MIN_WINDOW_PX = { width: 375, height: 600 }
export const PANEL_PX = { sidebar: 232, context: 320 }
const PANE_PADDING_PX = 24
export const COLUMN_PX = { min: MIN_WINDOW_PX.width - 2 * PANE_PADDING_PX, default: 760 }

export function dockedPanels(windowPx: number, widths: typeof PANEL_PX = PANEL_PX) {
  const sidebar = widths.sidebar + MIN_WINDOW_PX.width
  if (windowPx >= sidebar + widths.context) return 'both'
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
  if (chat.mod || chat.archived || !items) return undefined
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
