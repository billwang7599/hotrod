import type { Attachment, ChatEntry, MemoryMessage, MessageKind, WorkerReport } from './shared.ts'

// What every chat needs of its history: its log read as numbered messages, and the history a fresh session is
// seeded with when no extension provides a memory (the Memory extension does by default). Without one, a session sees a
// window of the latest messages in full, the oldest dropped first, and is told how many were dropped. No summaries, no
// model calls, no tools.

// The Memory extension's budget for the latest messages in full plus its lines (40,000 + 48,000), so a session sees at
// most as much with the extension off as with it on.
export const WINDOW_MAX_CHARS = 88_000

export type Report = { text: string; report: WorkerReport }

// How a worker's report reads to its lead, in memory and in the prompt that delivers it.
export function reportText({ text, report: { chatId, name, error } }: Report) {
  const early = error ? `\n\n(The turn ended early: ${error})` : ''
  return `Report from worker "${name}" (${chatId}):\n\n${text || '(No reply)'}${early}`
}

export function withAttachments(text: string, attachments: Attachment[] = []) {
  if (!attachments.length) return text
  const list = ['Attached files:', ...attachments.map((a) => `- ${a.path} (${a.mimeType})`)].join('\n')
  return text ? `${text}\n\n${list}` : list
}

export function messagesOf(entries: ChatEntry[]): MemoryMessage[] {
  const messages: MemoryMessage[] = []
  const add = (kind: MessageKind, at: string, text: string) => messages.push({ id: messages.length, kind, at, text })
  for (const entry of entries) {
    if (entry.type === 'user.message') {
      const kind = entry.text.startsWith('[subagent "') ? 'work' : 'user'
      add(kind, entry.at, withAttachments(entry.text, entry.attachments))
    }
    if (entry.type === 'worker.report') {
      const { text, chatId, name, error } = entry
      add('work', entry.at, reportText({ text, report: { chatId, name, ...(error && { error }) } }))
    }
    if (entry.type === 'text.completed') add('talk', entry.at, entry.text)
    if (entry.type === 'tool.started') add('tool', entry.at, `${entry.name} ${JSON.stringify(entry.input) ?? ''}`.trim())
    if (entry.type === 'tool.completed') add('echo', entry.at, entry.isError ? `(error) ${entry.output}` : entry.output)
    if ((entry.type === 'turn.completed' || entry.type === 'session.ended') && entry.error) {
      add('note', entry.at, `Turn ended early: ${entry.error}`)
    }
  }
  return messages
}

const escapeTag = (text: string, tag: string) => text.replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1')
const messageText = ({ id, kind, text }: MemoryMessage) =>
  `<message id="${id}" kind="${kind}">\n${escapeTag(text, 'message')}\n</message>`

// The latest messages in full, newest first while they fit WINDOW_MAX_CHARS. The last message from the user (or a
// worker) and the reply after it always stay, however long, as the Memory extension's view keeps them.
export function windowView(messages: MemoryMessage[], maxChars = WINDOW_MAX_CHARS) {
  if (!messages.length) return ''
  const asked = messages.findLastIndex((m) => m.kind === 'user' || m.kind === 'work')
  const lastTalk = messages.findLastIndex((m) => m.kind === 'talk')
  const kept = new Map<number, string>()
  for (const id of new Set([asked, lastTalk > asked ? lastTalk : -1])) {
    if (id >= 0) kept.set(id, messageText(messages[id]!))
  }
  let budget = maxChars - [...kept.values()].reduce((sum, text) => sum + text.length, 0)
  for (let id = messages.length - 1; id >= 0; id--) {
    if (kept.has(id)) continue
    const text = messageText(messages[id]!)
    if (text.length > budget) break
    budget -= text.length
    kept.set(id, text)
  }
  const shown = [...kept].sort(([a], [b]) => a - b).map(([, text]) => text)
  const dropped = messages.length - kept.size
  const note = dropped
    ? [`(${dropped} of the ${messages.length} messages so far are left out: only the latest that fit are shown.)`]
    : []
  return [...note, ...shown].join('\n\n')
}

// The prompt that starts a turn: the history so far, then workers' reports and the user's message.
export function seededPrompt(view: string, message: string, reports: Report[] = []) {
  if (!reports.length && !view) return message
  const fromUser = message || !reports.length ? [`New message from the user:\n\n${message}`] : []
  const incoming = [...reports.map(reportText), ...fromUser].join('\n\n')
  if (!view) return incoming
  return `This is the conversation so far:\n\n${view}\n\n${incoming}`
}

// A prompt from Kothar that carries on the chat's last turn; the view shows how far that turn got.
export function continuationPrompt(view: string, text: string) {
  if (!view) return text
  return `This is the conversation so far:\n\n${view}\n\nFrom Kothar:\n\n${text}`
}
