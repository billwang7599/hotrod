import {
  isThinkingLevel,
  levelsOf,
  MODEL_ROLES,
  ROLE_NAMES,
  THINKING_LEVELS,
  type ChatInfo,
  type CoreMessage,
  type EngineInfo,
  type EngineStatus,
  type MemorySettings,
  type ModelLists,
  type ModelRole,
  type ModelRow,
  type Run,
  type Setup,
  type ThinkingLevel,
} from './shared.ts'
import type { Chat } from './chat.ts'

// Model choice, in one place. Settings keep one priority list per role, each an ordered list of {engine, model,
// thinking} rows that can mix engines; this module reads and writes them and decides what every chat, worker and
// summary runs on. Adapters only say what they offer (EngineStatus) and run what they're handed (SessionOptions). The
// Kothar MCP server and the UI never choose: they name a role at most, and the UI shows the Run the core sends.

// Each engine's cheap model, newest first: Claude's Haikus, then Codex's Lunas.
export const SUMMARY_MODELS = ['claude-haiku-5-5', 'claude-haiku-4-5', 'gpt-6-luna', 'gpt-5.6-luna']

// setup: the setup the chat uses, if any. Its model comes after the chat's own pick and before the list; its thinking
// level after the chat's own and before the row's.
type Chooses = Pick<ChatInfo, 'engine' | 'model' | 'thinking' | 'role'> & { setup?: SetupChoice }
export type SetupChoice = Pick<Setup, 'name' | 'engine' | 'model' | 'thinking'>

export type ModelSettings = {
  engines: Record<string, boolean>
  // Older Kothars saved one set of lists per engine, plus a default thinking level per engine (`defaultThinking`);
  // opening migrates them (migrateModels).
  models?: Partial<ModelLists>
  defaultThinking?: Record<string, string>
  memory?: MemorySettings
}

