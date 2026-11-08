import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from 'react'
import { AnimatePresence, m, useReducedMotion } from 'motion/react'
import { Dialog } from 'radix-ui'
import {
  editsAnywhere,
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
  type ToolKind,
  type Upload,
  type WorkFolder,
} from '@hotrod/core/shared'
import { attachmentUrl, coreUrl, readToken } from './connection.ts'
import { ContextPanel } from './context-panel.tsx'
import { usePathsShown } from './paths.ts'
import { useSmoothText } from './smooth.ts'
import { StepsOpen, useStepsShown } from './steps.ts'
import {
  Button,
  CHAT_NOUN,
  Chevron,
  confirm,
  CopyBlock,
  CopyButton,
  ErrorText,
  Hint,
  MOTION,
  PanelToggle,
  Select,
  SidePanel,
  useSettled,
} from './controls.tsx'
import { Markdown } from './markdown.tsx'
import type { SettingsPage } from './settings.tsx'
import {
  accountLabel,
  columnSlider,
  engineOptions,
  foldSteps,
  formatBytes,
  listedAccounts,
  MAX_PREVIEW_BYTES,
  modelMenu,
  pinState,
  previewText,
  type ChatView,
  type Item,
  type Permission,
} from './state.ts'

const MANAGE_ACCOUNTS = '__manage'
const SEND_HINT = 'Enter to send · Shift+Enter for a new line'
const QUEUE_HINT = 'Enter to queue · ⌘Enter to interrupt and send'
const INTERRUPT_SEND_TEXT = 'Interrupt and send now?'
const FORCE_STOP_HINT = 'Click Stopping… again to force stop'
const MODEL_HINT = 'Model'
const THINKING_HINT = 'Thinking level'
const INTERRUPTED = 'Interrupted'
const VERDICTS = { allowed: 'Allowed', denied: 'Denied', cancelled: 'Cancelled' }
const VERDICT_COLORS = { allowed: 'bg-green/10 text-green', denied: 'bg-red/10 text-red', cancelled: 'bg-raised text-muted' }
const AUTO_VERDICT_HINTS: Record<'allowed' | 'denied', Partial<Record<ToolKind, string>>> = {
  allowed: {
    edit: 'An edit inside the work folder, so Hotrod allowed it without asking',
    shell: 'A command in a sandboxed chat, so Hotrod ran it without asking',
  },
  denied: { edit: 'An edit outside the work folder, so Hotrod denied it without asking' },
}
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
  waiting: 'text-amber',
  error: 'text-red',
}
const WARNING_CHIP = 'shrink-0 cursor-help rounded-full bg-warning-bg px-8 py-2 text-xs text-amber'
const EDITS_ANYWHERE_HINT =
  'This chat runs without the work folder’s sandbox: its agents may edit files anywhere, asking you first. Turn ' +
  'it off in the Context panel.'
const EDITS_ANYWHERE_ALL_HINT =
  'Every chat runs without the work folder’s sandbox: agents may edit files anywhere, asking you first. Turn it ' +
  'off in Settings → Work folder.'
const NOT_SANDBOXED_HINT =
  'Hotrod can’t sandbox engines on this system yet, so a chat runs only with Edits anywhere on (in its Context ' +
  'panel, or for every chat in Settings → Work folder), and its agents can write anywhere.'
const BODY = 'max-h-320 overflow-y-auto py-8 pr-10 text-muted'
const SLIDER =
  'h-12 w-96 appearance-none border-0 bg-transparent p-0 opacity-35 transition-opacity duration-150 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent [&::-webkit-slider-runnable-track]:h-2 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-muted [&::-webkit-slider-thumb]:-mt-4 [&::-webkit-slider-thumb]:size-10 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-text'
const FILE_CHIP = 'flex max-w-200 min-w-0 items-center rounded-lg border px-10'
const FILE_ACTION =
  'rounded px-5 text-sm leading-[1.35] text-muted enabled:hover:bg-raised enabled:hover:text-text disabled:text-faint'
