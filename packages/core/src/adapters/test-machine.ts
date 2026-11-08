import { localMachine } from '../machine.ts'
import type { EngineProcess, Machine, Sandbox } from '../shared.ts'

// Fake engines start no process, so this machine can claim a sandbox on any platform.
export const sandboxingMachine: Machine = { ...localMachine, canSandbox: true }

export function fakeMachine(runResults: Record<string, { code: number | null; stdout: string; stderr: string }> = {}) {
  const spawned: { command: string; args: string[]; cwd: string; env?: Record<string, string>; sandbox?: Sandbox }[] =
    []
  const ran: {
    command: string
    args: string[]
    env?: Record<string, string>
    input?: string
    timeoutMs?: number
    sandbox?: Sandbox
  }[] = []
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
    canSandbox: true,
    spawn(command, args, { cwd, env, sandbox }) {
      spawned.push({ command, args, cwd, ...(env && { env }), ...(sandbox && { sandbox }) })
      return proc
    },
    async run(command, args, options) {
      const { env, input, timeoutMs, sandbox } = options
      ran.push({
        command,
        args,
        ...(env && { env }),
        ...(input && { input }),
        ...(timeoutMs && { timeoutMs }),
        ...(sandbox && { sandbox }),
      })
      const result = runResults[[command, ...args].join(' ')] ?? runResults[command]
      return result ?? { code: 127, stdout: '', stderr: 'not found' }
    },
    stopAll: async () => {},
  }
  return {
    machine,
    spawned,
    ran,
    state,
    written: () => written.join(''),
    sent: () => written.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    stdout: (chunk: string) => stdout(chunk),
    exit: (code: number | null, stderrTail = '') => exit(code, stderrTail),
  }
}
