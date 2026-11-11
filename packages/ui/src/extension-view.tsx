import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { ExtensionAction, ExtensionListItem, ExtensionTone, ExtensionView } from '@kothar/extension-api'
import { Button, Chevron, confirm, COPIED_MS, CopyButton, Hint, Select, Switch } from './controls.tsx'
import { useElapsed } from './elapsed.ts'
import { HtmlFrame } from './html-frame.tsx'
import { MarkdownEditor } from './markdown-editor.tsx'

/**
 * Draws an extension's panel from the view tree its core side sends (ExtensionView in @kothar/extension-api), with
 * Kothar's own controls, so it matches every theme. Actions go back to the extension through `act`.
 */
const TONES: Record<ExtensionTone, string> = {
  normal: 'text-text',
  muted: 'text-muted',
  faint: 'text-faint',
  accent: 'text-accent',
  success: 'text-green',
  warning: 'text-amber',
  error: 'text-red',
}
const DOTS: Record<ExtensionTone, string> = {
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
// How long a search box waits after the last key before it sends.
export const SEARCH_VIEW_MS = 150

type Act = (action: ExtensionAction) => void
// Saves one of the extension's space settings, for a panel's switches and pickers.
type SetValue = (key: string, value: string | number | boolean) => void
const SetValueContext = createContext<SetValue | undefined>(undefined)
// Show in Finder for a text with reveal; the core checks the path (host.reveal's rule).
type Reveal = (path: string) => void
const RevealContext = createContext<Reveal | undefined>(undefined)

// The desktop app's picker for a button's pick, or undefined in a browser tab, where there's none. A file picker gives
// the first file chosen.
function pickerFor(kind: 'folder' | 'file'): ((title?: string) => Promise<string | null>) | undefined {
  const desktop = typeof window === 'undefined' ? undefined : window.kothar
  if (!desktop) return undefined
  if (kind === 'folder') return (title) => desktop.pickFolder(title)
  return async (title) => (await desktop.pickFiles(title))[0] ?? null
}

function RevealButton({ path }: { path: string }) {
  const reveal = useContext(RevealContext)
  if (!reveal) return null
  return (
    <Button size="small" variant="ghost" className="shrink-0" onClick={() => reveal(path)}>
      Show in Finder
    </Button>
  )
}

function SettingSwitch({ node }: { node: Extract<ExtensionView, { type: 'switch' }> }) {
  const set = useContext(SetValueContext)
  const label = node.label ?? node.setting
  const row = (
    <label className="flex min-w-0 items-center justify-between gap-12">
      <span className="min-w-0 wrap-anywhere">{label}</span>
      <Switch
        label={label}
        checked={node.value === true}
        disabled={node.disabled || !set}
        onChange={(checked) => set?.(node.setting, checked)}
      />
    </label>
  )
  return <Hinted hint={node.hint}>{row}</Hinted>
}

function SettingPicker({ node }: { node: Extract<ExtensionView, { type: 'picker' }> }) {
  const set = useContext(SetValueContext)
  const label = node.label ?? node.setting
  const options = node.options ?? []
  const picked = options.find((o) => String(o.value) === String(node.value))
  return (
    <div className="flex min-w-0 items-center justify-between gap-12">
      <span className="min-w-0 wrap-anywhere">{label}</span>
      <Select
        label={label}
        hint={node.hint}
        value={picked === undefined ? '' : String(picked.value)}
        options={options.map((o) => ({ value: String(o.value), label: o.label }))}
        disabled={node.disabled || !set}
        // A select's values may be numbers; send back the option's own value, not its string.
        onChange={(value) => {
          const option = options.find((o) => String(o.value) === value)
          if (option) set?.(node.setting, option.value)
        }}
      />
    </div>
  )
}

function Hinted({ hint, children }: { hint?: string; children: ReactNode }) {
  return hint ? (
    <Hint text={hint} align="start">
      <span className="w-fit">{children}</span>
    </Hint>
  ) : (
    <>{children}</>
  )
}

function Badges({ badges }: { badges?: ExtensionListItem['badges'] }) {
  return badges?.map((badge, i) => (
    <Hinted key={i} hint={badge.hint}>
      <span className={`${BADGE} ${TONES[badge.tone ?? 'muted']}`}>{badge.text}</span>
    </Hinted>
  ))
}

// Its own component, so the shared clock redraws only this text.
function Elapsed({ since, className }: { since: number; className: string }) {
  return <span className={className}>{useElapsed(since)}</span>
}

function lineTone(line: string) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-faint'
  if (line.startsWith('+')) return 'bg-green/10 text-green'
  if (line.startsWith('-')) return 'bg-red/10 text-red'
  if (line.startsWith('@@')) return 'text-accent'
  return 'text-muted'
}

