import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { runBench, STRATEGIES, type Strategy } from './bench.ts'
import { reportOf } from './report.ts'
import { syntheticChat } from './synthetic.ts'

// npm run bench:memory -- [--turns 200] [--seed 1] [--only tree,window] [--out report.md]
// Offline only: the fake engine and a fake summarizer. Nothing here calls a model.
const { values } = parseArgs({
  options: {
    turns: { type: 'string', default: '200' },
    seed: { type: 'string', default: '1' },
    only: { type: 'string' },
    out: { type: 'string' },
  },
})
const turns = Number(values.turns)
const seed = Number(values.seed)
if (!Number.isInteger(turns) || turns < 1) throw new Error('--turns must be a whole number from 1')
const strategies = (values.only?.split(',') ?? STRATEGIES) as Strategy[]
const unknown = strategies.find((s) => !STRATEGIES.includes(s))
if (unknown) throw new Error(`Unknown memory "${unknown}". Pick from: ${STRATEGIES.join(', ')}`)

const chat = syntheticChat(turns, seed)
const chars = chat.reduce(
  (sum, t) => sum + t.message.length + t.steps.reduce((s, step) => s + JSON.stringify(step).length, 0),
  0,
)
const started = Date.now()
const report = reportOf(await runBench(chat, strategies), { turns, seed, chars })
if (values.out) writeFileSync(values.out, report)
process.stdout.write(report)
process.stderr.write(`\n(${((Date.now() - started) / 1000).toFixed(1)} s)\n`)
