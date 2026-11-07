import { useEffect, useRef, useState, type FormEvent } from 'react'
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
import { Switch } from './controls.tsx'
import { accountLabel, engineProblem } from './state.ts'

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
  const remove = (account: Account) => {
    const question =
      account.kind === 'apiKey'
        ? `Remove ${account.name} and delete its saved API key?`
        : `Sign out of ${account.name} and remove it from Hotrod?`
    if (!confirm(question)) return
    send({ type: 'account.remove', engine: id, accountId: account.id })
  }
  const problem = engineProblem(engine)

  return (
    <section className={`engine-card ${engine.enabled ? 'on' : ''}`} aria-label={`${id} settings`}>
      <div className="engine-row">
        <span className="engine-name">
          <span className="mono">{id}</span>
          <span className={`engine-status ${problem ? 'problem' : 'ready'}`}>
            {problem ?? 'Ready'}
            {engine.detail && ` · ${engine.detail}`}
          </span>
        </span>
        <Switch
          label={`${id} on`}
          checked={engine.enabled}
          disabled={!connected}
          onChange={(enabled) => send({ type: 'engine.setEnabled', engine: id, enabled })}
        />
      </div>
      {engine.enabled && accounts && (
        <div className="engine-accounts">
          <ul className="account-list">
            {accounts.accounts.map((a) => (
              <li key={a.id}>
                <span className="account-name">
                  {accountLabel(a)}
                  {a.id === 'default' && <span className="account-note">{id}'s own sign-in</span>}
                </span>
                {a.id === accounts.active ? (
                  <span className="pill">In use</span>
                ) : (
                  <button
                    className="small"
                    disabled={!connected}
                    onClick={() => send({ type: 'account.use', engine: id, accountId: a.id })}
                  >
                    Use
                  </button>
                )}
                {a.id !== 'default' && (
                  <button className="small danger" disabled={!connected} onClick={() => remove(a)}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
          {!login ? (
            <form className="inline-form" onSubmit={startLogin}>
              <input value={name} placeholder="New account name, e.g. Work" onChange={(e) => setName(e.target.value)} />
              <button className="primary" disabled={!connected || !name.trim()}>
                Sign in…
              </button>
            </form>
          ) : login.error ? (
            <div className="account-login">
              <div className="turn-error">{login.error}</div>
              <button onClick={() => send({ type: 'account.cancelLogin', engine: id })}>Dismiss</button>
            </div>
          ) : (
            <div className="account-login">
              <p>Signing in “{login.name}”. Finish in the browser window that opened.</p>
              {login.url && (
                <>
                  <p className="muted">
                    No window, or it is signed in to another account? Open{' '}
                    <a href={login.url} target="_blank" rel="noreferrer">
                      this sign-in link
                    </a>{' '}
                    (a private window lets you pick the account), then paste the code it shows:
                  </p>
                  <form className="inline-form" onSubmit={submitCode}>
                    <input value={code} placeholder="Code" spellCheck={false} onChange={(e) => setCode(e.target.value)} />
                    <button className="primary" disabled={!connected || !code.trim()}>
                      Submit code
                    </button>
                  </form>
                </>
              )}
              <button disabled={!connected} onClick={() => send({ type: 'account.cancelLogin', engine: id })}>
                Cancel
              </button>
            </div>
          )}
          {accounts.apiKeys && (
            <form className="inline-form" onSubmit={addKey}>
              <input value={keyName} placeholder="API key name" onChange={(e) => setKeyName(e.target.value)} />
              <input
                type="password"
                value={key}
                placeholder="API key"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setKey(e.target.value)}
              />
              <button disabled={!connected || !keyName.trim() || !key.trim()}>Add API key</button>
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
    <div className={`engine-card ${enabled ? 'on' : ''}`}>
      <div className="engine-row">
        <span className="engine-name">
          Subagents
          <span className="muted">
            Chats can hand a task to a new chat that reports back when it ends. Claude Code only.
          </span>
        </span>
        <Switch
          label="Subagents"
          checked={enabled}
          disabled={!connected}
          onChange={(on) => send({ type: 'subagents.set', enabled: on, limit })}
        />
      </div>
      {enabled && (
        <label className="mod-limit">
          Max running per chat
          <input
            type="number"
            min={-1}
            step={1}
            value={draft}
            disabled={!connected}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
          <span className="muted">-1 for no limit</span>
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
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => dialogRef.current?.showModal(), [])
  return (
    <dialog
      ref={dialogRef}
      className="settings"
      aria-label="Settings"
      onClose={close}
      onClick={(e) => e.target === dialogRef.current && dialogRef.current.close()}
    >
      <div className="dialog-body">
        <header className="dialog-header">
          <h2>Settings</h2>
          <button className="ghost" aria-label="Close" onClick={() => dialogRef.current?.close()}>
            ×
          </button>
        </header>
        <section>
          <h3>Engines</h3>
          <p className="muted settings-hint">Hotrod only starts the engines you turn on here.</p>
          {engines.map((engine) => (
            <EngineSettings
              key={engine.id}
              engine={engine}
              accounts={accounts.find((a) => a.engine === engine.id)}
              connected={connected}
              send={send}
            />
          ))}
        </section>
        <section>
          <h3>Context</h3>
          <p className="muted settings-hint">
            Which AGENTS.md layers a chat gets unless you change it in that chat's Context panel.
          </p>
          <div className="context-defaults">
            {CONTEXT_KINDS.map((kind) => (
              <div key={kind} className="engine-row">
                <span className="engine-name">
                  {CONTEXT_LABELS[kind].label}
                  <span className="muted">{CONTEXT_LABELS[kind].about}</span>
                </span>
                <Switch
                  label={`${CONTEXT_LABELS[kind].label} on by default`}
                  checked={contextDefaults[kind]}
                  disabled={!connected}
                  onChange={(enabled) => send({ type: 'context.setDefault', kind, enabled })}
                />
              </div>
            ))}
          </div>
        </section>
        <section>
          <h3>Mods</h3>
          <p className="muted settings-hint">Built-in mods. Each is off until you turn it on.</p>
          <SubagentsSettings subagents={mods.subagents} connected={connected} send={send} />
        </section>
      </div>
    </dialog>
  )
}