const REVEAL = 'opacity-0 transition-opacity duration-150 group-focus-within/file:opacity-100 group-hover/file:opacity-100'
const DOT_STAGGER_MS = 200
export const JUMP_BELOW_PX = 240
/** Within this of the bottom, the view follows new output down. */
export const FOLLOW_PX = 16

function Dots({ label, className = '' }: { label: string; className?: string }) {
  return (
    <span role="img" aria-label={label} className={`flex h-[1lh] shrink-0 items-center gap-4 ${className}`}>
      {[2, 1, 0].map((lag) => (
        <span
          key={lag}
          className="size-5 rounded-full bg-current animate-blink motion-reduce:animate-none"
          style={{ animationDelay: `-${lag * DOT_STAGGER_MS}ms` }}
        />
      ))}
    </span>
  )
}

function Row({ summary, quiet, children }: { summary: ReactNode; quiet?: boolean; children: ReactNode }) {
  // Follows the chat's steps setting until the user opens or closes this row.
  const opens = useContext(StepsOpen)
  const [chosen, setOpen] = useState<boolean>()
  const open = chosen ?? opens
  return (
    <div className={`rounded border ${quiet ? 'border-transparent text-muted' : 'bg-panel shadow-raised'}`}>
      <button
        className={`group flex h-28 w-full items-center gap-8 rounded pr-10 pl-8 text-left transition-colors hover:bg-raised ${quiet ? 'text-sm' : 'text-ui'}`}
        aria-expanded={open}
        data-open={open || undefined}
        onClick={() => setOpen(!open)}
      >
        <Chevron />
        {summary}
      </button>
      <AnimatePresence initial={false}>{open && <m.div {...MOTION.collapse}>{children}</m.div>}</AnimatePresence>
    </div>
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
          <button className={FILE_ACTION} aria-label={`Open ${name}`}>
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
                  className="fixed inset-0 m-auto flex size-fit max-h-[calc(100vh-32px)] max-w-[calc(100vw-32px)] min-w-[min(320px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border bg-panel shadow-overlay"
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
                          className="flex h-24 items-center rounded border bg-raised px-8 text-text shadow-raised hover:bg-hover active:shadow-sunken"
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
        <Hint text={pin === 'pinned' ? "Remove from this chat's context" : "Add to this chat's context, for every message"}>
          <button
            className={FILE_ACTION}
            disabled={!connected}
            aria-label={pin === 'pinned' ? `Unpin ${name}` : `Pin ${name}`}
            onClick={() =>
              send({ type: pin === 'pinned' ? 'context.remove' : 'context.add', chatId: chat.id, section: 'files', path })
            }
          >
            {pin === 'pinned' ? 'Unpin' : 'Pin'}
          </button>
        </Hint>
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
            className="block max-h-160 min-h-32 max-w-240 min-w-80 rounded-lg border object-contain shadow-raised"
          />
          <span className={`absolute top-4 right-4 flex rounded border bg-panel p-2 shadow-floating ${REVEAL}`}>{actions}</span>
        </>
      ) : (
        <div className={`${FILE_CHIP} h-40 bg-panel shadow-raised`} title={name}>
          <FileLabel name={name} size={size} actions={<span className={`-ml-5 flex ${REVEAL}`}>{actions}</span>} />
        </div>
      )}
      {pin === 'pinned' && (
        <Hint text="Pinned to this chat's context">
          <span
            className="absolute -top-6 -left-6 grid size-18 place-items-center rounded-full bg-accent text-on-accent"
            role="img"
            aria-label="Pinned to the context"
          >
            <PinIcon />
          </span>
        </Hint>
      )}
    </div>
  )
}

function Verdict({ permission: { outcome, auto, toolKind } }: { permission: Permission }) {
  if (outcome === 'pending') return null
  const hint = auto && outcome !== 'cancelled' ? AUTO_VERDICT_HINTS[outcome][toolKind] : undefined
  return (
    <Hint text={hint}>
      <span
        data-verdict
        className={`shrink-0 rounded-full px-6 text-xs leading-[1.6] ${VERDICT_COLORS[outcome]} ${hint ? 'cursor-help' : ''}`}
      >
        {auto && outcome === 'allowed' ? 'Allowed automatically' : VERDICTS[outcome]}
      </span>
    </Hint>
  )
}

