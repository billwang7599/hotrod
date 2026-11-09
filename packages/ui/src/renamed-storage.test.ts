// @vitest-environment jsdom
import { expect, test, vi } from 'vitest'
import { moveRenamedKeys } from './renamed-storage.ts'

function storage(entries: Record<string, string>) {
  const items = new Map(Object.entries(entries))
  return {
    items,
    get length() {
      return items.size
    },
    key: (i: number) => [...items.keys()][i] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }
}

test('preferences saved under hotrod.* keys move to kothar.*', () => {
  const s = storage({ 'hotrod.theme': 'dusk', 'hotrod.drafts': '{"c1":"hi"}', other: 'x' })
  moveRenamedKeys(s)
  expect(Object.fromEntries(s.items)).toEqual({ other: 'x', 'kothar.theme': 'dusk', 'kothar.drafts': '{"c1":"hi"}' })
})

test('a value already under the kothar.* key wins, and the old key still goes', () => {
  const s = storage({ 'hotrod.theme': 'dusk', 'kothar.theme': 'dawn' })
  moveRenamedKeys(s)
  expect(Object.fromEntries(s.items)).toEqual({ 'kothar.theme': 'dawn' })
})

test('importing it moves the window\'s own localStorage, as main.tsx does first', async () => {
  localStorage.clear()
  localStorage.setItem('hotrod.panelTab', 'context')
  vi.resetModules()
  await import('./renamed-storage.ts')
  expect(localStorage.getItem('kothar.panelTab')).toBe('context')
  expect(localStorage.getItem('hotrod.panelTab')).toBeNull()
})
