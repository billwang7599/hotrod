import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeAdapter } from '../../packages/core/src/adapters/fake.ts'
import { localMachine } from '../../packages/core/src/machine.ts'
import { memoryPrompt, messagesOf, openSummaries, TAIL_MAX_CHARS } from '../../packages/core/src/memory.ts'
import type { Adapter, ChatEntry } from '../../packages/core/src/shared.ts'
import { loadTask, runTask, type LoadedTask } from './bench.ts'
import { summaryTable, totalsOf, type RunRecord, type TurnRecord } from './report.ts'
import { compareSeeds, viewOf } from './seed.ts'

let dirs: string[] = []
const tempDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hotrod-bench-test-')))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

const prompt = (view: string, message: string) => `This is the conversation so far:\n\n${view}\n\nNew message from the user:\n\n${message}`

describe('cache-break detection', () => {
  it('finds the memory view inside a prompt, and none in a first message', () => {
    expect(viewOf(prompt('0|user: hi', 'next'))).toBe('0|user: hi')
    expect(viewOf('just the message')).toBe('')
  })

  it('keeps the cache while the view only grows at its end, and reports where it first changed when not', () => {
    const instructions = 'RULES'
    const first = { instructions, prompt: 'hello' }
    const second = { instructions, prompt: prompt('<message id="0">hello</message>', 'more') }
    const third = { instructions, prompt: prompt('<message id="0">hello</message>\n\n<message id="1">hi</message>', 'x') }
    const coarser = { instructions, prompt: prompt('0+2|user: hello talk: hi', 'y') }
    expect(compareSeeds(undefined, first)).toEqual({
      seedChars: 'RULES\n\nhello'.length,
      viewChars: 0,
      prefixChars: 0,
      instructionsChanged: false,
    })
    expect(compareSeeds(first, second).cacheBreak).toBe(false)
    expect(compareSeeds(second, third)).toMatchObject({ cacheBreak: false, instructionsChanged: false })
    const broke = compareSeeds(third, coarser)
    expect(broke.cacheBreak).toBe(true)
    expect(broke.breakAt).toEqual({ offset: 0, line: '0+2|user: hello talk: hi', was: '<message id="0">hello</message>' })
    expect(broke.prefixChars).toBe('RULES\n\nThis is the conversation so far:\n\n'.length)
    expect(compareSeeds(third, { ...third, instructions: 'OTHER' })).toMatchObject({ cacheBreak: true, instructionsChanged: true })
  })

  it("sees Hotrod's real view stay append-only until the chat outgrows the tail, then break", () => {
    const summaries = openSummaries(join(tempDir(), 'summaries.jsonl'))
    const entries: ChatEntry[] = []
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
    let last: { instructions: string; prompt: string } | undefined
    const breaks: { turn: number; chars: number }[] = []
    let chars = 0
    for (let turn = 0; turn < 30; turn++) {
      const message = `question ${turn}`
      const next = { instructions: 'RULES', prompt: memoryPrompt(messagesOf(entries), summaries, message, { zoom: true }) }
      if (compareSeeds(last, next).cacheBreak) breaks.push({ turn, chars })
      last = next
      const reply = `answer ${turn} `.repeat(250)
      entries.push({ at: at(turn * 2), type: 'user.message', text: message })
      entries.push({ at: at(turn * 2 + 1), type: 'text.completed', text: reply })
      chars += message.length + reply.length
    }
    expect(breaks.length).toBeGreaterThan(0)
    expect(breaks[0]!.chars).toBeGreaterThan(TAIL_MAX_CHARS * 0.8)
  })
})

const turn = (fields: Partial<TurnRecord>): TurnRecord => ({
  type: 'turn',
  task: 't',
  mode: 'hotrod',
  index: 0,
  phase: 'task',
  message: 'm',
  wallMs: 1000,
  sessionStarted: true,
  instructionsChars: 10,
  promptChars: 10,
  seed: { seedChars: 100, viewChars: 0, prefixChars: 0, instructionsChanged: false },
  reply: 'r',
  permissionsAllowed: 0,
  questionsDeclined: 0,
  ...fields,
})

