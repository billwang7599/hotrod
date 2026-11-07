import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from 'react'
import { AnimatePresence, m } from 'motion/react'
import { Dialog } from 'radix-ui'
import {
  IMAGE_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  type Attachment,
  type ChatStatus,
  type ClientMessage,
  type ContextItem,
  type ContextSection,
  type EngineAccounts,
  type EngineInfo,
  type ModelLists,
  type Upload,
} from '@hotrod/core/shared'
import { attachmentUrl, coreUrl, readToken } from './connection.ts'
import { ContextPanel } from './context-panel.tsx'
import { Button, CHAT_NOUN, Chevron, confirm, ErrorText, MOTION, SidePanel, useSettled } from './controls.tsx'
import { Markdown } from './markdown.tsx'
import type { SettingsPage } from './settings.tsx'
import {
  accountLabel,
  columnSlider,
  engineOptions,
  formatBytes,
  listedAccounts,
  MAIN_CHAT_ID,
  MAX_PREVIEW_BYTES,
  modelMenu,
  pinState,
  previewText,
  type ChatView,
  type Item,
} from './state.ts'

const MANAGE_ACCOUNTS = '__manage'
const SEND_HINT = 'Enter to send · Shift+Enter for a new line'
const QUEUE_HINT = 'Enter to queue · ⌘Enter to interrupt and send'
const INTERRUPT_SEND_TEXT = 'Interrupt and send now?'
const FORCE_STOP_HINT = 'Click Stopping… again to force stop'
const MODEL_HINT = 'Model, from the next message. Choosing the one from Settings goes back to following Settings.'
const THINKING_HINT = 'Thinking level, from the next message. Choosing the Settings default goes back to following it.'
const INTERRUPTED = 'Interrupted'
const OUTCOMES = { allowed: '✓ Allowed', denied: '✕ Denied', cancelled: '– Cancelled' }
const FORCE_STOP_TEXT = 'Force stop? The engine and any command it started get a few seconds to exit, then are killed.'
const PLACEHOLDERS: Record<ChatStatus, string> = {
  idle: 'Message',
  running: 'Working… Enter queues a message',
  waiting: 'Waiting for your approval… Enter queues a message',
  stopping: 'Stopping… Enter queues a message',
}
const ASSISTANT = 'min-w-0 text-body leading-[1.6] wrap-break-word'
const TOOL_NAME = 'shrink-0 font-mono text-sm leading-[normal] font-semibold'
const TOOL_INPUT = 'min-w-0 flex-1 truncate font-mono text-sm leading-[normal] text-muted'
const TOOL_STATES: Record<string, string> = {
  running: 'text-green before:animate-blink',
  waiting: 'text-amber',
  error: 'text-red',
}
const OUTCOME_COLORS = { allowed: 'text-green', denied: 'text-red', cancelled: 'text-muted' }
const BODY = 'max-h-320 overflow-y-auto py-8 pr-10 text-muted'
const SLIDER =
  'h-12 w-96 cursor-pointer appearance-none border-0 bg-transparent p-0 opacity-35 transition-opacity duration-150 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent [&::-webkit-slider-runnable-track]:h-2 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-muted [&::-webkit-slider-thumb]:-mt-4 [&::-webkit-slider-thumb]:size-10 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-text'
const FILE_CHIP = 'flex max-w-200 min-w-0 items-center rounded-lg border px-10'
const FILE_ACTION =
  'rounded px-5 text-sm leading-[1.35] text-muted enabled:hover:bg-raised enabled:hover:text-text disabled:text-faint'
const REVEAL = 'opacity-0 transition-opacity duration-150 group-focus-within/file:opacity-100 group-hover/file:opacity-100'
const SELECT_ARROW =
  'bg-[url(data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%2710%27%20height=%276%27%3E%3Cpath%20d=%27M1%201l4%204%204-4%27%20fill=%27none%27%20stroke=%27%238b8e96%27%20stroke-width=%271.5%27/%3E%3C/svg%3E)]'

