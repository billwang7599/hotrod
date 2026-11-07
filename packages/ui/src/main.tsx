import { useCallback, useEffect, useReducer, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { AnimatePresence, domAnimation, LazyMotion, m, MotionConfig, useReducedMotion } from 'motion/react'
import { Chat } from './chat.tsx'
import { useCore } from './connection.ts'
import { Button, CHAT_NOUN, ConfirmDialog, MOTION, SidePanel, Toast, TRANSITION } from './controls.tsx'
import { SettingsDialog, type SettingsPage } from './settings.tsx'
import { ChatNav, NameDialog, type NameRequest } from './sidebar.tsx'
import {
  dockedPanels,
  folderName,
  folderOf,
  initialState,
  MAIN_CHAT_ID,
  MIN_WINDOW_PX,
  PANEL_PX,
  reduce,
  storedColumn,
  storedFlag,
} from './state.ts'
import './styles.css'

const SELECTED_KEY = 'hotrod.selectedChat'
const CONTEXT_OPEN_KEY = 'hotrod.contextOpen'
const SIDEBAR_OPEN_KEY = 'hotrod.sidebarOpen'
const COLUMN_KEY = 'hotrod.columnWidth'

type Overlay = 'sidebar' | 'context' | null

const subscribeResize = (listener: () => void) => {
  addEventListener('resize', listener)
  return () => removeEventListener('resize', listener)
}

declare global {
  interface Window {
    hotrod?: {
      pickFolder(): Promise<string | null>
      onNewChatFromFolder(listener: () => void): () => void
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
  const [nameRequest, setNameRequest] = useState<NameRequest | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsPage, setSettingsPage] = useState<SettingsPage>('engines')
  const openSettings = useCallback((page?: SettingsPage) => {
    if (page) setSettingsPage(page)
    setSettingsOpen(true)
  }, [])
  const [contextOpen, setContextOpen] = useState(() => storedFlag(localStorage.getItem(CONTEXT_OPEN_KEY), false))
  useEffect(() => localStorage.setItem(CONTEXT_OPEN_KEY, String(contextOpen)), [contextOpen])
  const [sidebarOpen, setSidebarOpen] = useState(() => storedFlag(localStorage.getItem(SIDEBAR_OPEN_KEY), true))
  useEffect(() => localStorage.setItem(SIDEBAR_OPEN_KEY, String(sidebarOpen)), [sidebarOpen])
  const docked = useSyncExternalStore(subscribeResize, () => dockedPanels(innerWidth))
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [dockedBefore, setDockedBefore] = useState(docked)
  if (docked !== dockedBefore) {
    setDockedBefore(docked)
    setOverlay(null)
  }
  const sidebarDocks = docked !== 'none'
  const contextDocks = docked === 'both'
  const flipOverlay = (panel: Overlay) => setOverlay((open) => (open === panel ? null : panel))
  const toggleSidebar = useCallback(
    () => (sidebarDocks ? setSidebarOpen((open) => !open) : flipOverlay('sidebar')),
    [sidebarDocks],
  )
  const toggleContext = useCallback(
    () => (contextDocks ? setContextOpen((open) => !open) : flipOverlay('context')),
    [contextDocks],
  )
  useEffect(() => {
    if (!overlay) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // Blur first so a draft in the panel saves before it unmounts.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      setOverlay(null)
    }
    addEventListener('keydown', onKeyDown)
    return () => removeEventListener('keydown', onKeyDown)
  }, [overlay])
  const [columnPx, setColumnPx] = useState(() => storedColumn(localStorage.getItem(COLUMN_KEY)))
  useEffect(() => localStorage.setItem(COLUMN_KEY, String(columnPx)), [columnPx])
  const selected = state.chats.find((c) => c.id === state.selectedId)
  const select = useCallback((chatId: string) => {
    dispatch({ type: 'select', chatId })
    setOverlay((open) => (open === 'sidebar' ? null : open))
  }, [])
  const engine = state.engines.find((e) => e.id === selected?.engine)
  const accounts = state.accounts.find((a) => a.engine === selected?.engine)
  const activeAccount = accounts?.accounts.find((a) => a.id === accounts.active)
  const signedIn = activeAccount?.signedIn ?? engine?.signedIn

  const connected = state.connected
  const newChatFromFolder = useCallback(async () => {
    if (!connected || !window.hotrod) return
    const picked = await window.hotrod.pickFolder()
    if (picked) send({ type: 'chat.create', name: folderName(picked), folders: [picked] })
  }, [connected, send])
  useEffect(() => window.hotrod?.onNewChatFromFolder(() => void newChatFromFolder()), [newChatFromFolder])
  const [quitting, setQuitting] = useState(false)
  useEffect(() => window.hotrod?.onQuitting(() => setQuitting(true)), [])
  const reduceMotion = useReducedMotion()

  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user" transition={reduceMotion ? { duration: 0 } : TRANSITION}>
        <div
          className="relative isolate flex h-screen"
          style={{ minWidth: MIN_WINDOW_PX.width, minHeight: MIN_WINDOW_PX.height }}
        >
          <AnimatePresence>
            {overlay && (
              <m.div
                key="backdrop"
                className="absolute inset-0 z-10 bg-backdrop"
                {...MOTION.fade}
                onClick={() => setOverlay(null)}
              />
            )}
          </AnimatePresence>
          <AnimatePresence initial={false}>
            {(sidebarDocks ? sidebarOpen : overlay === 'sidebar') && (
              <SidePanel key="sidebar" side="left" overlay={!sidebarDocks}>
                <aside className="flex shrink-0 flex-col border-r bg-panel" style={{ width: PANEL_PX.sidebar }}>
                  <div className="flex h-44 items-center justify-between pr-8 pl-16">
                    <span className="font-bold tracking-[0.02em] text-accent">Hotrod</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`New ${CHAT_NOUN.one}`}
                      title={`New ${CHAT_NOUN.one}`}
                      disabled={!connected}
                      onClick={() => setNameRequest({ kind: 'new' })}
                    >
                      +
                    </Button>
                  </div>
                  <ChatNav
                    chats={state.chats}
                    selectedId={state.selectedId}
                    connected={connected}
                    send={send}
                    select={select}
                    askName={setNameRequest}
                  />
                  {window.hotrod && (
                    <div className="flex items-center gap-6 border-t px-8 py-10">
                      <Button className="flex-1" disabled={!connected} onClick={() => void newChatFromFolder()}>
                        New {CHAT_NOUN.one} from folder…
                      </Button>
                      <span className="text-sm text-faint">⌘O</span>
                    </div>
                  )}
                  <div className="px-8 pb-10">
                    <Button variant="ghost" className="flex w-full items-center gap-8" onClick={() => openSettings()}>
                      <span aria-hidden="true">⚙</span>
                      Settings
                    </Button>
                  </div>
                </aside>
              </SidePanel>
            )}
          </AnimatePresence>
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
            <SettingsDialog
              engines={state.engines}
              accounts={state.accounts}
              contextDefaults={state.contextDefaults}
              mods={state.mods}
              modelLists={state.modelLists}
              connected={connected}
              send={send}
              page={settingsPage}
              openPage={setSettingsPage}
              open={settingsOpen}
              close={() => setSettingsOpen(false)}
            />
            {selected ? (
              <Chat
                key={selected.id}
                chat={selected}
                chats={state.chats}
                folder={folderOf(state.chats, selected)}
                engines={state.engines}
                accounts={accounts}
                connected={state.connected}
                send={send}
                openSettings={openSettings}
                sidebarOpen={sidebarDocks ? sidebarOpen : overlay === 'sidebar'}
                toggleSidebar={toggleSidebar}
                contextOpen={contextDocks ? contextOpen : overlay === 'context'}
                contextOverlay={!contextDocks}
                toggleContext={toggleContext}
                columnPx={columnPx}
                setColumnPx={setColumnPx}
                contextItems={state.context?.chatId === selected.id ? state.context.items : undefined}
                contextDefaults={state.contextDefaults}
                modelLists={state.modelLists[selected.engine]}
              />
            ) : (
              <div className="m-auto flex max-w-420 flex-col items-center gap-4 p-24 text-center text-muted">
                <strong className="text-body font-semibold text-text">
                  {state.connected ? 'Loading…' : 'Connecting to the core…'}
                </strong>
              </div>
            )}
          </div>
          <div className="fixed right-16 bottom-120 z-30 flex max-w-360 flex-col">
            <AnimatePresence initial={false}>
              {state.toasts.map((t) => (
                <Toast key={t.id} id={t.id} message={t.message} dismiss={dismissToast} />
              ))}
            </AnimatePresence>
          </div>
          <NameDialog
            request={nameRequest}
            connected={connected}
            send={send}
            pickFolder={window.hotrod?.pickFolder}
            close={() => setNameRequest(null)}
          />
          <ConfirmDialog />
        </div>
      </MotionConfig>
    </LazyMotion>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
