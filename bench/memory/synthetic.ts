import type { FakeStep } from '../../packages/core/src/adapters/fake.ts'

// A synthetic coding chat, the same every run for a seed: each turn is a user message, a few tool calls with their
// output (now and then a big one, like a file read or a test log), and a reply. Sizes are rough guesses at a real
// agent chat; edit them here.
export type SyntheticTurn = { message: string; steps: FakeStep[] }

export const SIZES = {
  message: [80, 600],
  toolCalls: [0, 6],
  toolInput: [30, 240],
  output: [150, 2_500],
  bigOutput: [6_000, 20_000],
  bigOutputChance: 0.12,
  reply: [250, 1_500],
}

// mulberry32: a small seeded generator, so a run is reproducible.
function random(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = (
  'the a to of and in is it that for on with as this be at by not are from or have an they which you were ' +
  'function test file error build commit branch config import export const return type value check run fix ' +
  'module server client request response cache token session chat memory summary view line message user agent'
).split(' ')

export function syntheticChat(turns: number, seed = 1): SyntheticTurn[] {
  const next = random(seed)
  const between = ([min, max]: number[]) => Math.floor(min! + next() * (max! - min!))
  const text = (chars: number, prefix = '') => {
    let out = prefix
    while (out.length < chars) out += (out ? ' ' : '') + WORDS[Math.floor(next() * WORDS.length)]
    return out.slice(0, chars)
  }
  return Array.from({ length: turns }, (_, turn) => {
    const steps: FakeStep[] = []
    for (let call = 0, calls = between(SIZES.toolCalls); call < calls; call++) {
      const toolId = `t${turn}-${call}`
      const command = text(between(SIZES.toolInput), `turn ${turn} call ${call}:`)
      const big = next() < SIZES.bigOutputChance
      steps.push(
        { type: 'tool.started', toolId, name: 'Bash', kind: 'shell', summary: command.slice(0, 40), input: { command } },
        { type: 'tool.completed', toolId, output: text(between(big ? SIZES.bigOutput : SIZES.output)), isError: false },
      )
    }
    steps.push({ type: 'text.completed', text: text(between(SIZES.reply), `Turn ${turn} reply:`) })
    return { message: text(between(SIZES.message), `Turn ${turn}:`), steps }
  })
}
