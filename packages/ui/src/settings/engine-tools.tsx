// Settings → Engines → Tools: every built-in tool of each engine that's on, each with a switch, under two master
// switches: Engine tools for every engine (at the top of the page) and one per engine. A master off turns every tool
// off, core ones too; the per-tool choices stay saved, shown greyed out, and come back as they were.
import type { ClientMessage, EngineInfo, EngineToolRow, EngineToolsSettings, ToolGroup } from '@kothar/core/shared'
import { Button, GROUP, Hint, Switch } from '../controls.tsx'
import { SettingRow } from './rows.tsx'

const GROUPS: Record<ToolGroup, { label: string; hint: string }> = {
  core: {
    label: 'Core',
    hint: 'What the engine works with: commands, edits, reads, searches. On by default: its model was trained on these exact tools, and Kothar sees and asks about every call.',
  },
  replaced: {
    label: 'Kothar has its own',
    hint: 'Kothar or an extension has its own version, which the user can see, open and stop. Off while that version is on.',
  },
  outside: {
    label: 'Outside Kothar',
    hint: "Acts where Kothar can't see, stop or log it, such as schedules, notifications and publishing. Off by default.",
  },
}

const NEW_HINT = "The engine has this tool and Kothar doesn't know it yet. It's on, and asks before each use."
const CORE_CAPABILITIES = new Set(['shell', 'edit', 'read', 'search'])
const WHAT: Record<string, string> = {
  shell: 'run commands',
  edit: 'edit files',
  read: 'read files',
  search: 'search files',
}

export const ENGINE_TOOLS_OFF =
  "Engine tools are off: engines can't run commands, edit or read files themselves. Only Kothar's tools are available: its MCP tools, workers, extensions and MCP servers."

type Props = {
  settings?: EngineToolsSettings
  engines: EngineInfo[]
  connected: boolean
  send: (m: ClientMessage) => void
}

/** The master switch for every engine, at the top of Settings → Engines. */
export function EngineToolsMaster({ settings, connected, send }: Omit<Props, 'engines'>) {
  if (!settings) return null
  return (
    <div className={`${GROUP} mb-16`}>
      <SettingRow
        name={
          <Hint text="Each engine's own built-in tools. Off, every engine runs with none of them, leaving the agent only Kothar's tools. Your choices per tool are kept.">
            <span className="self-start">Engine tools</span>
          </Hint>
        }
        description={!settings.enabled && <span className="text-amber">{ENGINE_TOOLS_OFF}</span>}
      >
        <Switch
          label="Engine tools"
          checked={settings.enabled}
          disabled={!connected}
          onChange={(enabled) => send({ type: 'engineTools.setEnabled', enabled })}
        />
      </SettingRow>
    </div>
  )
}

/** Each engine's tools, for the engines that are on and whose tools Kothar can switch. */
export function EngineToolsSections({ settings, engines, connected, send }: Props) {
  if (!settings) return null
  const on = new Set(engines.filter((engine) => engine.enabled).map((engine) => engine.id))
  const shown = settings.engines.filter((engine) => on.has(engine.engine))
  return shown.map((engine) => (
    <EngineToolsSection key={engine.engine} engine={engine} all={settings.enabled} connected={connected} send={send} />
  ))
}

type SectionProps = {
  engine: EngineToolsSettings['engines'][number]
  all: boolean
  connected: boolean
  send: (m: ClientMessage) => void
}

function EngineToolsSection({ engine, all, connected, send }: SectionProps) {
  const live = all && engine.enabled
  const changed = engine.tools.some((tool) => tool.saved)
  const offCore = live
    ? [
        ...new Set(
          engine.tools
            .filter(
              (t) => !t.on && t.capability && CORE_CAPABILITIES.has(t.capability) && allOff(engine.tools, t.capability),
            )
            .map((t) => t.capability!),
        ),
      ]
    : []
  return (
    <section aria-label={`${engine.name} tools`} className="flex flex-col pt-24">
      <div className="flex items-center gap-8 pb-8">
        <h3 className="flex-1 font-semibold">{engine.name} tools</h3>
        {changed && (
          <Button
            size="small"
            disabled={!connected}
            onClick={() => send({ type: 'engineTools.reset', engine: engine.engine })}
          >
            Reset to defaults
          </Button>
        )}
        <Switch
          label={`All ${engine.name} tools`}
          checked={live}
          disabled={!connected || !all}
          onChange={(enabled) =>
            send({
              type: 'engineTools.setEnabled',
              engine: engine.engine,
              enabled,
            })
          }
        />
      </div>
      {!all && <p className="pb-8 text-sm text-amber">Off with Engine tools, above.</p>}
      {all && !engine.enabled && (
        <p className="pb-8 text-sm text-amber">
          All off: {engine.name} can't run commands, edit or read files itself. Only Kothar's tools are available.
        </p>
      )}
      {offCore.map((capability) => (
        <p key={capability} className="pb-8 text-sm text-amber">
          {engine.name} can't {WHAT[capability]} any more, and Kothar has no tool of its own for that yet.
        </p>
      ))}
      <div className={GROUP}>
        {engine.tools.map((tool) => (
          <ToolRow key={tool.name} engine={engine.engine} tool={tool} live={live} connected={connected} send={send} />
        ))}
      </div>
    </section>
  )
}

// Every tool for that capability is off, so the engine has no way left to do it.
const allOff = (tools: EngineToolRow[], capability: string) =>
  tools.filter((t) => t.capability === capability).every((t) => !t.on)

type RowProps = {
  engine: string
  tool: EngineToolRow
  live: boolean
  connected: boolean
  send: (m: ClientMessage) => void
}

function ToolRow({ engine, tool, live, connected, send }: RowProps) {
  const group = GROUPS[tool.group]
  const status = tool.isNew ? (
    <Hint text={NEW_HINT}>
      <span className="self-start text-amber">New</span>
    </Hint>
  ) : (
    <Hint text={group.hint}>
      <span className="self-start">{group.label}</span>
    </Hint>
  )
  const replaced = tool.replacedBy && !tool.on ? ` · ${tool.replacedBy} instead` : ''
  const changed = tool.saved && tool.on !== tool.defaultOn ? ` · ${tool.defaultOn ? 'on' : 'off'} by default` : ''
  return (
    <SettingRow
      name={<span className="font-mono">{tool.name}</span>}
      description={
        <span className="flex flex-wrap gap-x-4">
          {status}
          {tool.capability && <span>· {tool.capability}</span>}
          {replaced && <span>{replaced}</span>}
          {changed && <span>{changed}</span>}
        </span>
      }
    >
      <Switch
        label={`${tool.name} on`}
        checked={live && tool.on}
        disabled={!connected || !live}
        onChange={(on) =>
          send({
            type: 'engineTools.setTool',
            engine,
            tool: tool.name,
            on: on === tool.defaultOn ? undefined : on,
          })
        }
      />
    </SettingRow>
  )
}
