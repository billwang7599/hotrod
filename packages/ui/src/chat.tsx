import { useLayoutEffect, useRef, useState } from 'react'
import type {
  ChatStatus,
  ClientMessage,
  ContextKind,
  ContextLayer,
  EngineAccounts,
  EngineInfo,
  Project,
} from '@hotrod/core/types'
import { ContextPanel } from './context-panel.tsx'
import { Markdown } from './markdown.tsx'
import { accountLabel, engineOptions, type ChatView, type Item } from './state.ts'

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

type ItemProps = { item: Item; chat: ChatView; connected: boolean; send: (m: ClientMessage) => void }

function ItemView({ item, chat, connected, send }: ItemProps) {
  switch (item.kind) {
    case 'user':
      return <div className="user">{item.text}</div>
    case 'text':
      return <Markdown className="assistant" text={item.text} />
    case 'error':
      return <div className="turn-error">{item.text}</div>
    case 'thinking':
      return (
        <details className="row thinking">
          <summary>
            <span className="chevron" />
            <span className="thinking-label">Thinking…</span>
          </summary>
          <div className="thinking-text">{item.text}</div>
        </details>
      )
    case 'tool':
      return (
        <details className={`row tool ${item.state}`}>
          <summary>
            <span className="chevron" />
            <span className="tool-name">{item.name}</span>
            <span className="tool-input">{item.summary}</span>
            <span className="tool-state">{item.state === 'waiting' ? 'waiting for approval' : item.state}</span>
          </summary>
          <pre className="row-body">
            {item.output ||
              (item.state === 'running' ? 'Running…' : item.state === 'waiting' ? 'Waiting for approval…' : 'No output')}
          </pre>
        </details>
      )
    case 'permission': {
      const fullInput = <pre className="row-body">{JSON.stringify(item.input, null, 2)}</pre>
      if (item.outcome !== 'pending') {
        return (
          <details className={`row permission-line ${item.outcome}`}>
            <summary>
              <span className="chevron" />
              <span className="permission-outcome">{OUTCOMES[item.outcome]}</span>
              <span className="tool-name">{item.name}</span>
              <span className="tool-input">{item.summary}</span>
            </summary>
            {fullInput}
          </details>
        )
      }
      const respond = (allow: boolean) =>
        send({ type: 'permission.respond', chatId: chat.id, requestId: item.requestId, allow })
      return (
        <div className="permission">
          <div className="permission-title">
            Allow <strong>{item.name}</strong>?
          </div>
          <pre className="permission-summary">{item.summary}</pre>
          <details className="permission-input">
            <summary>Full input</summary>
            {fullInput}
          </details>
          {chat.status === 'waiting' ? (
            <div className="permission-actions">
              <button className="primary" disabled={!connected} onClick={() => respond(true)}>
                Approve
              </button>
              <button className="danger" disabled={!connected} onClick={() => respond(false)}>
                Deny
              </button>
            </div>
          ) : (
            <div className="permission-note">{chat.status === 'stopping' ? 'Stopping…' : 'Pending'}</div>
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
  openSettings: () => void
  contextOpen: boolean
  toggleContext: () => void
  contextLayers?: ContextLayer[]
  contextDefaults: Record<ContextKind, boolean>
}

export function Chat(props: ChatProps) {
  const { chat, project, engines, accounts, connected, send, openSettings, contextOpen, toggleContext } = props
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

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
  const interruptAndSend = () => {
    if (!canQueue) return
    submit()
    if (chat.status !== 'stopping' && window.confirm(INTERRUPT_SEND_TEXT)) {
      send({ type: 'chat.interrupt', chatId: chat.id })
    }
  }
  const stop = () => {
    if (chat.status !== 'stopping') return send({ type: 'chat.interrupt', chatId: chat.id })
    if (window.confirm(FORCE_STOP_TEXT)) send({ type: 'chat.interrupt', chatId: chat.id, force: true })
  }
  const withSaved = (list: string[] = [], saved?: string) => (saved && !list.includes(saved) ? [...list, saved] : list)
  const models = withSaved(offers?.models, chat.model)
  const levels = withSaved(offers?.thinking, chat.thinking)
  const setModel = (model?: string, thinking?: string) =>
    send({ type: 'chat.setModel', chatId: chat.id, model: model || undefined, thinking: thinking || undefined })
  const unarchive = () =>
    project?.archived
      ? send({ type: 'project.archive', projectId: project.id, archived: false })
      : send({ type: 'chat.archive', chatId: chat.id, archived: false })
  const place = project?.name ?? 'Workshop'

  return (
    <div className="chat-area">
      <main className="chat">
        <header className="chat-header">
          <div className="chat-title">
            <span className="chat-name">{chat.main ? place : chat.title}</span>
            <span className="chat-path">{project?.path ?? 'Not tied to a folder'}</span>
          </div>
          <select
            className="chip"
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
          </select>
          {accounts && !engineOff && (
            <select
              className="chip"
              aria-label="Account"
              value={accounts.active}
              disabled={!canSend}
              onChange={(e) =>
                e.target.value === MANAGE_ACCOUNTS
                  ? openSettings()
                  : send({ type: 'account.use', engine: accounts.engine, accountId: e.target.value })
              }
            >
              {accounts.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {accountLabel(a)}
                </option>
              ))}
              <option value={MANAGE_ACCOUNTS}>Manage accounts…</option>
            </select>
          )}
          <button
            className={`ghost small context-toggle ${contextOpen ? 'active' : ''}`}
            aria-pressed={contextOpen}
            title={contextOpen ? 'Hide context' : 'Show the AGENTS.md layers this chat gets'}
            onClick={toggleContext}
          >
            Context
          </button>
        </header>
        <div
          className="messages"
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
        >
          <div className="column">
            {chat.items.length === 0 && !chat.draft && (
              <div className="empty">
                <strong>
                  Start a chat in <span className="mono">{place}</span>
                </strong>
                <span>
                  Each message starts <span className="mono">{chat.engine}</span> in{' '}
                  {project?.path ?? 'a scratch folder'}
                </span>
              </div>
            )}
            {chat.items.map((item, i) => (
              <ItemView key={i} item={item} chat={chat} connected={connected} send={send} />
            ))}
            {chat.draft && <Markdown className="assistant streaming" text={chat.draft} />}
          </div>
        </div>
        <div className="composer">
          {archivedBy && (
            <div className="archived-note">
              <span>
                This {archivedBy === project ? 'project' : 'chat'} is archived. Its history stays; unarchive it to
                continue.
              </span>
              <button className="small" disabled={!connected} onClick={unarchive}>
                Unarchive
              </button>
            </div>
          )}
          {showEngineNote && (
            <div className="engine-off-note">
              <span>
                {noEngineOn ? (
                  'No engine is on. Turn one on in Settings to start chatting.'
                ) : (
                  <>
                    <span className="mono">{chat.engine}</span> is off. Pick another engine above, or turn it on in
                    Settings.
                  </>
                )}
              </span>
              <button className="small primary" onClick={openSettings}>
                Open Settings
              </button>
            </div>
          )}
          {chat.queue.length > 0 && (
            <ul className="queue" aria-label="Queued messages">
              {chat.queue.map((q) => (
                <li key={q.id}>
                  <span className="queue-text" title={q.text}>
                    {q.text}
                  </span>
                  <button
                    className="ghost icon"
                    aria-label="Remove from queue"
                    disabled={!connected}
                    onClick={() => send({ type: 'chat.unqueue', chatId: chat.id, id: q.id })}
                  >
                    ×
                  </button>
                </li>
              ))}
              <li className="hint">Sends when this turn ends</li>
            </ul>
          )}
          {!showEngineNote && (
            <div className={`composer-box ${canSend || canQueue ? '' : 'disabled'}`}>
              <textarea
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
              <div className="composer-footer">
                <span className="hint">
                  {chat.status === 'stopping' ? FORCE_STOP_HINT : busy ? QUEUE_HINT : SEND_HINT}
                </span>
                <span className="composer-actions">
                  {models.length > 0 && (
                    <select
                      className="chip"
                      aria-label="Model"
                      title="Model, from the next message"
                      value={chat.model ?? ''}
                      disabled={!canChange}
                      onChange={(e) => setModel(e.target.value, chat.thinking)}
                    >
                      <option value="">Default model</option>
                      {models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  )}
                  {levels.length > 0 && (
                    <select
                      className="chip"
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
                    </select>
                  )}
                  {busy ? (
                    <>
                      {text.trim() && (
                        <button className="small" disabled={!canQueue} onClick={submit}>
                          Queue
                        </button>
                      )}
                      <button
                        className={`danger stop ${chat.status}`}
                        disabled={!connected}
                        title={chat.status === 'stopping' ? FORCE_STOP_HINT : undefined}
                        onClick={stop}
                      >
                        {chat.status === 'stopping' ? 'Stopping…' : 'Stop'}
                      </button>
                    </>
                  ) : (
                    <button className="primary" disabled={!canSend || !text.trim()} onClick={submit}>
                      Send
                    </button>
                  )}
                </span>
              </div>
            </div>
          )}
        </div>
      </main>
      {contextOpen && (
        <ContextPanel
          chatId={chat.id}
          layers={props.contextLayers}
          contextDefaults={props.contextDefaults}
          readOnly={!!archivedBy}
          connected={connected}
          send={send}
          close={toggleContext}
        />
      )}
    </div>
  )
}
