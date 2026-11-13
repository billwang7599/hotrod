// Workers: a chat hands a task to a new chat below it, which reports back when it ends. They're part of the core, not
// an extension: child chats are the core's own chat tree, spawn_worker is a Kothar MCP tool (kothar-mcp.ts), and
// extensions start workers through host.createChat({ parentId }), so every engine and extension can count on them.
// Their settings live in settings.json under `workers` (Settings → Workers):
// - start: whether agents may start workers with spawn_worker (default on). Off, chats get neither the tool nor the
//   instructions; extensions can still start workers for their own work (Deep Research's searches).
// - limit: how many workers one chat runs at once (-1: no limit), counting every child, spawn_worker's and extensions'.
// - instructions: the user's edit of WORKER_INSTRUCTIONS, saved against the default it replaced (a PromptEdit).
import type { Settings } from './chat-store.ts'
import type { Chat } from './chat.ts'
import type { PromptEdit } from './prompts.ts'
import { MAX_PROMPT_CHARS } from './prompts.ts'
import type { CoreMessage, Setup, WorkersSettings } from './shared.ts'

export const WORKER_INSTRUCTIONS =
  'Delegate by default. Any task that needs more than a few tool calls (exploring code, making a change, running ' +
  'tests, researching) goes to a worker you start with spawn_worker, not to you, so you stay free to keep ' +
  'talking with the user while it runs. Split the work into as many workers as it needs, each with a whole task ' +
  "it can finish on its own, independent of the others. You can edit the same files, just ensure they're in " +
  'different worktrees, and make a stack PR so we have less merge conflicts. Do the work yourself only for quick ' +
  "answers and one-line changes. Each worker's final reply comes back to you as a message, so don't wait for it " +
  'or poll it; tell the user what you started and carry on. To stop a worker you no longer need, use stop_chat.'

export const DEFAULT_WORKER_LIMIT = 4
// The id the Inspector and Settings use for the workers' instructions (Settings → Workers, #prompt-workers-instructions).
export const WORKERS_PROMPT = { page: 'workers', id: 'instructions', label: 'When to start workers' } as const

export type SavedWorkers = { start?: boolean; limit?: number; instructions?: PromptEdit }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Moves what the Workers extension saved (settings.extensions.workers: its switch, limit and instructions) to the
 * core's `workers`, in place. A Workers switch left off becomes start: false; a limit of 0 (which let no agent start
 * one) does too, with the default limit, since the limit now counts extensions' workers as well. Returns whether
 * anything changed.
 */
export function moveWorkersSettings(settings: Settings): boolean {
  const saved = settings.extensions?.workers
  if (!isRecord(saved)) return false
  const workers: SavedWorkers = { ...(isRecord(settings.workers) ? settings.workers : {}) }
  if (saved.enabled === false) workers.start = false
  if (typeof saved.limit === 'number' && Number.isInteger(saved.limit)) {
    if (saved.limit === 0) workers.start = false
    else if (saved.limit >= -1) workers.limit = saved.limit
  }
  if (typeof saved.instructions === 'string' && saved.instructions !== WORKER_INSTRUCTIONS && saved.instructions.trim()) {
    workers.instructions = { text: saved.instructions, base: WORKER_INSTRUCTIONS }
  }
  const { workers: _, ...others } = settings.extensions!
  settings.extensions = others
  if (settings.prompts?.workers) {
    const { workers: __, ...prompts } = settings.prompts
    settings.prompts = prompts
  }
  if (Object.keys(workers).length) settings.workers = workers
  return true
}

/** A setup that says `workers: false`, or one an older Kothar saved with Workers in extensionsOff. */
export const setupStopsWorkers = (setup: Setup | undefined) => setup?.workers === false

export type WorkersDeps = {
  settings: Settings
  saveSettings: () => void
  broadcast: (message: CoreMessage) => void
  // The settings changed: workers waiting for a slot may start under a higher limit.
  changed?: () => void
}

