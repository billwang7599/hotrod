import type { TokenUsage } from '../../packages/core/src/shared.ts'
import type { SeedChange } from './seed.ts'

export type Mode = 'hotrod' | 'native'

export type TurnRecord = {
  type: 'turn'
  task: string
  mode: Mode
  index: number
  phase: 'task' | 'probe'
  message: string
  wallMs: number
  // A session started for this turn: every turn in hotrod mode, only the first in native mode.
  sessionStarted: boolean
  // What Hotrod sent: the session's instructions (when it started one) and the prompt.
  instructionsChars: number
  promptChars: number
  seed: SeedChange
  usage?: TokenUsage
  reply: string
  error?: string
  permissionsAllowed: number
  questionsDeclined: number
}

export type ProbeResult = { question: string; expect?: string; answer: string; passed?: boolean }

export type RunRecord = {
  type: 'run'
  task: string
  mode: Mode
  engine: string
  model?: string
  startedAt: string
  wallMs: number
  check?: { passed: boolean; output: string }
  probes: ProbeResult[]
  // The compactor's one-shot calls (hotrod mode); the engine reports no usage for them, so only characters.
  compaction: { calls: number; promptChars: number; replyChars: number; wallMs: number }
}

export type Totals = {
  mode: Mode
  turns: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  costUsd?: number
  // cacheRead over all input tokens (uncached + cache read + cache write).
  cacheHitRatio?: number
  turnsWithUsage: number
  cacheBreaks: number
  meanSeedChars: number
  wallMs: number
  check?: boolean
  probesPassed: number
  probesScored: number
  compactionCalls: number
  compactionPromptChars: number
}

export function totalsOf(mode: Mode, turns: TurnRecord[], run?: RunRecord): Totals {
  const own = turns.filter((t) => t.mode === mode)
  const sum = (pick: (u: TokenUsage) => number) => own.reduce((s, t) => s + (t.usage ? pick(t.usage) : 0), 0)
  const costs = own.flatMap((t) => (t.usage?.costUsd === undefined ? [] : [t.usage.costUsd]))
  const totals = {
    input: sum((u) => u.input),
    cacheRead: sum((u) => u.cacheRead),
    cacheWrite: sum((u) => u.cacheWrite),
    output: sum((u) => u.output),
  }
  const allInput = totals.input + totals.cacheRead + totals.cacheWrite
  const scored = run?.probes.filter((p) => p.passed !== undefined) ?? []
  return {
    mode,
    turns: own.length,
    ...totals,
    ...(costs.length && { costUsd: costs.reduce((a, b) => a + b, 0) }),
    ...(allInput > 0 && { cacheHitRatio: totals.cacheRead / allInput }),
    turnsWithUsage: own.filter((t) => t.usage).length,
    cacheBreaks: own.filter((t) => t.seed.cacheBreak).length,
    meanSeedChars: own.length ? Math.round(own.reduce((s, t) => s + t.seed.seedChars, 0) / own.length) : 0,
    wallMs: own.reduce((s, t) => s + t.wallMs, 0),
    ...(run?.check && { check: run.check.passed }),
    probesPassed: scored.filter((p) => p.passed).length,
    probesScored: scored.length,
    compactionCalls: run?.compaction.calls ?? 0,
    compactionPromptChars: run?.compaction.promptChars ?? 0,
  }
}

const int = (n: number) => n.toLocaleString('en-US')
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

// A Markdown comparison of the modes of one task: totals, then the probe answers side by side.
export function summaryTable(task: string, turns: TurnRecord[], runs: RunRecord[]) {
  const modes = runs.map((r) => r.mode)
  const totals = modes.map((mode) => totalsOf(mode, turns, runs.find((r) => r.mode === mode)))
  const row = (label: string, value: (t: Totals) => string) => `| ${label} | ${totals.map(value).join(' | ')} |`
  const lines = [
    `## ${task}`,
    '',
    `| | ${modes.join(' | ')} |`,
    `|---|${modes.map(() => '---:').join('|')}|`,
    row('Turns (with usage)', (t) => `${t.turns} (${t.turnsWithUsage})`),
    row('Uncached input tokens', (t) => int(t.input)),
    row('Cache read tokens', (t) => int(t.cacheRead)),
    row('Cache write tokens', (t) => int(t.cacheWrite)),
    row('Output tokens', (t) => int(t.output)),
    row('Cache hit ratio', (t) => (t.cacheHitRatio === undefined ? '–' : `${(t.cacheHitRatio * 100).toFixed(1)}%`)),
    row('Cost (engine-reported)', (t) => (t.costUsd === undefined ? '–' : `$${t.costUsd.toFixed(4)}`)),
    row('Wall time', (t) => `${(t.wallMs / 1000).toFixed(1)} s`),
    row('Mean seed chars', (t) => int(t.meanSeedChars)),
    row('Cache breaks (view not append-only)', (t) => String(t.cacheBreaks)),
    row('Compaction calls (prompt chars)', (t) => `${t.compactionCalls} (${int(t.compactionPromptChars)})`),
    row('Task check', (t) => (t.check === undefined ? '–' : t.check ? 'pass' : 'FAIL')),
    row('Recall probes passed', (t) => (t.probesScored ? `${t.probesPassed}/${t.probesScored}` : '–')),
  ]
  const questions = runs[0]?.probes.map((p) => p.question) ?? []
  if (questions.length) {
    lines.push('', `| Probe | ${modes.join(' | ')} |`, `|---|${modes.map(() => '---').join('|')}|`)
    for (const [i, question] of questions.entries()) {
      const answers = runs.map((run) => {
        const probe = run.probes[i]
        if (!probe) return '–'
        const mark = probe.passed === undefined ? '' : probe.passed ? '✓ ' : '✗ '
        return cell(mark + clip(probe.answer, 160))
      })
      lines.push(`| ${cell(question)} | ${answers.join(' | ')} |`)
    }
  }
  return lines.join('\n') + '\n'
}
