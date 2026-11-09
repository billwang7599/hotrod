import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseAmount, total } from './calc.mjs'

test('parses plain amounts', () => {
  assert.equal(parseAmount('12'), 12)
  assert.equal(parseAmount(' 3.50 '), 3.5)
})

test('parses thousands separators', () => {
  assert.equal(parseAmount('1,234.50'), 1234.5)
})

test('rejects text that is not an amount', () => {
  assert.throws(() => parseAmount('twelve'), TypeError)
})

test('totals lines', () => {
  assert.equal(total(['1', '2.5', '1,000']), 1003.5)
})
