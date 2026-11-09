// Amounts arrive as text such as "12", "3.50" or "1,234.50".
export function parseAmount(text) {
  const n = parseFloat(text.trim())
  if (Number.isNaN(n)) throw new TypeError(`Not an amount: ${text}`)
  return n
}

export function total(lines) {
  return lines.reduce((sum, line) => sum + parseAmount(line), 0)
}
