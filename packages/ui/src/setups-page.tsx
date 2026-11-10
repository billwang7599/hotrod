import { useState, type FormEvent } from 'react'
import {
  levelsOf,
  THINKING_LABELS,
  THINKING_LEVELS,
  type ClientMessage,
  type EngineInfo,
  type ExtensionInfo,
  type Setup,
  type ThinkingLevel,
} from '@kothar/core/shared'
import { Button, confirm, ErrorText, GROUP, Hint, Select, Switch } from './controls.tsx'
import { engineName, fromModelKey, modelChoices, modelKey } from './state.ts'

// Select values for "nothing picked": setup ids and model keys never hold a colon.
const LISTS = 'lists:'
const MODELS_OWN = 'own:'

export const SETUP_HINT =
  "A setup's model, thinking level, extensions and instructions apply from this chat's next message. A model or " +
  'thinking level picked in the message box still wins.'

type Draft = Omit<Setup, 'id'> & { id?: string }

type Props = {
  setups: Setup[]
  engines: EngineInfo[]
  extensions: ExtensionInfo[]
  connected: boolean
  send: (m: ClientMessage) => void
  // The core's answer to the last save (State.setupSave).
  saved?: { count: number; id?: string; error?: string }
}

/** Settings → Setups: every saved setup, each editable in place, plus a new one. */
export function SetupsPage({ setups, engines, extensions, connected, send, saved }: Props) {
  // The setup open for editing: its id, 'new' for a new one, or none.
  const [editing, setEditing] = useState<string>()
  const [copyOf, setCopyOf] = useState<Draft>()
  // A save sent and not yet answered: the answer count it waits past. The form stays open until the core saves it,
  // so a refused save keeps everything typed and shows why.
  const [waiting, setWaiting] = useState<number>()
  const [refused, setRefused] = useState<string>()
  const close = () => {
    setEditing(undefined)
    setCopyOf(undefined)
    setWaiting(undefined)
    setRefused(undefined)
  }
  // A new answer from the core: the save waited for is done or refused.
  const [answered, setAnswered] = useState(saved?.count)
  if (saved?.count !== answered) {
    setAnswered(saved?.count)
    if (waiting !== undefined && saved && saved.count > waiting) {
      if (saved.error === undefined) close()
      else {
        setWaiting(undefined)
        setRefused(saved.error)
      }
    }
  }
  const save = (draft: Draft) => {
    send({ type: 'setup.save', setup: draft })
    setWaiting(saved?.count ?? 0)
    setRefused(undefined)
  }
  const remove = async (setup: Setup) => {
    const ok = await confirm({
      text: `Delete the setup "${setup.name}"?`,
      body: 'Chats using it go back to your Settings from their next message.',
      ok: 'Delete',
      danger: true,
    })
    if (ok) send({ type: 'setup.remove', id: setup.id })
  }
  const duplicate = (setup: Setup) => {
    const names = setups.map((s) => s.name.toLowerCase())
    let name = `${setup.name} copy`
    for (let n = 2; names.includes(name.toLowerCase()); n++) name = `${setup.name} copy ${n}`
    setCopyOf({ ...setup, id: undefined, name })
    setEditing('new')
    setRefused(undefined)
  }
  const open = (id: string) => (setEditing(id), setCopyOf(undefined), setRefused(undefined))
  // Keyed by what it edits, so opening another draft (Duplicate while New is open) starts a fresh form.
  const form = (draft: Draft, key: string) => (
    <SetupForm
      key={key}
      draft={draft}
      taken={setups.filter((s) => s.id !== draft.id).map((s) => s.name.toLowerCase())}
      engines={engines}
      extensions={extensions}
      connected={connected}
      saving={waiting !== undefined}
      refused={refused}
      save={save}
      cancel={close}
    />
  )
  return (
    <>
      <div className="mb-12">
        <Button variant="primary" disabled={!connected || editing === 'new'} onClick={() => open('new')}>
          New setup
        </Button>
      </div>
      {editing === 'new' && <div className={`${GROUP} mb-12 py-12`}>{form(copyOf ?? { name: '' }, copyOf ? `copy:${copyOf.name}` : 'new')}</div>}
      {setups.length ? (
        <ul className={GROUP} aria-label="Setups">
          {setups.map((setup) => (
            <li key={setup.id} className="flex flex-col gap-8 py-12 not-first:border-t">
              <div className="flex flex-wrap items-center gap-x-16 gap-y-8">
                <div className="flex min-w-200 flex-1 flex-col gap-2 wrap-anywhere">
                  {setup.name}
                  <div className="text-sm text-muted">{summaryOf(setup, engines, extensions)}</div>
                </div>
                <div className="flex items-center gap-6">
                  <Button size="small" disabled={!connected} onClick={() => open(setup.id)}>
                    Edit
                  </Button>
                  <Button size="small" disabled={!connected} onClick={() => duplicate(setup)}>
                    Duplicate
                  </Button>
                  <Button size="small" variant="danger" disabled={!connected} onClick={() => void remove(setup)}>
                    Delete
                  </Button>
                </div>
              </div>
              {editing === setup.id && form(setup, setup.id)}
            </li>
          ))}
        </ul>
      ) : (
        editing !== 'new' && <p className="text-muted">No setups yet.</p>
      )}
    </>
  )
}

