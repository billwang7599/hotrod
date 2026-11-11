// One item of a chat's transcript: a message, reply, thinking, tool call, permission, question, report or note.
import type { ExtensionAction, ExtensionNoteCard } from '@kothar/extension-api'
import { Fragment, useContext, useState, type ReactNode } from 'react'
import { AnimatePresence, m } from 'motion/react'
import type { ClientMessage, ContextItem } from '@kothar/core/shared'
import { Chevron, CopyBlock, CopyButton, ErrorText, MOTION } from '../controls.tsx'
import { LinkedText, NoFileLinks } from '../file-links.tsx'
import { Markdown } from '../markdown.tsx'
import { UserText } from '../lists.tsx'
import { useReveal, type RevealFrom } from '../smooth.ts'
import { openReportCard, reportCardKey, ReportsOpen, useReportCardChoice } from '../steps.ts'
import type { ChatView, Item } from '../state.ts'
import { SentAttachment } from './attachments.tsx'
import { ASSISTANT, BODY, Dots, Row } from './parts.tsx'
import { PermissionPrompt, PILL, Verdict, VERDICT_COLORS, VERDICTS } from './permission.tsx'
import { QuestionCard } from './question.tsx'

const INTERRUPTED = 'Interrupted'

const TOOL_NAME = 'shrink-0 font-mono text-sm leading-[normal] font-semibold'
const TOOL_INPUT = 'min-w-0 flex-1 truncate font-mono text-sm leading-[normal] text-muted'
const TOOL_STATES: Record<string, string> = {
  waiting: 'text-amber',
  error: 'text-red',
}

/** How a streamed text is named across elements and where it starts typing; undefined shows it whole. */
export type RevealOf = (item: Item) => { key: string; from: RevealFrom } | undefined

type RevealedProps = { item: Item & { text: string }; revealOf?: RevealOf; children: (text: string) => ReactNode }

/** A reply or thinking text, typed out while it arrives live. Its paths become links once it's all shown. */
function Revealed({ item, revealOf, children }: RevealedProps) {
  const reveal = revealOf?.(item)
  const text = useReveal(reveal?.key ?? '', item.text, reveal?.from ?? 'none', !!reveal)
  return text === item.text ? children(text) : <NoFileLinks>{children(text)}</NoFileLinks>
}

type ItemProps = {
  item: Item
  chat: ChatView
  contextItems?: ContextItem[]
  connected: boolean
  send: (m: ClientMessage) => void
  space?: ChatView
  select?: (chatId: string) => void
  // Opens a chat that still exists, for a worker's report.
  openChat?: (chatId: string) => (() => void) | undefined
  revealOf?: RevealOf
  // Opens an extension's panel (a tab, a popup or a dock), for an extension's note, then sends it the note's action.
  openPanel?: (extension: string, panel: string, action?: ExtensionAction) => void
  // The item's index in the chat, for choices kept per item (a report card's fold).
  at?: number
}

/** An extension's note drawn as a card, such as an artifact an agent made: click to open it in the extension's panel. */
function NoteCard({ card, text, open }: { card: ExtensionNoteCard; text: string; open?: () => void }) {
  const body = (
    <>
      <span aria-hidden="true" className="grid size-32 shrink-0 place-items-center rounded bg-raised text-muted">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
          <path d="M5 6h6M5 8.5h6M5 11h3.5" />
        </svg>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="flex min-w-0 items-center gap-6">
          <span className="min-w-0 truncate font-semibold" title={card.title}>
            {card.title}
          </span>
          {card.badge && <span className="shrink-0 rounded-full bg-raised px-8 py-1 text-xs text-muted">{card.badge}</span>}
          {card.detail && <span className="shrink-0 font-mono text-xs text-faint">{card.detail}</span>}
        </span>
        <span className="min-w-0 truncate text-sm text-muted">{text}</span>
      </span>
    </>
  )
  const box = 'flex w-full max-w-420 min-w-0 items-center gap-10 rounded-lg border bg-bg px-10 py-8 text-left shadow-raised'
  return open ? (
    <button className={`${box} transition-colors hover:bg-hover`} data-note-card onClick={open}>
      {body}
    </button>
  ) : (
    <div className={box} data-note-card>
      {body}
    </div>
  )
}

type Report = Extract<Item, { kind: 'report' }>

/** A worker's report: unfolded or folded by the chat's setting until the user opens or closes it. */
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
    <section aria-label={`Report from worker ${item.name}`} className="flex flex-col gap-4 border-l-2 pl-12">
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
          Worker {name} reported
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

export function ItemView(props: ItemProps) {
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
                <UserText text={item.text} />
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
      const { extension, panel, card } = item
      const open = extension && panel && openPanel ? () => openPanel(extension, panel, item.action) : undefined
      if (card) return <NoteCard card={card} text={item.text} open={open} />
      if (!open) return <div className="text-sm text-muted">{item.text}</div>
      return (
        <button
          className="w-fit text-left text-sm text-muted underline decoration-faint underline-offset-2 hover:text-text"
          onClick={open}
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
              <span className={TOOL_INPUT}>
                <LinkedText text={item.summary} inButton />
              </span>
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
              {(item.output && <LinkedText text={item.output} />) ||
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
              <span className={TOOL_INPUT}>
                <LinkedText text={item.summary} inButton />
              </span>
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

/** The reply as it streams in, typed out rather than shown in the bursts the engine sends. */
export function StreamingText(props: { name: string; text: string; from: RevealFrom; smooth: boolean }) {
  const text = useReveal(props.name, props.text, props.from, props.smooth)
  // Paths in a reply still streaming aren't links: a half-typed one would be asked about.
  return (
    <NoFileLinks>
      <Markdown className={`streaming ${ASSISTANT}`} text={text} />
    </NoFileLinks>
  )
}
