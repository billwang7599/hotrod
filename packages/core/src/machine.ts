import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { EngineProcess, Machine, Sandbox, SpawnOptions } from './shared.ts'

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
  'KOTHAR_TOKEN',
  // Its name from when Kothar was Hotrod.
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

// Shells, Node and ptys write these devices; none of them is a file on disk.
const DEVICE_RULES = [
  '(literal "/dev/null")',
  '(literal "/dev/zero")',
  '(literal "/dev/tty")',
  '(literal "/dev/dtracehelper")',
  '(literal "/dev/stdout")',
  '(literal "/dev/stderr")',
  '(regex #"^/dev/fd/")',
  '(literal "/dev/ptmx")',
  '(regex #"^/dev/ttys")',
]

// The sandbox matches real paths (/tmp is /private/tmp), and a writable path may not exist yet.
export function realPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(realPath(parent), basename(path))
  }
}

// BSD mktemp and Cocoa tools use the per-user temp folder whatever TMPDIR says; allowing it exposes others' temp files.
export const USER_TEMP_WRITABLE = true
let userTempDir: string | undefined
const userTemp = () =>
  (userTempDir ??= execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim())

// zsh puts here-documents at TMPPREFIX, not TMPDIR; the caches keep tools off the user's shared ones.
const tempEnv = (tmpDir: string): Record<string, string> => ({
  TMPDIR: tmpDir,
  TMPPREFIX: join(tmpDir, 'zsh'),
  XDG_CACHE_HOME: join(tmpDir, 'cache'),
  npm_config_cache: join(tmpDir, 'cache', 'npm'),
  PIP_CACHE_DIR: join(tmpDir, 'cache', 'pip'),
  GOCACHE: join(tmpDir, 'cache', 'go-build'),
  GOMODCACHE: join(tmpDir, 'cache', 'go-extension'),
})

function sandboxed(command: string, args: string[], sandbox: Sandbox, platform: NodeJS.Platform) {
  if (platform !== 'darwin') {
    throw new Error(`Kothar can't sandbox engines on ${platform} yet, so it won't start one that should be sandboxed`)
  }
  const { tmpDir } = sandbox
  if (tmpDir) mkdirSync(tmpDir, { recursive: true })
  const temp = tmpDir ? [tmpDir, ...(USER_TEMP_WRITABLE ? [userTemp()] : [])] : []
  const writable = [...sandbox.writable, ...temp]
  // Paths go in as parameters, so no path can break out of the profile's quoting.
  const filters = (paths: string[], key: string) => ({
    rules: paths.map((path, i) => `(${path.endsWith('*') ? 'prefix' : 'subpath'} (param "${key}${i}"))`).join(' '),
    params: paths.flatMap((path, i) => ['-D', `${key}${i}=${realPath(path.replace(/\*$/, ''))}`]),
  })
  const allowed = filters(writable, 'W')
  const kept = filters(sandbox.readOnly ?? [], 'R')
  // The last matching rule wins, so read-only paths come after the writable ones.
  const profile =
    `(version 1)(allow default)(deny file-write* (subpath "/"))` +
    `(allow file-write* ${DEVICE_RULES.join(' ')} ${allowed.rules})` +
    (kept.rules ? `(deny file-write* ${kept.rules})` : '')
  const params = [...allowed.params, ...kept.params]
  const env = tmpDir ? tempEnv(tmpDir) : {}
  return { command: '/usr/bin/sandbox-exec', args: ['-p', profile, ...params, command, ...args], env }
}

function engineEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const key of STRIPPED_ENV_KEYS) delete env[key]
  return { ...env, ...extra }
}

export function createLocalMachine({
  killGraceMs = KILL_GRACE_MS,
  runTimeoutMs = RUN_TIMEOUT_MS,
  platform = process.platform,
} = {}) {
  const running = new Set<{ kill(): void; settled: Promise<void> }>()

  function spawnProcess(command: string, args: string[], options: SpawnOptions): EngineProcess {
    const jailed = options.sandbox && sandboxed(command, args, options.sandbox, platform)
    const child = spawn(jailed ? jailed.command : command, jailed ? jailed.args : args, {
      cwd: options.cwd,
      env: engineEnv({ ...jailed?.env, ...options.env }),
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

  function run(command: string, args: string[], options: Parameters<Machine['run']>[2]) {
    const timeoutMs = options.timeoutMs ?? runTimeoutMs
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawnProcess(command, args, options)
      let stdout = ''
      let timedOut = false
      const timeout = setTimeout(() => {
        timedOut = true
        child.kill()
      }, timeoutMs)
      child.onStdout((chunk) => {
        stdout += chunk
        options.onStdout?.(chunk)
      })
      options.signal?.addEventListener('abort', child.kill, { once: true })
      child.onExit((code, stderr) => {
        clearTimeout(timeout)
        if (!timedOut) return resolve({ code, stdout, stderr })
        resolve({ code: null, stdout, stderr: `${stderr}${command} timed out after ${timeoutMs}ms` })
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

  return { canSandbox: platform === 'darwin', spawn: spawnProcess, run, stopAll } satisfies Machine
}

export const localMachine = createLocalMachine()
