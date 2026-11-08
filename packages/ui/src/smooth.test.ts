import { expect, test } from 'vitest'
import { CATCH_UP_MS, nextLength } from './smooth.ts'

test('spreads a burst over several frames instead of showing it at once', () => {
  const target = 'x'.repeat(40)
  const first = nextLength(0, target, 16)
  expect(first).toBeGreaterThan(0)
  expect(first).toBeLessThan(40)
})

test('never falls far behind: a big backlog drains in a few catch-up periods', () => {
  const target = 'x'.repeat(5000)
  let shown = 0
  for (let t = 0; t < CATCH_UP_MS * 8; t += 16) shown = nextLength(shown, target, 16)
  expect(shown).toBe(5000)
})

test('always moves at least one character and never overshoots', () => {
  expect(nextLength(9, 'x'.repeat(10), 0)).toBe(10)
  expect(nextLength(10, 'x'.repeat(10), 16)).toBe(10)
})

test('never splits a surrogate pair', () => {
  expect(nextLength(0, 'a😀b', 0)).toBe(1)
  expect(nextLength(1, 'a😀b', 0)).toBe(3)
})
