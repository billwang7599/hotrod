// What changed between two versions of an artifact, as a unified diff of lines with a little context around each
// change, for the panel's Changes tab (a code view in 'diff').

// Past this many line pairs the table would be too big to build quickly; the diff says so instead.
const MAX_CELLS = 4_000_000
const CONTEXT = 3

type Op = { kind: ' ' | '-' | '+'; line: string; a: number; b: number }

function operations(a: string[], b: string[]): Op[] | undefined {
  // Lines the two share at either end need no table.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  const left = a.slice(start, a.length - end)
  const right = b.slice(start, b.length - end)
  if ((left.length + 1) * (right.length + 1) > MAX_CELLS) return undefined
  // Longest common subsequence, from the end, so the walk below goes forwards.
  const width = right.length + 1
  const table = new Uint32Array((left.length + 1) * width)
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i * width + j] =
        left[i] === right[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
    }
  }
  const ops: Op[] = a.slice(0, start).map((line, i) => ({ kind: ' ', line, a: i, b: i }))
  let i = 0
  let j = 0
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      ops.push({ kind: ' ', line: left[i]!, a: start + i++, b: start + j++ })
    } else if (i < left.length && (j === right.length || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) {
      // Removed lines come before the lines that replace them.
      ops.push({ kind: '-', line: left[i]!, a: start + i++, b: start + j })
    } else {
      ops.push({ kind: '+', line: right[j]!, a: start + i, b: start + j++ })
    }
  }
  const tail = a.length - end
  for (let k = 0; k < end; k++) ops.push({ kind: ' ', line: a[tail + k]!, a: tail + k, b: b.length - end + k })
  return ops
}

export type Diff = { text: string; added: number; removed: number } | { tooBig: true }

/** before → after as hunks: @@ -a,n +b,m @@ then the lines, with CONTEXT unchanged lines around each change. */
export function diffLines(before: string, after: string): Diff {
  const ops = operations(before.split('\n'), after.split('\n'))
  if (!ops) return { tooBig: true }
  const changed = ops.flatMap((op, i) => (op.kind === ' ' ? [] : [i]))
  const added = ops.filter((op) => op.kind === '+').length
  const removed = ops.filter((op) => op.kind === '-').length
  const hunks: string[] = []
  for (let k = 0; k < changed.length; ) {
    const from = Math.max(changed[k]! - CONTEXT, 0)
    let to = changed[k]!
    // Changes close together share a hunk.
    while (k < changed.length && changed[k]! <= to + 2 * CONTEXT + 1) to = changed[k++]!
    to = Math.min(to + CONTEXT, ops.length - 1)
    const slice = ops.slice(from, to + 1)
    const aCount = slice.filter((op) => op.kind !== '+').length
    const bCount = slice.filter((op) => op.kind !== '-').length
    hunks.push(`@@ -${slice[0]!.a + 1},${aCount} +${slice[0]!.b + 1},${bCount} @@`, ...slice.map((op) => `${op.kind}${op.line}`))
  }
  return { text: hunks.join('\n'), added, removed }
}
