import type { EngineProcess, Machine } from '../types.ts'

export function fakeMachine(runResults: Record<string, { code: number | null; stdout: string; stderr: string }> = {}) {
  const spawned: { command: string; args: string[]; cwd: string }[] = []
  const written: string[] = []
  const state = { stdinClosed: false, killed: false }
  let stdout = (_: string) => {}
  let exit = (_code: number | null, _stderrTail: string) => {}
  const proc: EngineProcess = {
    write: (data) => written.push(data),
    closeStdin: () => (state.stdinClosed = true),
    kill: () => (state.killed = true),
    onStdout: (l) => (stdout = l),
    onExit: (l) => (exit = l),
  }
  const machine: Machine = {
    spawn(command, args, options) {
      spawned.push({ command, args, cwd: options.cwd })
      return proc
    },
    async run(command, args) {
      return runResults[[command, ...args].join(' ')] ?? { code: 127, stdout: '', stderr: 'not found' }
    },
    stopAll: async () => {},
  }
  return {
    machine,
    spawned,
    state,
    sent: () => written.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    stdout: (chunk: string) => stdout(chunk),
    exit: (code: number | null, stderrTail = '') => exit(code, stderrTail),
  }
}
