import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Dialog } from 'radix-ui'
import {
  CONTEXT_KINDS,
  type Account,
  type ClientMessage,
  type ContextKind,
  type EngineAccounts,
  type EngineInfo,
  type Mods,
} from '@hotrod/core/types'
import { CONTEXT_LABELS } from './context-panel.tsx'
import { Button, confirm, ErrorText, Switch, useReturnFocus } from './controls.tsx'
import { accountLabel, engineProblem } from './state.ts'

const card = (on: boolean) => `flex flex-col rounded-lg border px-12 py-10 ${on ? 'bg-bg' : ''}`

function SettingRow({ title, detail, children }: { title: ReactNode; detail: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-12">
      <span className="flex min-w-0 flex-1 flex-col">
        {title}
        {detail}
      </span>
      {children}
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-8">
      <h3 className="text-xs font-semibold tracking-[0.04em] text-faint uppercase">{title}</h3>
      <p className="text-muted">{hint}</p>
      {children}
    </section>
  )
}

type EngineProps = {
  engine: EngineInfo
  accounts?: EngineAccounts
  connected: boolean
  send: (m: ClientMessage) => void
}

function EngineSettings({ engine, accounts, connected, send }: EngineProps) {
  const id = engine.id
  const login = accounts?.login
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
  const problem = engineProblem(engine)

  return (
    <section className={`${card(engine.enabled)} gap-8`} aria-label={`${id} settings`}>
      <SettingRow
        title={<span className="font-mono">{id}</span>}
        detail={
          <span className={`text-sm wrap-anywhere first-letter:uppercase ${problem ? 'text-amber' : 'text-green'}`}>
            {problem ?? 'Ready'}
            {engine.detail && ` · ${engine.detail}`}
          </span>
        }
      >
        <Switch
          label={`${id} on`}
          checked={engine.enabled}
          disabled={!connected}
          onChange={(enabled) => send({ type: 'engine.setEnabled', engine: id, enabled })}
        />
      </SettingRow>
      {engine.enabled && accounts && (
        <div className="flex flex-col gap-8">
          <ul className="flex flex-col rounded-lg border">
            {accounts.accounts.map((a) => (
              <li key={a.id} className="flex min-h-40 items-center gap-6 py-6 pr-8 pl-12 not-first:border-t">
                <span className="flex min-w-0 flex-1 flex-col wrap-anywhere">
                  {accountLabel(a)}
                  {a.id === 'default' && <span className="text-sm text-faint">{id}'s own sign-in</span>}
                </span>
                {a.id === accounts.active ? (
                  <span className="rounded-full bg-green/14 px-8 py-2 text-xs text-green">In use</span>
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
              </li>
            ))}
          </ul>
          {!login ? (
            <form className="flex gap-6" onSubmit={startLogin}>
              <input
                className="flex-1"
                value={name}
                placeholder="New account name, e.g. Work"
                onChange={(e) => setName(e.target.value)}
              />
              <Button variant="primary" disabled={!connected || !name.trim()}>
                Sign in…
              </Button>
            </form>
          ) : login.error ? (
            <div className="flex flex-col items-start gap-8">
              <ErrorText>{login.error}</ErrorText>
              <Button onClick={() => send({ type: 'account.cancelLogin', engine: id })}>Dismiss</Button>
            </div>
          ) : (
            <div className="flex flex-col items-start gap-8">
              <p className="max-w-[60ch]">Signing in “{login.name}”. Finish in the browser window that opened.</p>
              {login.url && (
                <>
                  <p className="max-w-[60ch] text-muted">
                    No window, or it is signed in to another account? Open{' '}
                    <a className="text-accent underline" href={login.url} target="_blank" rel="noreferrer">
                      this sign-in link
                    </a>{' '}
                    (a private window lets you pick the account), then paste the code it shows:
                  </p>
                  <form className="flex gap-6 self-stretch" onSubmit={submitCode}>
                    <input
                      className="flex-1"
                      value={code}
                      placeholder="Code"
                      spellCheck={false}
                      onChange={(e) => setCode(e.target.value)}
                    />
                    <Button variant="primary" disabled={!connected || !code.trim()}>
                      Submit code
                    </Button>
                  </form>
                </>
              )}
              <Button disabled={!connected} onClick={() => send({ type: 'account.cancelLogin', engine: id })}>
                Cancel
              </Button>
            </div>
          )}
          {accounts.apiKeys && (
            <form className="flex gap-6" onSubmit={addKey}>
              <input
                className="flex-1"
                value={keyName}
                placeholder="API key name"
                onChange={(e) => setKeyName(e.target.value)}
              />
              <input
                className="flex-1"
                type="password"
                value={key}
                placeholder="API key"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setKey(e.target.value)}
              />
              <Button disabled={!connected || !keyName.trim() || !key.trim()}>Add API key</Button>
            </form>
          )}
        </div>
      )}
    </section>
  )
}

type SubagentsProps = { subagents: Mods['subagents']; connected: boolean; send: (m: ClientMessage) => void }

function SubagentsSettings({ subagents: { enabled, limit }, connected, send }: SubagentsProps) {
  const [draft, setDraft] = useState(String(limit))
  useEffect(() => setDraft(String(limit)), [limit])
  const save = () => {
    const next = Number(draft)
    if (draft.trim() && Number.isInteger(next) && next >= -1 && next !== limit) {
      send({ type: 'subagents.set', enabled, limit: next })
    } else setDraft(String(limit))
  }
  return (
    <div className={`${card(enabled)} gap-10`}>
      <SettingRow
        title="Subagents"
        detail={
          <span className="text-muted">
            Chats can hand a task to a new chat that reports back when it ends. Claude Code only.
          </span>
        }
      >
        <Switch
          label="Subagents"
          checked={enabled}
          disabled={!connected}
          onChange={(on) => send({ type: 'subagents.set', enabled: on, limit })}
        />
      </SettingRow>
      {enabled && (
        <label className="flex items-center gap-8 text-sm">
          Max running per chat
          <input
            className="w-72"
            type="number"
            min={-1}
            step={1}
            value={draft}
            disabled={!connected}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
          <span className="text-muted">-1 for no limit</span>
        </label>
      )}
    </div>
  )
}

type SettingsProps = {
  engines: EngineInfo[]
  accounts: EngineAccounts[]
  contextDefaults: Record<ContextKind, boolean>
  mods: Mods
  connected: boolean
  send: (m: ClientMessage) => void
  close: () => void
}

export function SettingsDialog({ engines, accounts, contextDefaults, mods, connected, send, close }: SettingsProps) {
  const focus = useReturnFocus()
  return (
    <Dialog.Root open onOpenChange={(open) => open || close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-backdrop" />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={focus.remember}
          onCloseAutoFocus={focus.restore}
          className="fixed inset-0 m-auto h-fit max-h-[calc(100vh-64px)] w-[min(560px,calc(100vw-32px))] overflow-y-auto rounded-[10px] border bg-panel text-text shadow"
        >
          <div className="flex flex-col gap-16 px-16 pt-14 pb-18">
            <header className="flex items-center justify-between">
              <Dialog.Title className="text-body font-semibold">Settings</Dialog.Title>
              <Dialog.Close asChild>
                <Button variant="ghost" aria-label="Close">
                  ×
                </Button>
              </Dialog.Close>
            </header>
            <Section title="Engines" hint="Hotrod only starts the engines you turn on here.">
              {engines.map((engine) => (
                <EngineSettings
                  key={engine.id}
                  engine={engine}
                  accounts={accounts.find((a) => a.engine === engine.id)}
                  connected={connected}
                  send={send}
                />
              ))}
            </Section>
            <Section
              title="Context"
              hint="Which AGENTS.md layers a chat gets unless you change it in that chat's Context panel."
            >
              <div className={`${card(false)} gap-10`}>
                {CONTEXT_KINDS.map((kind) => (
                  <SettingRow
                    key={kind}
                    title={CONTEXT_LABELS[kind].label}
                    detail={<span className="text-muted">{CONTEXT_LABELS[kind].about}</span>}
                  >
                    <Switch
                      label={`${CONTEXT_LABELS[kind].label} on by default`}
                      checked={contextDefaults[kind]}
                      disabled={!connected}
                      onChange={(enabled) => send({ type: 'context.setDefault', kind, enabled })}
                    />
                  </SettingRow>
                ))}
              </div>
            </Section>
            <Section title="Mods" hint="Built-in mods. Each is off until you turn it on.">
              <SubagentsSettings subagents={mods.subagents} connected={connected} send={send} />
            </Section>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
