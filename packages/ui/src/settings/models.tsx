// The Models page: one ordered list of models per role.
import {
  MODEL_ROLES,
  levelsOf,
  ROLE_NAMES,
  THINKING_LABELS,
  type ClientMessage,
  type EngineInfo,
  type ModelLists,
  type ModelRole,
  type ModelRow,
  type ThinkingLevel,
} from '@kothar/core/shared'
import { Button, GROUP, Select } from '../controls.tsx'
import { engineName, engineProblem, modelChoices, modelKey, fromModelKey } from '../state.ts'
import { SettingRow } from './rows.tsx'

const ROLE_ABOUT: Record<ModelRole, string> = {
  chat: 'Chats you start.',
  planning: 'Workers started to plan.',
  searching: 'Workers started to search.',
  workers: 'Every other worker.',
}

type ModelListsProps = {
  engines: EngineInfo[]
  lists: ModelLists
  connected: boolean
  send: (m: ClientMessage) => void
}

export function ModelListsSection({ engines, lists, connected, send }: ModelListsProps) {
  const choices = modelChoices(engines)
  const quiet = engines.filter((e) => e.enabled && !e.models?.length)
  const engineOf = (id: string) => engines.find((e) => e.id === id)
  return (
    <section className="flex flex-col" aria-label="Models">
      {quiet.map((e) => (
        <p key={e.id} className="pb-8 text-muted">
          {engineName(e)} lists no models{engineProblem(e) && ` (${engineProblem(e)})`}.
        </p>
      ))}
      <div className={GROUP}>
        {MODEL_ROLES.map((role) => {
          const list = lists[role]
          const [name, about] = [ROLE_NAMES[role], ROLE_ABOUT[role]]
          const setList = (models: ModelRow[]) => send({ type: 'models.setList', role, models })
          const move = (from: number, to: number) => {
            const next = [...list]
            next.splice(to, 0, ...next.splice(from, 1))
            setList(next)
          }
          const items = list.map((row, i) => {
            const engine = engineOf(row.engine)
            const choice = choices.find((c) => c.engine === row.engine && c.model === row.model)
            const [model, on] = [choice?.name ?? row.model, engineName(engine) || row.engine]
            const label = `${model} · ${on}`
            const levels = choice ? levelsOf(engine, row.model) : []
            const setThinking = (level: string) =>
              setList(list.map((r, j) => (j === i ? { ...r, thinking: level as ThinkingLevel } : r)))
            // The Chat list always keeps one model, so what a chat runs is always on show.
            const removable = role !== 'chat' || list.length > 1
            return (
              <li key={modelKey(row)} className="flex h-28 items-center gap-6 rounded pr-2 pl-8 hover:bg-raised">
                <span className="w-16 text-sm text-faint">{i + 1}</span>
                <span className={`min-w-0 flex-1 truncate ${choice ? '' : 'text-muted'}`}>
                  {model} <span className="text-faint">· {on}</span>
                  {!choice && " (can't run, skipped)"}
                </span>
                {levels.length > 0 && (
                  <Select
                    variant="chip"
                    label={`Thinking for ${label} in ${name}`}
                    value={row.thinking && levels.includes(row.thinking) ? row.thinking : ''}
                    placeholder="Thinking"
                    disabled={!connected}
                    options={levels.map((level) => ({ value: level, label: THINKING_LABELS[level] }))}
                    onChange={setThinking}
                  />
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${label} up`}
                  disabled={!connected || i === 0}
                  onClick={() => move(i, i - 1)}
                >
                  ↑
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${label} down`}
                  disabled={!connected || i === list.length - 1}
                  onClick={() => move(i, i + 1)}
                >
                  ↓
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${label}`}
                  disabled={!connected || !removable}
                  onClick={() => setList(list.filter((_, j) => j !== i))}
                >
                  ×
                </Button>
              </li>
            )
          })
          const addable = choices.filter((c) => !list.some((r) => r.engine === c.engine && r.model === c.model))
          // The core gives a new row the level it runs at.
          const add = (key: string) => setList([...list, fromModelKey(key)])
          return (
            <SettingRow
              key={role}
              name={name}
              description={about}
              below={
                items.length > 0 ? (
                  <ol aria-label={`${name} models`}>{items}</ol>
                ) : (
                  role !== 'chat' && <p className="pl-8 text-sm text-muted">Same as Chat</p>
                )
              }
            >
              <Select
                label={`Add a ${name} model`}
                value=""
                placeholder="Add model…"
                disabled={!connected || !addable.length}
                options={addable.map((c) => ({ value: modelKey(c), label: c.label, group: c.group }))}
                onChange={add}
              />
            </SettingRow>
          )
        })}
      </div>
    </section>
  )
}
