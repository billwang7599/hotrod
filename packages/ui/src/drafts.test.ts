// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DRAFT_SAVE_MS, draftOf, flushDrafts, pruneDrafts, saveDraft, saveDraftSoon } from './drafts.ts'

beforeEach(() => localStorage.clear())
afterEach(() => vi.useRealTimers())

test('drafts of chats that no longer exist are dropped', () => {
  saveDraft('a', 'one')
  saveDraft('b', 'two')
  pruneDrafts(['b', 'c'])
  expect(draftOf('a')).toBe('')
  expect(draftOf('b')).toBe('two')
})

test('saving empty text clears the draft, and bad saved data reads as none', () => {
  saveDraft('a', 'one')
  saveDraft('a', '')
  expect(localStorage.getItem('hotrod.drafts')).toBeNull()
  localStorage.setItem('hotrod.drafts', 'not json')
  expect(draftOf('a')).toBe('')
})

test('typed text is written once typing pauses, or sooner when flushed, and reads back before then', () => {
  vi.useFakeTimers()
  saveDraftSoon('a', 'o')
  saveDraftSoon('a', 'one')
  expect(localStorage.getItem('hotrod.drafts')).toBeNull()
  expect(draftOf('a')).toBe('one')
  vi.advanceTimersByTime(DRAFT_SAVE_MS)
  expect(JSON.parse(localStorage.getItem('hotrod.drafts')!)).toEqual({ a: 'one' })
  saveDraftSoon('b', 'two')
  flushDrafts()
  expect(JSON.parse(localStorage.getItem('hotrod.drafts')!)).toEqual({ a: 'one', b: 'two' })
  saveDraftSoon('a', 'changed')
  saveDraft('a', '')
  vi.advanceTimersByTime(DRAFT_SAVE_MS)
  expect(draftOf('a')).toBe('')
})
