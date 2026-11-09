import type { CompletionRequest, MemoryMessage } from '@kothar/mod-api'
import { describe, expect, it } from 'vitest'
import {
  foldOf,
  openRollingCompactor,
  readRolling,
  ROLLING_FILE,
  ROLLING_STEP_CHARS,
  ROLLING_SUMMARY_MAX_CHARS,
  rollingView,
  tailStart,
} from './rolling.ts'
import { TAIL_MAX_CHARS } from './tree.ts'

const at = (id: number) => new Date(Date.UTC(2026, 10, 6) + id * 60_000).toISOString()
const chat = (count: number, chars = 2_000): MemoryMessage[] =>
  Array.from({ length: count }, (_, id) => ({
    id,
    kind: id % 2 ? 'talk' : 'user',
    at: at(id),
    text: `message ${id} `.padEnd(chars, '.'),
  }))
const memoryStorage = () => {
  const files = new Map<string, string>()
  return {
    files,
    read: (name: string) => files.get(name),
    write: (name: string, text: string) => void files.set(name, text),
  }
}

describe('rollingView', () => {
  it('shows a short chat in full', () => {
    const view = rollingView(chat(5), undefined, true)
    expect(view).not.toContain('<summary')
    expect([...view.matchAll(/<message id="(\d+)"/g)]).toHaveLength(5)
  })

  it('shows the summary, then lines for what it has not folded yet, then the tail in full', () => {
    const messages = chat(100)
    const start = tailStart(messages, true)
    expect(start).toBeGreaterThan(50)
    const view = rollingView(messages, { upTo: 40, at: at(39), text: 'SUMMARY' }, true)
    expect(view.startsWith('<summary of="0-39">\nSUMMARY\n</summary>')).toBe(true)
    expect(view).toMatch(/^40\|user: message 40/m)
    expect(view).toContain(`<message id="${start}" kind=`)
    expect(view).not.toContain(`<message id="${start - 1}" kind=`)
  })

  it('ignores a summary left over from other numbering', () => {
    const storage = memoryStorage()
    storage.write(ROLLING_FILE, JSON.stringify({ upTo: 10, at: 'other', text: 'x' }))
    expect(readRolling(storage, chat(20))).toBeUndefined()
    storage.write(ROLLING_FILE, JSON.stringify({ upTo: 10, at: at(9), text: 'x' }))
    expect(readRolling(storage, chat(20))).toEqual({ upTo: 10, at: at(9), text: 'x' })
  })
})

describe('foldOf', () => {
  it('waits until ROLLING_STEP_CHARS have left the tail', () => {
    const fits = Math.floor(TAIL_MAX_CHARS / 2_100)
    expect(foldOf(chat(fits + 2), undefined)).toBeUndefined()
    const fold = foldOf(chat(fits + Math.ceil(ROLLING_STEP_CHARS / 2_000) + 2), undefined)
    expect(fold?.upTo).toBeGreaterThan(0)
    expect(fold?.prompt).toContain(`<summary max_chars="${ROLLING_SUMMARY_MAX_CHARS}">\n(empty)\n</summary>`)
  })
})

describe('openRollingCompactor', () => {
  it('folds a long chat in steps until what is left fits, then reports failures once', async () => {
    const messages = chat(200)
    const storage = memoryStorage()
    const requests: CompletionRequest[] = []
    let fail = false
    const failures: string[] = []
    const compactor = openRollingCompactor({
      chat: () => ({ messages, storage }),
      complete: async (request) => {
        requests.push(request)
        if (fail) throw new Error('rate limited')
        return `summary ${requests.length}`
      },
      onFailure: (reason) => void failures.push(reason),
      debounceMs: 0,
      retryBaseMs: 1,
    })
    compactor.touch('a')
    await compactor.whenIdle()
    const rolling = readRolling(storage, messages)!
    expect(rolling.text).toBe(`summary ${requests.length}`)
    expect(foldOf(messages, rolling)).toBeUndefined()
    expect(requests[1]?.prompt).toContain('summary 1')

    messages.push(...chat(260).slice(200))
    fail = true
    compactor.touch('a')
    await new Promise((resolve) => setTimeout(resolve, 30))
    compactor.close()
    expect(failures).toEqual(['rate limited'])
  })
})
