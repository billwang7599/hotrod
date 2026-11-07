import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import type { Account, ClientMessage, EngineAccounts, EngineInfo } from '@hotrod/core/types'
import { useCore } from './connection.ts'
import { Markdown } from './markdown.tsx'
import { accountLabel, engineOptions, initialState, reduce, type Item, type ProjectView } from './state.ts'
import './styles.css'

const TOAST_MS = 6_000
const SELECTED_KEY = 'hotrod.selectedProject'
const MANAGE_ACCOUNTS = '__manage'

declare global {
  interface Window {
    hotrod?: { pickFolder(): Promise<string | null>; onAddProject(listener: () => void): () => void }
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
        <details className="thinking">
          <summary>Thinking…</summary>
          <div className="thinking-text">{item.text}</div>
        </details>
      )
    case 'tool':
      return (
        <details className={`tool ${item.state}`}>
          <summary>
            <span className="tool-name">{item.name}</span>
            <span className="tool-input">{item.summary}</span>
            <span className="tool-state">{item.state === 'waiting' ? 'waiting for approval' : item.state}</span>
          </summary>
          <pre>
            {item.output ||
              (item.state === 'running' ? 'Running…' : item.state === 'waiting' ? 'Waiting for approval…' : 'No output')}
          </pre>
        </details>
      )
    case 'permission': {
      const respond = (allow: boolean) =>
        send({ type: 'permission.respond', projectId: project.id, requestId: item.requestId, allow })
      return (
        <div className={`permission ${item.outcome}`}>
          <div className="permission-title">
            Allow <strong>{item.name}</strong>?
          </div>
          <pre>{item.summary}</pre>
          <details className="permission-input">
            <summary>Full input</summary>
            <pre>{JSON.stringify(item.input, null, 2)}</pre>
          </details>
          {item.outcome === 'pending' && project.status === 'waiting' ? (
            <div className="permission-actions">
              <button className="approve" disabled={!connected} onClick={() => respond(true)}>
                Approve
              </button>
              <button className="deny" disabled={!connected} onClick={() => respond(false)}>
                Deny
              </button>
            </div>
          ) : (
            <div className="permission-outcome">{item.outcome}</div>
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

function AccountsPanel({ accounts, connected, send, close }: AccountsProps) {
  const { engine, login } = accounts
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [keyName, setKeyName] = useState('')
  const [key, setKey] = useState('')
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
    <section className="accounts">
      <header className="accounts-header">
        <strong>{engine} accounts</strong>
        <button onClick={close}>Close</button>
      </header>
      <ul className="account-list">
        {accounts.accounts.map((a) => (
          <li key={a.id}>
            <span className="account-name">{accountLabel(a)}</span>
            {a.id === 'default' && <span className="account-note">{engine}'s own sign-in</span>}
            {a.id === accounts.active ? (
              <span className="account-active">In use</span>
            ) : (
              <button disabled={!connected} onClick={() => send({ type: 'account.use', engine, accountId: a.id })}>
                Use
              </button>
            )}
            {a.id !== 'default' && (
              <button disabled={!connected} onClick={() => remove(a)}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {!login ? (
        <form className="account-form" onSubmit={startLogin}>
          <input
            value={name}
            placeholder="Name for another account, e.g. Work"
            onChange={(e) => setName(e.target.value)}
          />
          <button disabled={!connected || !name.trim()}>Sign in…</button>
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
              <p>
                No window, or it is signed in to another account? Open{' '}
                <a href={login.url} target="_blank" rel="noreferrer">
                  this sign-in link
                </a>{' '}
                (a private window lets you pick the account), then paste the code it shows:
              </p>
              <form className="account-form" onSubmit={submitCode}>
                <input value={code} placeholder="Code" spellCheck={false} onChange={(e) => setCode(e.target.value)} />
                <button disabled={!connected || !code.trim()}>Submit code</button>
              </form>
            </>
          )}
          <button disabled={!connected} onClick={() => send({ type: 'account.cancelLogin', engine })}>
            Cancel
          </button>
        </div>
      )}
      {accounts.apiKeys && (
        <form className="account-form" onSubmit={addKey}>
          <input value={keyName} placeholder="Name for an API key" onChange={(e) => setKeyName(e.target.value)} />
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
    </section>
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

  return (
    <main className="chat">
      <header className="chat-header">
        <span className="chat-name">{project.name}</span>
        <span className="chat-path">{project.path}</span>
        <select
          className="engine-select"
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
            className="engine-select"
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
        {project.items.length === 0 && !project.draft && (
          <div className="empty">Send a message to start an agent in {project.path}</div>
        )}
        {project.items.map((item, i) => (
          <ItemView key={i} item={item} project={project} connected={connected} send={send} />
        ))}
        {project.draft && <Markdown className="assistant streaming" text={project.draft} />}
      </div>
      <div className="composer">
        <textarea
          value={text}
          rows={3}
          placeholder={
            project.status === 'waiting' ? 'Waiting for your approval…' : project.status === 'running' ? 'Working…' : 'Message'
          }
          disabled={!canSend}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {project.status !== 'idle' ? (
          <button className="stop" disabled={!connected} onClick={() => send({ type: 'chat.interrupt', projectId: project.id })}>
            Stop
          </button>
        ) : (
          <button disabled={!canSend || !text.trim()} onClick={submit}>
            Send
          </button>
        )}
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
    <div className="toast">
      <span>{message}</span>
      <button aria-label="Dismiss" onClick={() => dismiss(id)}>
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

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">Hotrod</div>
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
          </div>
        ) : (
          <form className="add-project" onSubmit={addProject}>
            <input
              value={path}
              placeholder="/absolute/path/to/project"
              spellCheck={false}
              onChange={(e) => setPath(e.target.value)}
            />
            <button disabled={!connected || !path.trim()}>Add project</button>
          </form>
        )}
      </aside>
      <div className="main">
        {state.rejected ? (
          <div className="banner">The core rejected this window. Open the link the core printed; it carries the token.</div>
        ) : (
          !state.connected && <div className="banner">Disconnected from the core. Reconnecting…</div>
        )}
        {engine && (!engine.installed || !signedIn) && (
          <div className="banner">
            {engine.id} is{' '}
            {!engine.installed
              ? 'not installed'
              : activeAccount && activeAccount.id !== 'default'
                ? `not signed in as ${activeAccount.name}`
                : 'not signed in'}
            .{engine.detail && ` ${engine.detail}`}
          </div>
        )}
        {managed && (
          <AccountsPanel accounts={managed} connected={connected} send={send} close={() => setManaging(null)} />
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
          <div className="empty">Add a project folder to start.</div>
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
