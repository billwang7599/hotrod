import { spawn } from 'node:child_process'
import type { EngineProcess, Machine } from './types.ts'

type SpawnOptions = { cwd: string; env?: Record<string, string> }

export const KILL_GRACE_MS = 3000
export const RUN_TIMEOUT_MS = 10000
// These would make an engine bill an API key or another endpoint instead of its own login.
export const STRIPPED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
] as const

function engineEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const key of STRIPPED_ENV_KEYS) delete env[key]
  return { ...env, ...extra }
}

export function createLocalMachine({ killGraceMs = KILL_GRACE_MS, runTimeoutMs = RUN_TIMEOUT_MS } = {}): Machine {
  function spawnProcess(command: string, args: string[], options: SpawnOptions): EngineProcess {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: engineEnv(options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const stderrListeners: ((chunk: string) => void)[] = []
    const exitListeners: ((code: number | null) => void)[] = []
    let exited = false
    let forceKill: NodeJS.Timeout | undefined
    const exit = (code: number | null) => {
      if (exited) return
      exited = true
      for (const listener of exitListeners) listener(code)
    }
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, signal)
      } catch {}
    }
    child.stderr.on('data', (chunk: string) => stderrListeners.forEach((listener) => listener(chunk)))
    // A missing command or a dead stdin emits 'error'; unhandled, it would crash the core.
    child.on('error', (error) => {
      stderrListeners.forEach((listener) => listener(error.message))
      exit(null)
    })
    child.stdin.on('error', () => {})
    child.on('close', (code) => exit(code))

    return {
      write: (data) => {
        if (child.stdin.writable) child.stdin.write(data)
      },
      closeStdin: () => child.stdin.end(),
      kill: () => {
        if (exited || forceKill) return
        signalGroup('SIGTERM')
        // Runs even after the engine exits: a tool it started may still ignore SIGTERM.
        forceKill = setTimeout(() => signalGroup('SIGKILL'), killGraceMs).unref()
      },
      onStdout: (listener) => child.stdout.on('data', listener),
      onStderr: (listener) => stderrListeners.push(listener),
      onExit: (listener) => exitListeners.push(listener),
    }
  }

  function run(command: string, args: string[], options: SpawnOptions) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawnProcess(command, args, options)
      let stdout = ''
      let stderr = ''
      const timeout = setTimeout(() => {
        child.kill()
        resolve({ code: null, stdout, stderr: `${stderr}${command} timed out after ${runTimeoutMs}ms` })
      }, runTimeoutMs)
      child.onStdout((chunk) => (stdout += chunk))
      child.onStderr((chunk) => (stderr += chunk))
      child.onExit((code) => {
        clearTimeout(timeout)
        resolve({ code, stdout, stderr })
      })
      child.closeStdin()
    })
  }

  return { spawn: spawnProcess, run }
}

export const localMachine = createLocalMachine()