export function openModels({
  settings,
  save,
  engines,
  defaultEngine,
  broadcast,
}: {
  settings: ModelSettings
  save: () => void
  // Every engine Kothar has an adapter for, in adapter order.
  engines: () => EngineInfo[]
  defaultEngine: string
  broadcast: (message: CoreMessage) => void
}) {
  const engineOf = (id: string) => engines().find((e) => e.id === id)
  const lists = (): ModelLists =>
    Object.fromEntries(MODEL_ROLES.map((role) => [role, rowsOf(settings.models?.[role])])) as ModelLists
  const ids = engines().map((e) => e.id)
  const migrated = migrateModels(settings.models, settings.defaultThinking, [
    ...(settings.engines[defaultEngine] ? [defaultEngine] : []),
    ...ids.filter((id) => settings.engines[id]),
    ...ids,
  ])
  if (migrated) {
    settings.models = migrated
    delete settings.defaultThinking
    save()
  }
  const setLists = (next: ModelLists) => {
    settings.models = next
    save()
    broadcast({ type: 'models.updated', lists: next })
  }
  // The engine a new chat starts on before anything runs: the default engine if it's on, else the first that is.
  const firstOn = () =>
    engineOf(defaultEngine)?.enabled ? defaultEngine : (engines().find((e) => e.enabled)?.id ?? defaultEngine)

  /**
   * The model a setup pins, if it names an engine: its own model there, else the first of the list's rows on that
   * engine that can run, else the engine's default model.
   */
  const setupRow = (setup: SetupChoice | undefined, list: ModelRow[]) => {
    if (setup?.engine === undefined) return undefined
    if (setup.model !== undefined) return { engine: setup.engine, model: setup.model }
    const engine = engineOf(setup.engine)
    const row = list.find((r) => r.engine === setup.engine && canRun(engine, r.model))
    const model = row?.model ?? engine?.defaultModel ?? engine?.models?.[0]?.id
    return model === undefined ? undefined : { engine: setup.engine, model }
  }

  /**
   * What a chat runs: its own model if it picked one (on its engine), else its setup's, else the first row in its
   * role's list (or the Chat list) that can run, even on another engine. The thinking level is the chat's own, else
   * the setup's, else the row's, else the fallback, snapped to one the model takes. Undefined when nothing can run; a
   * chat's own pick or a setup's that can't run doesn't fall back to the list.
   */
  const runOf = (chat: Chooses): Run | undefined => {
    const list = listFor(lists(), chat.role)
    const pinned = chat.model !== undefined ? { engine: chat.engine, model: chat.model } : setupRow(chat.setup, list)
    const row = pinned
      ? { ...pinned, ...list.find((r) => r.engine === pinned.engine && r.model === pinned.model) }
      : list.find((r) => canRun(engineOf(r.engine), r.model))
    if (!row || !canRun(engineOf(row.engine), row.model)) return undefined
    const engine = engineOf(row.engine)
    const wanted = chat.thinking ?? chat.setup?.thinking ?? row.thinking
    const thinking = wanted ? snapLevel(wanted, levelsOf(engine, row.model)) : fallbackLevel(engine, row.model)
    return { engine: row.engine, model: row.model, ...(thinking && { thinking }) }
  }

  return {
    lists,
    runOf,

    /** The engine a new chat sits on: the one its list (a worker's role list, else Chat's) runs first. */
    engineFor: (role?: ModelRole, setup?: SetupChoice) =>
      runOf({ engine: firstOn(), role, setup })?.engine ?? setup?.engine ?? firstOn(),

    /** A chat's own pick on `engine`: the first model of its list there, else the engine's default model. */
    pinOn(engine: string, role?: ModelRole): Pick<ChatInfo, 'model' | 'thinking'> | undefined {
      const info = engineOf(engine)
      const row = listFor(lists(), role).find((r) => r.engine === engine && canRun(info, r.model))
      if (row) return { model: row.model, ...(row.thinking && { thinking: row.thinking }) }
      const model = info?.defaultModel ?? info?.models?.[0]?.id
      return model ? { model } : undefined
    },

    /**
     * What a chat saves when the user picks `model` on `engine` (none: follow its setup or list again) and `thinking`
     * (none: the setup's or list's). Picking what the setup or list runs anyway, or the level it would run at, follows
     * them again, so the chat keeps up with Settings. The caller checks the engine exists and is on.
     */
    choose(chat: Chooses, engine?: string, model?: string, thinking?: string): Pick<ChatInfo, 'engine' | 'model' | 'thinking'> {
      const on = model === undefined ? undefined : (engine ?? chat.engine)
      if (on !== undefined && !engineOf(on)?.models?.some((m) => m.id === model)) {
        throw new Error(`Engine "${on}" offers no model "${model}"`)
      }
      if (thinking !== undefined && !isThinkingLevel(thinking)) throw new Error(`Unknown thinking level "${thinking}"`)
      const listed = runOf({ engine: chat.engine, role: chat.role, setup: chat.setup })
      const own = on !== undefined && !(listed?.engine === on && listed.model === model)
      const runs = own ? runOf({ engine: on!, model, role: chat.role, setup: chat.setup }) : listed
      if (thinking && runs && !levelsOf(engineOf(runs.engine), runs.model).includes(thinking)) {
        throw new Error(`Model "${runs.model}" offers no thinking level "${thinking}"`)
      }
      const listLevel = runs && runOf({ engine: runs.engine, model: runs.model, role: chat.role, setup: chat.setup })?.thinking
      return {
        engine: own ? on! : (listed?.engine ?? chat.engine),
        model: own ? model : undefined,
        thinking: thinking === listLevel ? undefined : thinking,
      }
    },

    /**
     * Why a chat can't run when runOf finds nothing, or undefined when its engine lists no models (not detected yet)
     * and runs as is, with no model named.
     */
    whyNot(chat: Chooses): string | undefined {
      const setup = chat.model === undefined && chat.setup?.engine !== undefined ? chat.setup : undefined
      if (setup) {
        const engine = engineOf(setup.engine!)
        const name = `The setup "${setup.name}"`
        if (!engine) return `${name} runs on engine "${setup.engine}", which is not available. Pick another model in the setup or for this chat.`
        if (!engine.enabled) return `${name} runs on engine "${setup.engine}", which is off. Turn it on in Settings.`
        if (!engine.models?.length) return undefined
        if (setup.model !== undefined) {
          return `Engine "${setup.engine}" no longer offers "${setup.model}", which the setup "${setup.name}" runs. Pick another model in Settings → Setups.`
        }
        return `${name} runs on engine "${setup.engine}", which offers no model now.`
      }
      const engine = engineOf(chat.engine)
      if (!engine) return `Engine "${chat.engine}" is not available. Pick another model for this chat.`
      if (!engine.enabled) return `Engine "${chat.engine}" is off. Turn it on in Settings.`
      if (!engine.models?.length) return undefined
      if (chat.model !== undefined) {
        return `Engine "${chat.engine}" no longer offers "${chat.model}". Pick another model for this chat.`
      }
      const list = chat.role && lists()[chat.role].length ? ROLE_NAMES[chat.role] : 'Chat'
      return `Nothing in the ${list} model list can run. Add a model or turn its engine on in Settings → Models.`
    },

    setList(role: unknown, models: unknown) {
      if (!MODEL_ROLES.includes(role as ModelRole)) throw new Error(`Unknown model role "${role}"`)
      if (!Array.isArray(models) || !models.every(isRow)) {
        throw new Error('A model list must be a list of models, each with its engine and a thinking level')
      }
      // A row whose engine isn't here is kept (and skipped), so a list survives an engine that's gone for a while.
      const rows = rowsOf(models).map((row) => settledRow(engineOf(row.engine), row))
      if (role === 'chat' && !rows.length && engines().some((e) => e.models?.length)) {
        throw new Error('The Chat list needs at least one model')
      }
      setLists({ ...lists(), [role as ModelRole]: rows })
    },

    /**
     * Once engines have said what they offer: gives each row the level it runs at (the engine's own default for one
     * with none, the nearest one the model takes for one it no longer does), and adds an engine's default model to the
     * Chat list when nothing in it can run, so what runs is always on screen.
     */
    settle() {
      const before = lists()
      const settled = Object.fromEntries(
        MODEL_ROLES.map((role) => [role, before[role].map((row) => settledRow(engineOf(row.engine), row))]),
      ) as ModelLists
      if (!settled.chat.some((row) => canRun(engineOf(row.engine), row.model))) {
        const preferred = [defaultEngine, ...engines().map((e) => e.id)].flatMap((id) => engineOf(id) ?? [])
        const seed = preferred.find((e) => canRun(e, e.defaultModel ?? e.models?.[0]?.id))
        const model = seed && (seed.defaultModel ?? seed.models![0]!.id)
        if (seed && model) settled.chat.push(settledRow(seed, { engine: seed.id, model }))
      }
      if (JSON.stringify(settled) !== JSON.stringify(before)) setLists(settled)
    },

    /** The engine and model that write memory summaries: the saved pick, else the first engine on with a cheap model. */
    memory() {
      const saved = settings.memory ?? {}
      const engine = saved.engine ? engineOf(saved.engine) : engines().find((e) => e.enabled && summaryModelOf(e))
      return { engine: engine?.id, model: saved.model ?? summaryModelOf(engine) }
    },
  }
}

