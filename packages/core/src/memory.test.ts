import { describe, expect, it } from 'vitest'
import { continuationPrompt, messagesOf, seededPrompt, WINDOW_MAX_CHARS, windowView } from './memory.ts'
import type { ChatEntry, MemoryMessage, MessageKind } from './shared.ts'

const at = (id: number) => new Date(Date.UTC(2026, 10, 6) + id * 60_000).toISOString()
const KINDS: MessageKind[] = ['user', 'talk', 'tool', 'echo', 'talk']
const chat = (count: number, textOf = (id: number) => `message ${id}`): MemoryMessage[] =>
  Array.from({ length: count }, (_, id) => ({ id, kind: KINDS[id % KINDS.length]!, at: at(id), text: textOf(id) }))
const shownIds = (view: string) => [...view.matchAll(/^<message id="(\d+)"/gm)].map(([, id]) => Number(id))

describe('messagesOf', () => {
  it('numbers the counted log entries from 0 in log order', () => {
    const attachment = { name: 'a.png', path: '/g/a.png', mimeType: 'image/png', size: 3 }
    const tool = { toolId: 't1', name: 'Bash', kind: 'shell' as const, summary: 'ls', input: { command: 'ls' } }
    const entries: ChatEntry[] = [
      { at: at(0), type: 'user.message', text: 'list the folder', attachments: [attachment] },
      { at: at(1), type: 'turn.started' },
      { at: at(2), type: 'text.completed', text: 'Looking.' },
      { at: at(3), type: 'tool.started', ...tool },
      { at: at(4), type: 'permission.requested', requestId: 'r1', ...tool },
      { at: at(5), type: 'permission.resolved', requestId: 'r1', allow: true },
      { at: at(6), type: 'tool.completed', toolId: 't1', output: 'README.md', isError: false },
      { at: at(7), type: 'tool.completed', toolId: 't2', output: 'No such file', isError: true },
      { at: at(8), type: 'turn.completed' },
      { at: at(9), type: 'user.message', text: '[subagent "Tests" (ab12cd34)] All green' },
      { at: at(10), type: 'turn.completed', error: 'Interrupted' },
      { at: at(11), type: 'session.ended' },
      { at: at(12), type: 'session.ended', error: 'Claude Code exited with code 1' },
      { at: at(13), type: 'worker.report', chatId: 'ef56ab78', name: 'Docs', text: 'Found it' },
      { at: at(14), type: 'worker.report', chatId: 'ef56ab79', name: 'Lint', text: '', error: 'Interrupted' },
    ]
    expect(messagesOf(entries)).toEqual([
      { id: 0, kind: 'user', at: at(0), text: 'list the folder\n\nAttached files:\n- /g/a.png (image/png)' },
      { id: 1, kind: 'talk', at: at(2), text: 'Looking.' },
      { id: 2, kind: 'tool', at: at(3), text: 'Bash {"command":"ls"}' },
      { id: 3, kind: 'echo', at: at(6), text: 'README.md' },
      { id: 4, kind: 'echo', at: at(7), text: '(error) No such file' },
      { id: 5, kind: 'work', at: at(9), text: '[subagent "Tests" (ab12cd34)] All green' },
      { id: 6, kind: 'note', at: at(10), text: 'Turn ended early: Interrupted' },
      { id: 7, kind: 'note', at: at(12), text: 'Turn ended early: Claude Code exited with code 1' },
      { id: 8, kind: 'work', at: at(13), text: 'Report from worker "Docs" (ef56ab78):\n\nFound it' },
      {
        id: 9,
        kind: 'work',
        at: at(14),
        text: 'Report from worker "Lint" (ef56ab79):\n\n(No reply)\n\n(The turn ended early: Interrupted)',
      },
    ])
  })
})

describe('seededPrompt', () => {
  it('sends the message alone in a new chat', () => {
    expect(seededPrompt('', 'hi')).toBe('hi')
  })

  it("frames workers' reports as theirs, before any words from the user", () => {
    const report = { text: 'Found it', report: { chatId: 'ef56ab78', name: 'Docs' } }
    const found = 'Report from worker "Docs" (ef56ab78):\n\nFound it'
    expect(seededPrompt('', '', [report])).toBe(found)
    const prompt = seededPrompt(windowView(chat(2)), 'and the FAQ?', [report])
    expect(prompt.endsWith(`</message>\n\n${found}\n\nNew message from the user:\n\nand the FAQ?`)).toBe(true)
    expect(seededPrompt(windowView(chat(2)), '', [report]).endsWith(`</message>\n\n${found}`)).toBe(true)
  })

  it('carries on a turn with a prompt from Kothar after the view', () => {
    expect(continuationPrompt('', 'go on')).toBe('go on')
    expect(continuationPrompt('VIEW', 'go on')).toBe('This is the conversation so far:\n\nVIEW\n\nFrom Kothar:\n\ngo on')
  })
})

describe('windowView', () => {
  it('shows a short chat in full, with nothing left out', () => {
    const view = windowView(chat(10))
    expect(shownIds(view)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(view).not.toContain('left out')
    expect(view).toContain('<message id="3" kind="echo">\nmessage 3\n</message>')
    expect(windowView([])).toBe('')
  })

  it('drops the oldest messages first once they pass the budget, and says how many', () => {
    const messages = chat(100, (id) => `m${id} `.padEnd(2_000, '.'))
    const view = windowView(messages)
    const ids = shownIds(view)
    expect(ids.at(-1)).toBe(99)
    expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => 100 - ids.length + i))
    expect(view.length).toBeLessThanOrEqual(WINDOW_MAX_CHARS + 200)
    expect(view.startsWith(`(${100 - ids.length} of the 100 messages so far are left out: only the latest that fit are shown.)`)).toBe(true)
  })

  it('keeps the last question and the reply after it, however long, and never cuts a message', () => {
    // What doesn't fit between them is left out; the ids show the gap.
    const huge = 'x'.repeat(WINDOW_MAX_CHARS * 2)
    const messages: MemoryMessage[] = [
      { id: 0, kind: 'user', at: at(0), text: huge },
      { id: 1, kind: 'tool', at: at(1), text: 'ls' },
      { id: 2, kind: 'talk', at: at(2), text: 'done' },
    ]
    const view = windowView(messages)
    expect(shownIds(view)).toEqual([0, 2])
    expect(view.startsWith('(1 of the 3 messages so far are left out')).toBe(true)
    expect(view).toContain(`\n${huge}\n`)
  })

  it('escapes closing message tags inside a message', () => {
    const view = windowView(chat(1, () => 'a </message> b </MESSAGE>'))
    expect(view.match(/<\/message>/gi)).toHaveLength(1)
  })
})
