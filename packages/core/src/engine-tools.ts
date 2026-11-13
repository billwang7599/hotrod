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
import type { Adapter, EngineToolSpec, SessionOptions, ToolCapability, ToolGroup } from './shared.ts'

export type SavedEngineTools = {
  // The master switch for every engine; absent means on.
  enabled?: boolean
  engines?: Record<string, { enabled?: boolean; tools?: Record<string, boolean> }>
}

// One tool as Settings shows it. defaultOn: what it is without the user's choice; saved: the user chose (on is that
// choice). replacedBy: who stands in for it while it's off by default, such as Workers.
export type EngineToolRow = {
  name: string
  capability?: ToolCapability
  group: ToolGroup
  isNew?: true
  defaultOn: boolean
  on: boolean
  saved?: true
  replacedBy?: string
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
    ...unknown.map((name) => ({ name, group: 'core' as const, isNew: true as const })),
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
  // A tool list changed (an engine reported new tools, or the user switched one).
  changed?: (engine?: string) => void
}

export function openEngineTools({ garage, settings, adapterFor, changed }: EngineToolsDeps) {
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
    return toolRowsOf(adapter.tools, reported[engine], isRecord(choices) ? (choices as Record<string, boolean>) : undefined, provided)
  }

  return {
    allEnabled,
    engineEnabled,
    rowsOf,
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
      changed?.(engine)
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
      return { tools, ...(!(allEnabled() && engineEnabled(engine)) && { noTools: true }) }
    },
  }
}

export type EngineTools = ReturnType<typeof openEngineTools>