/** A role's list, or the Chat list while the role's own is empty. */
const listFor = (lists: ModelLists, role: ModelRole = 'chat') => (lists[role]?.length ? lists[role] : lists.chat) ?? []

/** Whether `model` can run on `engine` now: the engine is on and offers it. */
const canRun = (engine: EngineInfo | undefined, model?: string) =>
  engine?.enabled === true && model !== undefined && (engine.models?.some((m) => m.id === model) ?? false)

/** The level among `levels` nearest to `level`, the cheaper one on a tie; undefined when there are none. */
export function snapLevel(level: ThinkingLevel, levels: readonly ThinkingLevel[]): ThinkingLevel | undefined {
  const at = THINKING_LEVELS.indexOf(level)
  const distance = (l: ThinkingLevel) => Math.abs(THINKING_LEVELS.indexOf(l) - at)
  return [...levels].sort((a, b) => distance(a) - distance(b) || THINKING_LEVELS.indexOf(a) - THINKING_LEVELS.indexOf(b))[0]
}

// The level a model runs at when nothing names one: what its engine runs with no flag, else medium, snapped.
const fallbackLevel = (engine: EngineInfo | undefined, model?: string) =>
  snapLevel(engine?.defaultThinking ?? 'medium', levelsOf(engine, model))

const summaryModelOf = (engine?: EngineInfo) =>
  SUMMARY_MODELS.map((id) => engine?.models?.find((m) => m.id === id || m.id.endsWith(`/${id}`))?.id).find(Boolean)

const isRow = (row: unknown): row is ModelRow => {
  if (typeof row !== 'object' || row === null) return false
  const { engine, model, thinking } = row as Record<string, unknown>
  const text = (value: unknown) => typeof value === 'string' && value !== ''
  return text(engine) && text(model) && (thinking === undefined || isThinkingLevel(thinking))
}

/** A saved model list as rows, without broken ones or a model listed twice. */
const rowsOf = (saved: unknown): ModelRow[] =>
  (Array.isArray(saved) ? saved : []).filter(isRow).flatMap((row, i, rows): ModelRow[] => {
    if (rows.findIndex((r) => r.engine === row.engine && r.model === row.model) !== i) return []
    return [{ engine: row.engine, model: row.model, ...(row.thinking && { thinking: row.thinking }) }]
  })

/**
 * A row as it runs: at the level its model takes nearest to its own, else at the engine's default, or with none for a
 * model that takes none. A row whose model the engine doesn't list (or hasn't yet) stays as it is.
 */