export function openWorkers({ settings, saveSettings, broadcast, changed }: WorkersDeps) {
  const saved = (): SavedWorkers => (isRecord(settings.workers) ? settings.workers : {})
  const edit = () => {
    const { instructions } = saved()
    return instructions && typeof instructions.text === 'string' && typeof instructions.base === 'string' ? instructions : undefined
  }
  const start = () => saved().start !== false
  const limit = () => {
    const value = saved().limit
    return typeof value === 'number' && Number.isInteger(value) && (value === -1 || value >= 1) ? value : DEFAULT_WORKER_LIMIT
  }
  const instructions = () => edit()?.text ?? WORKER_INSTRUCTIONS

  const info = (): WorkersSettings => {
    const own = edit()
    return {
      start: start(),
      limit: limit(),
      instructions: {
        id: WORKERS_PROMPT.id,
        label: WORKERS_PROMPT.label,
        where: 'instructions',
        default: WORKER_INSTRUCTIONS,
        text: own?.text ?? WORKER_INSTRUCTIONS,
        ...(own && { edited: true as const }),
        ...(own && own.base !== WORKER_INSTRUCTIONS && { updatedDefault: true as const }),
      },
    }
  }
  const write = (change: SavedWorkers) => {
    const next: SavedWorkers = { ...saved(), ...change }
    for (const key of Object.keys(next) as (keyof SavedWorkers)[]) if (next[key] === undefined) delete next[key]
    if (Object.keys(next).length) settings.workers = next
    else delete settings.workers
    saveSettings()
    broadcast({ type: 'workers.updated', workers: info() })
    changed?.()
  }

  return {
    info,
    instructions,
    edited: () => edit() !== undefined,
    limit,
    start,
    set(change: { start?: unknown; limit?: unknown }) {
      if (change.start !== undefined && typeof change.start !== 'boolean') throw new Error('Let agents start workers is on or off')
      if (change.limit !== undefined) {
        const value = change.limit
        if (typeof value !== 'number' || !Number.isInteger(value) || (value !== -1 && value < 1)) {
          throw new Error('Max running per chat is a whole number, 1 or more, or -1 for no limit')
        }
      }
      write({
        ...(change.start !== undefined && { start: change.start === false ? false : undefined }),
        ...(change.limit !== undefined && { limit: change.limit === DEFAULT_WORKER_LIMIT ? undefined : (change.limit as number) }),
      })
    },
    // text undefined (or the default itself): back to the default.
    setInstructions(text: unknown) {
      if (text !== undefined && typeof text !== 'string') throw new Error('A prompt is text')
      if (typeof text === 'string' && text.length > MAX_PROMPT_CHARS) throw new Error(`A prompt is at most ${MAX_PROMPT_CHARS} characters`)
      const own = text === undefined || text === WORKER_INSTRUCTIONS || !text.trim() ? undefined : { text, base: WORKER_INSTRUCTIONS }
      write({ instructions: own })
    },
  }
}

export type Workers = ReturnType<typeof openWorkers>

// Whether a chat may start workers itself (spawn_worker): agents may (Settings → Workers), it isn't a worker, and its
// setup doesn't leave workers out.
export const agentStartsWorkers = (chat: Chat, workers: Pick<Workers, 'start'>, setup: Setup | undefined) =>
  !chat.info.worker && workers.start() && !setupStopsWorkers(setup)

// What a chat that may start workers is told about them: undefined for a chat that may not.
export const workerInstructionsFor = (chat: Chat, workers: Pick<Workers, 'start' | 'instructions'>, setup: Setup | undefined) =>
  agentStartsWorkers(chat, workers, setup) ? workers.instructions() : undefined

// How many of a chat's children run now (any worker, quiet or not, spawn_worker's or an extension's): what the limit
// counts.
export const runningChildren = (parentId: string, chats: Iterable<{ info: { parentId?: string; worker?: boolean }; status: string }>) =>
  [...chats].filter((c) => c.info.parentId === parentId && c.info.worker && c.status !== 'idle').length
