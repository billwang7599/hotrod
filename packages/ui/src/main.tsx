import { useCallback, useEffect, useReducer, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Chat } from './chat.tsx'
import { useCore } from './connection.ts'
import { Button, ConfirmDialog, Toast } from './controls.tsx'
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

const BANNER_TONES = { warning: 'bg-warning-bg text-amber', error: 'bg-error-bg text-red' }

function Banner({ tone, children, action }: { tone: keyof typeof BANNER_TONES; children: ReactNode; action?: ReactNode }) {
  return (
    <div
      className={`flex min-h-32 items-center gap-8 border-b py-4 pr-12 pl-16 text-sm before:size-7 before:shrink-0 before:rounded-full before:bg-current ${BANNER_TONES[tone]}`}
    >
      <span className="flex-1 text-text">{children}</span>
      {action}
    </div>
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
    <div className="flex h-screen">
      <aside className="flex w-232 shrink-0 flex-col border-r bg-panel max-[900px]:w-200">
        <div className="flex h-44 items-center justify-between pr-8 pl-16">
          <span className="flex items-center gap-6 font-bold tracking-[0.02em] text-accent">
            <img src={logo} alt="" width={18} height={18} />
            Hotrod
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Add project"
            title={window.hotrod ? 'Add project… (⌘O)' : 'Add project'}
            disabled={!connected}
            onClick={() => (window.hotrod ? void pickProject() : pathRef.current?.focus())}
          >
            +
          </Button>
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
          <div className="flex items-center gap-6 border-t px-8 py-10">
            <Button className="flex-1" disabled={!connected} onClick={() => void pickProject()}>
              Add project…
            </Button>
            <span className="text-sm text-faint">⌘O</span>
          </div>
        ) : (
          <form className="flex items-center gap-6 border-t px-8 py-10" onSubmit={addProject}>
            <input
              className="flex-1 font-mono text-sm"
              ref={pathRef}
              value={path}
              placeholder="/path/to/project"
              spellCheck={false}
              onChange={(e) => setPath(e.target.value)}
            />
            <Button disabled={!connected || !path.trim()}>Add</Button>
          </form>
        )}
        <div className="px-8 pb-10">
          <Button variant="ghost" className="flex w-full items-center gap-8" onClick={() => setSettingsOpen(true)}>
            <span aria-hidden="true">⚙</span>
            Settings
          </Button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {quitting && (
          <Banner
            tone="warning"
            action={
              <Button variant="danger" size="small" onClick={() => void window.hotrod?.forceQuit()}>
                Force quit
              </Button>
            }
          >
            Stopping engines…
          </Banner>
        )}
        {state.rejected ? (
          <Banner tone="error">
            The core rejected this window. Open the link the core printed; it carries the token.
          </Banner>
        ) : (
          !state.connected && !quitting && <Banner tone="warning">Disconnected from the core. Reconnecting…</Banner>
        )}
        {engine?.enabled && (!engine.installed || !signedIn) && (
          <Banner tone="warning">
            {engine.id} is{' '}
            {!engine.installed
              ? 'not installed'
              : activeAccount && activeAccount.id !== 'default'
                ? `not signed in as ${activeAccount.name}`
                : 'not signed in'}
            .{engine.detail && ` ${engine.detail}`}
          </Banner>
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
          <div className="m-auto flex max-w-420 flex-col items-center gap-4 p-24 text-center text-muted">
            <strong className="text-body font-semibold text-text">
              {state.connected ? 'Loading…' : 'Connecting to the core…'}
            </strong>
          </div>
        )}
      </div>
      <div className="fixed right-16 bottom-128 flex max-w-360 flex-col gap-8">
        {state.toasts.map((t) => (
          <Toast key={t.id} id={t.id} message={t.message} dismiss={dismissToast} />
        ))}
      </div>
      <ConfirmDialog />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
