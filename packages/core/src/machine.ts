import { spawn } from 'node:child_process'
import type { EngineProcess, Machine } from './types.ts'

type SpawnOptions = { cwd: string; env?: Record<string, string> }

export const KILL_GRACE_MS = 5000
export const RUN_TIMEOUT_MS = 10000
export const STDERR_TAIL_CHARS = 2000
const GROUP_POLL_MS = 50
// These would make an engine bill an API key or another endpoint instead of its own login.
export const STRIPPED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'HOTROD_TOKEN',
] as const

const liveGroups = new Set<number>()
// Engines run detached in their own process group, so nothing else stops them when the core dies.
process.on('exit', () => {
  for (const pgid of liveGroups) signal(pgid, 'SIGKILL')
})

function signal(pgid: number, name: NodeJS.Signals | 0) {
  try {
    process.kill(-pgid, name)
    return true
  } catch {
    return false
  }
}

function engineEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const key of STRIPPED_ENV_KEYS) delete env[key]
  return { ...env, ...extra }
}

export function createLocalMachine({ killGraceMs = KILL_GRACE_MS, runTimeoutMs = RUN_TIMEOUT_MS } = {}): Machine {
  const running = new Set<{ kill(): void; settled: Promise<void> }>()

  function spawnProcess(command: string, args: string[], options: SpawnOptions): EngineProcess {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: engineEnv(options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const exitListeners: ((code: number | null, stderrTail: string) => void)[] = []
    const pgid = child.pid
    let stderrTail = ''
    const addStderr = (text: string) => (stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS))
    let exited = false
    let forceKill: NodeJS.Timeout | undefined
    let groupPoll: NodeJS.Timeout | undefined
    let done = false
    let settle = () => {}
    const tracked = { kill, settled: new Promise<void>((resolve) => (settle = resolve)) }
    const finish = () => {
      done = true
      clearTimeout(forceKill)
      clearInterval(groupPoll)
      if (pgid !== undefined) liveGroups.delete(pgid)
      running.delete(tracked)
      settle()
    }
    const groupAlive = () => pgid !== undefined && signal(pgid, 0)
    const exit = (code: number | null) => {
      if (exited) return
      exited = true
      for (const listener of exitListeners) listener(code, stderrTail)
      if (!groupAlive()) return finish()
      groupPoll = setInterval(() => groupAlive() || finish(), GROUP_POLL_MS)
    }
    function kill() {
      if (pgid === undefined || done || forceKill) return
      signal(pgid, 'SIGTERM')
      // Runs even after the engine exits: a tool it started may still ignore SIGTERM.
      forceKill = setTimeout(() => signal(pgid, 'SIGKILL'), killGraceMs)
    }
    if (pgid !== undefined) liveGroups.add(pgid)
    running.add(tracked)
    child.stderr.on('data', addStderr)
    // A missing command or a dead stdin emits 'error'; unhandled, it would crash the core.
    child.on('error', (error) => {
      addStderr(error.message)
      exit(null)
    })
    child.stdin.on('error', () => {})
    child.on('close', (code) => exit(code))

    return {
      write: (data) => {
        if (child.stdin.writable) child.stdin.write(data)
      },
      closeStdin: () => child.stdin.end(),
      kill,
      onStdout: (listener) => child.stdout.on('data', listener),
      onExit: (listener) => exitListeners.push(listener),
    }
  }

  function run(command: string, args: string[], options: SpawnOptions & { input?: string }) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawnProcess(command, args, options)
      let stdout = ''
      let timedOut = false
      const timeout = setTimeout(() => {
        timedOut = true
        child.kill()
      }, runTimeoutMs)
      child.onStdout((chunk) => (stdout += chunk))
      child.onExit((code, stderr) => {
        clearTimeout(timeout)
        if (!timedOut) return resolve({ code, stdout, stderr })
        resolve({ code: null, stdout, stderr: `${stderr}${command} timed out after ${runTimeoutMs}ms` })
      })
      if (options.input) child.write(options.input)
      child.closeStdin()
    })
  }

  async function stopAll() {
    const stopping = [...running]
    for (const proc of stopping) proc.kill()
    await Promise.all(stopping.map((proc) => proc.settled))
  }

  return { spawn: spawnProcess, run, stopAll }
}

export const localMachine = createLocalMachine()
