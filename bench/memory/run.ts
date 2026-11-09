// npm run bench:memory -- --engine claude-code --task short-fix --yes
// Compares Hotrod's fresh session per message with a native long session on scripted tasks. See README.md.
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { claudeCode } from '../../packages/core/src/adapters/claude-code.ts'
import { createFakeAdapter } from '../../packages/core/src/adapters/fake.ts'
import { pi } from '../../packages/core/src/adapters/pi.ts'
import type { Adapter } from '../../packages/core/src/shared.ts'
import { fixtureExists, loadTask, runTask } from './bench.ts'
import { summaryTable, type Mode, type RunRecord, type TurnRecord } from './report.ts'

const TASKS_DIR = fileURLToPath(new URL('tasks/', import.meta.url))
const ADAPTERS: Record<string, () => Adapter> = {
  'claude-code': () => claudeCode,
  pi: () => pi,
  fake: () => createFakeAdapter(undefined, 5),
}

const { values } = parseArgs({
  options: {
    engine: { type: 'string', default: 'claude-code' },
    task: { type: 'string', multiple: true },
    mode: { type: 'string', default: 'both' },
    model: { type: 'string' },
    thinking: { type: 'string' },
    out: { type: 'string', default: fileURLToPath(new URL('results/', import.meta.url)) },
    keep: { type: 'boolean', default: false },
    unsandboxed: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
})

const available = readdirSync(TASKS_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
if (values.help) {
  console.log(`Usage: npm run bench:memory -- [--engine claude-code|pi|fake] [--task <name>]... [--mode both|hotrod|native]
       [--model <id>] [--thinking <level>] [--out <dir>] [--keep] [--unsandboxed] [--yes]
Tasks: ${available.join(', ')}. Real engines bill your own login, so they run only with --yes.`)
  process.exit(0)
}

const make = ADAPTERS[values.engine!]
if (!make) throw new Error(`Unknown engine "${values.engine}". Pick one of: ${Object.keys(ADAPTERS).join(', ')}`)
const modes: Mode[] = values.mode === 'both' ? ['hotrod', 'native'] : [values.mode as Mode]
if (!modes.every((m) => m === 'hotrod' || m === 'native')) throw new Error('--mode is both, hotrod or native')
const names = values.task?.length ? values.task : available
const tasks = names.map((name) => {
  if (!available.includes(name)) throw new Error(`No task "${name}". Tasks: ${available.join(', ')}`)
  const task = loadTask(join(TASKS_DIR, `${name}.json`))
  if (!fixtureExists(task)) throw new Error(`The fixture of ${name} is missing: ${task.fixture}`)
  return task
})

const messages = tasks.reduce((sum, t) => sum + t.turns.length + (t.probes?.length ?? 0), 0) * modes.length
console.log(`${tasks.length} task(s) × ${modes.join(' + ')} on ${values.engine}: ${messages} messages.`)
if (values.engine !== 'fake' && !values.yes) {
  console.log('This bills the engine\'s own login (see README.md for rough costs). Add --yes to run it.')
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const out = join(values.out!, `${stamp}-${values.engine}`)
mkdirSync(out, { recursive: true })
const summary: string[] = [`# Memory bench: ${values.engine}${values.model ? ` (${values.model})` : ''}, ${stamp}\n`]
const adapter = make()

for (const task of tasks) {
  const turns: TurnRecord[] = []
  const runs: RunRecord[] = []
  for (const mode of modes) {
    const file = join(out, `${task.name}-${mode}.jsonl`)
    console.log(`\n${task.name} / ${mode} → ${file}`)
    const { turns: done, run } = await runTask({
      task,
      mode,
      adapter,
      ...(values.model && { model: values.model }),
      ...(values.thinking && { thinking: values.thinking }),
      keep: values.keep,
      ...(values.unsandboxed && { sandbox: false }),
      onTurn(turn) {
        appendFileSync(file, JSON.stringify(turn) + '\n')
        const u = turn.usage
        const used = u ? `in ${u.input} read ${u.cacheRead} write ${u.cacheWrite} out ${u.output}` : 'no usage'
        const broke = turn.seed.cacheBreak ? ' cache break' : ''
        console.log(`  ${turn.phase} ${turn.index}: ${(turn.wallMs / 1000).toFixed(1)} s, ${used}${broke}${turn.error ? ` ERROR ${turn.error}` : ''}`)
      },
    })
    appendFileSync(file, JSON.stringify(run) + '\n')
    turns.push(...done)
    runs.push(run)
  }
  summary.push(summaryTable(task.name, turns, runs))
}

writeFileSync(join(out, 'summary.md'), summary.join('\n'))
console.log(`\n${summary.join('\n')}\nWritten to ${out}`)
