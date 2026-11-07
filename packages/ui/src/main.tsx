import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import type { ClientMessage } from '@hotrod/core/types'
import { useCore } from './connection.ts'
import { Markdown } from './markdown.tsx'
import { initialState, reduce, type Item, type ProjectView } from './state.ts'
import './styles.css'

const TOAST_MS = 6_000
const SELECTED_KEY = 'hotrod.selectedProject'

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

function Chat({ project, connected, send }: { project: ProjectView; connected: boolean; send: (m: ClientMessage) => void }) {
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
  const selected = state.projects.find((p) => p.id === state.selectedId)
  const engine = state.engine

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
              {p.name}
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
        {!state.connected && <div className="banner">Disconnected from the core. Reconnecting…</div>}
        {engine && (!engine.installed || !engine.signedIn) && (
          <div className="banner">
            {engine.id} is {engine.installed ? 'not signed in' : 'not installed'}.{engine.detail && ` ${engine.detail}`}
          </div>
        )}
        {selected ? (
          <Chat key={selected.id} project={selected} connected={state.connected} send={send} />
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
