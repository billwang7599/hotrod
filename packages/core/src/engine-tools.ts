// Engines' own built-in tools, switched on and off from Kothar (Settings → Engines → Tools). Each adapter lists the
// tools it knows (Adapter.tools), each with a shared capability and a group that gives its default:
// - core: on. What the engine works with; its model was trained on these exact tools, and Kothar sees and gates every
//   call anyway.
// - replaced: off while Kothar has its own version on (workers for subagents, say), else on.
// - outside: off. It acts where Kothar can't see, stop or log it.
// A tool the engine reports that its adapter doesn't know (a newer engine) is on, marked new, and asks before each use
// as any tool of kind 'other' does. The user's own choice for a tool beats its default.
// Two master switches sit above the per-tool choices: one for every engine and one per engine. Either off turns every
// built-in tool of the engine off, core ones too, leaving the agent only MCP tools (Kothar's and extensions'); the
// per-tool choices stay saved and come back as they were.
// Saved in settings.json under `engineTools`; the tools each engine last reported, in <garage>/engine-tools.json.
// Sessions start fresh each message, so a change counts from the next one.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  Adapter,
  CoreMessage,
  EngineToolRow,
  EngineToolSpec,
  EngineToolsSettings,
  SessionOptions,
  ToolCapability,
} from './shared.ts'

export type { EngineToolRow }

export type SavedEngineTools = {
  // The master switch for every engine; absent means on.
  enabled?: boolean
  engines?: Record<string, { enabled?: boolean; tools?: Record<string, boolean> }>
}

// What Kothar has its own version of, by capability, with who provides it ("Workers"). A chat's own (an extension on
// for it) or, for Settings, what's on anywhere.
export type Provided = ReadonlyMap<ToolCapability, string>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function defaultOn(spec: Pick<EngineToolSpec, 'group' | 'on' | 'capability'>, provided: Provided): boolean {
  if (spec.on !== undefined) return spec.on
  if (spec.group === 'core') return true
  if (spec.group === 'outside') return false
  return !(spec.capability && provided.has(spec.capability))
}

/** Every tool of an engine: the adapter's, in its order, then ones the engine reported that the adapter doesn't know. */
export function toolRowsOf(
  known: readonly EngineToolSpec[],
  reported: readonly string[] | undefined,
  saved: Record<string, boolean> | undefined,
  provided: Provided,
): EngineToolRow[] {
  const names = new Set(known.map((tool) => tool.name))
  const unknown = (reported ?? []).filter((name) => !names.has(name))
  const specs: (EngineToolSpec & { isNew?: true })[] = [
    ...known,
    ...unknown.map((name) => ({
      name,
      group: 'core' as const,
      isNew: true as const,
    })),
  ]
  return specs.map((spec) => {
    const byDefault = defaultOn(spec, provided)
    const choice = saved?.[spec.name]
    const by = spec.capability && spec.group === 'replaced' && !byDefault ? provided.get(spec.capability) : undefined
    return {
      name: spec.name,
      ...(spec.capability && { capability: spec.capability }),
      group: spec.group,
      ...(spec.isNew && { isNew: true as const }),
      defaultOn: byDefault,
      on: typeof choice === 'boolean' ? choice : byDefault,
      ...(typeof choice === 'boolean' && { saved: true as const }),
      ...(by && { replacedBy: by }),
    }
  })
}

export type EngineToolsDeps = {
  garage: string
  settings: { engineTools?: SavedEngineTools }
  saveSettings: () => void
  adapterFor: (engine: string) => Adapter | undefined
  // For Settings: every engine whose tools can be switched (the UI shows those that are on), and what Kothar has its
  // own version of anywhere (Provided).
  adapters?: () => readonly Adapter[]
  provided?: () => Provided
  broadcast?: (message: CoreMessage) => void
}

