// The Inspector's Activity: what Kothar and its extensions did on their own (the core's onActivity stream), kept per
// chat in the chat's own storage, so it goes with the chat. Events are appended one line each, with every long text
// (what a model was sent, its reply) stored once by hash; the file is compacted to the last turns kept now and then.
// Drawing happens only for a chat whose Activity tab is open.
import { createHash } from 'node:crypto'
import type { ActivityEvent, ActivityKind, ExtensionStorage, ExtensionView } from '@kothar/extension-api'

export const ACTIVITY_FILE = 'inspector/activity.jsonl'
export const ACTIVITY_TEXT_DIR = 'inspector/activity-text'
// Kept at most, whatever the turns: a chat that's busy outside turns (summaries) can't grow it without bound.
export const MAX_EVENTS = 1000
// The newest shown at once.
export const SHOWN_EVENTS = 200

type StoredText = { hash: string; chars: number }
export type StoredEvent = Omit<ActivityEvent, 'sections' | 'result'> & {
  sections?: (StoredText & { label: string })[]
  result?: StoredText
}

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32)

export function parseEvents(text: string | undefined): StoredEvent[] {
  if (!text) return []
  const events: StoredEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as StoredEvent
      if (typeof event?.id === 'string' && typeof event.at === 'string' && typeof event.title === 'string') events.push(event)
    } catch {
      // A line cut off by a crash: skip it.
    }
  }
  return events
}

// The events of the last `turns` turns (and those since, outside any turn), at most MAX_EVENTS.
export function keptOf(events: StoredEvent[], turns: number) {
  const seen: string[] = []
  for (const event of events) if (event.turn && !seen.includes(event.turn)) seen.push(event.turn)
  let from = 0
  if (seen.length > turns) {
    const oldest = seen[seen.length - Math.max(1, turns)]!
    from = events.findIndex((event) => event.turn === oldest)
  }
  return events.slice(from).slice(-MAX_EVENTS)
}

// One storage's activity: a chat's (chatStorage) or the one for model calls not tied to a chat (the extension's own).
export function activityStore(storage: ExtensionStorage) {
  const text = (hash: string) => storage.read(`${ACTIVITY_TEXT_DIR}/${hash}.txt`) ?? ''
  const keep = (body: string): StoredText => {
    const hash = hashOf(body)
    const file = `${ACTIVITY_TEXT_DIR}/${hash}.txt`
    // The same instructions call after call (a summarizer's) are stored once.
    if (storage.read(file) === undefined) storage.write(file, body)
    return { hash, chars: body.length }
  }
  const read = () => parseEvents(storage.read(ACTIVITY_FILE))
  const compact = (turns: number) => {
    const kept = keptOf(read(), turns)
    storage.write(ACTIVITY_FILE, kept.map((event) => JSON.stringify(event) + '\n').join(''))
    const used = new Set(kept.flatMap((event) => [...(event.sections ?? []), ...(event.result ? [event.result] : [])]).map((t) => `${t.hash}.txt`))
    for (const file of storage.list(ACTIVITY_TEXT_DIR)) if (!used.has(file.name)) storage.remove(`${ACTIVITY_TEXT_DIR}/${file.name}`)
    return kept.length
  }
  const add = (event: ActivityEvent) => {
    const { sections, result, ...rest } = event
    const stored: StoredEvent = {
      ...rest,
      ...(sections?.length && { sections: sections.map((section) => ({ label: section.label, ...keep(section.text) })) }),
      ...(result !== undefined && { result: keep(result) }),
    }
    storage.append(ACTIVITY_FILE, JSON.stringify(stored) + '\n')
  }
  return { read, text, add, compact }
}

export const KIND_LABELS: Record<ActivityKind, string> = {
  model: 'Model call',
  permission: 'Permission',
  turn: 'Turn changed',
  worker: 'Worker',
  tool: 'Tool call',
  retry: 'Carried on',
  account: 'Account',
  browser: 'Browser',
  other: 'Other',
}

