// Formatting values for display.

/** A size in bytes as people read it: 512 B, 4.2 KB, 13 MB (powers of 1000). */
export function formatBytes(bytes: number) {
  if (bytes < 1000) return `${bytes} B`
  const [value, unit] = bytes < 1_000_000 ? [bytes / 1000, 'KB'] : [bytes / 1_000_000, 'MB']
  return `${value < 10 ? Number(value.toFixed(1)) : Math.round(value)} ${unit}`
}
