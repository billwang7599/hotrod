// A chat's view: its header, the transcript, what waits below it (queue, requests, waits) and the message box, with
// the Context panel beside it. The transcript items, cards and message box live in chat/.
import type { ExtensionAction } from '@kothar/extension-api'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AnimatePresence, m, useReducedMotion } from 'motion/react'
import {
  levelsOf,
  type ThinkingLevel,
  type ChatStatus,
  type ClientMessage,
  type ContextItem,
  type ContextSection,
  type MessageActionInfo,
  type EngineAccounts,
  type EngineInfo,
  type ModelLists,
  type PanelTab,
  type Setup,
  type WorkFolder,
} from '@kothar/core/shared'
import { ContextPanel } from './context-panel.tsx'
import { choosePanelTab, extensionTabId, openDock, openPopup } from './panel-tab.ts'
import { ExtensionDock, useOpenDock } from './extension-dock.tsx'
import { ReportsOpen, StepsOpen, useReportsShown, useStepsShown } from './steps.ts'
import { confirm, Hint, MOTION, SidePanel, useSettled } from './controls.tsx'
import type { SettingsPage } from './settings.tsx'
import {
  engineName,
  fromModelKey,
  foldSteps,
  modelMenu,
  type ChatView,
  type Item,
  type State,
  lineOf,
  waitsBelow,
  workerRequests,
} from './state.ts'
import { columnSlider } from './layout.ts'
import { localNth, onReveal, revealIn, takeReveal, type Reveal } from './search.tsx'
import { ArchivedNote, EngineNote, QueuedMessages, Waits, WorkerBar, WorkerRequests } from './chat/above-composer.tsx'
import { ChatHeader } from './chat/header.tsx'
import { useRevealNumbers } from './chat/reveal-numbers.ts'
import { useAttachments, useFileDrop } from './chat/use-attachments.ts'
import { Composer } from './chat/composer.tsx'
import { Dots, Row } from './chat/parts.tsx'
import { ItemView, StreamingText } from './chat/transcript-items.tsx'
import { editorLabel, FileLinks } from './file-links.tsx'

const INTERRUPT_SEND_TEXT = 'Interrupt and send now?'
const FORCE_STOP_TEXT = 'Force stop? The engine and any command it started get a few seconds to exit, then are killed.'
const PLACEHOLDERS: Record<ChatStatus, string> = {
  idle: 'Message',
  running: 'Working… Enter queues a message',
  waiting: 'Waiting for your approval… Enter queues a message',
  stopping: 'Stopping… Enter queues a message',
}
const ANSWER_PLACEHOLDER = 'Waiting for your answer… Enter queues a message'
// When the engine can steer, Enter hands a message to the running turn and ⌥Enter queues it.
const STEER_PLACEHOLDERS: Partial<Record<ChatStatus, string>> = {
  running: 'Working… Enter steers · ⌥Enter queues',
  waiting: 'Waiting for your approval… Enter steers · ⌥Enter queues',
}
const SLIDER =
  'h-12 w-96 appearance-none border-0 bg-transparent p-0 opacity-35 transition-opacity duration-150 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent [&::-webkit-slider-runnable-track]:h-2 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-muted [&::-webkit-slider-thumb]:-mt-4 [&::-webkit-slider-thumb]:size-10 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-text'
export const JUMP_BELOW_PX = 240
/** Within this of the bottom, the view follows new output down. */
export const FOLLOW_PX = 16
// Scrolled this close to the top, the view asks for the page of history before what it has.
export const OLDER_PX = 600

