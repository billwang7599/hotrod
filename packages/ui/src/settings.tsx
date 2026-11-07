import { Fragment, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { AnimatePresence, m } from 'motion/react'
import { Dialog, Tabs } from 'radix-ui'
import {
  CONTEXT_SECTIONS,
  MODEL_ROLES,
  WORKSHOP_NAME,
  type Account,
  type ClientMessage,
  type ContextSection,
  type EngineAccounts,
  type EngineInfo,
  type ModelLists,
  type ModelRole,
  type Mods,
} from '@hotrod/core/shared'
import { SECTIONS } from './context-panel.tsx'
import { Button, CHAT_NOUN, confirm, ErrorText, MOTION, NAV_LABEL, Switch, useReturnFocus } from './controls.tsx'
import { accountLabel, engineProblem, listedAccounts, NO_LISTS } from './state.ts'

type PageProps = {
  engines: EngineInfo[]
  accounts: EngineAccounts[]
  contextDefaults: Record<ContextSection, boolean>
  mods: Mods
  modelLists: Record<string, ModelLists>
  connected: boolean
  send: (m: ClientMessage) => void
}

type Page = {
  id: string
  group: (typeof NAV_GROUPS)[number]
  title: string
  hint?: string
  shown?: (props: PageProps) => boolean
  body: (props: PageProps) => ReactNode
}

const NAV_GROUPS = ['Options', 'Mods'] as const

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
    body: ({ engines, connected, send }: PageProps) =>
      engines.map((engine) => {
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
      }),
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
      `What a ${CHAT_NOUN.one} uses from ${WORKSHOP_NAME} and the ${CHAT_NOUN.many} above it, unless you switch it in its Context panel. ` +
      'Its own AGENTS.md, folders and files always start on.',
    body: ({ contextDefaults, connected, send }: PageProps) =>
      CONTEXT_SECTIONS.map((section) => (
        <SettingRow key={section} name={SECTIONS[section].label} description={SECTIONS[section].inherited}>
          <Switch
            label={`${SECTIONS[section].label} from above on by default`}
            checked={contextDefaults[section]}
            disabled={!connected}
            onChange={(enabled) => send({ type: 'context.setDefault', section, enabled })}
          />
        </SettingRow>
      )),
  },
  {
    id: 'mods',
    group: 'Mods',
    title: 'Built-in mods',
    hint: 'Mods that ship with Hotrod. Each is off until you turn it on.',
    body: ({ mods: { subagents }, connected, send }: PageProps) => (
      <SettingRow
        name="Subagents"
        description="Chats can hand a task to a new chat that reports back when it ends. Claude Code only."
      >
        <Switch
          label="Subagents"
          checked={subagents.enabled}
          disabled={!connected}
          onChange={(on) => send({ type: 'subagents.set', enabled: on, limit: subagents.limit })}
        />
      </SettingRow>
    ),
  },
  {
    id: 'subagents',
    group: 'Mods',
    title: 'Subagents',
    shown: ({ mods }: PageProps) => mods.subagents.enabled,
    body: ({ mods, connected, send }: PageProps) => (
      <SubagentLimit subagents={mods.subagents} connected={connected} send={send} />
    ),
  },
] as const satisfies readonly Page[]

export type SettingsPage = (typeof PAGES)[number]['id']

type RowProps = { name: ReactNode; description?: ReactNode; children?: ReactNode; below?: ReactNode }

function SettingRow({ name, description, children, below }: RowProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-16 gap-y-8 py-12 not-first:border-t">
      <div className="flex min-w-200 flex-1 flex-col gap-2 wrap-anywhere">
        {name}
        {description && <div className="text-sm text-muted">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-6">{children}</div>
      {below && <div className="basis-full">{below}</div>}
    </div>
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
      {offered.length > 0 &&
        MODEL_ROLES.map((role) => {
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
              description={about}
              below={items.length > 0 && <ol aria-label={`${engine.id} ${name} models`}>{items}</ol>}
            >
              <select
                className="h-control rounded border bg-bg px-8"
                aria-label={`Add a ${name} model for ${engine.id}`}
                value=""
                disabled={!connected || !addable.length}
                onChange={(e) => setList([...list, e.target.value])}
              >
                <option value="">Add model…</option>
                {addable.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </SettingRow>
          )
        })}
      {offered.length > 0 && engine.defaultThinking && (
        <SettingRow name="Default thinking" description={`For ${CHAT_NOUN.many} that don't pick a level.`}>
          <select
            className="h-control rounded border bg-bg px-8"
            aria-label={`Default thinking for ${engine.id}`}
            value={engine.defaultThinking}
            disabled={!connected}
            onChange={(e) => send({ type: 'engine.setDefaultThinking', engine: engine.id, thinking: e.target.value })}
          >
            {engine.thinking?.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </SettingRow>
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
      {listed.accounts.map((a) => (
        <SettingRow
          key={a.id}
          name={accountLabel(a)}
          description={
            a.id === 'default' &&
            (a.signedIn ? `Signed in through ${id} itself, not saved in Hotrod` : `No one is signed in to ${id} itself`)
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
        <SettingRow name="Add account" description="Sign in to another account in your browser.">
          <form className="flex gap-6" onSubmit={startLogin}>
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
              <form className="flex gap-6" onSubmit={submitCode}>
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
        <SettingRow name="Add API key" description="Use an API key instead of a sign-in.">
          <form className="flex gap-6" onSubmit={addKey}>
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
    </section>
  )
}

type SubagentLimitProps = { subagents: Mods['subagents']; connected: boolean; send: (m: ClientMessage) => void }

function SubagentLimit({ subagents: { enabled, limit }, connected, send }: SubagentLimitProps) {
  const [draft, setDraft] = useState(String(limit))
  useEffect(() => setDraft(String(limit)), [limit])
  const save = () => {
    const next = Number(draft)
    if (draft.trim() && Number.isInteger(next) && next >= -1 && next !== limit) {
      send({ type: 'subagents.set', enabled, limit: next })
    } else setDraft(String(limit))
  }
  return (
    <SettingRow name="Max running per chat" description="How many subagents one chat can run at once. -1 for no limit.">
      <input
        className="w-72"
        aria-label="Max running per chat"
        type="number"
        min={-1}
        step={1}
        value={draft}
        disabled={!connected}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && save()}
      />
    </SettingRow>
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
  const pages: readonly Page[] = PAGES.filter((p) => !('shown' in p) || p.shown(props))
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
                className="fixed inset-0 m-auto flex h-[min(620px,calc(100vh-32px))] w-[min(880px,calc(100vw-32px))] overflow-hidden rounded-[10px] border bg-bg text-text shadow"
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
                            <Tabs.Trigger
                              key={p.id}
                              value={p.id}
                              className="flex h-control shrink-0 items-center rounded px-8 text-left text-muted hover:bg-raised hover:text-text data-[state=active]:bg-raised data-[state=active]:text-text"
                            >
                              {p.title}
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
                        {p.hint && <p className="mt-4 text-muted">{p.hint}</p>}
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
