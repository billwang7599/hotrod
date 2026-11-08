// @vitest-environment jsdom
import { beforeEach, expect, test } from 'vitest'
import { draftOf, pruneDrafts, saveDraft } from './drafts.ts'

beforeEach(() => localStorage.clear())

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
