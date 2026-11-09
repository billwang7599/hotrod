import type { ModView } from '@kotharhq/mod-api'
import { bySpaceOrder, levelsOf, looksBinary, NO_LISTS } from '@kotharhq/core/shared'
import type {
  Account,
  Answers,
  Attachment,
  ChatEntry,
  ChatInfo,
  ChatState,
  ChatStatus,
  CommandInfo,
  ContextItem,
  ContextSection,
  CoreMessage,
  EngineAccounts,
  EngineInfo,
  ModelLists,
  Run,
  ModInfo,
  PanelTab,
  QueuedMessage,
  Question,
  ToolKind,
  WorkFolder,
} from '@kotharhq/core/shared'

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
  | { kind: 'user'; text: string; attachments?: Attachment[]; midTurn?: true }
  | { kind: 'report'; chatId: string; name: string; text: string; error?: string }
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
  | {
      kind: 'question'
      requestId: string
      questions: Question[]
      outcome: 'pending' | 'answered' | 'skipped' | 'cancelled'
      answers?: Answers
    }
  | { kind: 'error'; text: string }
  // mod and panel: clicking the note opens that mod's panel.
  | { kind: 'note'; text: string; mod?: string; panel?: string }

export type ChatView = ChatInfo & {
  // What the chat runs now, as the core picked it; absent when nothing can run.
  run?: Run
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
  modelLists: ModelLists
  workFolder: WorkFolder
  context?: { chatId: string; items: ContextItem[] }
  // The selected chat's mod panels and commands, and the views of the panels it has opened (panelKey).
  modUi?: { chatId: string; panels: PanelTab[]; commands: CommandInfo[] }
  panelViews: Record<string, { view?: ModView; error?: string }>
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
  modelLists: NO_LISTS,
  workFolder: { defaultPath: '', canSandbox: true },
  panelViews: {},
  toasts: [],
  nextToastId: 1,
}

const cancel = <P extends { outcome: string }>(p: P): P => (p.outcome === 'pending' ? { ...p, outcome: 'cancelled' } : p)

// Logs from before reports had their own entry carry them as user messages in this form.
const OLD_REPORT = /^\[subagent "(.*)" \(([0-9a-f]+)\)\] ([\s\S]*?)(?: \(The turn ended early: (.*)\))?$/
const NO_REPLY = '(No reply)'

function applyEntry(items: Item[], entry: ChatEntry): Item[] {
  switch (entry.type) {
    case 'user.message': {
      const { text, attachments } = entry
      const old = attachments ? null : OLD_REPORT.exec(text)
      if (old) {
        const [, name, chatId, reply, error] = old as unknown as string[]
        const replyText = reply === NO_REPLY ? '' : reply!
        return [...items, { kind: 'report', chatId: chatId!, name: name!, text: replyText, ...(error && { error }) }]
      }
      return [...items, { kind: 'user', text, ...(attachments && { attachments }), ...(entry.midTurn && { midTurn: true }) }]
    }
    case 'subagent.report': {
      const { chatId, name, text, error } = entry
      return [...items, { kind: 'report', chatId, name, text, ...(error && { error }) }]
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
    case 'question.asked': {
      const { requestId, questions, toolId } = entry
      const asked: Item = { kind: 'question', requestId, questions, outcome: 'pending' }
      const own = items.findIndex((i) => i.kind === 'tool' && i.toolId === toolId)
      return own < 0 ? [...items, asked] : items.with(own, asked)
    }
    case 'question.resolved': {
      const { requestId, answers } = entry
      const outcome = answers ? { outcome: 'answered' as const, answers } : { outcome: 'skipped' as const }
      return items.map((i) => (i.kind === 'question' && i.requestId === requestId ? { ...i, ...outcome } : i))
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
          : i.kind === 'permission' || i.kind === 'question'
            ? cancel(i)
            : i,
      )
      return entry.error ? [...settled, { kind: 'error', text: entry.error }] : settled
    }
    case 'mod.note': {
      const { text, mod, panel } = entry
      return [...items, { kind: 'note', text, ...(mod && panel && { mod, panel }) }]
    }
    // The turn's error or a mod's note says it.
    case 'limit.reached':
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

const asking = (item: Item) => item.kind === 'question' && item.outcome === 'pending'

// The last turn folds too unless `unfoldLast`; it never folds while a permission request in it waits. A question
// waiting for an answer is never folded away: it shows after the folded steps, like the reply. Answered ones fold.
export function foldSteps(items: Item[], unfoldLast: boolean): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  let turn: Shown[] = []
  const endTurn = (live: boolean) => {
    let end = turn.length
    while (turn[end - 1]?.item.kind === 'error' || turn[end - 1]?.item.kind === 'note') end--
    if (turn[end - 1]?.item.kind === 'text') end--
    const steps = turn.slice(0, end).filter((s) => !asking(s.item))
    if (live || steps.length < 2) rows.push(...turn)
    else {
      const kept = turn.slice(0, end).filter((s) => asking(s.item))
      rows.push({ at: steps[0]!.at, steps: steps.map((s) => s.item) }, ...kept, ...turn.slice(end))
    }
    turn = []
  }
  items.forEach((item, at) => {
    if (item.kind !== 'user' && item.kind !== 'report') turn.push({ at, item })
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
        run: undefined,
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
    case 'chat.mods': {
      if (action.chatId !== state.selectedId) return state
      const { chatId, panels, commands } = action
      return { ...state, modUi: { chatId, panels, commands } }
    }
    case 'mod.panel': {
      if (action.chatId !== state.selectedId) return state
      const { view, error } = action
      const key = panelKey(action.chatId, action.mod, action.panel)
      return { ...state, panelViews: { ...state.panelViews, [key]: { ...(view && { view }), ...(error && { error }) } } }
    }
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
      return { ...state, modelLists: action.lists }
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
      return { ...state, selectedId: action.chatId, context: undefined, modUi: undefined, panelViews: {} }
    case 'toast.dismiss':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) }
  }
}

