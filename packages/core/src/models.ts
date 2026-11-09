import {
  isThinkingLevel,
  levelsOf,
  MODEL_ROLES,
  ROLE_NAMES,
  THINKING_LEVELS,
  type ChatInfo,
  type CoreMessage,
  type EngineInfo,
  type MemorySettings,
  type ModelLists,
  type ModelRole,
  type ModelRow,
  type Run,
  type ThinkingLevel,
} from './shared.ts'

// Model choice, in one place. Settings keep one priority list per role, each an ordered list of {engine, model,
// thinking} rows that can mix engines; this module reads and writes them and decides what every chat, subagent and
// summary runs on. Adapters only say what they offer (EngineStatus) and run what they're handed (SessionOptions). The
// Hotrod MCP server and the UI never choose: they name a role at most, and the UI shows the Run the core sends.

export const SUMMARY_MODELS = ['claude-haiku-5-5', 'claude-haiku-4-5']

type Chooses = Pick<ChatInfo, 'engine' | 'model' | 'thinking' | 'role'>

export type ModelSettings = {
  engines: Record<string, boolean>
  // Older Hotrods saved one set of lists per engine, plus a default thinking level per engine (`defaultThinking`);
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
  // Every engine Hotrod has an adapter for, in adapter order.
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
   * What a chat runs: its own model if it picked one (on its engine), else the first row in its role's list (or the
   * Chat list) that can run, even on another engine. The thinking level is the chat's own, else the row's, else the
   * fallback, snapped to one the model takes. Undefined when nothing can run; a chat's own pick that can't run doesn't
   * fall back to the list.
   */
  const runOf = (chat: Chooses): Run | undefined => {
    const list = listFor(lists(), chat.role)
    const row =
      chat.model !== undefined
        ? { engine: chat.engine, model: chat.model, ...list.find((r) => r.engine === chat.engine && r.model === chat.model) }
        : list.find((r) => canRun(engineOf(r.engine), r.model))
    if (!row || !canRun(engineOf(row.engine), row.model)) return undefined
    const engine = engineOf(row.engine)
    const wanted = chat.thinking ?? row.thinking
    const thinking = wanted ? snapLevel(wanted, levelsOf(engine, row.model)) : fallbackLevel(engine, row.model)
    return { engine: row.engine, model: row.model, ...(thinking && { thinking }) }
  }

  return {
    lists,
    runOf,

    /** The engine a new chat sits on: the one its list (a subagent's role list, else Chat's) runs first. */
    engineFor: (role?: ModelRole) => runOf({ engine: firstOn(), role })?.engine ?? firstOn(),

    /** A chat's own pick on `engine`: the first model of its list there, else the engine's default model. */
    pinOn(engine: string, role?: ModelRole): Pick<ChatInfo, 'model' | 'thinking'> | undefined {
      const info = engineOf(engine)
      const row = listFor(lists(), role).find((r) => r.engine === engine && canRun(info, r.model))
      if (row) return { model: row.model, ...(row.thinking && { thinking: row.thinking }) }
      const model = info?.defaultModel ?? info?.models?.[0]?.id
      return model ? { model } : undefined
    },

    /**
     * What a chat saves when the user picks `model` on `engine` (none: follow the list again) and `thinking` (none:
     * the list's). Picking what the list runs anyway, or the level it would run at, follows the list again, so the chat
     * keeps up with Settings. The caller checks the engine exists and is on.
     */
    choose(chat: Chooses, engine?: string, model?: string, thinking?: string): Pick<ChatInfo, 'engine' | 'model' | 'thinking'> {
      const on = model === undefined ? undefined : (engine ?? chat.engine)
      if (on !== undefined && !engineOf(on)?.models?.some((m) => m.id === model)) {
        throw new Error(`Engine "${on}" offers no model "${model}"`)
      }
      if (thinking !== undefined && !isThinkingLevel(thinking)) throw new Error(`Unknown thinking level "${thinking}"`)
      const listed = runOf({ engine: chat.engine, role: chat.role })
      const own = on !== undefined && !(listed?.engine === on && listed.model === model)
      const runs = own ? runOf({ engine: on!, model, role: chat.role }) : listed
      if (thinking && runs && !levelsOf(engineOf(runs.engine), runs.model).includes(thinking)) {
        throw new Error(`Model "${runs.model}" offers no thinking level "${thinking}"`)
      }
      const listLevel = runs && runOf({ engine: runs.engine, model: runs.model, role: chat.role })?.thinking
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
