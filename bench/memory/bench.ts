import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryExtension } from '../../extensions/memory/index.ts'
import { createFakeAdapter, FAKE_MODELS, type FakeStep } from '../../packages/core/src/adapters/fake.ts'
import { sandboxingMachine } from '../../packages/core/src/adapters/test-machine.ts'
import { openCore } from '../../packages/core/src/core.ts'
import { messagesOf } from '../../packages/core/src/memory.ts'
import { SUMMARY_MODELS } from '../../packages/core/src/models.ts'
import type { Adapter, CompleteOptions } from '../../packages/core/src/shared.ts'
import type { SyntheticTurn } from './synthetic.ts'

// An offline bench of what a fresh session per message costs under each memory, against a native long session. It
// runs the real core with the fake engine, so the seeds are exactly what Kothar sends; summaries come from a fake
// summarizer that writes lines of a realistic length. Tokens are estimated, not counted. Nothing calls a model.

export type Strategy = 'tree' | 'rolling' | 'window' | 'native'
export const STRATEGIES: Strategy[] = ['tree', 'rolling', 'window', 'native']
export const LABELS: Record<Strategy, string> = {
  tree: 'Memory extension: summary tree',
  rolling: 'Memory extension: rolling summary',
  window: 'Memory extension off: window',
  native: 'Native session (modelled)',
}

// About 4 characters per token for English and code. A real tokenizer would differ by maybe ±20%.
export const CHARS_PER_TOKEN = 4
export const tokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN)

// Assumed prices in dollars per million tokens: a Sonnet-class model for the chat, a Haiku-class one for summaries,
// with Anthropic's cache multipliers (writes 1.25×, reads 0.1× the input price). Edit to taste.
export const PRICES = {
  input: 3,
  cacheWrite: 3.75,
  cacheRead: 0.3,
  output: 15,
  summaryInput: 1,
  summaryOutput: 5,
}

// A native session's own compaction, modelled: past this many tokens the engine summarizes the whole context into a
// short one, on the chat's model. Claude Code does something like it near its context limit; the numbers are guesses.
export const NATIVE_COMPACT_AT_TOKENS = 160_000
export const NATIVE_SUMMARY_TOKENS = 5_000

export type TurnCost = {
  turn: number
  // What the turn's first model call reads: the instructions and the prompt (memory view plus message).
  instructionsChars: number
  promptChars: number
  seedTokens: number
  // Tokens of that first call: read from cache, written to cache, with messages under 5 minutes apart.
  warmRead: number
  warmWrite: number
  // The view kept the previous turn's view as its start, so it could be cached if sent as its own block.
  appendOnly: boolean
}

export type StrategyResult = {
  strategy: Strategy
  turns: TurnCost[]
  summary: { calls: number; inputTokens: number; outputTokens: number }
}

// A fake summarizer: each tree item gets a line about 60% of its allowed length; a rolling fold a summary a quarter of
// what it read, at most its limit.
function fakeComplete(stats: StrategyResult['summary']): Adapter['complete'] {
  return async (_machine, request: CompleteOptions) => {
    const items = [...request.prompt.matchAll(/<item key="([^"]+)"[^>]*max_chars="(\d+)"/g)]
    const reply = items.length
      ? JSON.stringify({
          summaries: items.map(([, key, max]) => ({ key, text: `summary of ${key} `.padEnd(Math.floor(Number(max) * 0.6), 'x') })),
        })
      : 's'.repeat(Math.min(8_000, Math.floor(request.prompt.length / 4)))
    stats.calls++
    stats.inputTokens += tokens(request.system.length + request.prompt.length)
    stats.outputTokens += tokens(reply.length)
    return reply
  }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 2_000 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 1))
  if (!check()) throw new Error('The fake engine never finished its turn')
}

