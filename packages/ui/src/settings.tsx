import { Fragment, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { AnimatePresence, m } from 'motion/react'
import { AlertDialog, Dialog, Tabs } from 'radix-ui'
import {
  CONTEXT_SECTIONS,
  MODEL_ROLES,
  PERMISSION_SWITCHES,
  settingProblem,
  switchedOn,
  type Account,
  type ClientMessage,
  type ContextSection,
  type EngineAccounts,
  type EngineInfo,
  type ModelLists,
  type ModelRole,
  type ModInfo,
  type WorkFolder,
} from '@hotrod/core/shared'
import type { ModSetting } from '@hotrod/mod-api'
import { PERMISSIONS, SECTIONS } from './context-panel.tsx'
import {
  Button,
  CHAT_NOUN,
  confirm,
  ErrorText,
  GROUP,
  Hint,
  MOTION,
  NAV_LABEL,
  Select,
  Switch,
  useReturnFocus,
} from './controls.tsx'
import { accountLabel, engineProblem, listedAccounts, NO_LISTS } from './state.ts'
import { showPaths, usePathsShown } from './paths.ts'
import { showStepsByDefault, useStepsDefault } from './steps.ts'
import { Appearance } from './themes.tsx'

type PageProps = {
  engines: EngineInfo[]
  accounts: EngineAccounts[]
  contextDefaults: Record<ContextSection, boolean>
  mods: ModInfo[]
  modelLists: Record<string, ModelLists>
  workFolder: WorkFolder
  chooseWorkFolder: () => void
  connected: boolean
  send: (m: ClientMessage) => void
}

type Page = {
  id: string
  group: (typeof NAV_GROUPS)[number]
  title: string
  hint?: string
  body: (props: PageProps) => ReactNode
}

const NAV_GROUPS = ['Options', 'Mods'] as const

const WORK_FOLDER_TITLE = 'Choose a work folder'
const WORK_FOLDER_HINT =
  'Agents and subagents do all their work here, and can write nowhere else unless you allow it, here or for a chat. ' +
  `Each ${CHAT_NOUN.one} gets a folder of its own inside it.`

const PERMISSION_DEFAULT_HINT =
  `The default for every chat: Home, ${CHAT_NOUN.many} and subagents. Each can choose otherwise in its Context panel.`

const ROLES: Record<ModelRole, { name: string; about: string }> = {
  chat: { name: 'Chat', about: "Chats you start. Empty runs the engine's default." },
  planning: { name: 'Planning', about: 'Subagents started to plan. Empty uses Chat.' },
  searching: { name: 'Searching', about: 'Subagents started to search. Empty uses Chat.' },
  subagents: { name: 'Subagents', about: 'Every other subagent. Empty uses Chat.' },
}

const PAGES = [
  {
    id: 'engines',
    group: 'Options',
    title: 'Engines',
    hint: 'Hotrod only starts the engines you turn on here.',
    body: ({ engines, connected, send }: PageProps) => (
      <div className={GROUP}>
        {engines.map((engine) => {
          const problem = engineProblem(engine)
          return (
            <SettingRow
              key={engine.id}
              name={<span className="font-mono">{engine.id}</span>}
              description={
                <span className={`block first-letter:uppercase ${problem ? 'text-amber' : 'text-green'}`}>
                  {problem ?? 'Ready'}
                  {engine.detail && ` · ${engine.detail}`}
                </span>
              }
            >
              <Switch
                label={`${engine.id} on`}
                checked={engine.enabled}
                disabled={!connected}
                onChange={(enabled) => send({ type: 'engine.setEnabled', engine: engine.id, enabled })}
              />
            </SettingRow>
          )
        })}
      </div>
    ),
  },
  {
    id: 'work',
    group: 'Options',
    title: 'Work folder',
    hint: WORK_FOLDER_HINT,
    body: ({ workFolder, chooseWorkFolder, connected, send }: PageProps) => (
      <div className={GROUP}>
        <SettingRow
          name="Work folder"
          description={<span className="font-mono">{workFolder.path ?? 'Not chosen'}</span>}
          hint={`Changing it moves only new ${CHAT_NOUN.many}; existing ones keep their folder.`}
        >
          <Button disabled={!connected} onClick={chooseWorkFolder}>
            Change…
          </Button>
        </SettingRow>
        {PERMISSION_SWITCHES.map((name) => {
          const { label, about, amberWhileOn } = PERMISSIONS[name]
          const on = switchedOn(name, workFolder)
          return (
            <SettingRow
              key={name}
              name={<span className={amberWhileOn && on ? 'text-amber' : ''}>{label}</span>}
              hint={`${about} ${PERMISSION_DEFAULT_HINT}`}
            >
              <Switch
                label={label}
                checked={on}
                disabled={!connected}
                onChange={(enabled) => send({ type: 'permission.setDefault', name, enabled })}
              />
            </SettingRow>
          )
        })}
      </div>
    ),
  },
  {
    id: 'appearance',
    group: 'Options',
    title: 'Appearance',
    body: () => (
      <>
        <Appearance />
        <ShownPaths />
        <ShownSteps />
      </>
    ),
  },
  {
    id: 'accounts',
    group: 'Options',
    title: 'Accounts',
    hint:
      'Each engine runs as its Active account: one saved here, or whoever the engine itself is signed in as. ' +
      'Accounts show while their engine is on.',
    body: ({ engines, accounts, connected, send }: PageProps) => {
      const shown = engines.flatMap((e) => (e.enabled ? accounts.filter((a) => a.engine === e.id) : []))
      if (!shown.length) return <p className="text-muted">Turn on an engine to manage its accounts.</p>
      return shown.map((a) => <EngineAccountsSection key={a.engine} accounts={a} connected={connected} send={send} />)
    },
  },
  {
    id: 'models',
    group: 'Options',
    title: 'Models',
    hint:
      `A ${CHAT_NOUN.one} runs its own pick, else the first model in its list that the engine offers, ` +
      "else the engine's default.",
    body: ({ engines, modelLists, connected, send }: PageProps) => {
      const on = engines.filter((e) => e.enabled)
      if (!on.length) return <p className="text-muted">Turn on an engine to order its models.</p>
      return on.map((engine) => (
        <EngineModels
          key={engine.id}
          engine={engine}
          lists={modelLists[engine.id] ?? NO_LISTS}
          connected={connected}
          send={send}
        />
      ))
    },
  },
  {
    id: 'context',
    group: 'Options',
    title: 'Context',
    hint:
      `What a ${CHAT_NOUN.one} uses from the global AGENTS.md and the chats above it, unless you switch it in its ` +
      'Context panel. Its own AGENTS.md, folders and files always start on.',
    body: ({ contextDefaults, connected, send }: PageProps) => (
      <div className={GROUP}>
        {CONTEXT_SECTIONS.map((section) => (
          <SettingRow key={section} name={SECTIONS[section].label} hint={SECTIONS[section].inherited}>
            <Switch
              label={`${SECTIONS[section].label} from above on by default`}
              checked={contextDefaults[section]}
              disabled={!connected}
              onChange={(enabled) => send({ type: 'context.setDefault', section, enabled })}
            />
          </SettingRow>
        ))}
      </div>
    ),
  },
  {
    id: 'mods',
    group: 'Mods',
    title: 'Built-in mods',
    hint: 'Mods that ship with Hotrod. One with settings or a setup gets its own page while it is on.',
    body: (props: PageProps) => <ModsPage {...props} />,
  },
] as const satisfies readonly Page[]

export type SettingsPage = (typeof PAGES)[number]['id'] | `mod:${string}`

function ModsPage({ mods, connected, send }: PageProps) {
  const [setupFor, setSetupFor] = useState<string>()
  const [setupShown, setSetupShown] = useState(false)
  const mod = mods.find((m) => m.id === setupFor && m.enabled)
  const status = mod?.setup?.status
  const settled = !status || status === 'ready'
  if (setupFor && settled && status !== undefined) setSetupFor(undefined)
  const open = !settled && (setupShown || status !== 'checking')
  if (open !== setupShown) setSetupShown(open)
  const close = () => {
    setSetupFor(undefined)
    setSetupShown(false)
  }
  return (
    <div className={GROUP}>
      {mods.map((m) => (
        <SettingRow
          key={m.id}
          name={m.name}
          description={
            m.enabled && m.setup?.status === 'missing' && <span className="text-amber">{setupTitle(m)}</span>
          }
          hint={m.description}
        >
          <Switch
            label={m.name}
            checked={m.enabled}
            disabled={!connected}
            onChange={(enabled) => {
              send({ type: 'mod.setEnabled', modId: m.id, enabled })
              if (enabled && m.setup) setSetupFor(m.id)
            }}
          />
        </SettingRow>
      ))}
      {mod?.setup && <ModSetupDialog open={open} mod={mod} connected={connected} send={send} close={close} />}
    </div>
  )
}

const setupTitle = (mod: ModInfo) => mod.setup?.message ?? `${mod.name} isn't set up`

type SetupProps = { mod: ModInfo; connected: boolean; send: (m: ClientMessage) => void }

function SetupStatus({ mod }: { mod: ModInfo }) {
  const setup = mod.setup!
  const percent = Math.round((setup.progress ?? 0) * 100)
  return (
    <>
      {setup.status === 'installing' && (
        <div className="flex flex-col gap-6">
          <div
            role="progressbar"
            aria-label={`Installing ${mod.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-6 overflow-hidden rounded-full bg-raised shadow-sunken"
          >
            <div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          <span className="text-sm text-muted">{setup.progressText ?? 'Installing…'}</span>
        </div>
      )}
      {setup.status === 'checking' && <span className="text-sm text-muted">Checking…</span>}
      {setup.error && <ErrorText>{setup.error}</ErrorText>}
    </>
  )
}

function ModSetupDialog({ open, mod, connected, send, close }: SetupProps & { open: boolean; close: () => void }) {
  const focus = useReturnFocus()
  const installing = mod.setup?.status === 'installing'
  const cancel = () => {
    if (installing) send({ type: 'mod.cancelInstall', modId: mod.id })
    close()
  }
  return (
    <AlertDialog.Root open={open} onOpenChange={(open) => open || close()}>
      <AnimatePresence>
        {open && (
          <AlertDialog.Portal forceMount>
            <AlertDialog.Overlay forceMount asChild>
              <m.div className="fixed inset-0 bg-backdrop" {...MOTION.fade} />
            </AlertDialog.Overlay>
            <AlertDialog.Content
              forceMount
              asChild
              aria-describedby={undefined}
              onOpenAutoFocus={focus.remember}
              onCloseAutoFocus={focus.restore}
            >
              <m.div
                className="fixed inset-0 m-auto flex h-fit max-h-[calc(100vh-32px)] w-[min(420px,calc(100vw-32px))] flex-col gap-16 overflow-y-auto rounded-xl border bg-panel px-16 pt-14 pb-16 text-text shadow-overlay"
                {...MOTION.pop}
              >
                <Hint text={mod.setup?.description} side="bottom" align="start">
                  <AlertDialog.Title className="w-fit cursor-help text-[16px] font-semibold">
                    {setupTitle(mod)}
                  </AlertDialog.Title>
                </Hint>
                <SetupStatus mod={mod} />
                <div className="flex justify-end gap-8">
                  <Button onClick={cancel}>Cancel</Button>
                  <Button
                    variant="primary"
                    disabled={!connected || mod.setup?.status !== 'missing'}
                    onClick={() => send({ type: 'mod.install', modId: mod.id })}
                  >
                    {installing ? 'Installing…' : 'Install'}
                  </Button>
                </div>
              </m.div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        )}
      </AnimatePresence>
    </AlertDialog.Root>
  )
}

function ModSetupRow({ mod, connected, send }: SetupProps) {
  const status = mod.setup!.status
  return (
    <SettingRow
      name={<span className={status === 'ready' ? '' : 'text-amber'}>{setupTitle(mod)}</span>}
      hint={mod.setup!.description}
      below={(status === 'installing' || status === 'checking' || mod.setup!.error) && <SetupStatus mod={mod} />}
    >
      {status === 'ready' && <span className="rounded-full bg-green/14 px-8 py-2 text-xs text-green">Ready</span>}
      {status === 'missing' && (
        <Button variant="primary" disabled={!connected} onClick={() => send({ type: 'mod.install', modId: mod.id })}>
          Install
        </Button>
      )}
      {status === 'installing' && (
        <Button disabled={!connected} onClick={() => send({ type: 'mod.cancelInstall', modId: mod.id })}>
          Cancel
        </Button>
      )}
    </SettingRow>
  )
}

const modPages = (mods: ModInfo[]): Page[] =>
  mods
    .filter((mod) => mod.enabled && (mod.settings.length || mod.setup))
    .map((mod) => ({
      id: `mod:${mod.id}`,
      group: 'Mods',
      title: mod.name,
      body: ({ connected, send }: PageProps) => (
        <div className={GROUP}>
          {mod.setup && <ModSetupRow mod={mod} connected={connected} send={send} />}
          {mod.settings.map((setting) => (
            <SettingRow key={setting.key} name={setting.label} hint={setting.description}>
              <ModSettingControl
                setting={setting}
                value={mod.values[setting.key]}
                disabled={!connected}
                save={(value) => send({ type: 'mod.setValue', modId: mod.id, key: setting.key, value })}
              />
            </SettingRow>
          ))}
        </div>
      ),
    }))

type RowProps = { name: ReactNode; description?: ReactNode; hint?: string; children?: ReactNode; below?: ReactNode }

function ShownPaths() {
  const paths = usePathsShown()
  return (
    <>
      <div className="pt-24 pb-8 font-semibold">File paths</div>
      <div className={GROUP}>
        <SettingRow name="At the top of a space" hint="Show the space's folder beside its name. Hidden, it shows on hover.">
          <Switch label="Show paths at the top of a space" checked={paths.header} onChange={(on) => showPaths('header', on)} />
        </SettingRow>
        <SettingRow name="In the Context panel" hint="Show each AGENTS.md, folder and file's full path on its card">
          <Switch label="Show paths in the Context panel" checked={paths.context} onChange={(on) => showPaths('context', on)} />
        </SettingRow>
      </div>
    </>
  )
}

function ShownSteps() {
  const shown = useStepsDefault()
  return (
    <>
      <div className="pt-24 pb-8 font-semibold">Thinking and tool calls</div>
      <div className={GROUP}>
        <SettingRow
          name="Show unfolded"
          hint={`List each finished turn's thinking and tool calls open instead of folding them into "N steps". Each ${CHAT_NOUN.one} can override this in its Context panel.`}
        >
          <Switch label="Show thinking and tool calls unfolded" checked={shown} onChange={showStepsByDefault} />
        </SettingRow>
      </div>
    </>
  )
}

function SettingRow({ name, description, hint, children, below }: RowProps) {
  return (
    <Hint text={hint} align="start">
      <div className="flex flex-wrap items-center gap-x-16 gap-y-8 py-12 not-first:border-t">
        <div className="flex min-w-200 flex-1 flex-col gap-2 wrap-anywhere">
          {name}
          {description && <div className="text-sm text-muted">{description}</div>}
        </div>
        <div className="flex max-w-full min-w-0 items-center gap-6">{children}</div>
        {below && <div className="basis-full">{below}</div>}
      </div>
    </Hint>
  )
}

type EngineModelsProps = {
  engine: EngineInfo
  lists: ModelLists
  connected: boolean
  send: (m: ClientMessage) => void
}

function EngineModels({ engine, lists, connected, send }: EngineModelsProps) {
  const offered = engine.models ?? []
  const labelOf = (id: string) => offered.find((m) => m.id === id)?.label
  return (
    <section className="flex flex-col not-first:pt-24" aria-label={`${engine.id} models`}>
      <h3 className="pb-8 font-mono font-semibold">{engine.id}</h3>
      {!offered.length && (
        <p className="text-muted">
          {engine.id} lists no models{engineProblem(engine) && ` (${engineProblem(engine)})`}.
        </p>
      )}
      {offered.length > 0 && (
        <div className={GROUP}>
          {MODEL_ROLES.map((role) => {
            const list = lists[role]
            const { name, about } = ROLES[role]
            const setList = (models: string[]) => send({ type: 'models.setList', engine: engine.id, role, models })
            const move = (from: number, to: number) => {
              const next = [...list]
              next.splice(to, 0, ...next.splice(from, 1))
              setList(next)
            }
            const items = list.map((id, i) => {
              const label = labelOf(id)
              return (
                <li key={id} className="flex h-28 items-center gap-6 rounded pr-2 pl-8 hover:bg-raised">
                  <span className="w-16 text-sm text-faint">{i + 1}</span>
                  <span className={`min-w-0 flex-1 truncate ${label ? '' : 'font-mono text-muted'}`}>
                    {label ?? `${id} (not offered, skipped)`}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Move ${label ?? id} up`}
                    disabled={!connected || i === 0}
                    onClick={() => move(i, i - 1)}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Move ${label ?? id} down`}
                    disabled={!connected || i === list.length - 1}
                    onClick={() => move(i, i + 1)}
                  >
                    ↓
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${label ?? id}`}
                    disabled={!connected}
                    onClick={() => setList(list.filter((m) => m !== id))}
                  >
                    ×
                  </Button>
                </li>
              )
            })
            const addable = offered.filter((m) => !list.includes(m.id))
            return (
              <SettingRow
                key={role}
                name={name}
                hint={about}
                below={items.length > 0 && <ol aria-label={`${engine.id} ${name} models`}>{items}</ol>}
              >
                <Select
                  label={`Add a ${name} model for ${engine.id}`}
                  value=""
                  placeholder="Add model…"
                  disabled={!connected || !addable.length}
                  options={addable.map((m) => ({ value: m.id, label: m.label }))}
                  onChange={(model) => setList([...list, model])}
                />
              </SettingRow>
            )
          })}
          {engine.defaultThinking && (
            <SettingRow name="Default thinking" hint={`For ${CHAT_NOUN.many} that don't pick a level.`}>
              <Select
                label={`Default thinking for ${engine.id}`}
                value={engine.defaultThinking}
                disabled={!connected}
                options={(engine.thinking ?? []).map((level) => ({ value: level, label: level }))}
                onChange={(thinking) => send({ type: 'engine.setDefaultThinking', engine: engine.id, thinking })}
              />
            </SettingRow>
          )}
        </div>
      )}
    </section>
  )
}

type EngineAccountsProps = { accounts: EngineAccounts; connected: boolean; send: (m: ClientMessage) => void }

function EngineAccountsSection({ accounts, connected, send }: EngineAccountsProps) {
  const id = accounts.engine
  const login = accounts.login
  const listed = listedAccounts(accounts)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [keyName, setKeyName] = useState('')
  const [key, setKey] = useState('')
  const startLogin = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    send({ type: 'account.login', engine: id, name: name.trim() })
    setName('')
  }
  const submitCode = (e: FormEvent) => {
    e.preventDefault()
    if (!code.trim()) return
    send({ type: 'account.code', engine: id, code: code.trim() })
    setCode('')
  }
  const addKey = (e: FormEvent) => {
    e.preventDefault()
    if (!keyName.trim() || !key.trim()) return
    send({ type: 'account.addApiKey', engine: id, name: keyName.trim(), key })
    setKeyName('')
    setKey('')
  }
  const remove = async (account: Account) => {
    const question =
      account.kind === 'apiKey'
        ? `Remove ${account.name} and delete its saved API key?`
        : `Sign out of ${account.name} and remove it from Hotrod?`
    if (!(await confirm(question))) return
    send({ type: 'account.remove', engine: id, accountId: account.id })
  }
  const cancelLogin = (
    <Button disabled={!connected} onClick={() => send({ type: 'account.cancelLogin', engine: id })}>
      Cancel
    </Button>
  )

  return (
    <section className="flex flex-col not-first:pt-24" aria-label={`${id} accounts`}>
      <h3 className="pb-8 font-mono font-semibold">{id}</h3>
      <div className={GROUP}>
        {listed.accounts.map((a) => (
          <SettingRow
            key={a.id}
            name={accountLabel(a)}
            description={a.id === 'default' && !a.signedIn && `No one is signed in to ${id} itself`}
            hint={a.id === 'default' && a.signedIn ? `Signed in through ${id} itself, not saved in Hotrod` : undefined}
          >
            {a.id === listed.active ? (
              <span className="rounded-full bg-green/14 px-8 py-2 text-xs text-green">Active</span>
            ) : (
              <Button
                size="small"
                disabled={!connected}
                onClick={() => send({ type: 'account.use', engine: id, accountId: a.id })}
              >
                Use
              </Button>
            )}
            {a.id !== 'default' && (
              <Button size="small" variant="danger" disabled={!connected} onClick={() => remove(a)}>
                Remove
              </Button>
            )}
          </SettingRow>
        ))}
        {!login ? (
          <SettingRow name="Add account" hint="Sign in to another account in your browser.">
            <form className="flex min-w-0 gap-6" onSubmit={startLogin}>
              <input
                className="w-160"
                value={name}
                placeholder="Name, e.g. Work"
                onChange={(e) => setName(e.target.value)}
              />
              <Button variant="primary" disabled={!connected || !name.trim()}>
                Sign in…
              </Button>
            </form>
          </SettingRow>
        ) : login.error ? (
          <SettingRow name={<ErrorText>{login.error}</ErrorText>}>
            <Button onClick={() => send({ type: 'account.cancelLogin', engine: id })}>Dismiss</Button>
          </SettingRow>
        ) : (
          <>
            <SettingRow name={`Signing in “${login.name}”`} description="Finish in the browser window that opened.">
              {!login.url && cancelLogin}
            </SettingRow>
            {login.url && (
              <SettingRow
                name="Paste a code"
                description={
                  <>
                    No window, or it is signed in to another account? Open{' '}
                    <a className="text-accent underline" href={login.url} target="_blank" rel="noreferrer">
                      this sign-in link
                    </a>{' '}
                    (a private window lets you pick the account), then paste the code it shows.
                  </>
                }
              >
                <form className="flex min-w-0 gap-6" onSubmit={submitCode}>
                  <input
                    className="w-120"
                    value={code}
                    placeholder="Code"
                    spellCheck={false}
                    onChange={(e) => setCode(e.target.value)}
                  />
                  <Button variant="primary" disabled={!connected || !code.trim()}>
                    Submit code
                  </Button>
                </form>
                {cancelLogin}
              </SettingRow>
            )}
          </>
        )}
        {accounts.apiKeys && (
          <SettingRow name="Add API key" hint="Use an API key instead of a sign-in.">
            <form className="flex min-w-0 gap-6" onSubmit={addKey}>
              <input
                className="w-120"
                value={keyName}
                placeholder="API key name"
                onChange={(e) => setKeyName(e.target.value)}
              />
              <input
                className="w-140"
                type="password"
                value={key}
                placeholder="API key"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setKey(e.target.value)}
              />
              <Button disabled={!connected || !keyName.trim() || !key.trim()}>Add</Button>
            </form>
          </SettingRow>
        )}
      </div>
    </section>
  )
}

type ModSettingProps = {
  setting: ModSetting
  value: string | number | boolean | undefined
  disabled: boolean
  save: (value: string | number | boolean) => void
}

function ModSettingControl({ setting, value, disabled, save }: ModSettingProps) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  if (setting.type === 'boolean') {
    return <Switch label={setting.label} checked={value === true} disabled={disabled} onChange={save} />
  }
  if (setting.type === 'select') {
    return (
      <Select
        label={setting.label}
        value={String(value)}
        disabled={disabled}
        options={setting.options.map((option) => ({ value: String(option.value), label: option.label }))}
        onChange={(picked) => {
          const option = setting.options.find((o) => String(o.value) === picked)
          if (option) save(option.value)
        }}
      />
    )
  }
  const commit = () => {
    const next = Number(draft)
    if (draft.trim() && !settingProblem(setting, next) && next !== value) save(next)
    else setDraft(String(value))
  }
  return (
    <input
      className="w-72"
      aria-label={setting.label}
      type="number"
      min={setting.min}
      max={setting.max}
      step={setting.integer ? 1 : 'any'}
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  )
}

type WorkFolderDialogProps = {
  open: boolean
  workFolder: WorkFolder
  connected: boolean
  send: (m: ClientMessage) => void
  toasts: { id: number; message: string }[]
  pickFolder?: (title: string) => Promise<string | null>
  close?: () => void
}

export function WorkFolderDialog({ open, workFolder, connected, send, toasts, pickFolder, close }: WorkFolderDialogProps) {
  const [shown, setShown] = useState(false)
  const [path, setPath] = useState('')
  const [sentAfter, setSentAfter] = useState<number>()
  if (open !== shown) {
    setShown(open)
    setPath(workFolder.path ?? '')
    setSentAfter(undefined)
  }
  // The core refuses a folder with an error toast, which the dialog would hide, so it shows here.
  const error = sentAfter === undefined ? undefined : toasts.findLast((t) => t.id > sentAfter)?.message
  const focus = useReturnFocus()
  const choose = (chosen: string) => {
    setSentAfter(toasts.at(-1)?.id ?? 0)
    send({ type: 'workFolder.set', path: chosen })
  }
  const pick = async () => {
    const picked = await pickFolder?.(WORK_FOLDER_TITLE)
    if (!picked) return
    setPath(picked)
    choose(picked)
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (connected && path.trim()) choose(path.trim())
  }
  return (
    <Dialog.Root open={open} onOpenChange={(open) => open || close?.()}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay forceMount asChild>
              <m.div className="fixed inset-0 bg-backdrop" {...MOTION.fade} />
            </Dialog.Overlay>
            <Dialog.Content
              forceMount
              asChild
              aria-describedby={undefined}
              onOpenAutoFocus={focus.remember}
              onCloseAutoFocus={focus.restore}
            >
              <m.form
                className="fixed inset-0 m-auto flex h-fit max-h-[calc(100vh-32px)] w-[min(520px,calc(100vw-32px))] flex-col gap-12 overflow-y-auto rounded-xl border bg-panel px-16 pt-14 pb-16 text-text shadow-overlay"
                {...MOTION.pop}
                onSubmit={submit}
              >
                <Hint text={WORK_FOLDER_HINT} side="bottom" align="start">
                  <Dialog.Title className="w-fit cursor-help text-[16px] font-semibold">{WORK_FOLDER_TITLE}</Dialog.Title>
                </Hint>
                <label className="flex flex-col gap-4">
                  <span className="text-muted">Folder</span>
                  <span className="flex gap-6">
                    <input
                      className="flex-1 font-mono text-sm"
                      value={path}
                      placeholder={workFolder.defaultPath}
                      spellCheck={false}
                      onChange={(e) => setPath(e.target.value)}
                    />
                    {pickFolder && (
                      <Button type="button" disabled={!connected} onClick={() => void pick()}>
                        Choose…
                      </Button>
                    )}
                  </span>
                </label>
                <p className="text-sm text-muted">
                  Default: <span className="font-mono wrap-anywhere">{workFolder.defaultPath}</span>
                </p>
                {error && <ErrorText>{error}</ErrorText>}
                <div className="flex flex-wrap justify-end gap-8">
                  <Button
                    type="button"
                    className="mr-auto"
                    disabled={!connected}
                    onClick={() => choose(workFolder.defaultPath)}
                  >
                    Use default
                  </Button>
                  {close && (
                    <Dialog.Close asChild>
                      <Button type="button">Cancel</Button>
                    </Dialog.Close>
                  )}
                  <Button variant="primary" disabled={!connected || !path.trim()}>
                    Use this folder
                  </Button>
                </div>
              </m.form>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}

type SettingsProps = PageProps & {
  open: boolean
  page: SettingsPage
  openPage: (page: SettingsPage) => void
  close: () => void
}

export function SettingsDialog({ open, page, openPage, close, ...props }: SettingsProps) {
  const focus = useReturnFocus()
  const pages: readonly Page[] = [...PAGES, ...modPages(props.mods)]
  const current = pages.find((p) => p.id === page) ?? PAGES[0]
  return (
    <Dialog.Root open={open} onOpenChange={(open) => open || close()}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay forceMount asChild>
              <m.div className="fixed inset-0 bg-backdrop" {...MOTION.fade} />
            </Dialog.Overlay>
            <Dialog.Content
              forceMount
              asChild
              aria-describedby={undefined}
              onOpenAutoFocus={focus.remember}
              onCloseAutoFocus={focus.restore}
            >
              <m.div
                className="fixed inset-0 m-auto flex h-[min(620px,calc(100vh-32px))] w-[min(880px,calc(100vw-32px))] overflow-hidden rounded-xl border bg-bg text-text shadow-overlay"
                {...MOTION.pop}
              >
                <Dialog.Title className="sr-only">Settings</Dialog.Title>
                <Tabs.Root
                  className="flex min-w-0 flex-1 max-[600px]:flex-col"
                  orientation="vertical"
                  value={current.id}
                  onValueChange={(id) => openPage(id as SettingsPage)}
                >
                  <Tabs.List
                    aria-label="Settings"
                    className="flex w-200 shrink-0 flex-col gap-1 overflow-y-auto border-r bg-panel px-8 pt-4 pb-12 max-[720px]:w-160 max-[600px]:w-auto max-[600px]:flex-row max-[600px]:flex-wrap max-[600px]:border-r-0 max-[600px]:border-b max-[600px]:py-8 max-[600px]:pr-44"
                  >
                    {NAV_GROUPS.map((group) => (
                      <Fragment key={group}>
                        <div className={`${NAV_LABEL} max-[600px]:hidden`}>{group}</div>
                        {pages
                          .filter((p) => p.group === group)
                          .map((p) => (
                            <Tabs.Trigger key={p.id} value={p.id} asChild>
                              <Hint text={p.hint} side="right">
                                <button className="flex h-control shrink-0 items-center rounded px-8 text-left text-muted transition-colors hover:bg-raised hover:text-text data-[state=active]:bg-raised data-[state=active]:text-text">
                                  {p.title}
                                </button>
                              </Hint>
                            </Tabs.Trigger>
                          ))}
                      </Fragment>
                    ))}
                  </Tabs.List>
                  {pages.map((p) => (
                    <Tabs.Content key={p.id} value={p.id} asChild>
                      <m.div
                        className="min-h-0 min-w-0 flex-1 overflow-y-auto px-32 pt-20 pb-32 focus-visible:-outline-offset-2 max-[600px]:px-16"
                        initial={MOTION.fade.initial}
                        animate={MOTION.fade.animate}
                      >
                        <h2 className="pr-24 text-[16px] font-semibold">{p.title}</h2>
                        <div className="mt-16 flex flex-col">{p.body(props)}</div>
                      </m.div>
                    </Tabs.Content>
                  ))}
                </Tabs.Root>
                <Dialog.Close asChild>
                  <Button variant="ghost" size="icon" aria-label="Close" className="absolute top-14 right-14">
                    ×
                  </Button>
                </Dialog.Close>
              </m.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}