type PromptProps = {
  permission: Permission
  chat: ChatView
  connected: boolean
  send: (m: ClientMessage) => void
}

function PermissionPrompt({ permission, chat, connected, send }: PromptProps) {
  const respond = (allow: boolean) =>
    send({ type: 'permission.respond', chatId: chat.id, requestId: permission.requestId, allow })
  return (
    <div className="flex flex-col gap-8 rounded-lg border border-l-3 border-permission-border border-l-amber bg-permission-bg px-14 py-12 shadow-raised">
      <div className="text-body">
        Allow <strong>{permission.name}</strong>?
      </div>
      <pre className="rounded border bg-bg px-10 py-8">{permission.summary}</pre>
      <details className="group">
        <summary className="flex w-fit list-none items-center gap-6 text-sm text-muted hover:text-text">
          <Chevron />
          Full input
        </summary>
        <pre className={`${BODY} mt-6 rounded border bg-bg pl-10`}>{JSON.stringify(permission.input, null, 2)}</pre>
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
            <div className="flex items-start gap-6">
              <CopyButton label="Copy message" text={item.text} className="mt-6" />
              <div className="min-w-0 rounded-[12px_12px_4px_12px] bg-raised px-12 py-8 text-body shadow-raised leading-[1.5] whitespace-pre-wrap [word-break:break-word]">
                {item.text}
              </div>
            </div>
          )}
        </div>
      )
    case 'text':
      return (
        <div className="flex flex-col gap-2">
          <Markdown className={ASSISTANT} text={item.text} />
          <CopyButton label="Copy reply" text={item.text} className="self-start" />
        </div>
      )
    case 'error':
      return item.text === INTERRUPTED ? (
        <div className="text-sm text-muted">{item.text}</div>
      ) : (
        <ErrorText>{item.text}</ErrorText>
      )
    case 'thinking':
      return (
        <Row quiet summary={<span className="italic">Thinking…</span>}>
          <div className="mt-2 mb-4 ml-13 max-h-320 overflow-y-auto border-l-2 pl-12 text-sm leading-[1.5] whitespace-pre-wrap">
            {item.text}
          </div>
        </Row>
      )
    case 'tool': {
      const row = (
        <Row
          summary={
            <>
              <span className={TOOL_NAME}>{item.name}</span>
              <span className={TOOL_INPUT}>{item.summary}</span>
              {item.permission && <Verdict permission={item.permission} />}
              {item.state === 'running' ? (
                <Dots label="running" className="text-sm text-green" />
              ) : (
                <span
                  className={`flex shrink-0 items-center gap-6 text-sm before:size-6 before:rounded-full before:bg-current ${TOOL_STATES[item.state] ?? 'text-faint'}`}
                >
                  {item.state === 'waiting' ? 'waiting for approval' : item.state}
                </span>
              )}
            </>
          }
        >
          <CopyBlock label="Copy output" text={item.output}>
            <pre className={`${BODY} border-t pl-26`}>
              {item.output ||
                (item.state === 'running' ? (
                  <Dots label="running" />
                ) : item.state === 'waiting' ? (
                  'Waiting for approval…'
                ) : (
                  'No output'
                ))}
            </pre>
          </CopyBlock>
        </Row>
      )
      if (item.permission?.outcome !== 'pending') return row
      return (
        <div className="flex flex-col gap-6">
          {row}
          <PermissionPrompt permission={item.permission} chat={chat} connected={connected} send={send} />
        </div>
      )
    }
    case 'permission':
      if (item.outcome === 'pending') {
        return <PermissionPrompt permission={item} chat={chat} connected={connected} send={send} />
      }
      return (
        <Row
          summary={
            <>
              <span className={TOOL_NAME}>{item.name}</span>
              <span className={TOOL_INPUT}>{item.summary}</span>
              <Verdict permission={item} />
            </>
          }
        >
          <CopyBlock label="Copy input" text={JSON.stringify(item.input, null, 2)}>
            <pre className={`${BODY} border-t pl-26`}>{JSON.stringify(item.input, null, 2)}</pre>
          </CopyBlock>
        </Row>
      )
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
  workFolder: WorkFolder
}

