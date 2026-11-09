import { Fragment, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { AnimatePresence, m } from 'motion/react'
import { AlertDialog, Dialog, Tabs } from 'radix-ui'
import {
  CONTEXT_SECTIONS,
  MODEL_ROLES,
  MOD_USES,
  PERMISSION_SWITCHES,
  levelsOf,
  settingProblem,
  ROLE_NAMES,
  THINKING_LABELS,
  switchedOn,
  type Account,
  type ClientMessage,
  type ContextSection,
  type EngineAccounts,
  type EngineInfo,
  type ModelLists,
  type ModelRole,
  type ModelRow,
  type ThinkingLevel,
  type ModInfo,
  type WorkFolder,
} from '@kotharhq/core/shared'
import type { ModSetting } from '@kotharhq/mod-api'
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
import { accountLabel, engineName, engineProblem, listedAccounts, modelChoices, modelKey, fromModelKey } from './state.ts'
import { showPaths, usePathsShown } from './paths.ts'
import { showReportsByDefault, showStepsByDefault, useReportsDefault, useStepsDefault } from './steps.ts'
import { MarketplacePage, MOD_WARNING, modStatus, UsesList, type Market } from './marketplace.tsx'
import { Appearance } from './themes.tsx'
import { ShortcutsPage } from './shortcuts-page.tsx'

type PageProps = {
  engines: EngineInfo[]
  accounts: EngineAccounts[]
  contextDefaults: Record<ContextSection, boolean>
  mods: ModInfo[]
  modelLists: ModelLists
  workFolder: WorkFolder
  chooseWorkFolder: () => void
  connected: boolean
  send: (m: ClientMessage) => void
  // Installed themes and the marketplace's catalog.
  market?: Market
}

const NO_MARKET: Market = { marketFailures: {} }

type Page = {
  id: string
  group: (typeof NAV_GROUPS)[number]
  title: string
  intro?: string
  body: (props: PageProps) => ReactNode
}

const NAV_GROUPS = ['Options', 'Mods'] as const

const WORK_FOLDER_TITLE = 'Choose a work folder'
const WORK_FOLDER_HINT =
  'Agents and subagents do all their work here, and can write nowhere else unless you allow it, here or for a chat. ' +
  `Each ${CHAT_NOUN.one} gets a folder of its own inside it.`

const PERMISSION_DEFAULT_HINT = 'The switches below are the default for every chat; each can choose otherwise in its Context panel.'

const ROLE_ABOUT: Record<ModelRole, string> = {
  chat: 'Chats you start.',
  planning: 'Subagents started to plan.',
  searching: 'Subagents started to search.',
  subagents: 'Every other subagent.',
}

const PAGES = [
  {
    id: 'engines',
    group: 'Options',
    title: 'Engines',
    intro: 'Kothar only starts the engines you turn on here.',
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
    intro: `${WORK_FOLDER_HINT} ${PERMISSION_DEFAULT_HINT}`,
    body: ({ workFolder, chooseWorkFolder, connected, send }: PageProps) => (
      <div className={GROUP}>
        <SettingRow
          name="Work folder"
          description={<span className="font-mono">{workFolder.path ?? 'Not chosen'}</span>}
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
              description={about}
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
        <ShownReports />
      </>
    ),
  },
  {
    id: 'marketplace',
    group: 'Options',
    title: 'Marketplace',
    intro: 'Themes from their authors\' own repos, beyond Default and Glass. Installed themes show in Appearance.',
    body: ({ market = NO_MARKET, connected, send }: PageProps) => (
      <MarketplacePage market={market} connected={connected} send={send} />
    ),
  },
  {
    id: 'shortcuts',
    group: 'Options',
    title: 'Shortcuts',
    intro: 'Click an action\'s keys, then press new ones.',
    body: () => <ShortcutsPage />,
  },
  {
    id: 'accounts',
    group: 'Options',
    title: 'Accounts',
    intro:
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
    intro:
      'Each list runs its first model that can run, on any engine; if that engine is off or stops offering it, the ' +
      `next one runs. A ${CHAT_NOUN.one}'s own pick in its message box comes first.`,
    body: ({ engines, modelLists, connected, send }: PageProps) => {
      if (!engines.some((e) => e.enabled)) return <p className="text-muted">Turn on an engine to pick models.</p>
      return <ModelListsSection engines={engines} lists={modelLists} connected={connected} send={send} />
    },
  },
  {
    id: 'context',
    group: 'Options',
    title: 'Context',
    intro:
      `What a ${CHAT_NOUN.one} uses from the global AGENTS.md and the chats above it, unless you switch it in its ` +
      'Context panel. Its own AGENTS.md, folders and files always start on.',
    body: ({ contextDefaults, connected, send }: PageProps) => (
      <div className={GROUP}>
        {CONTEXT_SECTIONS.map((section) => (
          <SettingRow key={section} name={SECTIONS[section].label} description={SECTIONS[section].inherited}>
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
    intro: 'Mods that ship with Kothar. One with settings or a setup gets its own page while it is on.',
    body: (props: PageProps) => <ModsPage {...props} />,
  },
  {
    id: 'community-mods',
    group: 'Mods',
    title: 'Community mods',
    intro: 'Mods installed from the Marketplace or a folder. Each stays off until you turn it on, and runs from the next start.',
    body: (props: PageProps) => <CommunityModsPage {...props} />,
  },
] as const satisfies readonly Page[]

export type SettingsPage = (typeof PAGES)[number]['id'] | `mod:${string}`

function CommunityModsPage({ mods, connected, send }: PageProps) {
  const community = mods.filter((m) => m.community)
  const turn = async (m: ModInfo, enabled: boolean) => {
    if (enabled) {
      const uses = m.community!.uses.map((use) => `• ${MOD_USES[use]}`).join('\n')
      const ok = await confirm(
        `Turn on ${m.name}? It runs code on your computer with your permissions.` +
          (uses ? `\n\nIt says it:\n${uses}` : '') +
          '\n\nIt starts the next time Kothar starts.',
      )
      if (!ok) return
    }
    send({ type: 'mod.setEnabled', modId: m.id, enabled })
  }
  return (
    <>
      <p className="pb-12 text-sm text-amber">{MOD_WARNING}</p>
      {!community.length && <p className="text-muted">No community mods installed. Find them in the Marketplace.</p>}
      {community.length > 0 && (
        <div className={GROUP}>
          {community.map((m) => {
            const { version, author, uses, source, repo, path } = m.community!
            const status = modStatus(m)
            return (
              <SettingRow
                key={m.id}
                name={
                  <span className="flex flex-wrap items-baseline gap-x-8">
                    <span>{m.name}</span>
                    <span className="text-xs text-faint">
                      {version} by {author}
                    </span>
                    {source === 'local' && (
                      <Hint text={`Installed from ${path ?? 'a folder'}`}>
                        <span className="text-xs text-amber">Local</span>
                      </Hint>
                    )}
                  </span>
                }
                description={
                  <span className="flex flex-col gap-4">
                    <span>{m.description}</span>
                    <UsesList uses={uses} />
                    {repo && (
                      <a
                        className="w-fit text-xs text-faint underline-offset-2 hover:underline"
                        href={`https://github.com/${repo}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {repo}
                      </a>
                    )}
                    {status && <span className="text-faint">{status}</span>}
                  </span>
                }
                below={m.loadError && <ErrorText>Couldn't load: {m.loadError}</ErrorText>}
              >
                <Button
                  variant="ghost"
                  disabled={!connected}
                  onClick={() => send({ type: 'market.uninstall', kind: 'mod', id: m.id })}
                >
                  Uninstall
                </Button>
                <Switch label={m.name} checked={m.enabled} disabled={!connected} onChange={(on) => void turn(m, on)} />
              </SettingRow>
            )
          })}
        </div>
      )}
    </>
  )
}

function ModsPage({ mods: all, connected, send }: PageProps) {
  const mods = all.filter((m) => !m.community)
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
            <>
              {m.description}
              {m.enabled && m.setup?.status === 'missing' && <span className="block text-amber">{setupTitle(m)}</span>}
            </>
          }
          below={m.loadError && <ErrorText>Couldn't load: {m.loadError}</ErrorText>}
        >
          <Switch
            label={m.name}
            checked={m.enabled}
            disabled={!connected || m.loadError !== undefined}
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

// A mod's text is plain; its web addresses become links.
const linked = (text: string) =>
  text.split(/(https:\/\/[^\s)]*[^\s).,;:])/).map((part, i) =>
    i % 2 ? (
      <a key={i} className="text-accent underline" href={part} target="_blank" rel="noreferrer">
        {part}
      </a>
    ) : (
      part
    ),
  )

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
                <div className="flex flex-col gap-4">
                  <AlertDialog.Title className="text-[16px] font-semibold">{setupTitle(mod)}</AlertDialog.Title>
                  {mod.setup?.description && <p className="text-sm text-muted">{linked(mod.setup.description)}</p>}
                </div>
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
      description={linked(mod.setup!.description)}
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
          {mod.community && (
            <SettingRow name="Uses" description={<UsesList uses={mod.community.uses} />} />
          )}
          {mod.setup && <ModSetupRow mod={mod} connected={connected} send={send} />}
          {mod.settings.map((setting) => (
            <ModSettingRow
              key={setting.key}
              setting={setting}
              value={mod.values[setting.key]}
              disabled={!connected}
              save={(value) => send({ type: 'mod.setValue', modId: mod.id, key: setting.key, value })}
            />
          ))}
        </div>
      ),
    }))

type RowProps = { name: ReactNode; description?: ReactNode; children?: ReactNode; below?: ReactNode }

function ShownPaths() {
  const paths = usePathsShown()
  return (
    <>
      <div className="pt-24 pb-8 font-semibold">File paths</div>
      <div className={GROUP}>
        <SettingRow name="At the top of a space">
          <Switch label="Show paths at the top of a space" checked={paths.header} onChange={(on) => showPaths('header', on)} />
        </SettingRow>
        <SettingRow name="In the Context panel">
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
          description={`Instead of folding them into "N steps". Each ${CHAT_NOUN.one} can override this in its Context panel.`}
        >
          <Switch label="Show thinking and tool calls unfolded" checked={shown} onChange={showStepsByDefault} />
        </SettingRow>
      </div>
    </>
  )
}

function ShownReports() {
  const shown = useReportsDefault()
  return (
    <>
      <div className="pt-24 pb-8 font-semibold">Subagent reports</div>
      <div className={GROUP}>
        <SettingRow
          name="Show unfolded"
          description={`Folded, a report shows one line until opened. Each ${CHAT_NOUN.one} can override this in its General tab.`}
        >
          <Switch label="Show subagent reports unfolded" checked={shown} onChange={showReportsByDefault} />
        </SettingRow>
      </div>
    </>
  )
}

function SettingRow({ name, description, children, below }: RowProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-16 gap-y-8 py-12 not-first:border-t">
      <div className="flex min-w-200 flex-1 flex-col gap-2 wrap-anywhere">
        {name}
        {description && <div className="text-sm text-muted">{description}</div>}
      </div>
      <div className="flex max-w-full min-w-0 items-center gap-6">{children}</div>
      {below && <div className="basis-full">{below}</div>}
    </div>
  )
}

type ModelListsProps = {
  engines: EngineInfo[]
  lists: ModelLists
  connected: boolean
  send: (m: ClientMessage) => void
}

function ModelListsSection({ engines, lists, connected, send }: ModelListsProps) {
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
        : `Sign out of ${account.name} and remove it from Kothar?`
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
            description={
              a.id === 'default' && (a.signedIn ? `Signed in through ${id} itself` : `No one is signed in to ${id} itself`)
            }
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
          <SettingRow name="Add account">
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
          <SettingRow name="Add API key">
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

function ModSettingRow({ setting, value, disabled, save }: ModSettingProps) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const row = (control: ReactNode, below?: ReactNode) => (
    <SettingRow name={setting.label} description={setting.description && linked(setting.description)} below={below}>
      {control}
    </SettingRow>
  )
  if (setting.type === 'boolean') {
    return row(<Switch label={setting.label} checked={value === true} disabled={disabled} onChange={save} />)
  }
  if (setting.type === 'text') {
    const reset = () => {
      setDraft(setting.default)
      save('')
    }
    const commit = () => {
      if (!draft.trim()) reset()
      else if (draft !== value) save(draft)
    }
    return row(
      draft !== setting.default && (
        <Button size="small" disabled={disabled} onClick={reset}>
          Reset to default
        </Button>
      ),
      <textarea
        className="block w-full resize-y px-8 py-6 font-mono text-sm leading-[1.5] focus:border-accent disabled:text-muted"
        aria-label={setting.label}
        rows={setting.rows ?? 4}
        spellCheck={false}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
      />,
    )
  }
  if (setting.type === 'select') {
    return row(
      <Select
        label={setting.label}
        value={String(value)}
        disabled={disabled}
        options={setting.options.map((option) => ({ value: String(option.value), label: option.label }))}
        onChange={(picked) => {
          const option = setting.options.find((o) => String(o.value) === picked)
          if (option) save(option.value)
        }}
      />,
    )
  }
  const commit = () => {
    const next = Number(draft)
    if (draft.trim() && !settingProblem(setting, next) && next !== value) save(next)
    else setDraft(String(value))
  }
  return row(
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
    />,
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
                <div className="flex flex-col gap-4">
                  <Dialog.Title className="text-[16px] font-semibold">{WORK_FOLDER_TITLE}</Dialog.Title>
                  <p className="text-sm text-muted">{WORK_FOLDER_HINT}</p>
                </div>
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
                              <button className="flex h-control shrink-0 items-center rounded px-8 text-left text-muted transition-colors hover:bg-raised hover:text-text data-[state=active]:bg-raised data-[state=active]:text-text">
                                {p.title}
                              </button>
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
                        {p.intro && <p className="mt-4 max-w-[60ch] pr-24 text-sm text-muted">{p.intro}</p>}
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