/** One line on what a setup sets, or that it follows Settings. */
export function summaryOf(setup: Setup, engines: EngineInfo[], extensions: ExtensionInfo[]) {
  const engine = engines.find((e) => e.id === setup.engine)
  const model = setup.model && (engine?.models?.find((m) => m.id === setup.model)?.label ?? setup.model)
  const off = (setup.extensionsOff ?? []).map((id) => extensions.find((e) => e.id === id)?.name ?? id)
  const parts = [
    model ? `${model} · ${engineName(engine) || setup.engine}` : setup.engine && `${engineName(engine) || setup.engine}'s default model`,
    setup.thinking && `${THINKING_LABELS[setup.thinking]} thinking`,
    off.length > 0 && `Without ${off.join(', ')}`,
    setup.instructions && 'Instructions',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Follows Settings'
}

type FormProps = {
  draft: Draft
  taken: string[]
  engines: EngineInfo[]
  extensions: ExtensionInfo[]
  connected: boolean
  // A save is on its way to the core; refused: why the core turned the last one down.
  saving: boolean
  refused?: string
  save: (draft: Draft) => void
  cancel: () => void
}

function SetupForm({ draft, taken, engines, extensions, connected, saving, refused, save, cancel }: FormProps) {
  const [name, setName] = useState(draft.name)
  const [engine, setEngine] = useState(draft.engine)
  const [model, setModel] = useState(draft.model)
  const [thinking, setThinking] = useState(draft.thinking)
  const [off, setOff] = useState(draft.extensionsOff ?? [])
  const [instructions, setInstructions] = useState(draft.instructions ?? '')
  const choices = modelChoices(engines)
  const modelValue = model !== undefined && engine ? modelKey({ engine, model }) : engine ? `${MODELS_OWN}${engine}` : LISTS
  // A saved model that can't run now still shows, so editing doesn't drop it unseen.
  const missing = model !== undefined && engine && !choices.some((c) => c.engine === engine && c.model === model)
  const engineChoices = engines.filter((e) => e.enabled)
  const levels = engine && model ? levelsOf(engines.find((e) => e.id === engine), model) : []
  const pickModel = (value: string) => {
    if (value === LISTS) {
      setEngine(undefined)
      setModel(undefined)
    } else if (value.startsWith(MODELS_OWN)) {
      setEngine(value.slice(MODELS_OWN.length))
      setModel(undefined)
    } else {
      const picked = fromModelKey(value)
      setEngine(picked.engine)
      setModel(picked.model)
    }
  }
  const trimmed = name.trim()
  const error = !trimmed
    ? undefined
    : taken.includes(trimmed.toLowerCase())
      ? `A setup named "${trimmed}" already exists`
      : undefined
  const ready = connected && !saving && trimmed !== '' && !error
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!ready) return
    save({
      ...(draft.id && { id: draft.id }),
      name: trimmed,
      ...(engine && { engine }),
      ...(engine && model !== undefined && { model }),
      ...(thinking && { thinking }),
      ...(off.length && { extensionsOff: off }),
      ...(instructions.trim() && { instructions }),
    })
  }
  // Only extensions that are on can be left out; one left out earlier stays listed so it can be put back. One with a
  // chat of its own (Home) isn't listed: a setup never leaves it out of that chat.
  const listed = extensions.filter((e) => ((e.enabled && !e.loadError) || off.includes(e.id)) && !e.ownsChat)
  return (
    <form className="flex flex-col gap-12" aria-label={draft.id ? `Edit ${draft.name}` : 'New setup'} onSubmit={submit}>
      <label className="flex flex-col gap-4">
        <span className="text-muted">Name</span>
        <input value={name} placeholder="e.g. Reviewer" maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} />
        {error && <ErrorText>{error}</ErrorText>}
      </label>
      <div className="flex flex-wrap items-end gap-8">
        <div className="flex flex-col gap-4">
          <span className="text-muted">Model</span>
          <Select
            label="Model"
            value={modelValue}
            hint="Model lists: whatever Settings → Models runs. An engine's default: its first model in your lists, else the engine's own default."
            disabled={!connected}
            options={[
              { value: LISTS, label: 'Model lists' },
              ...engineChoices.map((e) => ({ value: `${MODELS_OWN}${e.id}`, label: `${engineName(e)}'s default`, group: 'Engine' })),
              ...(missing ? [{ value: modelValue, label: `${model} (can't run now)`, group: engine }] : []),
              ...choices.map((c) => ({ value: modelKey(c), label: c.name, group: c.group })),
            ]}
            onChange={pickModel}
          />
        </div>
        <div className="flex flex-col gap-4">
          <span className="text-muted">Thinking</span>
          <Select
            label="Thinking"
            value={thinking ?? LISTS}
            hint="Snapped to the nearest level the model takes."
            disabled={!connected}
            options={[
              { value: LISTS, label: "Model's own" },
              ...(levels.length ? levels : THINKING_LEVELS).map((level) => ({
                value: level,
                label: THINKING_LABELS[level],
              })),
            ]}
            onChange={(value) => setThinking(value === LISTS ? undefined : (value as ThinkingLevel))}
          />
        </div>
      </div>
      {listed.length > 0 && (
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-4 text-muted">
            <Hint text="Turned off here, an extension adds nothing to this setup's chats: no tools, instructions, rewrites, permission answers or memory. Extensions off in Settings stay off.">
              <span>Extensions</span>
            </Hint>
          </legend>
          {listed.map((extension) => (
            <div key={extension.id} className="flex items-center justify-between gap-8">
              <span className={off.includes(extension.id) ? 'text-muted' : ''}>{extension.name}</span>
              <Switch
                label={`${extension.name} in this setup`}
                checked={!off.includes(extension.id)}
                disabled={!connected}
                onChange={(on) => setOff(on ? off.filter((id) => id !== extension.id) : [...off, extension.id])}
              />
            </div>
          ))}
        </fieldset>
      )}
      <label className="flex flex-col gap-4">
        <Hint text="Added to every session of this setup's chats, after extensions' instructions and before AGENTS.md files.">
          <span className="w-fit text-muted">Instructions</span>
        </Hint>
        <textarea
          className="min-h-96 resize-y px-8 py-6 text-sm leading-[1.5] focus:border-accent"
          rows={5}
          value={instructions}
          placeholder="e.g. Review the changes; don't edit files."
          onChange={(e) => setInstructions(e.target.value)}
        />
      </label>
      {refused && <ErrorText>{refused}</ErrorText>}
      <div className="flex justify-end gap-8">
        <Button type="button" onClick={cancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!ready}>
          {draft.id ? 'Save' : 'Create'}
        </Button>
      </div>
    </form>
  )
}
