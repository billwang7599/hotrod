import { readFileSync } from 'node:fs'

// items.csv: sku,name,category,supplier,stock,unit_price
export function loadItems(text) {
  const [header, ...rows] = text.trim().split('\n')
  const keys = header.split(',')
  return rows.map((row) => {
    const values = row.split(',')
    const item = Object.fromEntries(keys.map((key, i) => [key, values[i]]))
    return { ...item, stock: Number(item.stock), unit_price: Number(item.unit_price) }
  })
}

export const readItems = (path = new URL('items.csv', import.meta.url)) => loadItems(readFileSync(path, 'utf8'))