export function Chat(props: ChatProps) {
  const { chat, folder, engines, accounts, connected, send, openSettings, workFolder } = props
  const paths = usePathsShown()
  const listed = accounts && listedAccounts(accounts)
  const [text, setText] = useState('')
  const [pending, setPending] = useState<Pending[]>([])
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  const fileInput = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // True while the user is at the bottom: new output then scrolls into view. Scrolling up turns it off.
  const following = useRef(true)
  // True during a jump to the bottom, so the smooth scroll's own steps don't count as scrolling up.
  const jumping = useRef(false)
  const [jumpShown, setJumpShown] = useState(false)
  const reduceMotion = useReducedMotion()
  const stepsShown = useStepsShown(chat.id)
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
  }
  const userScrolls = () => {
    jumping.current = false
  }

  useLayoutEffect(follow, [chat.items, chat.status, chat.draft])

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list || !contentRef.current) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) if (entry.target === list) setPaneColumnPx(entry.contentRect.width)
      follow()
    })
    observer.observe(list)
    observer.observe(contentRef.current)
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
  const working = busy && !archived && !text
  const asking = chat.status === 'waiting'
  const canQueue = connected && busy && !archived
  const viewOnly = !!chat.subagent
  const showEngineNote = engineOff && !archived && chat.status === 'idle' && !viewOnly
  const last = chat.items.at(-1)
  const awaitingOutput = chat.status === 'running' && !chat.draft && !(last?.kind === 'tool' && last.state === 'running')
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
    following.current = true
    toBottom()
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
  const itemProps = { chat, contextItems: props.contextItems, connected, send }

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
            <Hint text={!chat.mod && !paths.header && (folder ?? 'Not tied to a folder')} side="bottom" align="start">
              <span className="max-w-[50%] shrink-0 truncate font-semibold max-[900px]:max-w-full">{chat.name}</span>
            </Hint>
            {!chat.mod && paths.header && (
              <span className="min-w-0 truncate font-mono text-sm leading-[normal] text-faint max-[900px]:hidden">
                {folder ?? 'Not tied to a folder'}
              </span>
            )}
          </div>
          {(editsAnywhere(chat, workFolder) || !workFolder.canSandbox) && (
            <Hint
              text={
                !workFolder.canSandbox
                  ? NOT_SANDBOXED_HINT
                  : chat.editAnywhere === undefined
                    ? EDITS_ANYWHERE_ALL_HINT
                    : EDITS_ANYWHERE_HINT
              }
            >
              <span className={WARNING_CHIP}>{workFolder.canSandbox ? 'Edits anywhere' : 'Not sandboxed'}</span>
            </Hint>
          )}
          <Select
            variant="chip"
            label="Engine"
            value={chat.engine}
            disabled={!canChange}
            options={engineOptions(engines, chat.engine).map((o) => ({ ...o, value: o.id }))}
            onChange={(engine) => send({ type: 'chat.setEngine', chatId: chat.id, engine })}
          />
          {accounts && listed && !engineOff && (
            <Select
              variant="chip"
              label="Account"
              value={listed.active}
              disabled={!canSend}
              options={[
                ...listed.accounts.map((a) => ({ value: a.id, label: accountLabel(a) })),
                { value: MANAGE_ACCOUNTS, label: 'Manage accounts…' },
              ]}
              onChange={(accountId) =>
                accountId === MANAGE_ACCOUNTS
                  ? openSettings('accounts')
                  : send({ type: 'account.use', engine: accounts.engine, accountId })
              }
            />
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
          // Chrome's scroll anchoring would otherwise drag the view along with output added near the bottom.
          className="flex flex-1 flex-col overflow-y-auto p-24 [overflow-anchor:none]"
          ref={listRef}
          onScroll={scrolled}
          onWheel={userScrolls}
          onTouchStart={userScrolls}
          onKeyDown={userScrolls}
        >
          <div className="mx-auto flex w-full max-w-column flex-1 flex-col gap-10" ref={contentRef}>
            <StepsOpen.Provider value={stepsShown}>
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
              {foldSteps(chat.items, stepsShown).map((row) => {
                const kind = 'item' in row ? row.item.kind : 'steps'
                return (
                  <m.div
                    key={kind === 'steps' ? `steps-${row.at}` : row.at}
                    className={`group/item flex flex-col ${kind === 'user' ? 'mt-14 first:mt-0' : ''}`}
                    initial={kind !== 'text' && enter}
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
                      <ItemView item={row.item} {...itemProps} />
                    )}
                  </m.div>
                )
              })}
              {chat.draft && (
                <m.div initial={enter} animate={MOTION.rise.animate}>
                  <StreamingText text={chat.draft} smooth={!reduceMotion} />
                </m.div>
              )}
              {awaitingOutput && (
                <m.div className="text-body leading-[1.6] text-muted" initial={MOTION.fade.initial} animate={MOTION.fade.animate}>
                  <Dots label="Working" />
                </m.div>
              )}
            </StepsOpen.Provider>
          </div>
        </div>
        <div className="relative shrink-0 px-24 pb-16">
          <div className="pointer-events-none absolute inset-x-24 bottom-full mx-auto flex max-w-column justify-end pb-12">
            <AnimatePresence>
              {jumpShown && (
                <Hint key="jump" text={asking ? 'A permission request is waiting below' : 'Jump to the latest output'}>
                  <m.button
                    className={`pointer-events-auto grid size-32 place-items-center rounded-full border shadow-floating transition-colors ${
                      asking
                        ? 'border-amber bg-warning-bg text-amber hover:bg-raised'
                        : 'bg-panel text-muted hover:bg-raised hover:text-text'
                    }`}
                    aria-label={asking ? 'Scroll to the permission request' : 'Scroll to bottom'}
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
          {viewOnly && !archived && (
            <div
              className="mx-auto flex max-w-column items-center gap-12 rounded-lg border border-dashed px-14 py-10 text-muted"
              aria-label="Subagent"
            >
              <span className="min-w-0 flex-1 truncate">
                Subagent of {props.chats.find((c) => c.id === chat.parentId)?.name ?? 'another chat'} · view only
              </span>
              {busy && (
                <Hint text={chat.status === 'stopping' && FORCE_STOP_HINT}>
                  <Button
                    variant="danger"
                    size="small"
                    className={chat.status === 'stopping' ? 'enabled:animate-[blink_1.4s_ease-in-out_infinite]' : ''}
                    disabled={!connected}
                    onClick={stop}
                  >
                    {chat.status === 'stopping' ? 'Stopping…' : 'Stop'}
                  </Button>
                </Hint>
              )}
            </div>
          )}
          {!showEngineNote && !viewOnly && (
            <div
              className={`@container mx-auto max-w-column rounded-lg border transition-[border-color,box-shadow] has-[textarea:focus]:border-accent ${canSend || canQueue ? 'bg-panel shadow-raised has-[textarea:focus]:shadow-floating' : 'bg-bg'}`}
            >
              {pending.length > 0 && (
                <ul className="flex flex-wrap gap-6 px-8 pt-8" aria-label="Attachments">
                  {pending.map((p) => (
                    <li key={p.id} className="relative min-w-0">
                      {p.preview ? (
                        <img
                          src={p.preview}
                          alt={p.name}
                          title={p.name}
                          className="block size-48 rounded-lg border object-cover shadow-raised"
                        />
                      ) : (
                        <div className={`${FILE_CHIP} h-48 bg-bg pr-20 shadow-raised`} title={p.name}>
                          <FileLabel name={p.name} size={p.size} />
                        </div>
                      )}
                      <Hint text="Remove">
                        <button
                          className="absolute -top-4 -right-4 grid size-18 place-items-center rounded-full border bg-raised text-[12px] leading-none text-muted shadow-raised hover:text-text"
                          aria-label={`Remove ${p.name}`}
                          onClick={() => unattach([p])}
                        >
                          ×
                        </button>
                      </Hint>
                    </li>
                  ))}
                </ul>
              )}
              <div className="relative">
                {working && (
                  <span
                    className="shimmer pointer-events-none absolute inset-x-12 top-8 truncate text-body leading-[1.5]"
                    data-status={chat.status}
                    aria-hidden="true"
                  >
                    {PLACEHOLDERS[chat.status]}
                  </span>
                )}
                <textarea
                  className="block max-h-[calc(12lh+16px)] min-h-[calc(2lh+16px)] w-full resize-none border-none bg-transparent px-12 shadow-none py-8 text-body leading-[1.5] field-sizing-content"
                  value={text}
                  rows={2}
                  placeholder={working ? undefined : archived ? 'Archived' : PLACEHOLDERS[chat.status]}
                  aria-placeholder={working ? PLACEHOLDERS[chat.status] : undefined}
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
              </div>
              <div className="flex items-center gap-8 px-6 pb-6">
                <span className="flex min-w-0 flex-1 items-center gap-6">
                  <Hint text="Attach files">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="grid shrink-0 place-items-center"
                      aria-label="Attach files"
                      disabled={!canAttach}
                      onClick={() => fileInput.current?.click()}
                    >
                      <PaperclipIcon />
                    </Button>
                  </Hint>
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
                </span>
                <span className="flex min-w-0 flex-wrap items-center justify-end gap-6">
                  {menu.model && (
                    <Select
                      variant="chip"
                      label="Model"
                      hint={MODEL_HINT}
                      value={menu.model}
                      disabled={!canChange}
                      options={menu.models.map((m) => ({ value: m.id, label: m.label }))}
                      onChange={(model) => setModel(model, menu.thinking)}
                    />
                  )}
                  {menu.thinking && (
                    <Select
                      variant="chip"
                      label="Thinking"
                      hint={THINKING_HINT}
                      value={menu.thinking}
                      disabled={!canChange}
                      options={menu.levels.map((l) => ({ value: l, label: l }))}
                      onChange={(thinking) => setModel(menu.model, thinking)}
                    />
                  )}
                  {busy ? (
                    <>
                      {hasContent && (
                        <Hint text={QUEUE_HINT}>
                          <Button size="small" disabled={!canQueue} onClick={submit}>
                            Queue
                          </Button>
                        </Hint>
                      )}
                      <Hint text={chat.status === 'stopping' && FORCE_STOP_HINT}>
                        <Button
                          variant="danger"
                          className={chat.status === 'stopping' ? 'enabled:animate-[blink_1.4s_ease-in-out_infinite]' : ''}
                          disabled={!connected}
                          onClick={stop}
                        >
                          {chat.status === 'stopping' ? 'Stopping…' : 'Stop'}
                        </Button>
                      </Hint>
                    </>
                  ) : (
                    <Hint text={SEND_HINT}>
                      <span className="flex">
                        <Button
                          variant="primary"
                          className="disabled:pointer-events-none"
                          disabled={!canSend || !hasContent}
                          onClick={submit}
                        >
                          Send
                        </Button>
                      </span>
                    </Hint>
                  )}
                </span>
              </div>
            </div>
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
        {props.contextOpen && (
          <SidePanel key="context" side="right" overlay={props.contextOverlay}>
            <ContextPanel
              chatId={chat.id}
              items={props.contextItems}
              chats={props.chats}
              workFolder={workFolder}
              readOnly={archived}
              connected={connected}
              send={send}
              hide={props.contextOverlay ? props.toggleContext : undefined}
            />
          </SidePanel>
        )}
      </AnimatePresence>
    </div>
  )
}

/** The reply as it streams in, revealed smoothly rather than in the bursts the engine sends. */
function StreamingText(props: { text: string; smooth: boolean }) {
  const text = useSmoothText(props.text, props.smooth)
  return <Markdown className={`streaming ${ASSISTANT}`} text={text} />
}