const short = (chars: number) => {
  const tokens = Math.ceil(chars / 4)
  return tokens >= 1000 ? `~${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : `~${tokens}`
}

export function eventView(event: StoredEvent, text: (hash: string) => string, where?: string): ExtensionView {
  const children: ExtensionView[] = []
  const line = (value: string, tone: 'muted' | 'normal' | 'warning' = 'muted') => children.push({ type: 'text', text: value, small: true, tone })
  line([KIND_LABELS[event.kind] ?? event.kind, ...(where ? [`in ${where}`] : []), event.at].join(' · '))
  if (event.rule) line(`Decided by: ${event.rule}`, 'normal')
  if (event.model) line(`Model: ${event.model}`)
  if (event.detail) children.push({ type: 'code', text: event.detail, maxLines: 8 })
  for (const section of event.sections ?? []) {
    children.push({
      type: 'card',
      title: section.label,
      open: false,
      badges: [{ text: `${short(section.chars)} tokens`, tone: 'faint', hint: 'A rough estimate: about 4 characters a token' }],
      children: [{ type: 'code', text: text(section.hash), maxLines: 40 }],
    })
  }
  if (event.result) {
    children.push({
      type: 'card',
      title: 'Result',
      open: false,
      badges: [{ text: `${short(event.result.chars)} tokens`, tone: 'faint' }],
      children: [{ type: 'code', text: text(event.result.hash), maxLines: 20 }],
    })
  }
  if (event.error) line(`Failed: ${event.error}`, 'warning')
  return {
    type: 'card',
    title: event.title,
    open: false,
    badges: [
      { text: event.by.name, tone: event.by.extension ? 'normal' : 'accent', hint: event.by.extension ? 'An extension' : 'Kothar itself' },
      ...(event.decision ? [{ text: event.decision === 'allowed' ? 'Allowed' : 'Denied', tone: event.decision === 'allowed' ? ('success' as const) : ('warning' as const) }] : []),
      ...(event.error ? [{ text: 'Failed', tone: 'warning' as const }] : []),
      { text: timeOf(event.at), tone: 'faint', hint: event.at },
    ],
    children: children.length ? children : [{ type: 'text', text: 'Nothing more to show.', small: true, tone: 'faint' }],
  }
}

const timeOf = (at: string) => {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? at : date.toISOString().slice(11, 19)
}

export type Scope = 'chat' | 'space' | 'none'
export const SCOPES: { scope: Scope; label: string; hint: string }[] = [
  { scope: 'chat', label: 'This chat', hint: 'What happened in this chat' },
  { scope: 'space', label: 'Whole space', hint: 'This space and every chat under it, such as workers' },
  { scope: 'none', label: 'Not tied to a chat', hint: 'Model calls and account switches no chat asked for' },
]

export function activityView(
  events: { event: StoredEvent; text: (hash: string) => string; where?: string }[],
  scope: Scope,
  kind: ActivityKind | 'all',
): ExtensionView {
  const filtered = events.filter(({ event }) => kind === 'all' || event.kind === kind)
  const shown = filtered.slice(-SHOWN_EVENTS).reverse()
  const kinds = [...new Set(events.map(({ event }) => event.kind))]
  return {
    type: 'stack',
    gap: 'normal',
    children: [
      { type: 'heading', text: 'Activity', hint: 'What Kothar and its extensions did on their own, outside the agent’s tool calls' },
      {
        type: 'row',
        children: SCOPES.map(({ scope: s, label, hint }) => ({
          type: 'button',
          label,
          hint,
          variant: s === scope ? 'primary' : 'ghost',
          action: { name: 'scope', value: s },
        })),
      },
      ...(kinds.length > 1
        ? [
            {
              type: 'row' as const,
              children: [
                { type: 'button' as const, label: 'All', variant: kind === 'all' ? ('primary' as const) : ('ghost' as const), action: { name: 'kind', value: 'all' } },
                ...kinds.map((k) => ({
                  type: 'button' as const,
                  label: KIND_LABELS[k] ?? k,
                  variant: k === kind ? ('primary' as const) : ('ghost' as const),
                  action: { name: 'kind', value: k },
                })),
              ],
            },
          ]
        : []),
      ...(filtered.length > SHOWN_EVENTS
        ? [{ type: 'text' as const, text: `The newest ${SHOWN_EVENTS} of ${filtered.length}.`, small: true, tone: 'muted' as const }]
        : []),
      ...(shown.length
        ? shown.map(({ event, text, where }) => eventView(event, text, where))
        : [{ type: 'empty' as const, text: 'Nothing yet. Model calls, permission answers and what extensions do on their own show here.' }]),
    ],
  }
}