type CodeNode = Extract<ExtensionView, { type: 'code' }>

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
      className="scroll-inset scroll-inset-tight max-h-480 overflow-auto rounded border bg-bg py-6 font-mono text-xs leading-[1.5]"
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

function Card({ node, act }: { node: Extract<ExtensionView, { type: 'card' }>; act: Act }) {
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

function List({ node, act }: { node: Extract<ExtensionView, { type: 'list' }>; act: Act }) {
  if (!node.items.length) return node.empty ? <p className="text-sm text-faint">{node.empty}</p> : null
  return (
    <ul className="flex flex-col" aria-label={node.label}>
      {node.items.map((item) => {
        const body = (
          <>
            {item.dot && <span className={`size-7 shrink-0 rounded-full ${DOTS[item.dot]}`} data-tone={item.dot} />}
            <span className={`min-w-0 flex-1 truncate ${item.mono ? 'font-mono text-xs' : ''}`}>{item.label}</span>
            {item.since !== undefined ? (
              <Elapsed since={item.since} className="shrink-0 font-mono text-xs text-faint" />
            ) : (
              item.detail && <span className="shrink-0 font-mono text-xs text-faint">{item.detail}</span>
            )}
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

type FormNode = Extract<ExtensionView, { type: 'form' }>

const startOf = (node: FormNode) => Object.fromEntries(node.fields.map((f) => [f.name, f.value ?? '']))

// Fields keep what's typed until submit; a form with a new key or new starting values starts over.
function Form({ node, act }: { node: FormNode; act: Act }) {
  const start = JSON.stringify([node.key, startOf(node)])
  const [typed, setTyped] = useState<{ start: string; values: Record<string, string> }>({ start, values: startOf(node) })
  const values = typed.start === start ? typed.values : startOf(node)
  const set = (name: string, text: string) => setTyped({ start, values: { ...values, [name]: text } })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    act({ name: node.submit.action, value: values })
  }
  return (
    <form className="flex min-w-0 flex-col gap-8" onSubmit={submit}>
      {node.fields.map((field) => {
        const shared = {
          'aria-label': field.label,
          value: values[field.name] ?? '',
          placeholder: field.placeholder,
          spellCheck: false,
          onChange: (e: { target: { value: string } }) => set(field.name, e.target.value),
        }
        const mono = field.mono ? 'font-mono' : ''
        return (
          <label key={field.name} className="flex min-w-0 flex-col gap-4">
            <Hinted hint={field.hint}>
              <span className="text-sm text-muted">{field.label}</span>
            </Hinted>
            {(field.rows ?? 1) > 1 ? (
              <textarea
                className={`min-h-96 resize-y px-8 py-6 text-sm leading-[1.5] focus:border-accent ${mono}`}
                rows={field.rows}
                {...shared}
              />
            ) : (
              <input className={`min-w-0 text-sm ${mono}`} {...shared} />
            )}
          </label>
        )
      })}
      <div className="flex items-center gap-8">
        <Button size="small" variant="primary">
          {node.submit.label}
        </Button>
        {node.cancel && (
          <Button type="button" size="small" variant="ghost" onClick={() => act(node.cancel!.action)}>
            {node.cancel.label}
          </Button>
        )}
      </div>
    </form>
  )
}

type SearchNode = Extract<ExtensionView, { type: 'search' }>

// What's typed stays as the panel draws again (with what matches); a new key starts over at value.
function Search({ node, act }: { node: SearchNode; act: Act }) {
  const start = node.key ?? ''
  const [typed, setTyped] = useState({ start, text: node.value ?? '' })
  const text = typed.start === start ? typed.text : (node.value ?? '')
  const sent = useRef(text)
  const latest = useRef(act)
  useLayoutEffect(() => {
    latest.current = act
  })
  useEffect(() => {
    if (text === sent.current) return
    const timer = setTimeout(() => {
      sent.current = text
      latest.current({ name: node.action, value: text })
    }, SEARCH_VIEW_MS)
    return () => clearTimeout(timer)
  }, [text, node.action])
  return (
    <input
      type="search"
      className="min-w-0 text-sm"
      aria-label={node.label ?? node.placeholder ?? 'Search'}
      placeholder={node.placeholder}
      spellCheck={false}
      value={text}
      onChange={(e) => setTyped({ start, text: e.target.value })}
    />
  )
}

// A labelled button that copies text, saying for a moment whether it worked.
function CopyText({ node }: { node: Extract<ExtensionView, { type: 'copy' }> }) {
  const [result, setResult] = useState<'Copied' | 'Couldn’t copy'>()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    let copied = true
    try {
      await navigator.clipboard.writeText(node.text)
    } catch {
      copied = false
    }
    setResult(copied ? 'Copied' : 'Couldn’t copy')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setResult(undefined), COPIED_MS)
  }
  const button = (
    <Button size="small" variant="ghost" onClick={() => void copy()} aria-live="polite">
      {result ?? node.label}
    </Button>
  )
  return node.hint ? <Hint text={node.hint}>{button}</Hint> : button
}

// Saves text as a file through the browser's own download.
export function downloadText(text: string, filename: string, mimeType = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()
  // The download has its own copy by now.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

// An html frame without a height takes the room it's given, so the stacks around it grow to give it that room.
const fills = (node: ExtensionView): boolean =>
  node.type === 'html' ? node.height === undefined : node.type === 'stack' && node.children.some(fills)

function Node({ node, act }: { node: ExtensionView; act: Act }): ReactNode {
  switch (node.type) {
    case 'stack':
      return (
        <div className={`flex min-w-0 flex-col ${GAPS[node.gap ?? 'normal']} ${fills(node) ? 'flex-1' : ''}`}>
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
    case 'text': {
      const text = (
        <Hinted hint={node.hint}>
          <span
            className={`min-w-0 wrap-anywhere ${TONES[node.tone ?? 'normal']} ${node.mono ? 'font-mono text-xs' : ''} ${node.small ? 'text-sm' : ''}`}
          >
            {node.text}
          </span>
        </Hinted>
      )
      if (!node.copy && !node.reveal) return text
      return (
        <div className="flex min-w-0 items-center gap-4">
          {text}
          {node.copy && <CopyButton text={node.text} label={`Copy ${node.text}`} />}
          {node.reveal && <RevealButton path={node.text} />}
        </div>
      )
    }
    case 'badge':
      return <Badges badges={[node]} />
    case 'elapsed':
      return (
        <Hinted hint={node.hint}>
          <Elapsed
            since={node.since}
            className={`${TONES[node.tone ?? 'normal']} ${node.mono ? 'font-mono text-xs' : ''} ${node.small ? 'text-sm' : ''}`}
          />
        </Hinted>
      )
    case 'button': {
      const pick = node.pick && pickerFor(node.pick.kind)
      if (node.pick && !pick) return null
      const button = (
        <Button
          variant={node.variant === 'primary' ? 'primary' : node.variant === 'ghost' ? 'ghost' : 'default'}
          size="small"
          disabled={node.disabled}
          onClick={async () => {
            if (node.confirm && !(await confirm(node.confirm))) return
            if (!pick) return act(node.action)
            const path = await pick(node.pick!.title)
            if (path) act({ name: node.action.name, value: path })
          }}
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
    case 'form':
      return <Form node={node} act={act} />
    case 'switch':
      return <SettingSwitch node={node} />
    case 'picker':
      return <SettingPicker node={node} />
    case 'split':
      return (
        // Side by side once there's room; in a narrow panel the side sits above.
        <div className="@container flex min-h-0 min-w-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-12 @min-[560px]:flex-row" data-split>
            <div className="flex min-h-0 min-w-0 flex-col gap-8 @min-[560px]:w-240 @min-[560px]:shrink-0 @min-[560px]:overflow-y-auto @min-[560px]:border-r @min-[560px]:pr-12">
              <Node node={node.side} act={act} />
            </div>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-8 @min-[560px]:overflow-y-auto">
              <Node node={node.main} act={act} />
            </div>
          </div>
        </div>
      )
    case 'search':
      return <Search node={node} act={act} />
    case 'editor':
      return (
        <MarkdownEditor
          docKey={node.key}
          text={node.text}
          label={node.label}
          placeholder={node.placeholder}
          autofocus={node.autofocus}
          onChange={(text) => act({ name: node.change, value: text })}
          onLink={node.links ? (target) => act({ name: node.links!, value: target }) : undefined}
          onTag={node.tags ? (tag) => act({ name: node.tags!, value: tag }) : undefined}
        />
      )
    case 'html':
      return (
        <HtmlFrame
          html={node.html}
          label={node.label}
          web={node.web}
          height={node.height}
          theme={node.theme}
          libraries={node.libraries}
          onError={node.errors ? (error) => act({ name: node.errors!, value: error }) : undefined}
        />
      )
    case 'copy':
      return <CopyText node={node} />
    case 'download': {
      const button = (
        <Button size="small" variant="ghost" onClick={() => downloadText(node.text, node.filename, node.mimeType)}>
          {node.label}
        </Button>
      )
      return node.hint ? <Hint text={node.hint}>{button}</Hint> : button
    }
    default:
      return null
  }
}

type ViewerProps = { view?: ExtensionView; error?: string; act: Act; set?: SetValue; reveal?: Reveal }

export function ExtensionViewer({ view, error, act, set, reveal }: ViewerProps) {
  if (error) return <p className="text-sm text-red">{error}</p>
  if (!view) return <p className="text-sm text-faint">Loading…</p>
  return (
    <SetValueContext.Provider value={set}>
      <RevealContext.Provider value={reveal}>
        <Node node={view} act={act} />
      </RevealContext.Provider>
    </SetValueContext.Provider>
  )
}
