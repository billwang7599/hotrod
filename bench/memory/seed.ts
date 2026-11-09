// What Hotrod seeds a session with, and whether a turn's seed keeps the last one's prefix, which a prompt cache needs.

// memoryPrompt and continuationPrompt (packages/core/src/memory.ts) frame the view between these.
const VIEW_START = 'This is the conversation so far:\n\n'
const VIEW_ENDS = ['\n\nNew message from the user:', '\n\nReport from subagent "', '\n\nFrom Hotrod:']

export type Seed = { instructions: string; prompt: string }

export type SeedChange = {
  seedChars: number
  viewChars: number
  // Characters this seed shares with the last one from the start: instructions, then the prompt.
  prefixChars: number
  instructionsChanged: boolean
  // The last view isn't a prefix of this one, so whatever a cache kept of it is lost. Undefined on the first turn.
  cacheBreak?: boolean
  // Where this view first differs from the last one, when it does.
  breakAt?: { offset: number; line: string; was: string }
}

// The memory view inside a prompt; empty for a chat's first message.
export function viewOf(prompt: string) {
  if (!prompt.startsWith(VIEW_START)) return ''
  const rest = prompt.slice(VIEW_START.length)
  const end = Math.min(...VIEW_ENDS.map((marker) => rest.indexOf(marker)).filter((i) => i >= 0), rest.length)
  return rest.slice(0, end)
}

export const seedText = ({ instructions, prompt }: Seed) => `${instructions}\n\n${prompt}`

export function commonPrefix(a: string, b: string) {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

const lineAt = (text: string, offset: number) => {
  const start = text.lastIndexOf('\n', offset - 1) + 1
  const end = text.indexOf('\n', offset)
  return text.slice(start, end < 0 ? undefined : end).slice(0, 160)
}

export function compareSeeds(last: Seed | undefined, next: Seed): SeedChange {
  const view = viewOf(next.prompt)
  const change: SeedChange = {
    seedChars: seedText(next).length,
    viewChars: view.length,
    prefixChars: last ? commonPrefix(seedText(last), seedText(next)) : 0,
    instructionsChanged: last !== undefined && last.instructions !== next.instructions,
  }
  if (!last) return change
  const lastView = viewOf(last.prompt)
  const kept = view.startsWith(lastView)
  change.cacheBreak = change.instructionsChanged || !kept
  if (!kept) {
    const offset = commonPrefix(lastView, view)
    change.breakAt = { offset, line: lineAt(view, offset), was: lineAt(lastView, offset) }
  }
  return change
}
