// First, so preferences saved before the rename move to their new keys before any module reads them.
import './renamed-storage.ts'
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { AnimatePresence, domAnimation, LazyMotion, m, MotionConfig, useReducedMotion } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { Chat } from './chat.tsx'
import { useCore } from './connection.ts'
import { pruneDrafts } from './drafts.ts'
import { Button, CHAT_NOUN, ConfirmDialog, MOTION, PanelToggle, SidePanel, Toast, TRANSITION } from './controls.tsx'
import { SettingsDialog, WorkFolderDialog, type SettingsPage } from './settings.tsx'
import { MarketplaceDialog } from './marketplace.tsx'
import { ResizeHandle, usePanelWidths } from './panel-width.tsx'
import { ChatNav, NameDialog, SidebarFooter, type NameRequest } from './sidebar.tsx'
import { nthSpace, stepSpace } from './nav.ts'
import { SearchPalette } from './search.tsx'
import { ExtensionPopup, sidebarEntries, usePanelShortcuts } from './extension-popups.tsx'
import { changesText, RestartButton } from './restart.tsx'
import { panelShortcuts, useBindings, useShortcuts, type ShortcutHandlers } from './shortcuts.ts'
import { setInstalledThemes, startAppearance } from './themes.tsx'
import { isLooking, useLooking, useMarkRead } from './unread.ts'
import { createNotifier, deliver } from './notifications.ts'
import {
  dockedPanels,
  folderName,
  folderOf,
  initialState,
  MIN_WINDOW_PX,
  reduce,
  storedColumn,
  type Action,
  storedFlag,
} from './state.ts'
import './styles.css'

const SELECTED_KEY = 'kothar.selectedChat'
const CONTEXT_OPEN_KEY = 'kothar.contextOpen'
const SIDEBAR_OPEN_KEY = 'kothar.sidebarOpen'
const COLUMN_KEY = 'kothar.columnWidth'
const HINT_DELAY_MS = 400

type Overlay = 'sidebar' | 'context' | null

const subscribeResize = (listener: () => void) => {
  addEventListener('resize', listener)
  return () => removeEventListener('resize', listener)
}

