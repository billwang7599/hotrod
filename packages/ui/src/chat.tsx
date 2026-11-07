import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { AnimatePresence, m } from 'motion/react'
import type {
  ChatStatus,
  ClientMessage,
  ContextKind,
  ContextLayer,
  EngineAccounts,
  EngineInfo,
  ModelLists,
  Project,
} from '@hotrod/core/types'
import { ContextPanel } from './context-panel.tsx'
import { Button, Chevron, confirm, ErrorText, MOTION, useSettled } from './controls.tsx'
import { Markdown } from './markdown.tsx'
import type { SettingsPage } from './settings.tsx'
import { accountLabel, engineOptions, modelMenu, type ChatView, type Item } from './state.ts'

const MANAGE_ACCOUNTS = '__manage'
const SEND_HINT = 'Enter to send · Shift+Enter for a new line'
const QUEUE_HINT = 'Enter to queue · ⌘Enter to interrupt and send'
const INTERRUPT_SEND_TEXT = 'Interrupt and send now?'
const FORCE_STOP_HINT = 'Click Stopping… again to force stop'
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
const SELECT_ARROW =
  'bg-[url(data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%2710%27%20height=%276%27%3E%3Cpath%20d=%27M1%201l4%204%204-4%27%20fill=%27none%27%20stroke=%27%238b8e96%27%20stroke-width=%271.5%27/%3E%3C/svg%3E)]'

function ChipSelect(props: ComponentProps<'select'>) {
  return (
    <select
      className={`h-26 max-w-220 cursor-pointer appearance-none truncate rounded border border-transparent bg-transparent bg-no-repeat bg-position-[right_8px_center] pr-24 pl-8 text-sm text-muted field-sizing-content enabled:hover:border-border enabled:hover:text-text disabled:cursor-default disabled:text-faint disabled:opacity-70 max-[900px]:max-w-150 [&_option]:bg-panel [&_option]:text-text ${SELECT_ARROW}`}
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

type ItemProps = { item: Item; chat: ChatView; connected: boolean; send: (m: ClientMessage) => void }

function ItemView({ item, chat, connected, send }: ItemProps) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="max-w-[85%] self-end rounded-[12px_12px_4px_12px] bg-raised px-12 py-8 text-body leading-[1.5] whitespace-pre-wrap [word-break:break-word]">
          {item.text}
        </div>
      )
    case 'text':
      return <Markdown className={ASSISTANT} text={item.text} />
    case 'error':
      return <ErrorText>{item.text}</ErrorText>
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
          <details>
            <summary className="w-fit text-sm text-muted">Full input</summary>
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
  project?: Project
  engines: EngineInfo[]
  accounts?: EngineAccounts
  connected: boolean
  send: (m: ClientMessage) => void
  openSettings: (page?: SettingsPage) => void
  contextOpen: boolean
  toggleContext: () => void
  contextLayers?: ContextLayer[]
  contextDefaults: Record<ContextKind, boolean>
  modelLists?: ModelLists
}