const run = (fields: Partial<RunRecord>): RunRecord => ({
  type: 'run',
  task: 't',
  mode: 'hotrod',
  engine: 'fake',
  startedAt: '2026-11-08T00:00:00.000Z',
  wallMs: 0,
  probes: [],
  compaction: { calls: 0, promptChars: 0, replyChars: 0, wallMs: 0 },
  ...fields,
})

describe('summary table', () => {
  it('totals each mode and sets the probe answers side by side', () => {
    const usage = (cacheRead: number, cacheWrite: number) => ({ input: 10, output: 5, cacheRead, cacheWrite, costUsd: 0.5 })
    const turns = [
      turn({ usage: usage(0, 1000) }),
      turn({ index: 1, usage: usage(500, 1500), seed: { seedChars: 300, viewChars: 200, prefixChars: 7, instructionsChanged: false, cacheBreak: true } }),
      turn({ mode: 'native', usage: usage(0, 1000) }),
      turn({ mode: 'native', index: 1, usage: { input: 10, output: 5, cacheRead: 1000, cacheWrite: 100 } }),
    ]
    const runs = [
      run({
        check: { passed: true, output: '' },
        probes: [{ question: 'Codename?', expect: 'heron', answer: 'BLUE-HERON | yes', passed: true }],
        compaction: { calls: 2, promptChars: 1234, replyChars: 10, wallMs: 5 },
      }),
      run({ mode: 'native', check: { passed: false, output: '' }, probes: [{ question: 'Codename?', expect: 'heron', answer: 'No idea', passed: false }] }),
    ]
    expect(totalsOf('hotrod', turns, runs[0])).toMatchObject({
      turns: 2,
      input: 20,
      cacheRead: 500,
      cacheWrite: 2500,
      costUsd: 1,
      cacheHitRatio: 500 / 3020,
      cacheBreaks: 1,
      meanSeedChars: 200,
      check: true,
      probesPassed: 1,
    })
    // Only one native turn reported a cost, so the total is that turn's.
    expect(totalsOf('native', turns, runs[1])).toMatchObject({ costUsd: 0.5, cacheBreaks: 0, check: false })
    expect(summaryTable('t', turns, runs)).toBe(`## t

| | hotrod | native |
|---|---:|---:|
| Turns (with usage) | 2 (2) | 2 (2) |
| Uncached input tokens | 20 | 20 |
| Cache read tokens | 500 | 1,000 |
| Cache write tokens | 2,500 | 1,100 |
| Output tokens | 10 | 10 |
| Cache hit ratio | 16.6% | 47.2% |
| Cost (engine-reported) | $1.0000 | $0.5000 |
| Wall time | 2.0 s | 2.0 s |
| Mean seed chars | 200 | 100 |
| Cache breaks (view not append-only) | 1 | 0 |
| Compaction calls (prompt chars) | 2 (1,234) | 0 (0) |
| Task check | pass | FAIL |
| Recall probes passed | 1/1 | 0/1 |

| Probe | hotrod | native |
|---|---|---|
| Codename? | ✓ BLUE-HERON \\| yes | ✗ No idea |
`)
  })
})