export const panelKey = (chatId: string, mod: string, panel: string) => `${chatId}/${mod}/${panel}`

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
      .sort((a, b) => Number(!!b.mod) - Number(!!a.mod) || bySpaceOrder(a, b))
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
/** The chat column's width. It never exceeds the pane (CSS caps it at 100%); `max` only bounds a saved value. */
export const COLUMN_PX = { min: MIN_WINDOW_PX.width - 2 * PANE_PADDING_PX, max: 2400, default: 760 }

export function dockedPanels(windowPx: number, widths: typeof PANEL_PX = PANEL_PX) {
  const sidebar = widths.sidebar + MIN_WINDOW_PX.width
  if (windowPx >= sidebar + widths.context) return 'both'
  return windowPx >= sidebar ? 'sidebar' : 'none'
}

export function storedColumn(value: string | null) {
  const px = Number(value ?? NaN)
  return Number.isFinite(px) ? Math.min(Math.max(Math.round(px), COLUMN_PX.min), COLUMN_PX.max) : COLUMN_PX.default
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

export const engineName = (engine?: Pick<EngineInfo, 'id' | 'name'>) => engine?.name ?? engine?.id ?? ''

// A model on an engine as one Select value; model ids can hold '/', never a newline.
export const modelKey = (choice: { engine: string; model: string }) => `${choice.engine}\n${choice.model}`
export const fromModelKey = (key: string) => {
  const [engine = '', model = ''] = key.split('\n')
  return { engine, model }
}

// name: the model's own label; label: with its engine added when more than one engine offers models; group: the engine.
export type ModelChoice = { engine: string; model: string; name: string; label: string; group: string }

/** Every model the engines that are on offer, labelled with its engine when more than one engine offers models. */
export function modelChoices(engines: EngineInfo[]): ModelChoice[] {
  const offering = engines.filter((e) => e.enabled && e.models?.length)
  const mixed = offering.length > 1
  return offering.flatMap((e) =>
    e.models!.map((m) => ({
      engine: e.id,
      model: m.id,
      name: m.label,
      label: mixed ? `${m.label} · ${engineName(e)}` : m.label,
      group: engineName(e),
    })),
  )
}

/**
 * What a chat's model and thinking pickers show: what it runs (the core's pick, sent with the chat), the models it can
 * pick and the levels the running model takes. `runnable` is false when sending would fail: nothing can run, unless
 * its engine lists no models (not detected yet), in which case the engine runs as is.
 */
export function modelMenu(chat: ChatView, engines: EngineInfo[]) {
  const { run } = chat
  const engine = engines.find((e) => e.id === (run?.engine ?? chat.engine))
  const choices = modelChoices(engines)
  // A pick of the chat's own that can't run stays on show, so the user sees why nothing runs.
  if (!run && chat.model && !choices.some((c) => c.engine === chat.engine && c.model === chat.model)) {
    const label = `${chat.model} (not available)`
    choices.push({ engine: chat.engine, model: chat.model, name: chat.model, label, group: engineName(engine) || chat.engine })
  }
  const runnable = run !== undefined || (engine?.enabled === true && !engine.models?.length)
  const shown = run ?? (chat.model ? { engine: chat.engine, model: chat.model } : undefined)
  return {
    run,
    runnable,
    value: shown && modelKey(shown),
    choices,
    thinking: run?.thinking,
    levels: run ? levelsOf(engine, run.model) : [],
  }
}

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