function settledRow(engine: EngineInfo | undefined, row: ModelRow): ModelRow {
  if (!engine?.models?.some((m) => m.id === row.model)) return row
  const levels = levelsOf(engine, row.model)
  const thinking = row.thinking ? snapLevel(row.thinking, levels) : fallbackLevel(engine, row.model)
  return { engine: row.engine, model: row.model, ...(thinking && { thinking }) }
}

type OldLists = Partial<Record<ModelRole, unknown[]>>

/**
 * Settings saved per engine (`models: { <engine>: { <role>: [id or {model, thinking}] } }` plus `defaultThinking:
 * { <engine>: level }`) as the one set of lists: each role's rows from every engine, in `engineOrder` (the default
 * engine first), each at its own level, else its engine's old default. Undefined when there's nothing to migrate.
 */
export function migrateModels(
  saved: unknown,
  defaultThinking: Record<string, string> | undefined,
  engineOrder: string[],
): ModelLists | undefined {
  const old = typeof saved === 'object' && saved !== null ? (saved as Record<string, unknown>) : {}
  const perEngine = Object.values(old).some((value) => typeof value === 'object' && value !== null && !Array.isArray(value))
  if (!perEngine && defaultThinking === undefined) return undefined
  if (!perEngine) return Object.fromEntries(MODEL_ROLES.map((role) => [role, rowsOf(old[role])])) as ModelLists
  const engines = [...new Set([...engineOrder, ...Object.keys(old)])].filter((id) => id in old)
  const level = (value: unknown) => (isThinkingLevel(value) ? value : undefined)
  const rowsFor = (role: ModelRole) =>
    engines.flatMap((engine) =>
      ((old[engine] as OldLists)?.[role] ?? []).flatMap((entry) => {
        const { model, thinking } = typeof entry === 'string' ? { model: entry, thinking: undefined } : (entry as any)
        const runsAt = level(thinking) ?? level(defaultThinking?.[engine])
        return typeof model === 'string' && model ? [{ engine, model, ...(runsAt && { thinking: runsAt }) }] : []
      }),
    )
  return Object.fromEntries(MODEL_ROLES.map((role) => [role, rowsOf(rowsFor(role))])) as ModelLists
}

// A chat that follows its model list sits on the engine the list picks, so its engine, accounts and notes are right;
// any chat whose run changed is shown again (showRun).
export function followModels(
  chats: Iterable<Chat>,
  deps: { runOf: (chat: Chat) => Run | undefined; setEngine: (chat: Chat, engine: string) => void; showRun: (chat: Chat) => void },
) {
  for (const chat of chats) {
    const run = deps.runOf(chat)
    const follows = chat.info.model === undefined && chat.status === 'idle'
    if (follows && run && run.engine !== chat.info.engine) deps.setEngine(chat, run.engine)
    else if (JSON.stringify(run) !== chat.shownRun) deps.showRun(chat)
  }
}

// An engine's detected status with its models named and ordered for the UI: Claude models by family and newest first
// ("Opus 5.5"), dated snapshots dropped, other ids as they are; each provider's models stay together.
const CLAUDE_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku']
const CLAUDE_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/
// A dated snapshot like claude-haiku-4-5-20251001 repeats the model its alias names.
const SNAPSHOT_ID = /-\d{8}$/

const providerOf = (id: string) => id.slice(0, id.lastIndexOf('/') + 1)

function describeModel(id: string) {
  const [, family = '', major = '', minor] = id.slice(providerOf(id).length).match(CLAUDE_ID) ?? []
  const known = CLAUDE_FAMILIES.indexOf(family)
  const rank = known < 0 ? CLAUDE_FAMILIES.length : known
  if (!family) return { label: id, rank, version: 0 }
  const label = `${family[0]!.toUpperCase()}${family.slice(1)} ${major}${minor === undefined ? '' : `.${minor}`}`
  return { label, rank, version: Number(major) * 100 + Number(minor ?? 0) }
}

export function nameModels(status: EngineStatus): Omit<EngineInfo, 'id' | 'enabled'> {
  const { models, defaultModel, modelThinking, ...rest } = status
  if (!models) return { ...rest, ...(defaultModel && { defaultModel }) }
  const providers = [...new Set(models.map(providerOf))]
  const named = models
    .filter((id) => !SNAPSHOT_ID.test(id))
    .map((id) => ({ id, provider: providers.indexOf(providerOf(id)), ...describeModel(id) }))
    .sort((a, b) => a.provider - b.provider || a.rank - b.rank || b.version - a.version)
  const shown = defaultModel && (named.some((m) => m.id === defaultModel) ? defaultModel : named[0]?.id)
  const options = named.map(({ id, label }) => ({ id, label, ...(modelThinking?.[id] && { thinking: modelThinking[id] }) }))
  return { ...rest, models: options, ...(shown && { defaultModel: shown }) }
}
