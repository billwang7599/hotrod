import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseAmount, total } from './calc.mjs'

test('hidden: separators in large amounts', () => {
  assert.equal(parseAmount('12,345,678.9'), 12345678.9)
})

test('hidden: totals with separators', () => {
  assert.equal(total(['2,000', '0.5']), 2000.5)
})
