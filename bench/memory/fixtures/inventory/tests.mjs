import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadItems, readItems } from './inventory.mjs'

test('loads items with numbers for stock and price', () => {
  const [item] = loadItems('sku,name,category,supplier,stock,unit_price\nSKU-1,steel saw,tools,Acme,3,9.50\n')
  assert.deepEqual(item, { sku: 'SKU-1', name: 'steel saw', category: 'tools', supplier: 'Acme', stock: 3, unit_price: 9.5 })
})

test('reads items.csv', () => {
  assert.equal(readItems().length, 160)
})