describe('runTask with the fake engine', () => {
  // The fake engine bills each turn its prompt's length as cache writes, so a growing seed shows in the totals.
  function billedFake() {
    const fake = createFakeAdapter([{ type: 'text.completed', text: 'Hello from the fake' }], 1)
    const sessions: { instructions: string; prompts: string[]; closed: boolean }[] = []
    const adapter: Adapter = {
      ...fake,
      start(machine, options, emit) {
        const record = { instructions: options.instructions, prompts: [] as string[], closed: false }
        sessions.push(record)
        let length = 0
        const session = fake.start(machine, options, (event) =>
          emit(event.type === 'turn.completed' ? { ...event, usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: length, costUsd: 0.01 } } : event),
        )
        return {
          ...session,
          prompt(text, images) {
            length = text.length
            record.prompts.push(text)
            session.prompt(text, images)
          },
          close() {
            record.closed = true
            session.close()
          },
        }
      },
    }
    return { adapter, sessions }
  }

  function smallTask(): LoadedTask {
    const dir = tempDir()
    mkdirSync(join(dir, 'repo'))
    writeFileSync(join(dir, 'repo', 'a.txt'), 'A')
    mkdirSync(join(dir, 'hidden'))
    writeFileSync(join(dir, 'hidden', 'b.txt'), 'B')
    const task = {
      name: 'small',
      fixture: 'repo',
      turns: ['first', 'second', 'third'],
      check: { command: 'sh', args: ['-c', 'test -f a.txt && test -f b.txt'], hidden: 'hidden' },
      probes: [{ question: 'What did you say?', expect: 'hello' }, { question: 'Anything else?', expect: 'goodbye' }],
    }
    writeFileSync(join(dir, 'small.json'), JSON.stringify(task))
    return loadTask(join(dir, 'small.json'))
  }

  const machine = { ...localMachine, canSandbox: false }

  it('runs every message in a fresh seeded session in hotrod mode', async () => {
    const { adapter, sessions } = billedFake()
    const seen: TurnRecord[] = []
    const { turns, run } = await runTask({
      task: smallTask(),
      mode: 'hotrod',
      adapter,
      machine,
      pollMs: 5,
      tmpDir: tempDir(),
      onTurn: (t) => seen.push(t),
    })
    expect(seen).toEqual(turns)
    expect(turns.map((t) => [t.phase, t.message, t.sessionStarted])).toEqual([
      ['task', 'first', true],
      ['task', 'second', true],
      ['task', 'third', true],
      ['probe', 'What did you say?', true],
      ['probe', 'Anything else?', true],
    ])
    expect(sessions).toHaveLength(5)
    expect(sessions[1]!.prompts[0]).toContain('This is the conversation so far:')
    expect(turns.map((t) => t.seed.cacheBreak)).toEqual([undefined, false, false, false, false])
    expect(turns[2]!.seed.viewChars).toBeGreaterThan(turns[1]!.seed.viewChars)
    expect(turns[2]!.usage).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: turns[2]!.promptChars, costUsd: 0.01 })
    expect(turns.every((t) => t.reply === 'Hello from the fake' && !t.error)).toBe(true)
    expect(run).toMatchObject({
      type: 'run',
      task: 'small',
      mode: 'hotrod',
      engine: 'fake',
      check: { passed: true },
      probes: [
        { question: 'What did you say?', answer: 'Hello from the fake', passed: true },
        { question: 'Anything else?', answer: 'Hello from the fake', passed: false },
      ],
    })
  })

  it('keeps one session and sends each message as typed in native mode', async () => {
    const { adapter, sessions } = billedFake()
    const { turns, run } = await runTask({ task: smallTask(), mode: 'native', adapter, machine, pollMs: 5, tmpDir: tempDir() })
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.prompts).toEqual(['first', 'second', 'third', 'What did you say?', 'Anything else?'])
    expect(sessions[0]!.instructions).not.toContain('Each message you get starts with your memory')
    expect(sessions[0]!.closed).toBe(true)
    expect(turns.map((t) => t.sessionStarted)).toEqual([true, false, false, false, false])
    expect(turns.map((t) => t.usage?.cacheWrite)).toEqual(['first', 'second', 'third', 'What did you say?', 'Anything else?'].map((m) => m.length))
    expect(run.check?.passed).toBe(true)
    expect(run.compaction.calls).toBe(0)
  })

  it('loads the starter tasks, each with a fixture and a check', () => {
    for (const name of ['short-fix', 'feature', 'long-recall']) {
      const task = loadTask(fileURLToPath(new URL(`tasks/${name}.json`, import.meta.url)))
      expect(task.turns.length).toBeGreaterThan(0)
      expect(task.check?.hidden).toBeTruthy()
    }
  })
})
