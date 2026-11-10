import { describe, expect, it } from 'vitest'
import { costsOf, runBench } from './bench.ts'
import { reportOf } from './report.ts'
import { syntheticChat } from './synthetic.ts'

describe('memory bench', () => {
  it('makes the same synthetic chat for a seed', () => {
    expect(syntheticChat(5, 3)).toEqual(syntheticChat(5, 3))
    expect(syntheticChat(5, 3)).not.toEqual(syntheticChat(5, 4))
  })

  it('runs a small chat through every memory offline and reports a table', async () => {
    const chat = syntheticChat(30, 1)
    const results = await runBench(chat)
    expect(results.map((r) => r.strategy)).toEqual(['tree', 'rolling', 'window', 'native'])
    for (const result of results) expect(result.turns).toHaveLength(30)
    const [tree, rolling, window, native] = results
    // A short chat fits in full everywhere at first, so every memory sends the same first turn.
    expect(tree!.turns[0]!.promptChars).toBe(window!.turns[0]!.promptChars)
    expect(tree!.summary.calls).toBeGreaterThan(0)
    expect(window!.summary.calls).toBe(0)
    expect(native!.turns.at(-1)!.seedTokens).toBeGreaterThan(window!.turns.at(-1)!.seedTokens)
    // A native session reads its history from the cache; a fresh one writes its view anew each turn.
    expect(costsOf(native!).warm).toBeLessThan(costsOf(native!).noCache)
    expect(costsOf(rolling!).warm).toBeGreaterThan(costsOf(rolling!).noCache)
    const report = reportOf(results, { turns: 30, seed: 1, chars: 1 })
    expect(report).toContain('| Memory extension: summary tree |')
    expect(report).toContain('| Native session (modelled) |')
    expect(report).toMatch(/\| 30 \| [\d,]+ \| [\d,]+ \| [\d,]+ \| [\d,]+ \|/)
  }, 60_000)
})
