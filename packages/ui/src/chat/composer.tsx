// The message box: typing (with its draft kept), attachments, model and thinking pickers, and Send, Queue or Stop.
import { useEffect, useRef, useState } from 'react'
import { THINKING_LABELS, type ThinkingLevel } from '@kothar/core/shared'
import { Button, Hint, Select } from '../controls.tsx'
import { draftOf, flushDrafts, saveDraft, saveDraftSoon } from '../drafts.ts'
import { applyEdit, continueList, indentList } from '../lists.tsx'
import { modelKey, type ChatView, type modelMenu } from '../state.ts'
import { FILE_CHIP, FileLabel, PaperclipIcon, type Pending } from './attachments.tsx'

const SEND_HINT = 'Enter to send · Shift+Enter for a new line'
const QUEUE_HINT = 'Enter to queue · ⌘Enter to interrupt and send'
const STEER_HINT = 'Enter steers it in at the next step · ⌥Enter queues · ⌘Enter interrupts and sends'
export const FORCE_STOP_HINT = 'Click Stopping… again to force stop'
const MODEL_HINT = 'Model'
const THINKING_HINT = 'Thinking level'

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
export function Composer(props: ComposerProps) {
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
            if (e.nativeEvent.isComposing) return
            // Lists: a new line (Shift+Enter) continues one, Tab and Shift+Tab nest a list line.
            const listKey = e.key === 'Tab' ? !e.altKey && !e.metaKey && !e.ctrlKey : e.key === 'Enter' && e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey
            if (listKey) {
              const box = e.currentTarget
              const { value, selectionStart, selectionEnd } = box
              const edit = e.key === 'Tab' ? indentList(value, selectionStart, selectionEnd, e.shiftKey) : continueList(value, selectionStart, selectionEnd)
              if (!edit) return
              e.preventDefault()
              applyEdit(box, edit)
              return
            }
            if (e.key !== 'Enter' || e.shiftKey) return
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
