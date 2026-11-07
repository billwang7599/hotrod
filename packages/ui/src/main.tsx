import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import type { Account, ChatStatus, ClientMessage, EngineAccounts, EngineInfo } from '@hotrod/core/types'
import { useCore } from './connection.ts'
import { Markdown } from './markdown.tsx'
import { accountLabel, engineOptions, initialState, reduce, type Item, type ProjectView } from './state.ts'
import './styles.css'

const TOAST_MS = 6_000
const SELECTED_KEY = 'hotrod.selectedProject'
const MANAGE_ACCOUNTS = '__manage'
const SEND_HINT = 'Enter to send · Shift+Enter for a new line'
const FORCE_STOP_HINT = 'Click Stopping… again to force stop'
const OUTCOMES = { allowed: '✓ Allowed', denied: '✕ Denied', cancelled: '– Cancelled' }
const FORCE_STOP_TEXT = 'Force stop? The engine and any command it started get a few seconds to exit, then are killed.'
const PLACEHOLDERS: Record<ChatStatus, string> = {
  idle: 'Message',
  running: 'Working…',
  waiting: 'Waiting for your approval…',
  stopping: 'Stopping…',
}

declare global {
  interface Window {
    hotrod?: {
      pickFolder(): Promise<string | null>
      onAddProject(listener: () => void): () => void
      onQuitting(listener: () => void): () => void
      forceQuit(): Promise<void>
    }
  }
}

type ItemProps = { item: Item; project: ProjectView; connected: boolean; send: (m: ClientMessage) => void }

function ItemView({ item, project, connected, send }: ItemProps) {
  switch (item.kind) {
    case 'user':
      return <div className="user">{item.text}</div>
    case 'text':
      return <Markdown className="assistant" text={item.text} />
    case 'error':
      return <div className="turn-error">{item.text}</div>
    case 'thinking':
      return (
        <details className="row thinking">
          <summary>
            <span className="chevron" />
            <span className="thinking-label">Thinking…</span>
          </summary>
          <div className="thinking-text">{item.text}</div>
        </details>
      )
    case 'tool':
      return (
        <details className={`row tool ${item.state}`}>
          <summary>
            <span className="chevron" />
            <span className="tool-name">{item.name}</span>
            <span className="tool-input">{item.summary}</span>
            <span className="tool-state">{item.state === 'waiting' ? 'waiting for approval' : item.state}</span>
          </summary>
          <pre className="row-body">
            {item.output ||
              (item.state === 'running' ? 'Running…' : item.state === 'waiting' ? 'Waiting for approval…' : 'No output')}
          </pre>
        </details>
      )
    case 'permission': {
      const fullInput = <pre className="row-body">{JSON.stringify(item.input, null, 2)}</pre>
      if (item.outcome !== 'pending') {
        return (
          <details className={`row permission-line ${item.outcome}`}>
            <summary>
              <span className="chevron" />
              <span className="permission-outcome">{OUTCOMES[item.outcome]}</span>
              <span className="tool-name">{item.name}</span>
              <span className="tool-input">{item.summary}</span>
            </summary>
            {fullInput}
          </details>
        )
      }
      const respond = (allow: boolean) =>
        send({ type: 'permission.respond', projectId: project.id, requestId: item.requestId, allow })
      return (
        <div className="permission">
          <div className="permission-title">
            Allow <strong>{item.name}</strong>?
          </div>
          <pre className="permission-summary">{item.summary}</pre>
          <details className="permission-input">
            <summary>Full input</summary>
            {fullInput}
          </details>
          {project.status === 'waiting' ? (
            <div className="permission-actions">
              <button className="primary" disabled={!connected} onClick={() => respond(true)}>
                Approve
              </button>
              <button className="danger" disabled={!connected} onClick={() => respond(false)}>
                Deny
              </button>
            </div>
          ) : (
            <div className="permission-note">{project.status === 'stopping' ? 'Stopping…' : 'Pending'}</div>
          )}
        </div>
      )
    }
  }
}

