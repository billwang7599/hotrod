import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import type { Account, ChatStatus, ClientMessage, EngineAccounts, EngineInfo, Project } from '@hotrod/core/types'
import { useCore } from './connection.ts'
import { Markdown } from './markdown.tsx'
import {
  accountLabel,
  engineOptions,
  initialState,
  MAIN_CHAT_ID,
  reduce,
  type ChatView,
  type Item,
} from './state.ts'
import './styles.css'

const TOAST_MS = 6_000
const SELECTED_KEY = 'hotrod.selectedChat'
const COLLAPSED_KEY = 'hotrod.collapsedProjects'
const CHAT_BUSY = 'Stop this chat first'
const PROJECT_BUSY = 'Stop the running chats in this project first'
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

type ItemProps = { item: Item; chat: ChatView; connected: boolean; send: (m: ClientMessage) => void }

function ItemView({ item, chat, connected, send }: ItemProps) {
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
        send({ type: 'permission.respond', chatId: chat.id, requestId: item.requestId, allow })
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
          {chat.status === 'waiting' ? (
            <div className="permission-actions">
              <button className="primary" disabled={!connected} onClick={() => respond(true)}>
                Approve
              </button>
              <button className="danger" disabled={!connected} onClick={() => respond(false)}>
                Deny
              </button>
            </div>
          ) : (
            <div className="permission-note">{chat.status === 'stopping' ? 'Stopping…' : 'Pending'}</div>
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
  chat: ChatView
  project?: Project
  engines: EngineInfo[]
  accounts?: EngineAccounts
  connected: boolean
  send: (m: ClientMessage) => void
  manageAccounts: () => void
}

function Chat({ chat, project, engines, accounts, connected, send, manageAccounts }: ChatProps) {
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  useLayoutEffect(() => {
    const list = listRef.current
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight
  }, [chat.items, chat.draft, chat.status])

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) list.scrollTop = list.scrollHeight
    })
    observer.observe(list)
    return () => observer.disconnect()
  }, [])

  const archivedBy = project?.archived ? project : chat.archived ? chat : undefined
  const canSend = connected && chat.status === 'idle' && !archivedBy
  const submit = () => {
    if (!canSend || !text.trim()) return
    send({ type: 'chat.send', chatId: chat.id, text })
    setText('')
  }
  const stop = () => {
    if (chat.status !== 'stopping') return send({ type: 'chat.interrupt', chatId: chat.id })
    if (window.confirm(FORCE_STOP_TEXT)) send({ type: 'chat.interrupt', chatId: chat.id, force: true })
  }
  const unarchive = () =>
    project?.archived
      ? send({ type: 'project.archive', projectId: project.id, archived: false })
      : send({ type: 'chat.archive', chatId: chat.id, archived: false })
  const place = project?.name ?? 'Main'

  return (
    <main className="chat">
      <header className="chat-header">
        <div className="chat-title">
          <span className="chat-name">{chat.main ? place : chat.title}</span>
          <span className="chat-path">{project?.path ?? 'Not tied to a folder'}</span>
        </div>
        <select
          className="chip"
          aria-label="Engine"
          value={chat.engine}
          disabled={!canSend}
          onChange={(e) => send({ type: 'chat.setEngine', chatId: chat.id, engine: e.target.value })}
        >
          {engineOptions(engines, chat.engine).map((o) => (
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
          {chat.items.length === 0 && !chat.draft && (
            <div className="empty">
              <strong>
                Start a chat in <span className="mono">{place}</span>
              </strong>
              <span>
                Each message starts <span className="mono">{chat.engine}</span> in{' '}
                {project?.path ?? 'a scratch folder'}
              </span>
            </div>
          )}
          {chat.items.map((item, i) => (
            <ItemView key={i} item={item} chat={chat} connected={connected} send={send} />
          ))}
          {chat.draft && <Markdown className="assistant streaming" text={chat.draft} />}
        </div>
      </div>
      <div className="composer">
        {archivedBy && (
          <div className="archived-note">
            <span>
              This {archivedBy === project ? 'project' : 'chat'} is archived. Its history stays; unarchive it to continue.
            </span>
            <button className="small" disabled={!connected} onClick={unarchive}>
              Unarchive
            </button>
          </div>
        )}
        <div className={`composer-box ${canSend ? '' : 'disabled'}`}>
          <textarea
            value={text}
            rows={2}
            placeholder={archivedBy ? 'Archived' : PLACEHOLDERS[chat.status]}
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
            <span className="hint">{chat.status === 'stopping' ? FORCE_STOP_HINT : SEND_HINT}</span>
            {chat.status !== 'idle' ? (
              <button
                className={`danger stop ${chat.status}`}
                disabled={!connected}
                title={chat.status === 'stopping' ? FORCE_STOP_HINT : undefined}
                onClick={stop}
              >
                {chat.status === 'stopping' ? 'Stopping…' : 'Stop'}
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

type MenuItem = { label: string; run: () => void; danger?: boolean; disabledReason?: string }

function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!position) return
    const onPointer = (e: MouseEvent) => ref.current?.contains(e.target as Node) || setPosition(null)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPosition(null)
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [position])
  return (
    <div className={`row-menu ${position ? 'open' : ''}`} ref={ref}>
      <button
        className="ghost icon"
        aria-label={`More for ${label}`}
        aria-haspopup="menu"
        aria-expanded={!!position}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          setPosition(position ? null : { top: rect.bottom + 4, right: window.innerWidth - rect.right })
        }}
      >
        ⋯
      </button>
      {position && (
        <div className="menu" role="menu" style={position}>
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={item.danger ? 'danger' : ''}
              disabled={!!item.disabledReason}
              title={item.disabledReason}
              onClick={() => {
                setPosition(null)
                item.run()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

type RowProps = {
  chat: ChatView
  label: string
  title?: string
  selected: boolean
  sub?: boolean
  select: () => void
  menu?: MenuItem[]
}

function ChatRow({ chat, label, title, selected, sub, select, menu }: RowProps) {
  return (
    <div className={`chat-row ${selected ? 'selected' : ''} ${sub ? 'sub' : ''} ${menu ? 'has-menu' : ''}`}>
      <button className="chat-link" title={title ?? label} onClick={select}>
        <span className={`dot ${chat.status}`} />
        <span className="chat-label">{label}</span>
        <span className="chat-engine">{chat.engine}</span>
      </button>
      {menu && <RowMenu label={label} items={menu} />}
    </div>
  )
}

const newestFirst = (a: ChatView, b: ChatView) => b.createdAt.localeCompare(a.createdAt)

function readCollapsed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
  } catch {
    return []
  }
}

type SidebarProps = {
  projects: Project[]
  chats: ChatView[]
  selectedId: string
  connected: boolean
  send: (m: ClientMessage) => void
  select: (chatId: string) => void
}

function ChatNav({ projects, chats, selectedId, connected, send, select }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  useEffect(() => localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed)), [collapsed])
  const toggle = (id: string) => setCollapsed((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))

  const main = chats.find((c) => c.id === MAIN_CHAT_ID)
  const subchats = (projectId?: string) =>
    chats.filter((c) => !c.main && !c.archived && c.projectId === projectId).sort(newestFirst)
  const projectBusy = (id: string) => chats.some((c) => c.projectId === id && c.status !== 'idle')
  const offline = connected ? undefined : 'Disconnected from the core'

  const chatMenu = (chat: ChatView): MenuItem[] => {
    const disabledReason = offline ?? (chat.status !== 'idle' ? CHAT_BUSY : undefined)
    const remove = () => {
      if (window.confirm(`Delete “${chat.title}”? Its messages are deleted from Hotrod.`)) {
        send({ type: 'chat.delete', chatId: chat.id })
      }
    }
    return [
      {
        label: chat.archived ? 'Unarchive' : 'Archive',
        disabledReason,
        run: () => send({ type: 'chat.archive', chatId: chat.id, archived: !chat.archived }),
      },
      { label: 'Delete…', danger: true, disabledReason, run: remove },
    ]
  }
  const projectMenu = (project: Project): MenuItem[] => {
    const disabledReason = offline ?? (projectBusy(project.id) ? PROJECT_BUSY : undefined)
    const remove = () => {
      const folder = `The folder ${project.path} stays on disk.`
      if (window.confirm(`Remove ${project.name} from Hotrod and delete its chats? ${folder}`)) send({ type: 'project.delete', projectId: project.id })
    }
    return [
      {
        label: project.archived ? 'Unarchive' : 'Archive',
        disabledReason,
        run: () => send({ type: 'project.archive', projectId: project.id, archived: !project.archived }),
      },
      { label: 'Delete…', danger: true, disabledReason, run: remove },
    ]
  }
  const row = (chat: ChatView, props: Partial<RowProps> = {}) => (
    <ChatRow
      key={chat.id}
      chat={chat}
      label={chat.title}
      selected={chat.id === selectedId}
      select={() => select(chat.id)}
      menu={chatMenu(chat)}
      sub
      {...props}
    />
  )

  const activeProjects = projects.filter((p) => !p.archived)
  const archivedProjects = projects.filter((p) => p.archived)
  const archivedChats = chats
    .filter((c) => c.archived && !projects.find((p) => p.id === c.projectId)?.archived)
    .sort(newestFirst)
  const placeOf = (chat: ChatView) => projects.find((p) => p.id === chat.projectId)?.name ?? 'Main'

  return (
    <nav className="chat-nav">
      {main && row(main, { label: 'Main', title: 'Main: not tied to a folder', menu: undefined, sub: false })}
      {subchats().map((c) => row(c))}
      <button className="ghost small new-chat" disabled={!connected} onClick={() => send({ type: 'chat.create' })}>
        + New chat
      </button>

      <div className="nav-label">Projects</div>
      {activeProjects.length === 0 && <div className="nav-empty">No projects yet</div>}
      {activeProjects.map((project) => {
        const open = !collapsed.includes(project.id)
        const projectMain = chats.find((c) => c.projectId === project.id && c.main)
        return (
          <section key={project.id} className="project-section">
            <div className="chat-row section-header has-menu">
              <button
                className="chat-link"
                title={project.path}
                aria-expanded={open}
                onClick={() => toggle(project.id)}
              >
                <span className={`disclosure ${open ? 'open' : ''}`} />
                <span className="chat-label">{project.name}</span>
              </button>
              <button
                className="ghost icon add-chat"
                aria-label={`New chat in ${project.name}`}
                title={`New chat in ${project.name}`}
                disabled={!connected}
                onClick={() => send({ type: 'chat.create', projectId: project.id })}
              >
                +
              </button>
              <RowMenu label={project.name} items={projectMenu(project)} />
            </div>
            {open && projectMain && row(projectMain, { label: 'Main', title: project.path, menu: undefined })}
            {open && subchats(project.id).map((c) => row(c))}
          </section>
        )
      })}

      {(archivedProjects.length > 0 || archivedChats.length > 0) && (
        <details className="archived-group">
          <summary className="nav-label">
            <span className="disclosure" />
            Archived ({archivedProjects.length + archivedChats.length})
          </summary>
          {archivedProjects.map((project) => {
            const projectMain = chats.find((c) => c.projectId === project.id && c.main)
            return (
              projectMain && (
                <ChatRow
                  key={project.id}
                  chat={projectMain}
                  label={project.name}
                  title={`${project.path} (archived project)`}
                  selected={chats.some((c) => c.projectId === project.id && c.id === selectedId)}
                  select={() => select(projectMain.id)}
                  menu={projectMenu(project)}
                />
              )
            )
          })}
          {archivedChats.map((c) => row(c, { title: `${c.title} (in ${placeOf(c)})`, sub: false }))}
        </details>
      )}
    </nav>
  )
}

function App() {
  const [state, dispatch] = useReducer(reduce, initialState, (s) => ({
    ...s,
    selectedId: localStorage.getItem(SELECTED_KEY) ?? MAIN_CHAT_ID,
  }))
  const send = useCore(dispatch)
  const dismissToast = useCallback((id: number) => dispatch({ type: 'toast.dismiss', id }), [])

  useEffect(() => localStorage.setItem(SELECTED_KEY, state.selectedId), [state.selectedId])
  const [path, setPath] = useState('')
  const pathRef = useRef<HTMLInputElement>(null)
  const [managing, setManaging] = useState<string | null>(null)
  const selected = state.chats.find((c) => c.id === state.selectedId)
  const selectedProject = state.projects.find((p) => p.id === selected?.projectId)
  const select = useCallback((chatId: string) => dispatch({ type: 'select', chatId }), [])
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
        <ChatNav
          projects={state.projects}
          chats={state.chats}
          selectedId={state.selectedId}
          connected={connected}
          send={send}
          select={select}
        />
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
            chat={selected}
            project={selectedProject}
            engines={state.engines}
            accounts={accounts}
            connected={state.connected}
            send={send}
            manageAccounts={() => setManaging(selected.engine)}
          />
        ) : (
          <div className="empty">
            <strong>{state.connected ? 'Loading…' : 'Connecting to the core…'}</strong>
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