const commonStart = (a: string, b: string) => {
  let i = 0
  while (i < a.length && i < b.length && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}
const viewOf = (prompt: string) => {
  const start = prompt.startsWith('This is the conversation so far:\n\n') ? 34 : 0
  const end = prompt.lastIndexOf('\n\nNew message from the user:')
  return end < start ? '' : prompt.slice(start, end)
}

// Runs the chat through the core under one memory: the Memory extension in a mode, or no memory extension (the window).
export async function runStrategy(strategy: Exclude<Strategy, 'native'>, chat: SyntheticTurn[]): Promise<StrategyResult> {
  const garage = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-bench-')))
  const summary = { calls: 0, inputTokens: 0, outputTokens: 0 }
  let current: FakeStep[] = []
  const sent: { instructions: string; prompt: string }[] = []
  const fake = createFakeAdapter(() => current, 0)
  const adapter: Adapter = {
    ...fake,
    kotharMcp: true,
    complete: fakeComplete(summary),
    detect: async (machine) => ({ ...(await fake.detect(machine)), models: [...FAKE_MODELS, SUMMARY_MODELS[0]!] }),
    start(machine, options, emit) {
      const record = { instructions: options.instructions, prompt: '' }
      sent.push(record)
      const session = fake.start(machine, options, emit)
      return { ...session, prompt: (text, images) => ((record.prompt = text), session.prompt(text, images)) }
    },
  }
  const memory = createMemoryExtension({ debounceMs: 0 })
  const core = openCore({
    garage,
    adapters: [adapter],
    defaultEngine: 'fake',
    machine: sandboxingMachine,
    extensions: strategy === 'window' ? [] : [memory],
  })
  try {
    // Seeds as for an engine that takes the Kothar MCP server (Claude Code, pi); nothing serves it, as no tool is called.
    core.serveMcp('http://127.0.0.1:9/mcp')
    const handle = (message: Parameters<typeof core.handle>[0]) => core.handle(message, () => {})
    handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true })
    handle({ type: 'workFolder.set', path: join(garage, 'work') })
    if (strategy === 'tree' || strategy === 'rolling') handle({ type: 'extension.setValue', extensionId: 'memory', key: 'mode', value: strategy })
    await core.refreshEngines()
    handle({ type: 'chat.create', name: 'Bench' })
    const chatId = core.chats().find((c) => c.name === 'Bench')!.id
    const idle = () => core.chats().find((c) => c.id === chatId)?.status === 'idle'
    for (const { message, steps } of chat) {
      current = steps
      handle({ type: 'chat.send', chatId, text: message })
      await until(idle)
      await memory.whenIdle()
    }
  } finally {
    await core.close(true)
    rmSync(garage, { recursive: true, force: true })
  }
  let previousView = ''
  const turns = sent.map(({ instructions, prompt }, turn): TurnCost => {
    const view = viewOf(prompt)
    const appendOnly = turn > 0 && commonStart(previousView, view) === previousView.length
    previousView = view
    // A fresh session can reuse the cached tools, system prompt and instructions; the view and message go as one
    // block, so they're written anew each turn.
    return {
      turn,
      instructionsChars: instructions.length,
      promptChars: prompt.length,
      seedTokens: tokens(instructions.length + prompt.length),
      warmRead: turn > 0 ? tokens(instructions.length) : 0,
      warmWrite: tokens(prompt.length) + (turn > 0 ? 0 : tokens(instructions.length)),
      appendOnly,
    }
  })
  return { strategy, turns, summary }
}

// A native long session, modelled from the same chat: each turn's first call reads everything so far from the cache
// and writes only the new message; past NATIVE_COMPACT_AT_TOKENS the engine compacts on its own model.
export function modelNative(chat: SyntheticTurn[], instructionsChars: number): StrategyResult {
  const summary = { calls: 0, inputTokens: 0, outputTokens: 0 }
  const entries: Parameters<typeof messagesOf>[0] = []
  const at = new Date(0).toISOString()
  let context = tokens(instructionsChars)
  const turns: TurnCost[] = []
  for (const [turn, { message, steps }] of chat.entries()) {
    const before = messagesOf(entries).length
    entries.push({ at, type: 'user.message', text: message })
    const asked = tokens(message.length)
    turns.push({
      turn,
      instructionsChars,
      promptChars: (context - tokens(instructionsChars)) * CHARS_PER_TOKEN + message.length,
      seedTokens: context + asked,
      warmRead: turn > 0 ? context : 0,
      warmWrite: asked + (turn > 0 ? 0 : context),
      appendOnly: turn > 0,
    })
    for (const step of steps) {
      if (step.type === 'tool.started' || step.type === 'tool.completed' || step.type === 'text.completed') entries.push({ at, ...step })
    }
    const added = messagesOf(entries).slice(before).reduce((sum, m) => sum + tokens(m.text.length), 0)
    context += added
    if (context > NATIVE_COMPACT_AT_TOKENS) {
      summary.calls++
      summary.inputTokens += context
      summary.outputTokens += NATIVE_SUMMARY_TOKENS
      context = tokens(instructionsChars) + NATIVE_SUMMARY_TOKENS
    }
  }
  return { strategy: 'native', turns, summary }
}

export async function runBench(chat: SyntheticTurn[], strategies: Strategy[] = STRATEGIES) {
  const results: StrategyResult[] = []
  for (const strategy of strategies.filter((s) => s !== 'native')) {
    results.push(await runStrategy(strategy as Exclude<Strategy, 'native'>, chat))
  }
  if (strategies.includes('native')) {
    // Kothar's instructions without any memory text: what a native session would be started with.
    const window = results.find((r) => r.strategy === 'window') ?? (await runStrategy('window', chat.slice(0, 1)))
    results.push(modelNative(chat, window.turns[0]!.instructionsChars))
  }
  return results
}

const dollars = (perMillion: number, count: number) => (perMillion * count) / 1_000_000

// Input cost of the turns' first calls plus summaries: with no caching, a warm cache (messages under 5 minutes
// apart) and a cold one (every cache expired, so everything is written again).
export function costsOf({ strategy, turns, summary }: StrategyResult) {
  const seeds = turns.reduce((sum, t) => sum + t.seedTokens, 0)
  const native = strategy === 'native'
  const summaries = native
    ? dollars(PRICES.input, summary.inputTokens) + dollars(PRICES.output, summary.outputTokens)
    : dollars(PRICES.summaryInput, summary.inputTokens) + dollars(PRICES.summaryOutput, summary.outputTokens)
  const warm = turns.reduce((sum, t) => sum + dollars(PRICES.cacheRead, t.warmRead) + dollars(PRICES.cacheWrite, t.warmWrite), 0)
  return {
    seeds,
    noCache: dollars(PRICES.input, seeds) + summaries,
    warm: warm + summaries,
    cold: dollars(PRICES.cacheWrite, seeds) + summaries,
    summaries,
  }
}
