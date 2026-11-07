import { spawn } from 'node:child_process'
import type { EngineProcess, Machine } from './types.ts'

type SpawnOptions = { cwd: string; env?: Record<string, string> }

function spawnProcess(command: string, args: string[], options: SpawnOptions): EngineProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  const stderrListeners: ((chunk: string) => void)[] = []
  const exitListeners: ((code: number | null) => void)[] = []
  let exited = false
  const exit = (code: number | null) => {
    if (exited) return
    exited = true
    for (const listener of exitListeners) listener(code)
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
    kill: () => child.kill(),
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
    child.onStdout((chunk) => (stdout += chunk))
    child.onStderr((chunk) => (stderr += chunk))
    child.onExit((code) => resolve({ code, stdout, stderr }))
    child.closeStdin()
  })
}

export const localMachine: Machine = { spawn: spawnProcess, run }
