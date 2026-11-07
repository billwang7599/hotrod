import { useCallback, useEffect, useReducer, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { Chat } from './chat.tsx'
import { useCore } from './connection.ts'
import { Toast } from './controls.tsx'
import logo from './logo.svg'
import { SettingsDialog } from './settings.tsx'
import { ChatNav } from './sidebar.tsx'
import { initialState, MAIN_CHAT_ID, reduce } from './state.ts'
import './styles.css'

const SELECTED_KEY = 'hotrod.selectedChat'
const CONTEXT_OPEN_KEY = 'hotrod.contextOpen'

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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(() => localStorage.getItem(CONTEXT_OPEN_KEY) === 'true')
  useEffect(() => localStorage.setItem(CONTEXT_OPEN_KEY, String(contextOpen)), [contextOpen])
  const toggleContext = useCallback(() => setContextOpen((open) => !open), [])
  const selected = state.chats.find((c) => c.id === state.selectedId)
  const selectedProject = state.projects.find((p) => p.id === selected?.projectId)
  const select = useCallback((chatId: string) => dispatch({ type: 'select', chatId }), [])
  const engine = state.engines.find((e) => e.id === selected?.engine)
  const accounts = state.accounts.find((a) => a.engine === selected?.engine)
  const activeAccount = accounts?.accounts.find((a) => a.id === accounts.active)
  const signedIn = activeAccount?.signedIn ?? engine?.signedIn

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
          <span className="brand">
            <img src={logo} alt="" width={18} height={18} />
            Hotrod
          </span>
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
        <div className="sidebar-footer">
          <button className="ghost settings-button" onClick={() => setSettingsOpen(true)}>
            <span aria-hidden="true">⚙</span>
            Settings
          </button>
        </div>
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
        {engine?.enabled && (!engine.installed || !signedIn) && (
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
        {settingsOpen && (
          <SettingsDialog
            engines={state.engines}
            accounts={state.accounts}
            contextDefaults={state.contextDefaults}
            mods={state.mods}
            connected={connected}
            send={send}
            close={() => setSettingsOpen(false)}
          />
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
            openSettings={() => setSettingsOpen(true)}
            contextOpen={contextOpen}
            toggleContext={toggleContext}
            contextLayers={state.context?.chatId === selected.id ? state.context.layers : undefined}
            contextDefaults={state.contextDefaults}
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