type AccountsProps = {
  accounts: EngineAccounts
  connected: boolean
  send: (m: ClientMessage) => void
  close: () => void
}

function AccountsDialog({ accounts, connected, send, close }: AccountsProps) {
  const { engine, login } = accounts
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [keyName, setKeyName] = useState('')
  const [key, setKey] = useState('')
  useEffect(() => dialogRef.current?.showModal(), [])
  const startLogin = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    send({ type: 'account.login', engine, name: name.trim() })
    setName('')
  }
  const submitCode = (e: FormEvent) => {
    e.preventDefault()
    if (!code.trim()) return
    send({ type: 'account.code', engine, code: code.trim() })
    setCode('')
  }
  const addKey = (e: FormEvent) => {
    e.preventDefault()
    if (!keyName.trim() || !key.trim()) return
    send({ type: 'account.addApiKey', engine, name: keyName.trim(), key })
    setKeyName('')
    setKey('')
  }
  const remove = (account: Account) => {
    const question =
      account.kind === 'apiKey'
        ? `Remove ${account.name} and delete its saved API key?`
        : `Sign out of ${account.name} and remove it from Hotrod?`
    if (!confirm(question)) return
    send({ type: 'account.remove', engine, accountId: account.id })
  }

  return (
    <dialog
      ref={dialogRef}
      className="accounts"
      aria-label={`${engine} accounts`}
      onClose={close}
      onClick={(e) => e.target === dialogRef.current && dialogRef.current.close()}
    >
      <div className="dialog-body">
        <header className="dialog-header">
          <h2>
            <span className="mono">{engine}</span> accounts
          </h2>
          <button className="ghost" aria-label="Close" onClick={() => dialogRef.current?.close()}>
            ×
          </button>
        </header>
        <ul className="account-list">
          {accounts.accounts.map((a) => (
            <li key={a.id}>
              <span className="account-name">
                {accountLabel(a)}
                {a.id === 'default' && <span className="account-note">{engine}'s own sign-in</span>}
              </span>
              {a.id === accounts.active ? (
                <span className="pill">In use</span>
              ) : (
                <button className="small" disabled={!connected} onClick={() => send({ type: 'account.use', engine, accountId: a.id })}>
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
        <section>
          <h3>Add an account</h3>
          {!login ? (
            <form className="inline-form" onSubmit={startLogin}>
              <input value={name} placeholder="Name, e.g. Work" onChange={(e) => setName(e.target.value)} />
              <button className="primary" disabled={!connected || !name.trim()}>
                Sign in…
              </button>
            </form>
          ) : login.error ? (
            <div className="account-login">
              <div className="turn-error">{login.error}</div>
              <button onClick={() => send({ type: 'account.cancelLogin', engine })}>Dismiss</button>
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
              <button disabled={!connected} onClick={() => send({ type: 'account.cancelLogin', engine })}>
                Cancel
              </button>
            </div>
          )}
        </section>
        {accounts.apiKeys && (
          <section>
            <h3>Add an API key</h3>
            <form className="inline-form" onSubmit={addKey}>
              <input value={keyName} placeholder="Name" onChange={(e) => setKeyName(e.target.value)} />
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
          </section>
        )}
      </div>
    </dialog>
  )
}

type ChatProps = {
  project: ProjectView
  engines: EngineInfo[]
  accounts?: EngineAccounts
  connected: boolean
  send: (m: ClientMessage) => void
  manageAccounts: () => void
}

function Chat({ project, engines, accounts, connected, send, manageAccounts }: ChatProps) {
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  useLayoutEffect(() => {
    const list = listRef.current
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight
  }, [project.items, project.draft, project.status])

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) list.scrollTop = list.scrollHeight
    })
    observer.observe(list)
    return () => observer.disconnect()
  }, [])

  const canSend = connected && project.status === 'idle'
  const submit = () => {
    if (!canSend || !text.trim()) return
    send({ type: 'chat.send', projectId: project.id, text })
    setText('')
  }
  const stop = () => {
    if (project.status !== 'stopping') return send({ type: 'chat.interrupt', projectId: project.id })
    if (window.confirm(FORCE_STOP_TEXT)) send({ type: 'chat.interrupt', projectId: project.id, force: true })
  }

  return (
    <main className="chat">
      <header className="chat-header">
        <div className="chat-title">
          <span className="chat-name">{project.name}</span>
          <span className="chat-path">{project.path}</span>
        </div>
        <select
          className="chip"
          aria-label="Engine"
          value={project.engine}
          disabled={!canSend}
          onChange={(e) => send({ type: 'project.setEngine', projectId: project.id, engine: e.target.value })}
        >
          {engineOptions(engines, project.engine).map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        {accounts && (
          <select
            className="chip"
            aria-label="Account"
            value={accounts.active}
            disabled={!canSend}
            onChange={(e) =>
              e.target.value === MANAGE_ACCOUNTS
                ? manageAccounts()
                : send({ type: 'account.use', engine: accounts.engine, accountId: e.target.value })
            }
          >
            {accounts.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {accountLabel(a)}
              </option>
            ))}
            <option value={MANAGE_ACCOUNTS}>Manage accounts…</option>
          </select>
        )}
      </header>
      <div
        className="messages"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        <div className="column">
          {project.items.length === 0 && !project.draft && (
            <div className="empty">
              <strong>
                Start a chat in <span className="mono">{project.name}</span>
              </strong>
              <span>
                Each message starts <span className="mono">{project.engine}</span> in {project.path}
              </span>
            </div>
          )}
          {project.items.map((item, i) => (
            <ItemView key={i} item={item} project={project} connected={connected} send={send} />
          ))}
          {project.draft && <Markdown className="assistant streaming" text={project.draft} />}
        </div>
      </div>
      <div className="composer">
        <div className={`composer-box ${canSend ? '' : 'disabled'}`}>
          <textarea
            value={text}
            rows={2}
            placeholder={PLACEHOLDERS[project.status]}
            disabled={!canSend}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <div className="composer-footer">
            <span className="hint">{project.status === 'stopping' ? FORCE_STOP_HINT : SEND_HINT}</span>
            {project.status !== 'idle' ? (
              <button
                className={`danger stop ${project.status}`}
                disabled={!connected}
                title={project.status === 'stopping' ? FORCE_STOP_HINT : undefined}
                onClick={stop}
              >
                {project.status === 'stopping' ? 'Stopping…' : 'Stop'}
              </button>
            ) : (
              <button className="primary" disabled={!canSend || !text.trim()} onClick={submit}>
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}

function Toast({ id, message, dismiss }: { id: number; message: string; dismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => dismiss(id), TOAST_MS)
    return () => clearTimeout(timer)
  }, [id, dismiss])
  return (
    <div className="toast" role="status">
      <span>{message}</span>
      <button className="ghost" aria-label="Dismiss" onClick={() => dismiss(id)}>
        ×
      </button>
    </div>
  )
}

