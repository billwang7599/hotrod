// Runs one scripted multi-turn task through the real core in a throwaway garage, in one of two modes:
//
// - hotrod: what Hotrod does. Every message starts a fresh engine session seeded with the chat's memory view.
// - native: an experiment only. The engine keeps one session for the whole chat and gets each message as the user
//   typed it, so its own history (and prompt cache) carries over. Hotrod never does this (design rule 5); it lives
//   here, as a wrapper around the adapter, so no adapter or core code knows about it. See bench/memory/README.md.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { localMachine } from '../../packages/core/src/machine.ts'
import { startCore } from '../../packages/core/src/main.ts'
import { MEMORY_INSTRUCTIONS, ZOOM_INSTRUCTIONS } from '../../packages/core/src/memory.ts'
import type { Adapter, ChatState, EngineEvent, Machine, Session, TokenUsage } from '../../packages/core/src/shared.ts'
import type { Mode, ProbeResult, RunRecord, TurnRecord } from './report.ts'
import { compareSeeds, type Seed, type SeedChange } from './seed.ts'

export type Task = {
  name: string
  description?: string
  // The repo the agent works on, relative to the task file; copied into the space's work folder.
  fixture: string
  turns: string[]
  // Run in the work folder once the turns are done; passes on exit code 0. hidden: a folder (relative to the task
  // file) copied over the work folder first, such as acceptance tests the agent never saw.
  check?: { command: string; args?: string[]; hidden?: string }
  // Asked after the check, to catch state lost between turns. expect: a case-insensitive regex the answer must match.
  probes?: { question: string; expect?: string }[]
}

export type LoadedTask = Task & { dir: string }

export function loadTask(file: string): LoadedTask {
  const task = JSON.parse(readFileSync(file, 'utf8')) as Task
  if (!task.name || !task.fixture || !Array.isArray(task.turns)) throw new Error(`${file}: a task needs name, fixture, turns`)
  return { ...task, dir: dirname(resolve(file)) }
}

export type RunOptions = {
  task: LoadedTask
  mode: Mode
  adapter: Adapter
  model?: string
  thinking?: string
  machine?: Machine
  // Off runs engines unsandboxed (edits anywhere), for machines that can't sandbox.
  sandbox?: boolean
  turnTimeoutMs?: number
  pollMs?: number
  // Where the throwaway garage goes; removed afterwards unless keep is set.
  tmpDir?: string
  keep?: boolean
  onTurn?(turn: TurnRecord): void
}

type TurnProbe = { instructions?: string; prompt?: string; usage?: TokenUsage; sessionStarted: boolean }

const OUTPUT_TAIL_CHARS = 4000
const CHECK_TIMEOUT_MS = 300_000

// The memory instructions describe a view a native session never gets.
const withoutMemory = (instructions: string) =>
  instructions
    .split('\n\n')
    .filter((part) => part !== MEMORY_INSTRUCTIONS && part !== ZOOM_INSTRUCTIONS)
    .join('\n\n')

// The compactor's reply, without a model: native chats are never summarized for the engine, so they shouldn't pay.
const stubSummaries = (prompt: string) =>
  JSON.stringify({
    summaries: [...prompt.matchAll(/<item key="([^"]+)"/g)].map(([, key]) => ({ key, text: `(native run) ${key}` })),
  })

