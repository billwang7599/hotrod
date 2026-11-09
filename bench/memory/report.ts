import { CHARS_PER_TOKEN, costsOf, LABELS, PRICES, type StrategyResult } from './bench.ts'

const int = (n: number) => Math.round(n).toLocaleString('en-US')
const usd = (n: number) => `$${n.toFixed(2)}`

// The turns the growth table shows: a few points along the chat, and its last turn.
export function checkpoints(count: number) {
  const points = [1, 10, 25, 50, 100, 200, 400, 800].filter((n) => n < count)
  return [...points, count]
}

export function reportOf(results: StrategyResult[], about: { turns: number; seed: number; chars: number }) {
  const rows = results.map((result) => ({ result, costs: costsOf(result) }))
  const turnsOf = (r: StrategyResult) => r.turns.length
  const lines = [
    `# Memory bench: ${about.turns} turns (seed ${about.seed}, ${int(about.chars)} characters of chat)`,
    '',
    `Offline: the real core and the fake engine, a fake summarizer, tokens estimated at ${CHARS_PER_TOKEN} characters ` +
      'each. Costs count the input of each turn’s first model call plus summaries, at assumed prices ' +
      `($${PRICES.input}/M input, $${PRICES.cacheWrite}/M cache write, $${PRICES.cacheRead}/M cache read; summaries ` +
      `$${PRICES.summaryInput}/M in, $${PRICES.summaryOutput}/M out). The engine’s own system prompt and tool ` +
      'definitions, replies and tool round-trips inside a turn are left out: they are the same for every memory.',
    '',
    '| Memory | Mean seed tokens/turn | Last turn | Seed tokens, total | Summary calls | Summary tokens in / out | No cache | Warm cache | Cold cache | Append-only views |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map(({ result, costs }) => {
      const { turns, summary } = result
      const last = turns.at(-1)!.seedTokens
      const appendOnly = turns.slice(1).filter((t) => t.appendOnly).length
      return (
        `| ${LABELS[result.strategy]} | ${int(costs.seeds / turnsOf(result))} | ${int(last)} | ${int(costs.seeds)} | ` +
        `${summary.calls} | ${int(summary.inputTokens)} / ${int(summary.outputTokens)} | ${usd(costs.noCache)} | ` +
        `${usd(costs.warm)} | ${usd(costs.cold)} | ${appendOnly}/${Math.max(0, turns.length - 1)} |`
      )
    }),
    '',
    '## Seed tokens by turn',
    '',
    `| Turn | ${results.map((r) => LABELS[r.strategy]).join(' | ')} |`,
    `|---:|${results.map(() => '---:').join('|')}|`,
    ...checkpoints(about.turns).map(
      (n) => `| ${n} | ${results.map((r) => int(r.turns[n - 1]?.seedTokens ?? 0)).join(' | ')} |`,
    ),
    '',
    'Warm cache: a fresh session reads its instructions from the cache and writes the view and message, which go as one ' +
      'block; a native session reads everything so far and writes the new message. Cold cache: every message comes ' +
      'after the cache expired. Append-only views: turns whose view kept the last one as its start, which a split ' +
      'into cacheable blocks could reuse. The native row is modelled from the same chat, with a compaction on the ' +
      'chat’s model past a context limit (its summary calls).',
  ]
  return lines.join('\n') + '\n'
}