export function Chat(props: ChatProps) {
  const { chat, project, engines, accounts, connected, send, openSettings, contextOpen, toggleContext } = props
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const settled = useSettled()
  const enter = settled.current && MOTION.rise.initial

  useLayoutEffect(() => {
    const list = listRef.current
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight
  }, [chat.items, chat.draft, chat.status])

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) list.scrollTop = list.scrollHeight
    })
    observer.observe(list)
    return () => observer.disconnect()
  }, [])

  const archivedBy = project?.archived ? project : chat.archived ? chat : undefined
  const canChange = connected && chat.status === 'idle' && !archivedBy
  const offers = engines.find((e) => e.id === chat.engine)
  const engineOff = !offers?.enabled
  const noEngineOn = !engines.some((e) => e.enabled)
  const canSend = canChange && !engineOff
  const busy = chat.status !== 'idle'
  const canQueue = connected && busy && !archivedBy
  const showEngineNote = engineOff && !archivedBy && chat.status === 'idle'
  const submit = () => {
    if (!(canSend || canQueue) || !text.trim()) return
    send({ type: 'chat.send', chatId: chat.id, text })
    setText('')
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
  const models = modelMenu(chat, offers, props.modelLists)
  const offeredLevels = offers?.thinking ?? []
  const saved = chat.thinking && !offeredLevels.includes(chat.thinking)
  const levels = saved ? [...offeredLevels, chat.thinking!] : offeredLevels
  const setModel = (model?: string, thinking?: string) =>
    send({ type: 'chat.setModel', chatId: chat.id, model: model || undefined, thinking: thinking || undefined })
  const unarchive = () =>
    project?.archived
      ? send({ type: 'project.archive', projectId: project.id, archived: false })
      : send({ type: 'chat.archive', chatId: chat.id, archived: false })
  const place = project?.name ?? 'Workshop'

  return (
    <div className="flex min-h-0 flex-1">
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-44 shrink-0 items-center gap-6 border-b pr-12 pl-20">
          <div className="flex min-w-0 flex-1 items-baseline gap-10 whitespace-nowrap">
            <span className="max-w-[50%] shrink-0 truncate font-semibold">{chat.main ? place : chat.title}</span>
            <span className="min-w-0 truncate font-mono text-sm leading-[normal] text-faint max-[900px]:hidden">
              {project?.path ?? 'Not tied to a folder'}
            </span>
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
          {accounts && !engineOff && (
            <ChipSelect
              aria-label="Account"
              value={accounts.active}
              disabled={!canSend}
              onChange={(e) =>
                e.target.value === MANAGE_ACCOUNTS
                  ? openSettings('accounts')
                  : send({ type: 'account.use', engine: accounts.engine, accountId: e.target.value })
              }
            >
              {accounts.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {accountLabel(a)}
                </option>
              ))}
              <option value={MANAGE_ACCOUNTS}>Manage accounts…</option>
            </ChipSelect>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="grid place-items-center aria-pressed:text-text"
            aria-label="Context panel"
            aria-pressed={contextOpen}
            title={contextOpen ? 'Hide context' : 'Show context'}
            onClick={toggleContext}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
              <path d="M10 2.5v11" />
              {contextOpen && (
                <path d="M10 2.5h3a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-3z" fill="currentColor" />
              )}
            </svg>
          </Button>
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
                  Start a chat in <span className="font-mono">{place}</span>
                </strong>
                <span>
                  Each message starts <span className="font-mono">{chat.engine}</span> in{' '}
                  {project?.path ?? 'a scratch folder'}
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
                <ItemView item={item} chat={chat} connected={connected} send={send} />
              </m.div>
            ))}
            {chat.draft && (
              <m.div initial={enter} animate={MOTION.rise.animate}>
                <Markdown className={`streaming ${ASSISTANT}`} text={chat.draft} />
              </m.div>
            )}
          </div>
        </div>
        <div className="shrink-0 px-24 pb-16">
          {archivedBy && (
            <div className="mx-auto mb-8 flex max-w-column items-center gap-8 text-sm text-muted">
              <span className="flex-1">
                This {archivedBy === project ? 'project' : 'chat'} is archived. Its history stays; unarchive it to
                continue.
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
                          <span className="flex-1 truncate" title={q.text}>
                            {q.text}
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
              className={`mx-auto max-w-column rounded-lg border has-[textarea:focus]:border-accent ${canSend || canQueue ? 'bg-panel' : 'bg-bg'}`}
            >
              <textarea
                className="block max-h-[calc(12lh+16px)] min-h-[calc(2lh+16px)] w-full resize-none border-none bg-transparent px-12 py-8 text-body leading-[1.5] field-sizing-content"
                value={text}
                rows={2}
                placeholder={archivedBy ? 'Archived' : PLACEHOLDERS[chat.status]}
                disabled={!(canSend || canQueue)}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
                  e.preventDefault()
                  const emptyWithQueue = !text.trim() && chat.queue.length > 0
                  if (busy && (e.metaKey || e.ctrlKey || emptyWithQueue)) interruptAndSend()
                  else submit()
                }}
              />
              <div className="flex items-center justify-between gap-8 pr-6 pb-6 pl-12">
                <span className="text-sm text-faint">
                  {chat.status === 'stopping' ? FORCE_STOP_HINT : busy ? QUEUE_HINT : SEND_HINT}
                </span>
                <span className="flex min-w-0 items-center gap-6">
                  {models.options.length > 1 && (
                    <ChipSelect
                      aria-label="Model"
                      title="Model, from the next message. Auto follows the lists in Settings."
                      value={models.value}
                      disabled={!canChange}
                      onChange={(e) => setModel(e.target.value, chat.thinking)}
                    >
                      {models.options.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </ChipSelect>
                  )}
                  {levels.length > 0 && (
                    <ChipSelect
                      aria-label="Thinking"
                      title="Thinking level, from the next message"
                      value={chat.thinking ?? ''}
                      disabled={!canChange}
                      onChange={(e) => setModel(chat.model, e.target.value)}
                    >
                      <option value="">Default thinking</option>
                      {levels.map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                    </ChipSelect>
                  )}
                  {busy ? (
                    <>
                      {text.trim() && (
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
                    <Button variant="primary" disabled={!canSend || !text.trim()} onClick={submit}>
                      Send
                    </Button>
                  )}
                </span>
              </div>
            </div>
          )}
        </div>
      </main>
      <AnimatePresence initial={false}>
        {contextOpen && (
          <m.div
            key="context"
            className="flex shrink-0 overflow-hidden"
            initial={{ width: 0 }}
            animate={{ width: 'auto' }}
            exit={{ width: 0 }}
          >
            <ContextPanel
              chatId={chat.id}
              layers={props.contextLayers}
              contextDefaults={props.contextDefaults}
              readOnly={!!archivedBy}
              connected={connected}
              send={send}
            />
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
}
