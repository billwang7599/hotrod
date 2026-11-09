import {
  Fragment,
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
  levelsOf,
  ROLE_NAMES,
  THINKING_LABELS,
  type ThinkingLevel,
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
import { choosePanelTab, modTabId } from './panel-tab.ts'
import { usePathsShown } from './paths.ts'
import { draftOf, flushDrafts, saveDraft, saveDraftSoon } from './drafts.ts'
import { useReveal, type RevealFrom } from './smooth.ts'
import {
  openReportCard,
  reportCardKey,
  ReportsOpen,
  StepsOpen,
  useReportCardChoice,
  useReportsShown,
  useStepsShown,
} from './steps.ts'
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
  engineName,
  fromModelKey,
  foldSteps,
  formatBytes,
  listedAccounts,
  MAX_PREVIEW_BYTES,
  modelKey,
  modelMenu,
  pinState,
  previewText,
  type ChatView,
  type Item,
  type Permission,
  type State,
  lineOf,
  subagentRequests,
} from './state.ts'

const MANAGE_ACCOUNTS = '__manage'
const SEND_HINT = 'Enter to send · Shift+Enter for a new line'
const QUEUE_HINT = 'Enter to queue · ⌘Enter to interrupt and send'
const STEER_HINT = 'Enter steers it in at the next step · ⌥Enter queues · ⌘Enter interrupts and sends'
const INTERRUPT_SEND_TEXT = 'Interrupt and send now?'
const FORCE_STOP_HINT = 'Click Stopping… again to force stop'
const MODEL_HINT = 'Model'
const THINKING_HINT = 'Thinking level'
const INTERRUPTED = 'Interrupted'
const VERDICTS = { allowed: 'Allowed', denied: 'Denied', cancelled: 'Cancelled' }
const PILL = 'shrink-0 rounded-full px-6 text-xs leading-[1.6]'
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
const ANSWER_PLACEHOLDER = 'Waiting for your answer… Enter queues a message'
// When the engine can steer, Enter hands a message to the running turn and ⌥Enter queues it.
const STEER_PLACEHOLDERS: Partial<Record<ChatStatus, string>> = {
  running: 'Working… Enter steers · ⌥Enter queues',
  waiting: 'Waiting for your approval… Enter steers · ⌥Enter queues',
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

/** How a streamed text is named across elements and where it starts typing; undefined shows it whole. */
type RevealOf = (item: Item) => { key: string; from: RevealFrom } | undefined

type RevealedProps = { item: Item & { text: string }; revealOf?: RevealOf; children: (text: string) => ReactNode }

/** A reply or thinking text, typed out while it arrives live. */
function Revealed({ item, revealOf, children }: RevealedProps) {
  const reveal = revealOf?.(item)
  return children(useReveal(reveal?.key ?? '', item.text, reveal?.from ?? 'none', !!reveal))
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
      <span data-verdict className={`${PILL} ${VERDICT_COLORS[outcome]} ${hint ? 'cursor-help' : ''}`}>
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
  // Set in a subagent's own view: its requests are answered in this chat, its space, not here.
  space?: ChatView
  select?: (chatId: string) => void
  // Set in a space, on the requests of a subagent below it.
  fromSubagent?: boolean
}

function PermissionPrompt({ permission, chat, connected, send, space, select, fromSubagent }: PromptProps) {
  const respond = (allow: boolean) =>
    send({ type: 'permission.respond', chatId: chat.id, requestId: permission.requestId, allow })
  return (
    <div
      className="flex flex-col gap-8 rounded-lg border border-l-3 border-permission-border border-l-amber bg-permission-bg px-14 py-12 shadow-raised"
      aria-label={fromSubagent ? `Request from subagent ${chat.name}` : undefined}
    >
      <div className="text-body">
        {fromSubagent ? (
          <>
            Subagent <strong>{chat.name}</strong> wants to run <strong>{permission.name}</strong>
          </>
        ) : (
          <>
            Allow <strong>{permission.name}</strong>?
          </>
        )}
      </div>
      <pre className="rounded border bg-bg px-10 py-8">{permission.summary}</pre>
      <details className="group">
        <summary className="flex w-fit list-none items-center gap-6 text-sm text-muted hover:text-text">
          <Chevron />
          Full input
        </summary>
        <pre className={`${BODY} mt-6 rounded border bg-bg pl-10`}>{JSON.stringify(permission.input, null, 2)}</pre>
      </details>
      {space && chat.status === 'waiting' ? (
        <div className="flex items-center gap-8 text-sm text-muted" data-waiting-in={space.id}>
          <span className="flex-1">Waiting for approval in {space.name}</span>
          {select && (
            <Button size="small" onClick={() => select(space.id)}>
              Go to {space.name}
            </Button>
          )}
        </div>
      ) : chat.status === 'waiting' ? (
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

type QuestionItem = Extract<Item, { kind: 'question' }>

function ChoiceMark({ multi, on }: { multi: boolean; on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-2 grid size-14 shrink-0 place-items-center border transition-colors ${multi ? 'rounded-sm' : 'rounded-full'} ${on ? 'border-accent bg-accent text-on-accent' : 'bg-panel shadow-sunken'}`}
    >
      {on &&
        (multi ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
            <path d="M2 5.2 4.2 7.4 8 3" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <span className="size-6 rounded-full bg-current" />
        ))}
    </span>
  )
}

function QuestionCard({ item, chat, connected, send }: { item: QuestionItem } & Omit<PromptProps, 'permission'>) {
  const { questions } = item
  const [shown, setShown] = useState(0)
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []))
  // Undefined while Other isn't chosen; the text typed once it is.
  const [typed, setTyped] = useState<(string | undefined)[]>(() => questions.map(() => undefined))
  const [sent, setSent] = useState(false)
  if (sent && !connected) setSent(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const asking = chat.status === 'waiting'
  const live = asking && connected && !sent
  const question = questions[shown]!
  const otherAt = question.options.length
  const answerOf = (i: number) => {
    const other = typed[i]?.trim()
    const labels = questions[i]!.options.flatMap((o) => (picked[i]!.includes(o.label) ? [o.label] : []))
    return other ? [...labels, other] : labels
  }
  const firstOpen = questions.findIndex((_, i) => answerOf(i).length === 0)

  const choose = (n: number) => {
    const mine = picked[shown]!
    if (n === otherAt) {
      setTyped(typed.with(shown, typed[shown] === undefined ? '' : undefined))
      if (!question.multiSelect) setPicked(picked.with(shown, []))
      return
    }
    const { label } = question.options[n]!
    if (question.multiSelect) {
      setPicked(picked.with(shown, mine.includes(label) ? mine.filter((l) => l !== label) : [...mine, label]))
      return
    }
    setPicked(picked.with(shown, [label]))
    setTyped(typed.with(shown, undefined))
    if (shown + 1 < questions.length) setShown(shown + 1)
  }
  const submit = () => {
    if (!live) return
    if (firstOpen >= 0) return setShown(firstOpen)
    const answers = Object.fromEntries(questions.map((q, i) => [q.question, answerOf(i)]))
    setSent(true)
    send({ type: 'question.respond', chatId: chat.id, requestId: item.requestId, answers })
  }
  const skip = () => {
    setSent(true)
    send({ type: 'question.respond', chatId: chat.id, requestId: item.requestId })
  }

  useEffect(() => {
    if (!live) return
    // Keys count while nothing else has focus, so the card answers without being clicked first.
    const onKey = (e: KeyboardEvent) => {
      const card = cardRef.current
      const focus = document.activeElement
      if (!card || e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return
      if (focus && focus !== document.body && !card.contains(focus)) return
      const typing = e.target instanceof HTMLInputElement
      if (e.key === 'Enter') {
        if (!typing && e.target instanceof Element && e.target.closest('[data-action]')) return
        e.preventDefault()
        return submit()
      }
      if (typing) return
      const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
      if (step && questions[shown + step]) {
        e.preventDefault()
        return setShown(shown + step)
      }
      if (!/^[1-9]$/.test(e.key) || Number(e.key) > otherAt + 1) return
      e.preventDefault()
      choose(Number(e.key) - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const choices = [...question.options, { label: 'Other…', description: '' }]
  return (
    <div
      ref={cardRef}
      role="group"
      aria-label="Question"
      className="flex flex-col gap-10 rounded-lg border border-l-3 border-l-accent bg-panel px-14 py-12 shadow-raised"
    >
      {questions.length > 1 && (
        <div role="tablist" aria-label="Questions" className="-mx-6 -mt-2 flex flex-wrap gap-2">
          {questions.map((q, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === shown}
              className="flex items-center gap-4 rounded px-6 py-2 text-sm font-semibold text-muted transition-[background-color,color] hover:bg-hover hover:text-text aria-selected:bg-hover aria-selected:text-text"
              onClick={() => setShown(i)}
            >
              {answerOf(i).length > 0 && (
                <span className="text-green" aria-hidden="true">
                  ✓
                </span>
              )}
              {q.header}
            </button>
          ))}
        </div>
      )}
      <div className="text-body leading-[1.5]">{question.question}</div>
      <div
        role={question.multiSelect ? 'group' : 'radiogroup'}
        aria-label={question.header}
        className="flex flex-col overflow-hidden rounded border bg-bg"
      >
        {choices.map((choice, n) => {
          const other = n === otherAt
          const on = other ? typed[shown] !== undefined : picked[shown]!.includes(choice.label)
          return (
            <button
              key={n}
              type="button"
              role={question.multiSelect ? 'checkbox' : 'radio'}
              aria-checked={on}
              data-label={other ? 'Other' : choice.label}
              disabled={!live}
              className="flex w-full items-start gap-10 border-t px-10 py-8 text-left transition-colors first:border-t-0 enabled:hover:bg-raised aria-checked:bg-accent/8 disabled:text-muted"
              onClick={() => choose(n)}
            >
              <ChoiceMark multi={question.multiSelect} on={on} />
              <span className="flex min-w-0 flex-1 flex-col gap-1 leading-[1.4]">
                <strong className={`font-semibold ${other && !on ? 'text-muted' : ''}`}>{choice.label}</strong>
                {choice.description && <span className="text-sm text-muted">{choice.description}</span>}
              </span>
              <kbd className="mt-1 shrink-0 rounded-sm border px-4 font-mono text-xs leading-[1.5] text-faint">{n + 1}</kbd>
            </button>
          )
        })}
        {typed[shown] !== undefined && (
          <div className="border-t px-10 py-8">
            <input
              key={shown}
              autoFocus
              aria-label="Other answer"
              placeholder="Your answer"
              className="w-full"
              value={typed[shown]}
              disabled={!live}
              onChange={(e) => setTyped(typed.with(shown, e.target.value))}
            />
          </div>
        )}
      </div>
      {asking ? (
        <div className="flex items-center gap-8">
          <Hint text={`Enter to submit · 1–${otherAt + 1} to pick${questions.length > 1 ? ' · ←→ switch questions' : ''}`}>
            <span className="flex">
              <Button
                variant="primary"
                data-action
                className="disabled:pointer-events-none"
                disabled={!live || firstOpen >= 0}
                onClick={submit}
              >
                Submit
              </Button>
            </span>
          </Hint>
          <Hint text="Tell the agent you'd rather not answer">
            <Button variant="ghost" data-action disabled={!connected || sent} onClick={skip}>
              Skip
            </Button>
          </Hint>
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
  space?: ChatView
  select?: (chatId: string) => void
  // Opens a chat that still exists, for a subagent's report.
  openChat?: (chatId: string) => (() => void) | undefined
  revealOf?: RevealOf
  // Opens a mod's panel in the right sidebar, for a mod's note.
  openPanel?: (mod: string, panel: string) => void
  // The item's index in the chat, for choices kept per item (a report card's fold).
  at?: number
}

type Report = Extract<Item, { kind: 'report' }>

/** A subagent's report: unfolded or folded by the chat's setting until the user opens or closes it. */
function ReportCard({ item, chatId, at, open }: { item: Report; chatId: string; at?: number; open?: () => void }) {
  const opens = useContext(ReportsOpen)
  const key = at === undefined ? undefined : reportCardKey(chatId, at)
  const chosen = useReportCardChoice(key ?? '')
  const [local, setLocal] = useState<boolean>()
  const shown = (key ? chosen : local) ?? opens
  const toggle = () => (key ? openReportCard(key, !shown) : setLocal(!shown))
  const name = open ? (
    <button type="button" className="font-medium text-text hover:underline" onClick={open}>
      {item.name}
    </button>
  ) : (
    <span className="font-medium text-text">{item.name}</span>
  )
  const preview = item.text.split('\n').find((l) => l.trim())?.replace(/[*_`#>]/g, '').trim() || 'No reply'
  return (
    <section aria-label={`Report from subagent ${item.name}`} className="flex flex-col gap-4 border-l-2 pl-12">
      <div className="flex min-w-0 items-center gap-6 text-sm text-muted">
        <button
          type="button"
          className="group -ml-4 flex h-20 items-center rounded px-4 hover:bg-raised"
          aria-label={shown ? 'Fold report' : 'Unfold report'}
          aria-expanded={shown}
          data-open={shown || undefined}
          onClick={toggle}
        >
          <Chevron />
        </button>
        {/* Wraps instead of holding its width: a long name or error would otherwise push the chat sideways. */}
        <span className="min-w-0 [overflow-wrap:anywhere]">
          Subagent {name} reported
          {item.error && <span> · ended early: {item.error}</span>}
        </span>
        {!shown && (
          <button type="button" className="min-w-0 truncate text-left text-faint hover:text-muted" onClick={toggle}>
            {preview}
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {shown && (
          <m.div {...MOTION.collapse}>
            {item.text ? (
              <Markdown className={ASSISTANT} text={item.text} />
            ) : (
              <div className="text-sm text-muted">No reply</div>
            )}
          </m.div>
        )}
      </AnimatePresence>
    </section>
  )
}

function ItemView(props: ItemProps) {
  const { item, chat, contextItems, connected, send, space, select, openChat, revealOf, openPanel } = props
  const promptProps = { chat, connected, send, space, select }
  switch (item.kind) {
    case 'report':
      return <ReportCard item={item} chatId={chat.id} at={props.at} open={openChat?.(item.chatId)} />
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
          {item.midTurn && <span className="text-xs text-faint">Sent mid-turn</span>}
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
          <Revealed item={item} revealOf={revealOf}>
            {(text) => <Markdown className={ASSISTANT} text={text} />}
          </Revealed>
          <CopyButton label="Copy reply" text={item.text} className="self-start" />
        </div>
      )
    case 'error':
      return item.text === INTERRUPTED ? (
        <div className="text-sm text-muted">{item.text}</div>
      ) : (
        <ErrorText>{item.text}</ErrorText>
      )
    case 'note': {
      const { mod, panel } = item
      if (!mod || !panel || !openPanel) return <div className="text-sm text-muted">{item.text}</div>
      return (
        <button
          className="w-fit text-left text-sm text-muted underline decoration-faint underline-offset-2 hover:text-text"
          onClick={() => openPanel(mod, panel)}
        >
          {item.text}
        </button>
      )
    }
    case 'thinking':
      return (
        <Row quiet summary={<span className="italic">Thinking…</span>}>
          <div className="mt-2 mb-4 ml-13 max-h-320 overflow-y-auto border-l-2 pl-12 text-sm leading-[1.5] whitespace-pre-wrap">
            <Revealed item={item} revealOf={revealOf}>
              {(text) => text}
            </Revealed>
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
          <PermissionPrompt permission={item.permission} {...promptProps} />
        </div>
      )
    }
    case 'question': {
      if (item.outcome === 'pending') {
        return <QuestionCard key={item.requestId} item={item} chat={chat} connected={connected} send={send} />
      }
      const answerOf = (question: string) => item.answers?.[question]?.join(', ')
      return (
        <Row
          summary={
            <>
              <span className="min-w-0 flex-1 truncate">
                {item.questions.map((q, i) => (
                  <Fragment key={i}>
                    {i > 0 && <span className="text-faint"> · </span>}
                    <span className="font-semibold">{q.header}</span>
                    {item.outcome === 'answered' && (
                      <>
                        <span className="text-faint"> → </span>
                        {answerOf(q.question)}
                      </>
                    )}
                  </Fragment>
                ))}
              </span>
              {item.outcome !== 'answered' && (
                <span data-verdict className={`${PILL} ${VERDICT_COLORS.cancelled}`}>
                  {item.outcome === 'skipped' ? 'Skipped' : VERDICTS.cancelled}
                </span>
              )}
            </>
          }
        >
          <div className={`${BODY} flex flex-col gap-6 border-t pl-26`}>
            {item.questions.map((q, i) => (
              <div key={i}>
                <div>{q.question}</div>
                <div className="text-text">{answerOf(q.question) ?? '—'}</div>
              </div>
            ))}
          </div>
        </Row>
      )
    }
    case 'permission':
      if (item.outcome === 'pending') {
        return <PermissionPrompt permission={item} {...promptProps} />
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
  modUi?: State['modUi']
  panelViews?: State['panelViews']
  contextDefaults: Record<ContextSection, boolean>
  modelLists?: ModelLists
  columnPx: number
  setColumnPx: (px: number) => void
  notify: (message: string) => void
  workFolder: WorkFolder
  select?: (chatId: string) => void
}

export function Chat(props: ChatProps) {
  const { chat, folder, engines, accounts, connected, send, openSettings, workFolder } = props
  const paths = usePathsShown()
  const listed = accounts && listedAccounts(accounts)
  const [pending, setPending] = useState<Pending[]>([])
  const pendingRef = useRef(pending)
  pendingRef.current = pending
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
  const line = lineOf(props.chats, chat)
  const space = line.at(-1)!
  const stepsShown = useStepsShown(chat.id, ...line.slice(1).map((c) => c.id))
  const reportsShown = useReportsShown(chat.id, ...line.slice(1).map((c) => c.id))
  const viewOnly = !!chat.subagent
  // Subagents never ask in their own view: their requests wait in the space above them.
  const requests = viewOnly ? [] : subagentRequests(props.chats, chat.id)
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

  useLayoutEffect(follow, [chat.items, chat.status, chat.draft, requests.length])

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
  const menu = modelMenu(chat, engines, props.modelLists)
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
  // A chat's nth reply keeps one name from draft to finished item, so its reveal carries over. Texts already there when
  // the chat was opened show whole; ones that arrive while it's open type out.
  const replyNumbers = new Map<Item, number>()
  const thoughtNumbers = new Map<Item, number>()
  for (const i of chat.items) {
    if (i.kind === 'text') replyNumbers.set(i, replyNumbers.size)
    else if (i.kind === 'thinking') thoughtNumbers.set(i, thoughtNumbers.size)
  }
  const draftKey = `${chat.id}:text:${replyNumbers.size}`
  const opened = useRef({ chatId: '', texts: 0, thoughts: 0, draftKey: '' })
  if (opened.current.chatId !== chat.id) {
    const [texts, thoughts] = [replyNumbers.size, thoughtNumbers.size]
    opened.current = { chatId: chat.id, texts, thoughts, draftKey: chat.draft ? draftKey : '' }
  }
  // A finished turn drops its thinking, so the next turn's thoughts count from zero again.
  opened.current.thoughts = Math.min(opened.current.thoughts, thoughtNumbers.size)
  const revealOf: RevealOf = (item) => {
    const reply = replyNumbers.get(item)
    if (reply !== undefined)
      return { key: `${chat.id}:text:${reply}`, from: reply >= opened.current.texts ? 'start' : 'none' }
    const thought = thoughtNumbers.get(item)
    if (thought === undefined) return undefined
    return { key: `${chat.id}:thinking:${thought}`, from: thought >= opened.current.thoughts ? 'start' : 'end' }
  }
  const draftFrom: RevealFrom = draftKey === opened.current.draftKey ? 'end' : 'start'
  const itemProps = {
    chat,
    ...(!reduceMotion && { revealOf }),
    contextItems: props.contextItems,
    connected,
    send,
    ...(viewOnly && space !== chat && { space, select: props.select }),
    openChat: (chatId: string) => {
      const select = props.select
      return select && props.chats.some((c) => c.id === chatId) ? () => select(chatId) : undefined
    },
    openPanel: (mod: string, panel: string) => {
      choosePanelTab(modTabId(mod, panel))
      if (!props.contextOpen) props.toggleContext()
    },
  }

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
          {(editsAnywhere(...line, workFolder) || !workFolder.canSandbox) && (
            <Hint
              text={
                !workFolder.canSandbox
                  ? NOT_SANDBOXED_HINT
                  : line.every((c) => c.editAnywhere === undefined)
                    ? EDITS_ANYWHERE_ALL_HINT
                    : EDITS_ANYWHERE_HINT
              }
            >
              <span className={WARNING_CHIP}>{workFolder.canSandbox ? 'Edits anywhere' : 'Not sandboxed'}</span>
            </Hint>
          )}
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
                {foldSteps(chat.items, stepsShown).map((row) => {
                  const kind = 'item' in row ? row.item.kind : 'steps'
                  return (
                    <m.div
                      key={kind === 'steps' ? `steps-${row.at}` : row.at}
                      className={`group/item flex flex-col ${kind === 'user' || kind === 'report' ? 'mt-14 first:mt-0' : ''}`}
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
                {noEngineOn
                  ? 'No engine is on. Turn one on in Settings to start chatting.'
                  : chat.model
                    ? `${chat.model} on ${engineName(offers) || chat.engine} can't run: ${offers?.enabled ? 'the engine no longer offers it' : 'the engine is off or gone'}. Pick another model, or go back to the models in Settings.`
                    : `Nothing in the ${chat.role && props.modelLists?.[chat.role]?.length ? ROLE_NAMES[chat.role] : 'Chat'} model list can run. Add a model, or turn its engine on, in Settings.`}
              </span>
              {chat.model && !noEngineOn && (
                <Button size="small" disabled={!connected} onClick={() => send({ type: 'chat.setModel', chatId: chat.id })}>
                  Use Settings' models
                </Button>
              )}
              <Button variant="primary" size="small" onClick={() => openSettings(noEngineOn ? 'engines' : 'models')}>
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
                            {q.steering && <span className="shrink-0 text-faint">At the next step:</span>}
                            {q.report && <span className="shrink-0 text-faint">Subagent {q.report.name} reported:</span>}
                            {q.text && <span className="truncate">{q.text}</span>}
                            {q.attachments && (
                              <span className="flex min-w-0 shrink-0 items-center gap-4 text-faint last:shrink">
                                <PaperclipIcon />
                                <span className="truncate">{q.attachments.map((a) => a.name).join(', ')}</span>
                              </span>
                            )}
                          </span>
                          {!q.steering && (
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="Remove from queue"
                              disabled={!connected}
                              onClick={() => send({ type: 'chat.unqueue', chatId: chat.id, id: q.id })}
                            >
                              ×
                            </Button>
                          )}
                        </div>
                      </m.li>
                    ))}
                  </AnimatePresence>
                  {chat.queue.some((q) => !q.steering) && <li className="text-sm text-faint">Sends when this turn ends</li>}
                </ul>
              </m.div>
            )}
          </AnimatePresence>
          {requests.length > 0 && (
            <ul
              className="mx-auto mb-8 flex max-h-[50vh] max-w-column flex-col gap-8 overflow-y-auto"
              aria-label="Subagent requests"
            >
              {requests.map(({ chat: below, permission }) => (
                <li key={`${below.id}-${permission.requestId}`}>
                  <PermissionPrompt permission={permission} chat={below} connected={connected} send={send} fromSubagent />
                </li>
              ))}
            </ul>
          )}
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
              modUi={props.modUi}
              panelViews={props.panelViews}
            />
          </SidePanel>
        )}
      </AnimatePresence>
    </div>
  )
}

type ComposerProps = {
  chat: ChatView
  connected: boolean
  pending: Pending[]
  unattach: (removed: Pending[]) => void
  attach: (files: File[]) => Promise<void>
  canSend: boolean
  canQueue: boolean
  canChange: boolean
  steers: boolean
  placeholder: string
  menu: ReturnType<typeof modelMenu>
  setModel: (key?: string, thinking?: ThinkingLevel) => void
  stop: () => void
  /** Sends the text with the pending attachments; false when it can't be sent now, so the text stays. */
  submit: (text: string, steer?: boolean) => boolean
  /** Offers to stop the turn, so what's queued sends now. */
  interrupt: () => void
}

/**
 * The message box. It keeps what's typed in its own state, so a keystroke re-renders only the box, never the
 * transcript above it, and the draft is written to localStorage once typing pauses.
 */
function Composer(props: ComposerProps) {
  const { chat, connected, pending, unattach, attach, canSend, canQueue, canChange, steers, placeholder, menu } = props
  const { setModel, stop } = props
  const [text, setTyped] = useState(() => draftOf(chat.id))
  const setText = (typed: string) => {
    setTyped(typed)
    saveDraftSoon(chat.id, typed)
  }
  useEffect(() => flushDrafts, [])
  const fileInput = useRef<HTMLInputElement>(null)
  const archived = chat.archived
  const busy = chat.status !== 'idle'
  const working = busy && !archived && !text
  const canAttach = canSend || canQueue
  const hasContent = text.trim() !== '' || pending.length > 0
  const submit = (steer = false) => {
    if (!props.submit(text, steer)) return
    setTyped('')
    saveDraft(chat.id, '')
  }
  const interruptAndSend = () => {
    if (!canQueue) return
    submit()
    props.interrupt()
  }
  return (
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
            {placeholder}
          </span>
        )}
        <textarea
          className="block max-h-[calc(12lh+16px)] min-h-[calc(1lh+16px)] w-full resize-none border-none bg-transparent px-12 shadow-none py-8 text-body leading-[1.5] field-sizing-content"
          value={text}
          rows={1}
          placeholder={working ? undefined : archived ? 'Archived' : placeholder}
          aria-placeholder={working ? placeholder : undefined}
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
            else submit(!e.altKey)
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
          {menu.value && (
            <Select
              variant="chip"
              label="Model"
              hint={MODEL_HINT}
              value={menu.value}
              disabled={!canChange}
              options={menu.choices.map((c) => ({ value: modelKey(c), label: c.label, group: c.group }))}
              onChange={(key) => setModel(key, menu.thinking)}
            />
          )}
          {menu.levels.length > 0 && (
            <Select
              variant="chip"
              label="Thinking"
              hint={THINKING_HINT}
              value={menu.thinking ?? ''}
              placeholder="Thinking"
              disabled={!canChange}
              options={menu.levels.map((l) => ({ value: l, label: THINKING_LABELS[l] }))}
              onChange={(thinking) => setModel(menu.value, thinking as ThinkingLevel)}
            />
          )}
          {busy ? (
            <>
              {hasContent && (
                <Hint text={steers ? STEER_HINT : QUEUE_HINT}>
                  <Button size="small" disabled={!canQueue} onClick={() => submit()}>
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
                  onClick={() => submit()}
                >
                  Send
                </Button>
              </span>
            </Hint>
          )}
        </span>
      </div>
    </div>
  )
}

/** The reply as it streams in, typed out rather than shown in the bursts the engine sends. */
function StreamingText(props: { name: string; text: string; from: RevealFrom; smooth: boolean }) {
  const text = useReveal(props.name, props.text, props.from, props.smooth)
  return <Markdown className={`streaming ${ASSISTANT}`} text={text} />
}
