import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import type { ClientMessage, ToolKind } from '@hotrod/core/types'
import { initialState, reduce, type Action, type Item, type ProjectView } from './state.ts'
import './styles.css'

const CORE_URL = import.meta.env.VITE_HOTROD_CORE_URL ?? 'ws://127.0.0.1:4317'
const MIN_RETRY_MS = 500
const MAX_RETRY_MS = 10_000
const TOAST_MS = 6_000
const SELECTED_KEY = 'hotrod.selectedProject'

function useCore(dispatch: (action: Action) => void) {
  const socketRef = useRef<WebSocket | null>(null)
  useEffect(() => {
    let retryMs = MIN_RETRY_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const connect = () => {
      const socket = new WebSocket(CORE_URL)
      socketRef.current = socket
      socket.onopen = () => {
        retryMs = MIN_RETRY_MS
        dispatch({ type: 'connection', connected: true })
      }
      socket.onmessage = (e) => dispatch(JSON.parse(e.data))
      socket.onclose = () => {
        dispatch({ type: 'connection', connected: false })
        if (stopped) return
        timer = setTimeout(connect, retryMs)
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)
      }
    }
    connect()
    return () => {
      stopped = true
      clearTimeout(timer)
      socketRef.current?.close()
    }
  }, [dispatch])
  return useCallback((message: ClientMessage) => {
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }, [])
}

// Input shapes are engine-specific; these keys cover Claude Code's tools.
function summarize(kind: ToolKind, input: unknown): string {
  const fields = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const pick = (...keys: string[]) => keys.map((k) => fields[k]).find((v) => typeof v === 'string') as string | undefined
  const summary =
    kind === 'shell'
      ? pick('command')
      : kind === 'edit' || kind === 'read'
        ? pick('file_path', 'path', 'notebook_path')
        : kind === 'search'
          ? pick('pattern', 'query')
          : kind === 'fetch'
            ? pick('url', 'query')
            : undefined
  return (summary ?? JSON.stringify(input) ?? '').replace(/\s+/g, ' ')
}

type ItemProps = { item: Item; project: ProjectView; connected: boolean; send: (m: ClientMessage) => void }

function ItemView({ item, project, connected, send }: ItemProps) {
  switch (item.kind) {
    case 'user':
      return <div className="user">{item.text}</div>
    case 'text':
      return <div className="assistant">{item.text}</div>
    case 'error':
      return <div className="turn-error">{item.text}</div>
    case 'tool':
      return (
        <details className={`tool ${item.state}`}>
          <summary>
            <span className="tool-name">{item.name}</span>
            <span className="tool-input">{summarize(item.toolKind, item.input)}</span>
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
          <pre>{summarize(item.toolKind, item.input)}</pre>
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
        {project.draft && <div className="assistant streaming">{project.draft}</div>}
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
        <form className="add-project" onSubmit={addProject}>
          <input
            value={path}
            placeholder="/absolute/path/to/project"
            spellCheck={false}
            onChange={(e) => setPath(e.target.value)}
          />
          <button disabled={!state.connected || !path.trim()}>Add project</button>
        </form>
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
