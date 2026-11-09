import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ModAction, ModListItem, ModTone, ModView } from '@hotrod/mod-api'
import { Button, Chevron, Hint } from './controls.tsx'

/**
 * Draws a mod's panel from the view tree its core side sends (ModView in @hotrod/mod-api), with Hotrod's own
 * controls, so it matches every theme. Actions go back to the mod through `act`.
 */
const TONES: Record<ModTone, string> = {
  normal: 'text-text',
  muted: 'text-muted',
  faint: 'text-faint',
  accent: 'text-accent',
  success: 'text-green',
  warning: 'text-amber',
  error: 'text-red',
}
const DOTS: Record<ModTone, string> = {
  normal: 'bg-text',
  muted: 'bg-muted',
  faint: 'bg-faint',
  accent: 'bg-accent',
  success: 'bg-green',
  warning: 'bg-amber',
  error: 'bg-red',
}
const BADGE = 'shrink-0 rounded-full bg-raised px-8 py-2 text-xs font-normal'
// How near the end a followed log counts as at the end, in pixels.
const FOLLOW_PX = 16
const GAPS = { tight: 'gap-4', normal: 'gap-8', loose: 'gap-18' }
const JUSTIFY = { start: 'justify-start', between: 'justify-between', end: 'justify-end' }
const MAX_CODE_LINES = 400

type Act = (action: ModAction) => void

function Hinted({ hint, children }: { hint?: string; children: ReactNode }) {
  return hint ? (
    <Hint text={hint} align="start">
      <span className="w-fit">{children}</span>
    </Hint>
  ) : (
    <>{children}</>
  )
}

function Badges({ badges }: { badges?: ModListItem['badges'] }) {
  return badges?.map((badge, i) => (
    <Hinted key={i} hint={badge.hint}>
      <span className={`${BADGE} ${TONES[badge.tone ?? 'muted']}`}>{badge.text}</span>
    </Hinted>
  ))
}

function lineTone(line: string) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-faint'
  if (line.startsWith('+')) return 'bg-green/10 text-green'
  if (line.startsWith('-')) return 'bg-red/10 text-red'
  if (line.startsWith('@@')) return 'text-accent'
  return 'text-muted'
}

type CodeNode = Extract<ModView, { type: 'code' }>

function Code({ text, language, maxLines = MAX_CODE_LINES, follow }: Omit<CodeNode, 'type'>) {
  const lines = text.replace(/\n$/, '').split('\n')
  const shown = follow ? lines.slice(-maxLines) : lines.slice(0, maxLines)
  const cut = lines.length - shown.length
  const pre = useRef<HTMLPreElement>(null)
  // A followed log stays at its end as it grows, until the user scrolls up to read.
  const atEnd = useRef(true)
  useLayoutEffect(() => {
    if (follow && atEnd.current && pre.current) pre.current.scrollTop = pre.current.scrollHeight
  }, [follow, text])
  const onScroll = () => {
    const el = pre.current
    if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_PX
  }
  const more = cut > 0 && <div className="px-8 text-faint">{cut} {follow ? 'earlier' : 'more'} lines</div>
  return (
    <pre
      ref={pre}
      onScroll={follow ? onScroll : undefined}
      className="max-h-480 overflow-auto rounded border bg-bg py-6 font-mono text-xs leading-[1.5]"
    >
      {follow && more}
      {shown.map((line, i) => (
        <div key={i} className={`px-8 whitespace-pre ${language === 'diff' ? lineTone(line) : 'text-muted'}`}>
          {line || ' '}
        </div>
      ))}
      {!follow && more}
    </pre>
  )
}

function Card({ node, act }: { node: Extract<ModView, { type: 'card' }>; act: Act }) {
  const [open, setOpen] = useState(node.open ?? true)
  return (
    <div className="flex flex-col rounded-lg border bg-bg px-10 py-8 shadow-raised">
      <div className="flex min-w-0 items-center gap-6">
        <button
          className="group flex min-w-0 items-center gap-6 text-left font-semibold"
          aria-expanded={open}
          data-open={open || undefined}
          onClick={() => setOpen(!open)}
        >
          <Chevron />
          <span className="truncate">{node.title}</span>
        </button>
        <Badges badges={node.badges} />
      </div>
      {open && (
        <div className="flex flex-col gap-8 pt-8">
          {node.children.map((child, i) => (
            <Node key={i} node={child} act={act} />
          ))}
        </div>
      )}
    </div>
  )
}