export function openEngineTools({
  garage,
  settings,
  saveSettings,
  adapterFor,
  adapters,
  provided,
  broadcast,
}: EngineToolsDeps) {
  const file = join(garage, 'engine-tools.json')
  let reported: Record<string, string[]> = {}
  try {
    const read = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
    if (isRecord(read)) {
      reported = Object.fromEntries(
        Object.entries(read).flatMap(([engine, names]) =>
          Array.isArray(names) ? [[engine, names.filter((n): n is string => typeof n === 'string')]] : [],
        ),
      )
    }
  } catch {}

  const saved = (): SavedEngineTools => (isRecord(settings.engineTools) ? settings.engineTools : {})
  const savedOf = (engine: string) => {
    const own = saved().engines?.[engine]
    return isRecord(own) ? own : {}
  }
  const allEnabled = () => saved().enabled !== false
  const engineEnabled = (engine: string) => savedOf(engine).enabled !== false

  const rowsOf = (engine: string, provided: Provided) => {
    const adapter = adapterFor(engine)
    if (!adapter?.tools) return []
    const choices = savedOf(engine).tools
    return toolRowsOf(
      adapter.tools,
      reported[engine],
      isRecord(choices) ? (choices as Record<string, boolean>) : undefined,
      provided,
    )
  }

  const info = (): EngineToolsSettings => ({
    enabled: allEnabled(),
    engines: (adapters?.() ?? [])
      .filter((adapter) => adapter.tools)
      .map((adapter) => ({
        engine: adapter.id,
        name: adapter.name ?? adapter.id,
        enabled: engineEnabled(adapter.id),
        tools: rowsOf(adapter.id, provided?.() ?? new Map()),
      })),
  })
  const changed = () => broadcast?.({ type: 'engineTools.updated', engineTools: info() })
  const switchable = (engine: unknown) => {
    const adapter = typeof engine === 'string' ? adapterFor(engine) : undefined
    if (!adapter) throw new Error(`No engine "${String(engine)}"`)
    if (!adapter.tools) throw new Error(`Kothar can't switch ${adapter.name ?? adapter.id}'s tools`)
    return adapter
  }
  // Writes one engine's saved choices, dropping what's back to its default so settings.json stays small.
  const writeEngine = (engine: string, change: { enabled?: boolean | undefined; tools?: Record<string, boolean> }) => {
    const next: { enabled?: boolean; tools?: Record<string, boolean> } = {
      ...savedOf(engine),
      ...change,
    }
    if (next.enabled !== false) delete next.enabled
    if (!next.tools || !Object.keys(next.tools).length) delete next.tools
    const { [engine]: _, ...others } = saved().engines ?? {}
    const engines = Object.keys(next).length ? { ...others, [engine]: next } : others
    const all: SavedEngineTools = { ...saved(), engines }
    if (!Object.keys(engines).length) delete all.engines
    if (Object.keys(all).length) settings.engineTools = all
    else delete settings.engineTools
    saveSettings()
    changed()
  }

  return {
    allEnabled,
    engineEnabled,
    rowsOf,
    info,
    changed,

    /** A master switch: every engine's without engine, else that engine's. Per-tool choices stay as they were. */
    setEnabled(engine: unknown, enabled: unknown) {
      if (typeof enabled !== 'boolean') throw new Error('Engine tools are on or off')
      if (engine === undefined) {
        const { enabled: _, ...rest } = saved()
        const all = enabled ? rest : { ...rest, enabled: false }
        if (Object.keys(all).length) settings.engineTools = all
        else delete settings.engineTools
        saveSettings()
        return changed()
      }
      const { id } = switchable(engine)
      writeEngine(id, { enabled: enabled ? undefined : false })
    },

    /** One tool on or off; on undefined puts it back to its default. Any tool the engine has, core ones included. */
    setTool(engine: unknown, tool: unknown, on: unknown) {
      const { id } = switchable(engine)
      if (typeof tool !== 'string' || !rowsOf(id, new Map()).some((row) => row.name === tool)) {
        throw new Error(`${id} has no tool "${String(tool)}"`)
      }
      if (on !== undefined && typeof on !== 'boolean') throw new Error('A tool is on or off')
      const { [tool]: _, ...others } = savedOf(id).tools ?? {}
      writeEngine(id, {
        tools: on === undefined ? others : { ...others, [tool]: on },
      })
    },

    /** Every tool of an engine back to its default; its master switch stays as it is. */
    reset(engine: unknown) {
      const { id } = switchable(engine)
      writeEngine(id, { tools: {} })
    },
    reported: (engine: string) => reported[engine],

    /** An engine reported the tools a session has: kept, so Settings can list ones its adapter doesn't know yet. */
    record(engine: string, names: string[]) {
      const sorted = [...new Set(names)]
      const before = reported[engine]
      if (before && before.length === sorted.length && before.every((name, i) => name === sorted[i])) return
      reported = { ...reported, [engine]: sorted }
      try {
        writeFileSync(file, JSON.stringify(reported, null, 2) + '\n')
      } catch {}
      changed()
    },

    /** The tool options a session of this engine starts with; nothing for an engine whose tools can't be switched. */
    sessionFor(engine: string, provided: Provided): Pick<SessionOptions, 'tools' | 'noTools'> {
      const adapter = adapterFor(engine)
      if (!adapter?.tools) return {}
      const rows = rowsOf(engine, provided)
      const tools = {
        off: rows.filter((row) => !row.on).map((row) => row.name),
        on: rows.filter((row) => row.on).map((row) => row.name),
      }
      return {
        tools,
        ...(!(allEnabled() && engineEnabled(engine)) && { noTools: true }),
      }
    },
  }
}

export type EngineTools = ReturnType<typeof openEngineTools>