function App() {
  const [state, dispatch] = useReducer(reduce, initialState, (s) => ({ ...s, selectedId: localStorage.getItem(SELECTED_KEY) }))
  const send = useCore(dispatch)
  const dismissToast = useCallback((id: number) => dispatch({ type: 'toast.dismiss', id }), [])

  useEffect(() => {
    if (state.selectedId) localStorage.setItem(SELECTED_KEY, state.selectedId)
  }, [state.selectedId])
  const [path, setPath] = useState('')
  const pathRef = useRef<HTMLInputElement>(null)
  const [managing, setManaging] = useState<string | null>(null)
  const selected = state.projects.find((p) => p.id === state.selectedId)
  const engine = state.engines.find((e) => e.id === selected?.engine)
  const accounts = state.accounts.find((a) => a.engine === selected?.engine)
  const activeAccount = accounts?.accounts.find((a) => a.id === accounts.active)
  const signedIn = activeAccount?.signedIn ?? engine?.signedIn
  const managed = state.accounts.find((a) => a.engine === managing)

  const addProject = (e: FormEvent) => {
    e.preventDefault()
    if (!path.trim()) return
    send({ type: 'project.add', path: path.trim() })
    setPath('')
  }

  const connected = state.connected
  const pickProject = useCallback(async () => {
    if (!connected || !window.hotrod) return
    const picked = await window.hotrod.pickFolder()
    if (picked) send({ type: 'project.add', path: picked })
  }, [connected, send])
  useEffect(() => window.hotrod?.onAddProject(() => void pickProject()), [pickProject])
  const [quitting, setQuitting] = useState(false)
  useEffect(() => window.hotrod?.onQuitting(() => setQuitting(true)), [])

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="brand">Hotrod</span>
          <button
            className="ghost icon"
            aria-label="Add project"
            title={window.hotrod ? 'Add project… (⌘O)' : 'Add project'}
            disabled={!connected}
            onClick={() => (window.hotrod ? void pickProject() : pathRef.current?.focus())}
          >
            +
          </button>
        </div>
        <nav className="projects">
          {state.projects.map((p) => (
            <button
              key={p.id}
              className={`project ${p.id === state.selectedId ? 'selected' : ''}`}
              title={p.path}
              onClick={() => dispatch({ type: 'select', projectId: p.id })}
            >
              <span className={`dot ${p.status}`} />
              <span className="project-name">{p.name}</span>
              <span className="project-engine">{p.engine}</span>
            </button>
          ))}
        </nav>
        {window.hotrod ? (
          <div className="add-project">
            <button disabled={!connected} onClick={() => void pickProject()}>
              Add project…
            </button>
            <span className="hint">⌘O</span>
          </div>
        ) : (
          <form className="add-project" onSubmit={addProject}>
            <input
              ref={pathRef}
              value={path}
              placeholder="/path/to/project"
              spellCheck={false}
              onChange={(e) => setPath(e.target.value)}
            />
            <button disabled={!connected || !path.trim()}>Add</button>
          </form>
        )}
      </aside>
      <div className="main">
        {quitting && (
          <div className="banner warning">
            <span>Stopping engines…</span>
            <button className="small danger" onClick={() => void window.hotrod?.forceQuit()}>
              Force quit
            </button>
          </div>
        )}
        {state.rejected ? (
          <div className="banner error">
            <span>The core rejected this window. Open the link the core printed; it carries the token.</span>
          </div>
        ) : (
          !state.connected &&
          !quitting && (
            <div className="banner warning">
              <span>Disconnected from the core. Reconnecting…</span>
            </div>
          )
        )}
        {engine && (!engine.installed || !signedIn) && (
          <div className="banner warning">
            <span>
              {engine.id} is{' '}
              {!engine.installed
                ? 'not installed'
                : activeAccount && activeAccount.id !== 'default'
                  ? `not signed in as ${activeAccount.name}`
                  : 'not signed in'}
              .{engine.detail && ` ${engine.detail}`}
            </span>
          </div>
        )}
        {managed && (
          <AccountsDialog accounts={managed} connected={connected} send={send} close={() => setManaging(null)} />
        )}
        {selected ? (
          <Chat
            key={selected.id}
            project={selected}
            engines={state.engines}
            accounts={accounts}
            connected={state.connected}
            send={send}
            manageAccounts={() => setManaging(selected.engine)}
          />
        ) : (
          <div className="empty">
            <strong>No projects yet</strong>
            <span>
              {window.hotrod ? 'Add a project folder with + or ⌘O.' : 'Paste a project folder’s path in the sidebar.'}
            </span>
          </div>
        )}
      </div>
      <div className="toasts">
        {state.toasts.map((t) => (
          <Toast key={t.id} id={t.id} message={t.message} dismiss={dismissToast} />
        ))}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