export function instrument(adapter: Adapter, mode: Mode) {
  let turn: TurnProbe = { sessionStarted: false }
  let message = ''
  let cwd: string | undefined
  const compaction = { calls: 0, promptChars: 0, replyChars: 0, wallMs: 0 }
  const native: { session?: Session; emit?: (event: EngineEvent) => void } = {}
  const watch = (event: EngineEvent) => {
    if (event.type === 'turn.completed' && event.usage) turn.usage = event.usage
  }

  const wrapped: Adapter = {
    ...adapter,
    ...(adapter.complete && {
      async complete(machine, options) {
        if (mode === 'native') return stubSummaries(options.prompt)
        const started = Date.now()
        const reply = await adapter.complete!(machine, options)
        compaction.calls++
        compaction.promptChars += options.system.length + options.prompt.length
        compaction.replyChars += reply.length
        compaction.wallMs += Date.now() - started
        return reply
      },
    }),
    start(machine, options, emit) {
      cwd = options.cwd
      if (mode === 'hotrod') {
        turn.sessionStarted = true
        turn.instructions = options.instructions
        const session = adapter.start(machine, options, (event) => {
          watch(event)
          emit(event)
        })
        return {
          ...session,
          prompt(text, images) {
            turn.prompt = text
            session.prompt(text, images)
          },
        }
      }
      native.emit = emit
      if (!native.session) {
        // No memory view, so no zoom: the Hotrod MCP server's token is revoked after the turn anyway.
        const { hotrodMcp, ...rest } = options
        const instructions = withoutMemory(options.instructions)
        turn.sessionStarted = true
        turn.instructions = instructions
        native.session = adapter.start(machine, { ...rest, instructions }, (event) => {
          watch(event)
          if (event.type === 'session.ended') native.session = undefined
          native.emit?.(event)
        })
      }
      const session = native.session
      return {
        prompt(_text, images) {
          turn.prompt = message
          session.prompt(message, images)
        },
        interrupt: () => session.interrupt(),
        respond: (requestId, allow, reason) => session.respond(requestId, allow, reason),
        ...(session.answer && { answer: (requestId, answers) => session.answer!(requestId, answers) }),
        // The core closes a session after each turn; this one outlives it.
        close() {},
      }
    },
  }

  return {
    adapter: wrapped,
    begin(text: string) {
      turn = { sessionStarted: false }
      message = text
    },
    turn: () => turn,
    cwd: () => cwd,
    compaction,
    close() {
      native.session?.close()
      native.session = undefined
    },
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function runTask(options: RunOptions): Promise<{ turns: TurnRecord[]; run: RunRecord }> {
  const { task, mode, adapter, turnTimeoutMs = 20 * 60_000, pollMs = 100 } = options
  const machine = options.machine ?? localMachine
  const sandbox = options.sandbox ?? machine.canSandbox
  const root = realpathSync(mkdtempSync(join(options.tmpDir ?? tmpdir(), `hotrod-bench-${task.name}-${mode}-`)))
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  const probe = instrument(adapter, mode)
  const env = { HOTROD_GARAGE: join(root, 'garage'), HOTROD_PORT: '0', HOTROD_ENGINE: adapter.id, HOTROD_WORK: work }
  const hotrod = await startCore({ env, adapters: [probe.adapter], mods: [], machine })
  const { core } = hotrod
  const ignore = () => {}
  const handle = (message: Parameters<typeof core.handle>[0]) => core.handle(message, ignore)
  const startedAt = new Date().toISOString()
  const turns: TurnRecord[] = []
  const probes: ProbeResult[] = []
  let check: RunRecord['check']

  try {
    // One chat, one engine session at a time: subagents would muddy the comparison.
    handle({ type: 'mod.setEnabled', modId: 'subagents', enabled: false })
    if (!sandbox) handle({ type: 'permission.setDefault', name: 'editAnywhere', enabled: true })
    handle({ type: 'permission.setDefault', name: 'askNetworkCommands', enabled: false })
    const before = new Set(core.chats().map((c) => c.id))
    handle({ type: 'chat.create', name: task.name })
    const chatId = core.chats().find((c) => !before.has(c.id))!.id
    if (options.model || options.thinking) {
      handle({ type: 'chat.setModel', chatId, model: options.model, thinking: options.thinking })
    }
    const workDir = join(work, chatId)
    cpSync(resolve(task.dir, task.fixture), workDir, { recursive: true })
    const chat = () => core.chats().find((c) => c.id === chatId) as ChatState

    let lastSeed: Seed | undefined
    const say = async (message: string, phase: TurnRecord['phase']) => {
      probe.begin(message)
      const from = chat().entries.length
      const started = Date.now()
      let error: string | undefined
      let permissionsAllowed = 0
      let questionsDeclined = 0
      const answered = new Set<string>()
      try {
        handle({ type: 'chat.send', chatId, text: message })
        for (;;) {
          await sleep(pollMs)
          const { status, entries, queue } = chat()
          const mine = entries.slice(from)
          if (status === 'idle' && !queue.length && mine.some((e) => e.type === 'turn.completed' || e.type === 'session.ended')) break
          if (Date.now() - started > turnTimeoutMs) {
            error = `timed out after ${turnTimeoutMs} ms`
            handle({ type: 'chat.interrupt', chatId, force: true })
            await sleep(pollMs * 5)
            break
          }
          if (status !== 'waiting') continue
          // The bench says yes to everything the core didn't answer itself: the work folder is throwaway.
          const resolved = new Set(mine.flatMap((e) => (e.type === 'permission.resolved' || e.type === 'question.resolved' ? [e.requestId] : [])))
          for (const entry of mine) {
            if (entry.type !== 'permission.requested' && entry.type !== 'question.asked') continue
            if (resolved.has(entry.requestId) || answered.has(entry.requestId)) continue
            answered.add(entry.requestId)
            if (entry.type === 'permission.requested') {
              permissionsAllowed++
              handle({ type: 'permission.respond', chatId, requestId: entry.requestId, allow: true })
            } else {
              questionsDeclined++
              handle({ type: 'question.respond', chatId, requestId: entry.requestId })
            }
          }
        }
      } catch (thrown) {
        error = thrown instanceof Error ? thrown.message : String(thrown)
      }
      const mine = chat().entries.slice(from)
      const ended = mine.findLast((e) => e.type === 'turn.completed' || e.type === 'session.ended')
      error ??= ended && 'error' in ended ? ended.error : undefined
      const reply = mine.flatMap((e) => (e.type === 'text.completed' ? [e.text] : [])).join('\n\n')
      const seen = probe.turn()
      let seed: SeedChange
      if (mode === 'hotrod') {
        const next = { instructions: seen.instructions ?? '', prompt: seen.prompt ?? '' }
        seed = compareSeeds(lastSeed, next)
        lastSeed = next
      } else {
        // A native session gets its instructions once, then only each message: nothing it was sent ever changes.
        const sent = (seen.sessionStarted ? (seen.instructions ?? '').length + 2 : 0) + (seen.prompt ?? '').length
        seed = { seedChars: sent, viewChars: 0, prefixChars: 0, instructionsChanged: false }
        if (turns.length) seed.cacheBreak = false
      }
      const record: TurnRecord = {
        type: 'turn',
        task: task.name,
        mode,
        index: turns.length,
        phase,
        message,
        wallMs: Date.now() - started,
        sessionStarted: seen.sessionStarted,
        instructionsChars: seen.sessionStarted ? (seen.instructions ?? '').length : 0,
        promptChars: (seen.prompt ?? '').length,
        seed,
        ...(seen.usage && { usage: seen.usage }),
        reply,
        ...(error && { error }),
        permissionsAllowed,
        questionsDeclined,
      }
      turns.push(record)
      options.onTurn?.(record)
      return record
    }

    for (const message of task.turns) await say(message, 'task')

    if (task.check) {
      const cwd = probe.cwd() ?? workDir
      if (task.check.hidden) cpSync(resolve(task.dir, task.check.hidden), cwd, { recursive: true })
      const tmp = join(cwd, '.tmp')
      mkdirSync(tmp, { recursive: true })
      const jail = sandbox ? { sandbox: { writable: [cwd], tmpDir: tmp } } : {}
      const ran = await machine
        .run(task.check.command, task.check.args ?? [], { cwd, timeoutMs: CHECK_TIMEOUT_MS, ...jail })
        .catch((thrown) => ({ code: -1, stdout: '', stderr: String(thrown) }))
      check = { passed: ran.code === 0, output: (ran.stdout + ran.stderr).slice(-OUTPUT_TAIL_CHARS) }
    }

    for (const { question, expect } of task.probes ?? []) {
      const { reply } = await say(question, 'probe')
      probes.push({ question, ...(expect && { expect }), answer: reply, ...(expect && { passed: new RegExp(expect, 'i').test(reply) }) })
    }
  } finally {
    probe.close()
    await hotrod.close(true)
    if (!options.keep) rmSync(root, { recursive: true, force: true })
  }

  const run: RunRecord = {
    type: 'run',
    task: task.name,
    mode,
    engine: adapter.id,
    ...(options.model && { model: options.model }),
    startedAt,
    wallMs: turns.reduce((sum, t) => sum + t.wallMs, 0),
    ...(check && { check }),
    probes,
    compaction: { ...probe.compaction },
  }
  return { turns, run }
}

export const fixtureExists = (task: LoadedTask) => existsSync(resolve(task.dir, task.fixture))