function List({ node, act }: { node: Extract<ModView, { type: 'list' }>; act: Act }) {
  if (!node.items.length) return node.empty ? <p className="text-sm text-faint">{node.empty}</p> : null
  return (
    <ul className="flex flex-col" aria-label={node.label}>
      {node.items.map((item) => {
        const body = (
          <>
            {item.dot && <span className={`size-7 shrink-0 rounded-full ${DOTS[item.dot]}`} data-tone={item.dot} />}
            <span className={`min-w-0 flex-1 truncate ${item.mono ? 'font-mono text-xs' : ''}`}>{item.label}</span>
            {item.detail && <span className="shrink-0 font-mono text-xs text-faint">{item.detail}</span>}
            <Badges badges={item.badges} />
          </>
        )
        const row = 'flex w-full min-w-0 items-center gap-8 rounded px-6 py-4 text-left'
        return (
          <li key={item.key} className="flex min-w-0 items-center gap-8">
            <div className="flex min-w-0 flex-1 flex-col">
              <Hinted hint={item.hint}>
                {item.action ? (
                  <button
                    className={`${row} hover:bg-hover aria-pressed:bg-hover`}
                    aria-pressed={item.selected ?? undefined}
                    onClick={() => act(item.action!)}
                  >
                    {body}
                  </button>
                ) : (
                  <div className={row}>{body}</div>
                )}
              </Hinted>
            </div>
            {item.link && (
              <a
                className="shrink-0 font-mono text-xs text-accent hover:underline"
                href={item.link.url}
                target="_blank"
                rel="noreferrer"
              >
                {item.link.text}
              </a>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function Node({ node, act }: { node: ModView; act: Act }): ReactNode {
  switch (node.type) {
    case 'stack':
      return (
        <div className={`flex min-w-0 flex-col ${GAPS[node.gap ?? 'normal']}`}>
          {node.children.map((child, i) => (
            <Node key={i} node={child} act={act} />
          ))}
        </div>
      )
    case 'row':
      return (
        <div className={`flex min-w-0 flex-wrap items-center gap-8 ${JUSTIFY[node.justify ?? 'start']}`}>
          {node.children.map((child, i) => (
            <Node key={i} node={child} act={act} />
          ))}
        </div>
      )
    case 'heading':
      return (
        <Hinted hint={node.hint}>
          <h3 className="font-semibold">{node.text}</h3>
        </Hinted>
      )
    case 'text':
      return (
        <Hinted hint={node.hint}>
          <span
            className={`min-w-0 wrap-anywhere ${TONES[node.tone ?? 'normal']} ${node.mono ? 'font-mono text-xs' : ''} ${node.small ? 'text-sm' : ''}`}
          >
            {node.text}
          </span>
        </Hinted>
      )
    case 'badge':
      return <Badges badges={[node]} />
    case 'button': {
      const button = (
        <Button
          variant={node.variant === 'primary' ? 'primary' : node.variant === 'ghost' ? 'ghost' : 'default'}
          size="small"
          disabled={node.disabled}
          onClick={() => act(node.action)}
        >
          {node.label}
        </Button>
      )
      return node.hint ? <Hint text={node.hint}>{button}</Hint> : button
    }
    case 'link':
      return (
        <a className="w-fit text-accent hover:underline" href={node.url} target="_blank" rel="noreferrer">
          {node.text}
        </a>
      )
    case 'list':
      return <List node={node} act={act} />
    case 'code':
      return <Code text={node.text} language={node.language} maxLines={node.maxLines} follow={node.follow} />
    case 'card':
      return <Card node={node} act={act} />
    case 'divider':
      return <hr className="border-border" />
    case 'empty':
      return <p className="text-sm text-faint">{node.text}</p>
    default:
      return null
  }
}

export function ModViewer({ view, error, act }: { view?: ModView; error?: string; act: Act }) {
  if (error) return <p className="text-sm text-red">{error}</p>
  if (!view) return <p className="text-sm text-faint">Loading…</p>
  return <Node node={view} act={act} />
}