function ChipSelect(props: ComponentProps<'select'>) {
  return (
    <select
      className={`h-26 max-w-220 min-w-0 cursor-pointer appearance-none truncate rounded border border-transparent bg-transparent bg-no-repeat bg-position-[right_8px_center] pr-24 pl-8 text-sm text-muted field-sizing-content enabled:hover:border-border enabled:hover:text-text disabled:cursor-default disabled:text-faint disabled:opacity-70 max-[900px]:max-w-150 [&_option]:bg-panel [&_option]:text-text ${SELECT_ARROW}`}
      {...props}
    />
  )
}

function Row({ summary, quiet, children }: { summary: ReactNode; quiet?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className={`group rounded border ${quiet ? 'border-transparent text-muted' : 'bg-panel'}`}
      data-open={open || undefined}
    >
      <button
        className={`flex h-28 w-full items-center gap-8 rounded pr-10 pl-8 text-left hover:bg-raised ${quiet ? 'text-sm' : 'text-ui'}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Chevron />
        {summary}
      </button>
      <AnimatePresence initial={false}>{open && <m.div {...MOTION.collapse}>{children}</m.div>}</AnimatePresence>
    </div>
  )
}

type PanelToggleProps = { side: 'left' | 'right'; label: string; noun: string; open: boolean; toggle: () => void }

function PanelToggle({ side, label, noun, open, toggle }: PanelToggleProps) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="grid place-items-center aria-pressed:text-text"
      aria-label={label}
      aria-pressed={open}
      title={`${open ? 'Hide' : 'Show'} ${noun}`}
      onClick={toggle}
    >
      <svg
        className={side === 'left' ? '-scale-x-100' : ''}
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        aria-hidden="true"
      >
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
        <path d="M10 2.5v11" />
        {open && <path d="M10 2.5h3a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-3z" fill="currentColor" />}
      </svg>
    </Button>
  )
}

type Pending = Upload & { id: string; size: number; preview?: string }

function PaperclipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
      <path
        d="M13.5 7.5 8 13a3.5 3.5 0 0 1-5-5l6-6a2.3 2.3 0 0 1 3.3 3.3l-6 6a1.2 1.2 0 0 1-1.7-1.7L10 4"
        strokeWidth="1.4"
      />
    </svg>
  )
}

function FileLabel({ name, size, actions }: { name: string; size: number; actions?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col leading-[1.35]">
      <span className="truncate text-ui">{name}</span>
      <span className="grid text-sm text-faint *:col-start-1 *:row-start-1">
        <span className="transition-opacity duration-150 group-focus-within/file:opacity-0 group-hover/file:opacity-0">
          {formatBytes(size)}
        </span>
        {actions}
      </span>
    </span>
  )
}

function PinIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M5 1.5h6M6.5 1.5v4.5L3.5 9.5h9L9.5 6V1.5M8 9.5v5" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  )
}

type SentAttachmentProps = {
  chat: ChatView
  attachment: Attachment
  contextItems?: ContextItem[]
  connected: boolean
  send: (m: ClientMessage) => void
}

function SentAttachment({ chat, attachment, contextItems, connected, send }: SentAttachmentProps) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState<string | null>()
  const { name, size, mimeType, path } = attachment
  const url = attachmentUrl(coreUrl(import.meta.env, location, readToken('', sessionStorage)), chat.id, path)
  const kind = IMAGE_TYPES.includes(mimeType) ? 'image' : mimeType === 'application/pdf' ? 'pdf' : 'file'
  const pin = pinState(chat, contextItems, path)

  useEffect(() => {
    if (!open || kind !== 'file') return
    const abort = new AbortController()
    setText(undefined)
    void (async () => {
      try {
        const response = await fetch(url, { signal: abort.signal })
        if (!response.ok || !response.body) throw new Error(String(response.status))
        const reader = response.body.getReader()
        const chunks: Uint8Array<ArrayBuffer>[] = []
        for (let total = 0; total < MAX_PREVIEW_BYTES; ) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          total += value.length
        }
        void reader.cancel()
        setText(previewText(new Uint8Array(await new Blob(chunks).arrayBuffer())) ?? null)
      } catch {
        if (!abort.signal.aborted) setText(null)
      }
    })()
    return () => abort.abort()
  }, [open, kind, url])

  const actions = (
    <>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger asChild>
          <button className={FILE_ACTION} aria-label={`Open ${name}`} title="Preview">
            Open
          </button>
        </Dialog.Trigger>
        <AnimatePresence>
          {open && (
            <Dialog.Portal forceMount>
              <Dialog.Overlay forceMount asChild>
                <m.div className="fixed inset-0 bg-backdrop" {...MOTION.fade} />
              </Dialog.Overlay>
              <Dialog.Content forceMount asChild aria-describedby={undefined}>
                <m.div
                  className="fixed inset-0 m-auto flex size-fit max-h-[calc(100vh-32px)] max-w-[calc(100vw-32px)] min-w-[min(320px,calc(100vw-32px))] flex-col overflow-hidden rounded-[10px] border bg-panel shadow"
                  {...MOTION.pop}
                >
                  <header className="flex h-40 shrink-0 items-center gap-8 border-b pr-8 pl-12">
                    <Dialog.Title className="min-w-0 flex-1 truncate font-semibold">{name}</Dialog.Title>
                    <Dialog.Close asChild>
                      <Button variant="ghost" size="icon" aria-label="Close">
                        ×
                      </Button>
                    </Dialog.Close>
                  </header>
                  {kind === 'image' && (
                    <img
                      src={url}
                      alt={name}
                      className="mx-auto block max-h-[calc(100vh-74px)] max-w-[calc(100vw-34px)] object-contain"
                    />
                  )}
                  {kind === 'pdf' && (
                    <iframe src={url} title={name} className="h-[calc(100vh-74px)] w-[min(900px,calc(100vw-34px))]" />
                  )}
                  {kind === 'file' && (
                    <>
                      {typeof text === 'string' ? (
                        <pre className="min-h-0 w-[min(880px,calc(100vw-34px))] flex-1 overflow-auto px-12 py-10 text-sm leading-[1.5] whitespace-pre-wrap [word-break:break-word]">
                          {text}
                        </pre>
                      ) : (
                        <p className="px-12 py-16 text-muted">
                          {text === undefined ? 'Loading…' : 'No preview for this kind of file.'}
                        </p>
                      )}
                      <div className="flex shrink-0 items-center gap-8 border-t py-8 pr-8 pl-12 text-sm text-muted">
                        <span className="min-w-0 flex-1 truncate">
                          {mimeType} · {formatBytes(size)}
                          {typeof text === 'string' &&
                            size > MAX_PREVIEW_BYTES &&
                            ` · showing the first ${formatBytes(MAX_PREVIEW_BYTES)}`}
                        </span>
                        <a
                          href={url}
                          download={name}
                          className="flex h-24 items-center rounded border bg-raised px-8 text-text hover:bg-hover"
                        >
                          Download
                        </a>
                      </div>
                    </>
                  )}
                </m.div>
              </Dialog.Content>
            </Dialog.Portal>
          )}
        </AnimatePresence>
      </Dialog.Root>
      {pin && (
        <button
          className={FILE_ACTION}
          disabled={!connected}
          aria-label={pin === 'pinned' ? `Unpin ${name}` : `Pin ${name}`}
          title={pin === 'pinned' ? "Remove from this chat's context" : "Add to this chat's context, for every message"}
          onClick={() =>
            send({ type: pin === 'pinned' ? 'context.remove' : 'context.add', chatId: chat.id, section: 'files', path })
          }
        >
          {pin === 'pinned' ? 'Unpin' : 'Pin'}
        </button>
      )}
    </>
  )
  return (
    <div className="group/file relative">
      {kind === 'image' ? (
        <>
          <img
            src={url}
            alt={name}
            title={name}
            className="block max-h-160 min-h-32 max-w-240 min-w-80 rounded-lg border object-contain"
          />
          <span className={`absolute top-4 right-4 flex rounded border bg-panel p-2 shadow ${REVEAL}`}>{actions}</span>
        </>
      ) : (
        <div className={`${FILE_CHIP} h-40 bg-panel`} title={name}>
          <FileLabel name={name} size={size} actions={<span className={`-ml-5 flex ${REVEAL}`}>{actions}</span>} />
        </div>
      )}
      {pin === 'pinned' && (
        <span
          className="absolute -top-6 -left-6 grid size-18 place-items-center rounded-full bg-accent text-on-accent"
          role="img"
          aria-label="Pinned to the context"
          title="Pinned to this chat's context"
        >
          <PinIcon />
        </span>
      )}
    </div>
  )
}

type ItemProps = {
  item: Item
  chat: ChatView
  contextItems?: ContextItem[]
  connected: boolean
  send: (m: ClientMessage) => void
}

function ItemView({ item, chat, contextItems, connected, send }: ItemProps) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex max-w-[85%] flex-col items-end gap-6 self-end">
          {item.attachments && (
            <div className="flex flex-wrap justify-end gap-6">
              {item.attachments.map((a) => (
                <SentAttachment
                  key={a.path}
                  chat={chat}
                  attachment={a}
                  contextItems={contextItems}
                  connected={connected}
                  send={send}
                />
              ))}
            </div>
          )}
          {item.text && (
            <div className="rounded-[12px_12px_4px_12px] bg-raised px-12 py-8 text-body leading-[1.5] whitespace-pre-wrap [word-break:break-word]">
              {item.text}
            </div>
          )}
        </div>
      )
    case 'text':
      return <Markdown className={ASSISTANT} text={item.text} />
    case 'error':
      return item.text === INTERRUPTED ? (
        <div className="text-sm text-muted">{item.text}</div>
      ) : (
        <ErrorText>{item.text}</ErrorText>
      )
    case 'thinking':
      return (
        <Row quiet summary={<span className="italic group-last/item:animate-[blink_1.6s_ease-in-out_infinite]">Thinking…</span>}>
          <div className="mt-2 mb-4 ml-13 max-h-320 overflow-y-auto border-l-2 pl-12 text-sm leading-[1.5] whitespace-pre-wrap">
            {item.text}
          </div>
        </Row>
      )
    case 'tool':
      return (
        <Row
          summary={
            <>
              <span className={TOOL_NAME}>{item.name}</span>
              <span className={TOOL_INPUT}>{item.summary}</span>
              <span
                className={`flex shrink-0 items-center gap-6 text-sm before:size-6 before:rounded-full before:bg-current ${TOOL_STATES[item.state] ?? 'text-faint'}`}
              >
                {item.state === 'waiting' ? 'waiting for approval' : item.state}
              </span>
            </>
          }
        >
          <pre className={`${BODY} border-t pl-26`}>
            {item.output ||
              (item.state === 'running' ? 'Running…' : item.state === 'waiting' ? 'Waiting for approval…' : 'No output')}
          </pre>
        </Row>
      )
    case 'permission': {
      const input = JSON.stringify(item.input, null, 2)
      if (item.outcome !== 'pending') {
        return (
          <Row
            summary={
              <>
                <span className={`shrink-0 text-sm ${OUTCOME_COLORS[item.outcome]}`}>{OUTCOMES[item.outcome]}</span>
                <span className={TOOL_NAME}>{item.name}</span>
                <span className={TOOL_INPUT}>{item.summary}</span>
              </>
            }
          >
            <pre className={`${BODY} border-t pl-26`}>{input}</pre>
          </Row>
        )
      }
      const respond = (allow: boolean) =>
        send({ type: 'permission.respond', chatId: chat.id, requestId: item.requestId, allow })
      return (
        <div className="flex flex-col gap-8 rounded-lg border border-l-3 border-permission-border border-l-amber bg-permission-bg px-14 py-12">
          <div className="text-body">
            Allow <strong>{item.name}</strong>?
          </div>
          <pre className="rounded border bg-bg px-10 py-8">{item.summary}</pre>
          <details className="group">
            <summary className="flex w-fit list-none items-center gap-6 text-sm text-muted hover:text-text">
              <Chevron />
              Full input
            </summary>
            <pre className={`${BODY} mt-6 rounded border bg-bg pl-10`}>{input}</pre>
          </details>
          {chat.status === 'waiting' ? (
            <div className="flex gap-8">
              <Button variant="primary" disabled={!connected} onClick={() => respond(true)}>
                Approve
              </Button>
              <Button variant="danger" disabled={!connected} onClick={() => respond(false)}>
                Deny
              </Button>
            </div>
          ) : (
            <div className="text-sm text-muted">{chat.status === 'stopping' ? 'Stopping…' : 'Pending'}</div>
          )}
        </div>
      )
    }
  }
}

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
  contextDefaults: Record<ContextSection, boolean>
  modelLists?: ModelLists
  columnPx: number
  setColumnPx: (px: number) => void
  notify: (message: string) => void
}

export function Chat(props: ChatProps) {
  const { chat, folder, engines, accounts, connected, send, openSettings } = props
  const listed = accounts && listedAccounts(accounts)
  const [text, setText] = useState('')
  const [pending, setPending] = useState<Pending[]>([])
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  const fileInput = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const [paneColumnPx, setPaneColumnPx] = useState(0)
  const settled = useSettled()
  const enter = settled.current && MOTION.rise.initial

  useLayoutEffect(() => {
    const list = listRef.current
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight
  }, [chat.items, chat.draft, chat.status])

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const observer = new ResizeObserver(([entry]) => {
      if (stickToBottom.current) list.scrollTop = list.scrollHeight
      setPaneColumnPx(entry!.contentRect.width)
    })
    observer.observe(list)
    return () => observer.disconnect()
  }, [])

  useEffect(() => () => pendingRef.current.forEach((p) => p.preview && URL.revokeObjectURL(p.preview)), [])

  useEffect(() => {
    if (connected) send({ type: 'context.get', chatId: chat.id })
  }, [chat.id, connected, props.contextDefaults, send])

  const archived = chat.archived
  const canChange = connected && chat.status === 'idle' && !archived
  const offers = engines.find((e) => e.id === chat.engine)
  const engineOff = !offers?.enabled
  const noEngineOn = !engines.some((e) => e.enabled)
  const canSend = canChange && !engineOff
  const busy = chat.status !== 'idle'
  const hint = chat.status === 'stopping' ? FORCE_STOP_HINT : busy ? QUEUE_HINT : SEND_HINT
  const canQueue = connected && busy && !archived
  const showEngineNote = engineOff && !archived && chat.status === 'idle'
  const canAttach = canSend || canQueue
  const hasContent = text.trim() !== '' || pending.length > 0
  const unattach = (removed: Pending[]) => {
    removed.forEach((p) => p.preview && URL.revokeObjectURL(p.preview))
    setPending((list) => list.filter((p) => !removed.includes(p)))
  }
  const attach = async (files: File[]) => {
    let totalBytes = pendingRef.current.reduce((sum, p) => sum + p.size, 0)
    for (const file of files) {
      const name = file.name || 'attachment'
      try {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          const limit = formatBytes(MAX_ATTACHMENT_BYTES)
          props.notify(`${name} is ${formatBytes(file.size)}. Attachments can be at most ${limit} each.`)
          continue
        }
        if (totalBytes + file.size > MAX_ATTACHMENTS_TOTAL_BYTES) {
          const limit = formatBytes(MAX_ATTACHMENTS_TOTAL_BYTES)
          props.notify(`${name} doesn't fit: one message carries at most ${limit} of attachments. Send it in another.`)
          continue
        }
        totalBytes += file.size
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result).replace(/^[^,]*,/, ''))
          reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(file)
        })
        const mimeType = file.type || 'application/octet-stream'
        const preview = IMAGE_TYPES.includes(mimeType) ? URL.createObjectURL(file) : undefined
        const added = { id: crypto.randomUUID(), name, mimeType, base64, size: file.size, preview }
        setPending((list) => [...list, added])
      } catch {
        props.notify(`Could not read ${name}`)
      }
    }
  }
  const carriesFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')
  const submit = () => {
    if (!canAttach || !hasContent) return
    const attachments = pending.map(({ name, mimeType, base64 }) => ({ name, mimeType, base64 }))
    send({ type: 'chat.send', chatId: chat.id, text, ...(attachments.length && { attachments }) })
    setText('')
    unattach(pending)
  }
  const interruptAndSend = async () => {
    if (!canQueue) return
    submit()
    if (chat.status !== 'stopping' && (await confirm(INTERRUPT_SEND_TEXT))) {
      send({ type: 'chat.interrupt', chatId: chat.id })
    }
  }
  const stop = async () => {
    if (chat.status !== 'stopping') return send({ type: 'chat.interrupt', chatId: chat.id })
    if (await confirm(FORCE_STOP_TEXT)) send({ type: 'chat.interrupt', chatId: chat.id, force: true })
  }
  const menu = modelMenu(chat, offers, props.modelLists)
  const setModel = (model?: string, thinking?: string) =>
    send({ type: 'chat.setModel', chatId: chat.id, model, thinking })
  const unarchive = () => send({ type: 'chat.archive', chatId: chat.id, archived: false })

  return (
    <div className="flex min-h-0 flex-1" style={{ '--column': `${props.columnPx}px` } as CSSProperties}>
      <main
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        onDragEnter={(e) => {
          if (!carriesFiles(e)) return
          dragDepth.current++
          setDragging(true)
        }}
        onDragLeave={(e) => {
          if (!carriesFiles(e) || --dragDepth.current > 0) return
          setDragging(false)
        }}
        onDragOver={(e) => carriesFiles(e) && e.preventDefault()}
        onDrop={(e) => {
          if (!carriesFiles(e)) return
          e.preventDefault()
          dragDepth.current = 0
          setDragging(false)
          if (canAttach) void attach([...e.dataTransfer.files])
        }}
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
        <header className="flex h-44 shrink-0 items-center gap-6 border-b px-12">
          <PanelToggle
            side="left"
            label="Sidebar"
            noun="sidebar"
            open={props.sidebarOpen}
            toggle={props.toggleSidebar}
          />
          <div className="flex min-w-64 flex-1 items-baseline gap-10 pl-2 whitespace-nowrap">
            <span className="max-w-[50%] shrink-0 truncate font-semibold max-[900px]:max-w-full">{chat.name}</span>
            {chat.id !== MAIN_CHAT_ID && (
              <span className="min-w-0 truncate font-mono text-sm leading-[normal] text-faint max-[900px]:hidden">
                {folder ?? 'Not tied to a folder'}
              </span>
            )}
          </div>
          <ChipSelect
            aria-label="Engine"
            value={chat.engine}
            disabled={!canChange}
            onChange={(e) => send({ type: 'chat.setEngine', chatId: chat.id, engine: e.target.value })}
          >
            {engineOptions(engines, chat.engine).map((o) => (
              <option key={o.id} value={o.id} disabled={o.disabled}>
                {o.label}
              </option>
            ))}
          </ChipSelect>
          {accounts && listed && !engineOff && (
            <ChipSelect
              aria-label="Account"
              value={listed.active}
              disabled={!canSend}
              onChange={(e) =>
                e.target.value === MANAGE_ACCOUNTS
                  ? openSettings('accounts')
                  : send({ type: 'account.use', engine: accounts.engine, accountId: e.target.value })
              }
            >
              {listed.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {accountLabel(a)}
                </option>
              ))}
              <option value={MANAGE_ACCOUNTS}>Manage accounts…</option>
            </ChipSelect>
          )}
          <PanelToggle
            side="right"
            label="Context panel"
            noun="context"
            open={props.contextOpen}
            toggle={props.toggleContext}
          />
        </header>
        <div
          className="flex flex-1 flex-col overflow-y-auto p-24"
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
        >
          <div className="mx-auto flex w-full max-w-column flex-1 flex-col gap-10">
            {chat.items.length === 0 && !chat.draft && (
              <div className="m-auto flex max-w-420 flex-col items-center gap-4 p-24 text-center text-muted">
                <strong className="text-body font-semibold text-text">
                  Start a chat in <span className="font-mono">{chat.name}</span>
                </strong>
                <span>
                  Each message starts <span className="font-mono">{chat.engine}</span> in {folder ?? 'a scratch folder'}
                </span>
              </div>
            )}
            {chat.items.map((item, i) => (
              <m.div
                key={i}
                className={`group/item flex flex-col ${item.kind === 'user' ? 'mt-14 first:mt-0' : ''}`}
                initial={item.kind !== 'text' && enter}
                animate={MOTION.rise.animate}
              >
                <ItemView item={item} chat={chat} contextItems={props.contextItems} connected={connected} send={send} />
              </m.div>
            ))}
            {chat.draft && (
              <m.div initial={enter} animate={MOTION.rise.animate}>
                <Markdown className={`streaming ${ASSISTANT}`} text={chat.draft} />
              </m.div>
            )}
          </div>
        </div>
        <div className="relative shrink-0 px-24 pb-16">
          {archived && (
            <div className="mx-auto mb-8 flex max-w-column items-center gap-8 text-sm text-muted">
              <span className="flex-1">
                This {CHAT_NOUN.one} is archived. Its history stays; unarchive it to continue.
              </span>
              <Button size="small" disabled={!connected} onClick={unarchive}>
                Unarchive
              </Button>
            </div>
          )}
          {showEngineNote && (
            <div className="mx-auto flex max-w-column items-center gap-12 rounded-lg border border-dashed px-14 py-12 text-muted">
              <span className="flex-1">
                {noEngineOn ? (
                  'No engine is on. Turn one on in Settings to start chatting.'
                ) : (
                  <>
                    <span className="font-mono">{chat.engine}</span> is off. Pick another engine above, or turn it on in
                    Settings.
                  </>
                )}
              </span>
              <Button variant="primary" size="small" onClick={() => openSettings('engines')}>
                Open Settings
              </Button>
            </div>
          )}
          <AnimatePresence initial={false}>
            {chat.queue.length > 0 && (
              <m.div key="queue" {...MOTION.collapse}>
                <ul className="mx-auto mb-8 flex max-w-column flex-col text-sm" aria-label="Queued messages">
                  <AnimatePresence initial={false}>
                    {chat.queue.map((q) => (
                      <m.li key={q.id} {...MOTION.collapse}>
                        <div className="mb-4 flex items-center gap-8 rounded border border-dashed py-2 pr-4 pl-10 text-muted">
                          <span className="flex min-w-0 flex-1 items-center gap-6" title={q.text}>
                            {q.text && <span className="truncate">{q.text}</span>}
                            {q.attachments && (
                              <span className="flex min-w-0 shrink-0 items-center gap-4 text-faint last:shrink">
                                <PaperclipIcon />
                                <span className="truncate">{q.attachments.map((a) => a.name).join(', ')}</span>
                              </span>
                            )}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Remove from queue"
                            disabled={!connected}
                            onClick={() => send({ type: 'chat.unqueue', chatId: chat.id, id: q.id })}
                          >
                            ×
                          </Button>
                        </div>
                      </m.li>
                    ))}
                  </AnimatePresence>
                  <li className="text-sm text-faint">Sends when this turn ends</li>
                </ul>
              </m.div>
            )}
          </AnimatePresence>
          {!showEngineNote && (
            <div
              className={`@container mx-auto max-w-column rounded-lg border has-[textarea:focus]:border-accent ${canSend || canQueue ? 'bg-panel' : 'bg-bg'}`}
            >
              {pending.length > 0 && (
                <ul className="flex flex-wrap gap-6 px-8 pt-8" aria-label="Attachments">
                  {pending.map((p) => (
                    <li key={p.id} className="relative min-w-0">
                      {p.preview ? (
                        <img src={p.preview} alt={p.name} title={p.name} className="block size-48 rounded-lg border object-cover" />
                      ) : (
                        <div className={`${FILE_CHIP} h-48 bg-bg pr-20`} title={p.name}>
                          <FileLabel name={p.name} size={p.size} />
                        </div>
                      )}
                      <button
                        className="absolute -top-4 -right-4 grid size-18 place-items-center rounded-full border bg-raised text-[12px] leading-none text-muted hover:text-text"
                        aria-label={`Remove ${p.name}`}
                        title="Remove"
                        onClick={() => unattach([p])}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <textarea
                className="block max-h-[calc(12lh+16px)] min-h-[calc(2lh+16px)] w-full resize-none border-none bg-transparent px-12 py-8 text-body leading-[1.5] field-sizing-content"
                value={text}
                rows={2}
                placeholder={archived ? 'Archived' : PLACEHOLDERS[chat.status]}
                disabled={!(canSend || canQueue)}
                onChange={(e) => setText(e.target.value)}
                onPaste={(e) => {
                  const { types, files } = e.clipboardData
                  if (types.includes('text/plain') || !files.length) return
                  e.preventDefault()
                  void attach([...files])
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
                  e.preventDefault()
                  const emptyWithQueue = !hasContent && chat.queue.length > 0
                  if (busy && (e.metaKey || e.ctrlKey || emptyWithQueue)) interruptAndSend()
                  else submit()
                }}
              />
              <div className="flex items-center gap-8 px-6 pb-6">
                <span className="flex min-w-0 flex-1 items-center gap-6">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="grid shrink-0 place-items-center"
                    aria-label="Attach files"
                    title="Attach files, or paste or drop them here"
                    disabled={!canAttach}
                    onClick={() => fileInput.current?.click()}
                  >
                    <PaperclipIcon />
                  </Button>
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    hidden
                    onChange={(e) => {
                      void attach([...(e.target.files ?? [])])
                      e.target.value = ''
                    }}
                  />
                  <span className="@container min-w-0 flex-1">
                    <span className="block truncate text-sm text-faint @max-[8rem]:hidden" title={hint}>
                      {hint}
                    </span>
                  </span>
                </span>
                <span className="flex min-w-0 flex-wrap items-center justify-end gap-6">
                  {menu.model && (
                    <ChipSelect
                      aria-label="Model"
                      title={MODEL_HINT}
                      value={menu.model}
                      disabled={!canChange}
                      onChange={(e) => setModel(e.target.value, menu.thinking)}
                    >
                      {menu.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </ChipSelect>
                  )}
                  {menu.thinking && (
                    <ChipSelect
                      aria-label="Thinking"
                      title={THINKING_HINT}
                      value={menu.thinking}
                      disabled={!canChange}
                      onChange={(e) => setModel(menu.model, e.target.value)}
                    >
                      {menu.levels.map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                    </ChipSelect>
                  )}
                  {busy ? (
                    <>
                      {hasContent && (
                        <Button size="small" disabled={!canQueue} onClick={submit}>
                          Queue
                        </Button>
                      )}
                      <Button
                        variant="danger"
                        className={chat.status === 'stopping' ? 'enabled:animate-[blink_1.4s_ease-in-out_infinite]' : ''}
                        disabled={!connected}
                        title={chat.status === 'stopping' ? FORCE_STOP_HINT : undefined}
                        onClick={stop}
                      >
                        {chat.status === 'stopping' ? 'Stopping…' : 'Stop'}
                      </Button>
                    </>
                  ) : (
                    <Button variant="primary" disabled={!canSend || !hasContent} onClick={submit}>
                      Send
                    </Button>
                  )}
                </span>
              </div>
            </div>
          )}
          <input
            type="range"
            className={`absolute right-24 bottom-2 ${SLIDER}`}
            aria-label="Chat width"
            title="Chat width"
            {...columnSlider(props.columnPx, paneColumnPx)}
            onChange={(e) => props.setColumnPx(Number(e.target.value))}
          />
        </div>
      </main>
      <AnimatePresence initial={false}>
        {props.contextOpen && (
          <SidePanel key="context" side="right" overlay={props.contextOverlay}>
            <ContextPanel
              chatId={chat.id}
              items={props.contextItems}
              chats={props.chats}
              readOnly={archived}
              connected={connected}
              send={send}
            />
          </SidePanel>
        )}
      </AnimatePresence>
    </div>
  )
}