type ChatProps = {
  chat: ChatView
  chats: ChatView[]
  folder?: string
  engines: EngineInfo[]
  accounts?: EngineAccounts
  connected: boolean
  send: (m: ClientMessage) => void
  openSettings: (page?: SettingsPage) => void
  sidebarOpen: boolean
  toggleSidebar: () => void
  contextOpen: boolean
  contextOverlay: boolean
  toggleContext: () => void
  contextItems?: ContextItem[]
  // The context items are the last chat's, shown in the right panel until this chat's arrive (state.ts follow).
  contextStale?: boolean
  extensionUi?: State['extensionUi']
  extensions?: State['extensions']
  panelViews?: State['panelViews']
  terminalErrors?: State['terminalErrors']
  contextDefaults: Record<ContextSection, boolean>
  modelLists?: ModelLists
  setups?: Setup[]
  columnPx: number
  setColumnPx: (px: number) => void
  notify: (message: string) => void
  workFolder: WorkFolder
  select?: (chatId: string) => void
}

const NO_PANELS: PanelTab[] = []
const NO_ACTIONS: MessageActionInfo[] = []
const entryOf = (item: Item) => ('entry' in item && item.entry !== undefined ? [item.entry] : [])

export function Chat(props: ChatProps) {
  const { chat, folder, engines, accounts, connected, send, openSettings, workFolder } = props
  const { pending, attach, unattach } = useAttachments(props.notify)
  const listRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // True while the user is at the bottom: new output then scrolls into view. Scrolling up turns it off.
  const following = useRef(true)
  // True during a jump to the bottom, so the smooth scroll's own steps don't count as scrolling up.
  const jumping = useRef(false)
  const [jumpShown, setJumpShown] = useState(false)
  const reduceMotion = useReducedMotion()
  const line = lineOf(props.chats, chat)
  const space = line.at(-1)!
  const stepsShown = useStepsShown(chat.id, ...line.slice(1).map((c) => c.id))
  const reportsShown = useReportsShown(chat.id, ...line.slice(1).map((c) => c.id))
  const editor = editorLabel(workFolder)
  const fileLinks = useMemo(() => ({ chatId: chat.id, send, connected, editor }), [chat.id, send, connected, editor])
  const viewOnly = !!chat.worker
  // Workers never ask in their own view: their requests wait in the space above them.
  const requests = viewOnly ? [] : workerRequests(props.chats, chat.id)
  // A worker's waits show in its space, where the user is; its own view shows them too.
  const waits = viewOnly ? (chat.waits ?? []).map((wait) => ({ chat, wait })) : waitsBelow(props.chats, chat.id)
  const [paneColumnPx, setPaneColumnPx] = useState(0)
  const settled = useSettled()
  const enter = settled.current && MOTION.rise.initial

  const toBottom = () => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }
  const gapBelow = (list: HTMLElement) => list.scrollHeight - list.scrollTop - list.clientHeight
  const measure = () => {
    const list = listRef.current
    if (list) setJumpShown(gapBelow(list) > JUMP_BELOW_PX)
  }
  const follow = () => {
    if (following.current) toBottom()
    measure()
  }
  const scrolled = () => {
    const list = listRef.current
    if (!list) return
    const atBottom = gapBelow(list) <= FOLLOW_PX
    if (atBottom) jumping.current = false
    if (!jumping.current) following.current = atBottom
    measure()
    nearTop()
  }
  const userScrolls = () => {
    jumping.current = false
  }

  // Older history: asked for once per page (by where the loaded part starts). The view stays on the first message
  // loaded (a turn's start, whose row a page in front never regroups) while the loading row and then the page go in
  // above it.
  const from = chat.from ?? 0
  const [askedBefore, setAskedBefore] = useState<number>()
  const anchor = useRef<{ node: HTMLElement; top: number } | null>(null)
  const loadingOlder = askedBefore === from && from > 0
  const loadOlder = (to?: number) => {
    const list = listRef.current
    if (from === 0 || askedBefore === from || !connected) return
    const node =
      list?.querySelector<HTMLElement>('[data-item-kind="user"],[data-item-kind="report"]') ??
      list?.querySelector<HTMLElement>('[data-item-kind]')
    anchor.current = node ? { node, top: node.offsetTop } : null
    setAskedBefore(from)
    send({ type: 'chat.history', chatId: chat.id, before: from, ...(to !== undefined && { to }) })
  }
  // For effects that run on fewer changes than these do (declared first, so it's current when they run).
  const latest = useRef({ loadOlder, entries: chat.entries })
  useLayoutEffect(() => {
    latest.current = { loadOlder, entries: chat.entries }
  })
  const nearTop = () => {
    const list = listRef.current
    if (list && list.scrollTop < OLDER_PX && !following.current) loadOlder()
  }

  // The loading row or an older page went in front: scroll by what it added above that row.
  useLayoutEffect(() => {
    const list = listRef.current
    const kept = anchor.current
    if (!list || !kept?.node.isConnected) return
    list.scrollTop += kept.node.offsetTop - kept.top
    kept.top = kept.node.offsetTop
    if (!loadingOlder) anchor.current = null
  }, [from, loadingOlder])

  useLayoutEffect(follow, [chat.items, chat.status, chat.draft, requests.length])

  // Opened from a message match in the search palette: show that message instead of the bottom, loading the history
  // back to it first if it's older than what's loaded.
  const revealing = useRef<Reveal | null>(null)
  // A reveal for the chat that's open already (a message an extension's panel quotes, say) shows at once.
  const [revealAsked, setRevealAsked] = useState(0)
  useEffect(() => onReveal(() => setRevealAsked((n) => n + 1)), [])
  useLayoutEffect(() => {
    const reveal = revealing.current ?? takeReveal(chat.id)
    revealing.current = null
    const list = listRef.current
    if (!reveal || !list) return
    if (reveal.entry !== undefined && reveal.entry < from) {
      revealing.current = reveal
      following.current = false
      return latest.current.loadOlder(reveal.entry)
    }
    const { entries } = latest.current
    const shown = !('query' in reveal)
      ? reveal
      : { ...reveal, nth: reveal.entry === undefined || !entries ? reveal.nth : localNth(entries, from, reveal) }
    if (!revealIn(list, shown)) return
    following.current = false
    measure()
    // The view is keyed by chat id (main.tsx); it runs again when an older page it asked for lands.
  }, [chat.id, from, revealAsked])

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list || !contentRef.current) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) if (entry.target === list) setPaneColumnPx(entry.contentRect.width)
      follow()
      // A page too short to scroll can't be scrolled up to load more.
      if (list.scrollHeight <= list.clientHeight) latest.current.loadOlder()
    })
    observer.observe(list)
    observer.observe(contentRef.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (connected) send({ type: 'context.get', chatId: chat.id })
  }, [chat.id, connected, props.contextDefaults, send])

  const archived = chat.archived
  const canChange = connected && chat.status === 'idle' && !archived
  const offers = engines.find((e) => e.id === chat.engine)
  const menu = modelMenu(chat, engines)
  const engineOff = !menu.runnable
  const noEngineOn = !engines.some((e) => e.enabled)
  const canSend = canChange && !engineOff
  const busy = chat.status !== 'idle'
  const asking = chat.status === 'waiting' || requests.length > 0
  const questionWaits = asking && chat.items.some((i) => i.kind === 'question' && i.outcome === 'pending')
  const steers = offers?.steering === true && (chat.status === 'running' || chat.status === 'waiting')
  const placeholder = questionWaits
    ? ANSWER_PLACEHOLDER
    : ((steers ? STEER_PLACEHOLDERS[chat.status] : undefined) ?? PLACEHOLDERS[chat.status])
  const canQueue = connected && busy && !archived
  const showEngineNote = engineOff && !archived && chat.status === 'idle' && !viewOnly
  const last = chat.items.at(-1)
  const awaitingOutput = chat.status === 'running' && !chat.draft && !(last?.kind === 'tool' && last.state === 'running')
  const canAttach = canSend || canQueue
  const { dragging, dropHandlers } = useFileDrop(canAttach, attach)
  const submit = (text: string, steer = false) => {
    if (!canAttach || (text.trim() === '' && !pending.length)) return false
    const attachments = pending.map(({ name, mimeType, base64 }) => ({ name, mimeType, base64 }))
    const steering = steer && steers
    send({ type: 'chat.send', chatId: chat.id, text, ...(attachments.length && { attachments }), ...(steering && { steer: true }) })
    following.current = true
    toBottom()
    unattach(pending)
    return true
  }
  const interrupt = async () => {
    if (chat.status !== 'stopping' && (await confirm(INTERRUPT_SEND_TEXT))) {
      send({ type: 'chat.interrupt', chatId: chat.id })
    }
  }
  const stop = async () => {
    if (chat.status !== 'stopping') return send({ type: 'chat.interrupt', chatId: chat.id })
    if (await confirm(FORCE_STOP_TEXT)) send({ type: 'chat.interrupt', chatId: chat.id, force: true })
  }
  const setModel = (key?: string, thinking?: ThinkingLevel) => {
    if (!key) return
    const { engine, model } = fromModelKey(key)
    // A new model keeps the chat's own thinking level only if it takes it; otherwise its list picks the level again.
    const takes = levelsOf(engines.find((e) => e.id === engine), model)
    const pinned = chat.thinking && takes.includes(chat.thinking) ? chat.thinking : undefined
    send({ type: 'chat.setModel', chatId: chat.id, engine, model, thinking: key === menu.value ? thinking : pinned })
  }
  const unarchive = () => send({ type: 'chat.archive', chatId: chat.id, archived: false })
  // How many older items loaded pages put in front of the first one loaded; rows stay keyed from that one.
  const shift = chat.shift ?? 0
  const { revealOf, draftKey, draftFrom } = useRevealNumbers(chat)
  const dockPanel = useOpenDock(props.extensionUi?.chatId === chat.id ? props.extensionUi.panels : NO_PANELS)
  const itemProps = {
    chat,
    ...(!reduceMotion && { revealOf }),
    contextItems: props.contextStale ? undefined : props.contextItems,
    connected,
    send,
    messageActions: props.extensionUi?.chatId === chat.id ? (props.extensionUi.messageActions ?? NO_ACTIONS) : NO_ACTIONS,
    ...(viewOnly && space !== chat && { space, select: props.select }),
    openChat: (chatId: string) => {
      const select = props.select
      return select && props.chats.some((c) => c.id === chatId) ? () => select(chatId) : undefined
    },
    openPanel: (extension: string, panel: string, action?: ExtensionAction) => {
      // The action first, so the panel draws what the note is about as it opens.
      if (action && connected) send({ type: 'extension.panel.action', chatId: chat.id, extension, panel, action })
      const placement = props.extensionUi?.panels.find((p) => p.extension === extension && p.id === panel)?.placement
      if (placement === 'popup') return openPopup(extensionTabId(extension, panel))
      if (placement === 'dock') return openDock(extensionTabId(extension, panel))
      choosePanelTab(extensionTabId(extension, panel))
      if (!props.contextOpen) props.toggleContext()
    },
  }

  return (
    <div className="flex min-h-0 flex-1" style={{ '--column': `${props.columnPx}px` } as CSSProperties}>
      <div className="relative flex min-h-0 min-w-0 flex-1">
      <main
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        {...dropHandlers}
      >
        <AnimatePresence>
          {dragging && (
            <m.div
              key="drop"
              className="pointer-events-none absolute inset-8 z-10 grid place-items-center rounded-lg border-2 border-dashed border-accent bg-bg/85 text-body text-muted"
              {...MOTION.fade}
            >
              {canAttach ? 'Drop files to attach' : "Files can't be attached here right now"}
            </m.div>
          )}
        </AnimatePresence>
        <ChatHeader
          chat={chat}
          line={line}
          folder={folder}
          workFolder={workFolder}
          accounts={accounts}
          engineOff={engineOff}
          canSend={canSend}
          send={send}
          openSettings={openSettings}
          sidebarOpen={props.sidebarOpen}
          toggleSidebar={props.toggleSidebar}
          contextOpen={props.contextOpen}
          toggleContext={props.toggleContext}
        />
        <div
          // Chrome's scroll anchoring would otherwise drag the view along with output added near the bottom. The
          // transcript never scrolls sideways (code blocks and tables scroll on their own), and a gutter on both
          // edges keeps the column centred under a visible scrollbar, in line with the composer below.
          className="flex flex-1 flex-col overflow-x-hidden overflow-y-auto p-24 [overflow-anchor:none] [scrollbar-gutter:stable_both-edges]"
          ref={listRef}
          onScroll={scrolled}
          onWheel={userScrolls}
          onTouchStart={userScrolls}
          onKeyDown={userScrolls}
        >
          <div className="mx-auto flex w-full max-w-column flex-1 flex-col gap-10" ref={contentRef}>
            <FileLinks.Provider value={fileLinks}>
            <StepsOpen.Provider value={stepsShown}>
              <ReportsOpen.Provider value={reportsShown}>
                {chat.items.length === 0 && !chat.draft && (
                  <div className="m-auto flex max-w-420 flex-col items-center gap-4 p-24 text-center text-muted">
                    <strong className="text-body font-semibold text-text">
                      Start a chat in <span className="font-mono">{chat.name}</span>
                    </strong>
                    <span>
                      Each message starts {engineName(offers) || chat.engine} in {folder ?? 'a scratch folder'}
                    </span>
                  </div>
                )}
                {loadingOlder && (
                  <div className="flex justify-center text-sm text-muted" data-loading-older>
                    <Dots label="Loading earlier messages" />
                  </div>
                )}
                {foldSteps(chat.items, stepsShown).map((row) => {
                  const kind = 'item' in row ? row.item.kind : 'steps'
                  // Keyed from the first item loaded, so a page added in front leaves the rows already shown alone.
                  const at = row.at - shift
                  const logged = 'steps' in row ? row.steps.flatMap(entryOf) : []
                  return (
                    <m.div
                      key={kind === 'steps' ? `steps-${at}` : at}
                      data-item-kind={kind}
                      data-entry={'item' in row ? entryOf(row.item)[0] : undefined}
                      data-entry-first={logged[0]}
                      data-entry-last={logged.at(-1)}
                      className={`group/item flex flex-col rounded transition-colors duration-700 data-revealed:bg-accent/10 ${kind === 'user' || kind === 'report' ? 'mt-14 first:mt-0' : ''}`}
                      initial={kind !== 'text' && at >= 0 && enter}
                      animate={MOTION.rise.animate}
                    >
                      {'steps' in row ? (
                        <Row quiet summary={`${row.steps.length} steps`}>
                          <div className="mt-4 mb-2 ml-13 flex flex-col gap-10 border-l-2 pl-12 text-text">
                            {row.steps.map((item, i) => (
                              <ItemView key={i} item={item} {...itemProps} />
                            ))}
                          </div>
                        </Row>
                      ) : (
                        <ItemView item={row.item} at={row.at} {...itemProps} />
                      )}
                    </m.div>
                  )
                })}
                {chat.draft && (
                  <m.div initial={enter} animate={MOTION.rise.animate}>
                    <StreamingText name={draftKey} text={chat.draft} from={draftFrom} smooth={!reduceMotion} />
                  </m.div>
                )}
                {awaitingOutput && (
                  <m.div className="text-body leading-[1.6] text-muted" initial={MOTION.fade.initial} animate={MOTION.fade.animate}>
                    <Dots label="Working" />
                  </m.div>
                )}
              </ReportsOpen.Provider>
            </StepsOpen.Provider>
            </FileLinks.Provider>
          </div>
        </div>
        <div className="relative shrink-0 px-24 pb-16">
          <div className="pointer-events-none absolute inset-x-24 bottom-full mx-auto flex max-w-column justify-end pb-12">
            <AnimatePresence>
              {jumpShown && (
                <Hint
                  key="jump"
                  text={
                    questionWaits
                      ? 'A question is waiting below'
                      : asking
                        ? 'A permission request is waiting below'
                        : 'Jump to the latest output'
                  }
                >
                  <m.button
                    className={`pointer-events-auto grid size-32 place-items-center rounded-full border shadow-floating transition-colors ${
                      asking
                        ? 'border-amber bg-warning-bg text-amber hover:bg-raised'
                        : 'bg-panel text-muted hover:bg-raised hover:text-text'
                    }`}
                    aria-label={
                      questionWaits
                        ? 'Scroll to the question'
                        : asking
                          ? 'Scroll to the permission request'
                          : 'Scroll to bottom'
                    }
                    data-asking={asking || undefined}
                    onClick={() => {
                      const list = listRef.current
                      following.current = true
                      jumping.current = true
                      list?.scrollTo({ top: list.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' })
                    }}
                    {...MOTION.pop}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
                      <path d="M8 2.5v11M3.5 9 8 13.5 12.5 9" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </m.button>
                </Hint>
              )}
            </AnimatePresence>
          </div>
          {archived && <ArchivedNote connected={connected} unarchive={unarchive} />}
          {showEngineNote && (
            <EngineNote
              chat={chat}
              offers={offers}
              noEngineOn={noEngineOn}
              modelLists={props.modelLists}
              connected={connected}
              send={send}
              openSettings={openSettings}
            />
          )}
          <QueuedMessages chat={chat} connected={connected} send={send} />
          {requests.length > 0 && <WorkerRequests requests={requests} connected={connected} send={send} />}
          {waits.length > 0 && <Waits chat={chat} waits={waits} connected={connected} send={send} />}
          {viewOnly && !archived && (
            <WorkerBar
              chat={chat}
              parentName={props.chats.find((c) => c.id === chat.parentId)?.name ?? 'another chat'}
              busy={busy}
              connected={connected}
              stop={stop}
            />
          )}
          {!showEngineNote && !viewOnly && (
            <Composer
              key={chat.id}
              chat={chat}
              connected={connected}
              pending={pending}
              unattach={unattach}
              attach={attach}
              canSend={canSend}
              canQueue={canQueue}
              canChange={canChange}
              steers={steers}
              placeholder={placeholder}
              menu={menu}
              setModel={setModel}
              stop={stop}
              submit={submit}
              interrupt={interrupt}
            />
          )}
          <Hint text="Chat width">
            <input
              type="range"
              className={`absolute right-24 bottom-2 ${SLIDER}`}
              aria-label="Chat width"
              {...columnSlider(props.columnPx, paneColumnPx)}
              onChange={(e) => props.setColumnPx(Number(e.target.value))}
            />
          </Hint>
        </div>
      </main>
      <AnimatePresence initial={false}>
        {dockPanel && (
          <ExtensionDock
            key={extensionTabId(dockPanel.extension, dockPanel.id)}
            chatId={chat.id}
            panel={dockPanel}
            panelViews={props.panelViews}
            connected={connected}
            send={send}
          />
        )}
      </AnimatePresence>
      </div>
      <AnimatePresence initial={false}>
        {props.contextOpen && (
          <SidePanel key="context" side="right" overlay={props.contextOverlay}>
            <ContextPanel
              chatId={chat.id}
              items={props.contextItems}
              itemsStale={props.contextStale}
              chats={props.chats}
              workFolder={workFolder}
              readOnly={archived}
              connected={connected}
              send={send}
              hide={props.contextOverlay ? props.toggleContext : undefined}
              extensionUi={props.extensionUi}
              extensions={props.extensions}
              panelViews={props.panelViews}
              terminalErrors={props.terminalErrors}
              pickers={window.kothar}
              setups={props.setups}
              openSetups={() => openSettings('setups')}
            />
          </SidePanel>
        )}
      </AnimatePresence>
    </div>
  )
}
