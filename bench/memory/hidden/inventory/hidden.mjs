import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as inv from './inventory.mjs'

const items = inv.loadItems(`sku,name,category,supplier,stock,unit_price
A-1,steel saw,tools,Acme,2,10.00
A-2,brass valve,plumbing,Acme,20,1.50
B-1,mini rake,garden,Borealis,12,4.00
B-2,quick bolt,fasteners,Borealis,0,0.25
C-1,pro roller,paint,Castellan,40,3.00
`)

test('hidden: counts per category and per supplier', () => {
  assert.deepEqual(inv.byCategory(items), { tools: 1, plumbing: 1, garden: 1, fasteners: 1, paint: 1 })
  assert.deepEqual(inv.bySupplier(items).Acme, { items: 2, units: 22 })
})

test('hidden: lowStock defaults to 10 and sorts by stock', () => {
  assert.deepEqual(inv.lowStock(items).map((i) => i.sku), ['B-2', 'A-1'])
  assert.deepEqual(inv.lowStock(items, 15).map((i) => i.sku), ['B-2', 'A-1', 'B-1'])
})

test('hidden: value, restock plan, search and top suppliers', () => {
  assert.equal(inv.inventoryValue(items), 218)
  const plan = inv.restockPlan(items, 10).toSorted((a, b) => a.sku.localeCompare(b.sku))
  assert.deepEqual(plan, [{ sku: 'A-1', order: 18 }, { sku: 'B-2', order: 20 }])
  assert.deepEqual(inv.search(items, 'ROLLER').map((i) => i.sku), ['C-1'])
  assert.deepEqual(inv.topSuppliers(items, 1), [{ supplier: 'Castellan', value: 120 }])
  assert.equal(typeof inv.report(items), 'string')
})