declare global {
  interface Window {
    kothar?: {
      pickFolder(title?: string): Promise<string | null>
      pickFiles(title?: string): Promise<string[]>
      pathForFile(file: File): string
      /** The desktop menu's items run the same actions as their shortcuts. */
      onShortcut?(listener: (action: string) => void): () => void
      /** Shows the user's keys on the menu's items, as Electron accelerators by action id. */
      setMenuShortcuts?(accelerators: Record<string, string | null>): void
      onQuitting(listener: () => void): () => void
      forceQuit(): Promise<void>
      vibrancy: boolean
      setAppearance(appearance: { scheme: 'system' | 'light' | 'dark'; vibrancy: boolean; background: string }): void
      /** A system notification; clicking it brings the window to the front and calls onOpenChat with open. */
      notify?(notification: { title: string; body: string; open?: string }): void
      onOpenChat?(listener: (chatId: string) => void): () => void
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
    selectedId: localStorage.getItem(SELECTED_KEY) ?? '',
  }))
  // Notifications see each message with what the user saw before it (notifications.ts).
  const seenRef = useRef({ chats: state.chats, selectedId: state.selectedId })
  useLayoutEffect(() => {
    seenRef.current = { chats: state.chats, selectedId: state.selectedId }
  })
  const openRef = useRef((_chatId: string) => {})
  // oxlint-disable-next-line react/refs -- read when a notification is clicked, never during render
  const [notifier] = useState(() => createNotifier((shown) => deliver(shown, (chatId) => openRef.current(chatId))))
  const receive = useCallback(
    (action: Action) => {
      if (action.type !== 'connection' && action.type !== 'select' && action.type !== 'toast.dismiss') {
        notifier.observe(action, { ...seenRef.current, looking: isLooking() })
      }
      dispatch(action)
    },
    [notifier],
  )
  const send = useCore(receive)
  const dismissToast = useCallback((id: number) => dispatch({ type: 'toast.dismiss', id }), [])
  const notify = useCallback((message: string) => dispatch({ type: 'error', message }), [])

  useEffect(() => localStorage.setItem(SELECTED_KEY, state.selectedId), [state.selectedId])
  useEffect(() => {
    if (state.loaded) pruneDrafts(state.chats.map((c) => c.id))
  }, [state.loaded, state.chats])
  const [nameRequest, setNameRequest] = useState<NameRequest | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsPage, setSettingsPage] = useState<SettingsPage>('engines')
  const [changingWorkFolder, setChangingWorkFolder] = useState(false)
  const [workPath, setWorkPath] = useState(state.workFolder.path)
  if (state.workFolder.path !== workPath) {
    setWorkPath(state.workFolder.path)
    setChangingWorkFolder(false)
  }
  useEffect(() => state.themes && setInstalledThemes(state.themes), [state.themes])
  const firstRun = state.loaded && !state.workFolder.path
  const openSettings = useCallback((page?: SettingsPage) => {
    if (page) setSettingsPage(page)
    setSettingsOpen(true)
  }, [])
  const [contextOpen, setContextOpen] = useState(() => storedFlag(localStorage.getItem(CONTEXT_OPEN_KEY), false))
  useEffect(() => localStorage.setItem(CONTEXT_OPEN_KEY, String(contextOpen)), [contextOpen])
  const [sidebarOpen, setSidebarOpen] = useState(() => storedFlag(localStorage.getItem(SIDEBAR_OPEN_KEY), true))
  useEffect(() => localStorage.setItem(SIDEBAR_OPEN_KEY, String(sidebarOpen)), [sidebarOpen])
  const widths = usePanelWidths()
  const docked = useSyncExternalStore(subscribeResize, () => dockedPanels(innerWidth, widths))
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [dockedBefore, setDockedBefore] = useState(docked)
  if (docked !== dockedBefore) {
    setDockedBefore(docked)
    setOverlay(null)
  }
  const sidebarDocks = docked !== 'none'
  const contextDocks = docked === 'both'
  const sidebarShown = sidebarDocks ? sidebarOpen : overlay === 'sidebar'
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
  const looking = useLooking()
  useMarkRead(selected, looking && state.connected, send)
  const select = useCallback((chatId: string) => {
    dispatch({ type: 'select', chatId })
    setOverlay((open) => (open === 'sidebar' ? null : open))
  }, [])
  // A notification clicked: its chat opens, if it's still there.
  useEffect(() => {
    openRef.current = (chatId) => {
      if (seenRef.current.chats.some((c) => c.id === chatId)) select(chatId)
    }
  }, [select])
  useEffect(() => window.kothar?.onOpenChat?.((chatId) => openRef.current(chatId)), [])
  const engine = state.engines.find((e) => e.id === selected?.engine)
  const accounts = state.accounts.find((a) => a.engine === selected?.engine)
  const activeAccount = accounts?.accounts.find((a) => a.id === accounts.active)
  const signedIn = activeAccount?.signedIn ?? engine?.signedIn

  const connected = state.connected
  const { catalog, themes, installed, marketFailures, extensions, localInstall, communityExtensions } = state
  const market = useMemo(
    () => ({ catalog, themes, installed, marketFailures, extensions, localInstall, communityExtensions }),
    [catalog, themes, installed, marketFailures, extensions, localInstall, communityExtensions],
  )
  // What a restart would stop.
  const running = state.chats.filter((c) => c.status !== 'idle').length
  const newChatFromFolder = useCallback(async () => {
    if (!connected || !window.kothar) return
    const picked = await window.kothar.pickFolder()
    if (picked) send({ type: 'chat.create', name: folderName(picked), folders: [picked] })
  }, [connected, send])
  const [searching, setSearching] = useState(false)
  const [marketplace, setMarketplace] = useState(false)
  const openMarketplace = useCallback(() => setMarketplace(true), [])
  const goTo = (chatId: string | undefined) => chatId && select(chatId)
  // The open chat's extension panels: popups, their keys and sidebar entries.
  const panels = (selected && state.extensionUi?.chatId === selected.id && state.extensionUi.panels) || []
  const showContext = useCallback(() => {
    if (contextDocks) setContextOpen(true)
    else setOverlay('context')
  }, [contextDocks])
  const panelKeys = usePanelShortcuts(panels, showContext)
  const shortcuts: ShortcutHandlers = {
    previousSpace: () => goTo(stepSpace(state.chats, state.selectedId, -1)),
    nextSpace: () => goTo(stepSpace(state.chats, state.selectedId, 1)),
    ...Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`jump${i + 1}`, () => goTo(nthSpace(state.chats, i + 1))]),
    ),
    newSpace: () => connected && setNameRequest({ kind: 'new' }),
    settings: () => openSettings(),
    search: () => setSearching((open) => !open),
    marketplace: () => setMarketplace((open) => !open),
    ...panelShortcuts({ covered: settingsOpen || marketplace, chatOpen: !!selected, toggleSidebar, toggleContext }),
    ...(window.kothar && { newSpaceFromFolder: () => void newChatFromFolder() }),
    ...(!settingsOpen && !marketplace && panelKeys),
  }
  useShortcuts(shortcuts)
  const keys = useBindings()
  const [quitting, setQuitting] = useState(false)
  useEffect(() => window.kothar?.onQuitting(() => setQuitting(true)), [])
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
            {sidebarShown && (
              <SidePanel key="sidebar" side="left" overlay={!sidebarDocks}>
                <aside className="relative flex shrink-0 flex-col border-r bg-panel" style={{ width: widths.sidebar }}>
                  <ResizeHandle panel="sidebar" />
                  <ChatNav
                    chats={state.chats}
                    selectedId={state.selectedId}
                    looking={looking}
                    connected={connected}
                    send={send}
                    select={select}
                    askName={setNameRequest}
                    newSpaceKeys={keys.newSpace}
                  />
                  <SidebarFooter
                    settingsKeys={keys.settings}
                    openSettings={() => openSettings()}
                    entries={sidebarEntries(panels, keys, showContext)}
                  />
                </aside>
              </SidePanel>
            )}
          </AnimatePresence>
          <div className="flex min-w-0 flex-1 flex-col">
            {quitting && (
              <Banner
                tone="warning"
                action={
                  <Button variant="danger" size="small" onClick={() => void window.kothar?.forceQuit()}>
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
            {state.connected && !quitting && state.restart.changes.length > 0 && (
              <Banner
                tone="warning"
                action={<RestartButton restart={state.restart} running={running} connected={connected} send={send} />}
              >
                Restart Kothar to apply community extension changes: {changesText(state.restart.changes)}.
              </Banner>
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
              extensions={state.extensions}
              modelLists={state.modelLists}
              setups={state.setups}
              setupSave={state.setupSave}
              workFolder={state.workFolder}
              chooseWorkFolder={() => setChangingWorkFolder(true)}
              market={market}
              communityExtensions={communityExtensions}
              restart={state.restart}
              running={running}
              openMarketplace={openMarketplace}
              pickFolder={window.kothar?.pickFolder}
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
                workFolder={state.workFolder}
                engines={state.engines}
                accounts={accounts}
                connected={state.connected}
                send={send}
                openSettings={openSettings}
                sidebarOpen={sidebarShown}
                toggleSidebar={toggleSidebar}
                contextOpen={contextDocks ? contextOpen : overlay === 'context'}
                contextOverlay={!contextDocks}
                toggleContext={toggleContext}
                columnPx={columnPx}
                setColumnPx={setColumnPx}
                notify={notify}
                contextItems={state.context?.chatId === selected.id ? state.context.items : undefined}
                extensionUi={state.extensionUi}
                extensions={state.extensions}
                panelViews={state.panelViews}
                terminalErrors={state.terminalErrors}
                contextDefaults={state.contextDefaults}
                modelLists={state.modelLists}
                setups={state.setups}
                select={select}
              />
            ) : (
              <>
                <header className="flex h-44 shrink-0 items-center border-b px-12">
                  <PanelToggle
                    side="left"
                    label="Sidebar"
                    noun="sidebar"
                    open={sidebarShown}
                    toggle={toggleSidebar}
                    action="toggleSidebar"
                  />
                </header>
                <div className="m-auto flex max-w-420 flex-col items-center gap-12 p-24 text-center text-muted">
                  <strong className="text-body font-semibold text-text">
                    {state.loaded
                      ? `No ${CHAT_NOUN.one} open`
                      : state.connected
                        ? 'Loading…'
                        : 'Connecting to the core…'}
                  </strong>
                  {state.loaded && (
                    <Button variant="primary" disabled={!connected} onClick={() => setNameRequest({ kind: 'new' })}>
                      New {CHAT_NOUN.one}…
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
          <div className="fixed right-16 bottom-120 z-30 flex max-w-360 flex-col">
            <AnimatePresence initial={false}>
              {state.toasts.map((t) => (
                <Toast key={t.id} id={t.id} message={t.message} dismiss={dismissToast} />
              ))}
            </AnimatePresence>
          </div>
          <MarketplaceDialog
            open={marketplace}
            close={() => setMarketplace(false)}
            market={market}
            connected={connected}
            send={send}
            pickFolder={window.kothar?.pickFolder}
          />
          {selected && (
            <ExtensionPopup
              chatId={selected.id}
              panels={panels}
              panelViews={state.panelViews}
              connected={connected}
              send={send}
            />
          )}
          <SearchPalette
            open={searching}
            close={() => setSearching(false)}
            chats={state.chats}
            selectedId={state.selectedId}
            search={state.search}
            connected={connected}
            send={send}
            select={select}
          />
          <NameDialog
            request={nameRequest}
            connected={connected}
            send={send}
            close={() => setNameRequest(null)}
          />
          <WorkFolderDialog
            open={firstRun || changingWorkFolder}
            workFolder={state.workFolder}
            connected={connected}
            send={send}
            toasts={state.toasts}
            pickFolder={window.kothar?.pickFolder}
            close={firstRun ? undefined : () => setChangingWorkFolder(false)}
          />
          <ConfirmDialog />
        </div>
      </MotionConfig>
    </LazyMotion>
  )
}

startAppearance()
createRoot(document.getElementById('root')!).render(
  <Tooltip.Provider delayDuration={HINT_DELAY_MS}>
    <App />
  </Tooltip.Provider>,
)
