import { appendFileSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { ChatSummary, Mod, ModHost, ModProcess, SpaceDetail } from '@hotrod/mod-api'

// Long-running commands (dev servers, watchers) that a space's agents start with start_process. An engine's own
// background shell dies with its session, which ends with every turn; these belong to the space instead, so they keep
// running between messages, outlive the subagent that started them, and stop when someone stops them, the space goes,
// the mod is turned off or Hotrod quits. Each one runs through the Machine (host.spawn), sandboxed as the space's own
// commands are, with its output in a plain log file in the mod's storage.

// Kept in memory per process for read_output; the log file has the rest.
export const TAIL_LINES = 1000
export const READ_DEFAULT_LINES = 100
export const READ_MAX_LINES = 500
// A log past this size moves to <id>.log.1 (replacing the one before), so each process keeps at most twice this.
export const LOG_MAX_BYTES = 1024 * 1024
export const MAX_RUNNING = 8
// Exited and stopped processes a space keeps listed, newest first; older ones go with their logs.
export const KEEP_ENDED = 10
// How long start_process waits to report a process that fails at once, or the port it opened.
export const SETTLE_MS = 2000
// How long stop_process waits for it to go; the Machine kills what ignores SIGTERM after its own grace.
export const STOP_WAIT_MS = 7000

export type Status = 'running' | 'exited' | 'stopped'

export type Proc = {
  id: string
  name: string
  command: string
  cwd: string
  spaceId: string
  // The chat that started it, as it was named then.
  startedBy: string
  status: Status
  code?: number | null
  startedAt: number
  endedAt?: number
  port?: number
  url?: string
  lines: string[]
  partial: string
  log: string
  stopping?: boolean
  handle?: ModProcess
  ended: Promise<void>
  end: () => void
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
export const plain = (text: string) => text.replace(ANSI, '').replace(/\r(?!\n)/g, '\n')

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::]', '[::1]', '::'])
const URL_PATTERN = /\bhttps?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{1,5})(\/[^\s'"<>)]*)?/i
const HOST_PORT = /\b(localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{1,5})\b/i
const SAYS_PORT = /\b(?:listening|running|started|serving|server|available)\b[^\n]{0,40}?\bport\s*:?\s*(\d{1,5})\b/i

const validPort = (text: string | undefined) => {
  const port = Number(text)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined
}

// The first local address a line of output names, as a link that opens on this computer.
export function portOf(line: string): { port: number; url: string } | undefined {
  const text = plain(line)
  const url = URL_PATTERN.exec(text)
  if (url) {
    const port = validPort(url[2])
    const host = LOCAL_HOSTS.has(url[1]!.toLowerCase()) ? 'localhost' : url[1]
    const scheme = /^https/i.test(url[0]) ? 'https' : 'http'
    if (port) return { port, url: `${scheme}://${host}:${port}${url[3] ?? '/'}` }
  }
  const bare = HOST_PORT.exec(text) ?? SAYS_PORT.exec(text)
  const port = validPort(bare?.[2] ?? bare?.[1])
  return port ? { port, url: `http://localhost:${port}/` } : undefined
}

export function duration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

const within = (inner: string, outer: string) => inner === outer || inner.startsWith(outer.replace(/\/?$/, sep))
const real = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

export function createProcessesMod(
  options: { now?: () => number; settleMs?: number; stopWaitMs?: number; logMaxBytes?: number } = {},
) {
  const now = options.now ?? Date.now
  const logMaxBytes = options.logMaxBytes ?? LOG_MAX_BYTES
  const settleMs = options.settleMs ?? SETTLE_MS
  const stopWaitMs = options.stopWaitMs ?? STOP_WAIT_MS
  // Per space, in the order they started.
  const spaces = new Map<string, Proc[]>()
  const counters = new Map<string, number>()
  const changeListeners: ((spaceId: string) => void)[] = []
  const changed = (spaceId: string) => changeListeners.forEach((listener) => listener(spaceId))

  const listOf = (spaceId: string) => spaces.get(spaceId) ?? []
  const logDir = (host: ModHost, spaceId: string) => join(host.storage.dir, spaceId)

  const spaceOf = (host: ModHost, caller: ChatSummary): SpaceDetail & { workDir: string } => {
    const space = host.space(caller.id)
    if (!space?.workDir) throw new Error('Processes run in a space’s work folder, and this chat has none')
    return space as SpaceDetail & { workDir: string }
  }

  const find = (spaceId: string, ref: unknown) => {
    const wanted = text(ref)
    const list = listOf(spaceId)
    const proc =
      list.find((p) => p.id === wanted) ??
      list.findLast((p) => p.name === wanted && p.status === 'running') ??
      list.findLast((p) => p.name === wanted)
    if (!proc) throw new Error(`No process "${wanted}" in this space. list_processes shows them.`)
    return proc
  }

  // Where a command may run: the space's work folder or one of its checkouts. Relative paths start where the agent's
  // shell does, the first checkout, else the work folder.
  const cwdOf = (space: SpaceDetail & { workDir: string }, asked: string) => {
    const roots = [space.workDir, ...space.checkouts.map((c) => c.path)]
    const start = space.checkouts.find((c) => existsSync(c.path))?.path ?? space.workDir
    const cwd = asked ? (isAbsolute(asked) ? asked : resolve(start, asked)) : start
    if (!roots.some((root) => within(real(cwd), real(root)))) {
      throw new Error(`cwd must be inside the space’s work folder (${space.workDir}) or one of its checkouts`)
    }
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`No such folder: ${cwd}`)
    return cwd
  }

  const addLines = (proc: Proc, chunk: string) => {
    const parts = plain(proc.partial + chunk).split('\n')
    proc.partial = parts.pop() ?? ''
    for (const line of parts) {
      proc.lines.push(line)
      if (proc.port === undefined) Object.assign(proc, portOf(line))
    }
    if (proc.port === undefined && proc.partial) Object.assign(proc, portOf(proc.partial))
    if (proc.lines.length > TAIL_LINES) proc.lines.splice(0, proc.lines.length - TAIL_LINES)
  }

  const writeLog = (proc: Proc, chunk: string) => {
    try {
      if (existsSync(proc.log) && statSync(proc.log).size + Buffer.byteLength(chunk) > logMaxBytes) {
        renameSync(proc.log, `${proc.log}.1`)
      }
      appendFileSync(proc.log, chunk)
    } catch {
      // A log that can't be written (the space went) leaves the tail in memory.
    }
  }

  const removeLogs = (proc: Proc) => {
    rmSync(proc.log, { force: true })
    rmSync(`${proc.log}.1`, { force: true })
  }

  // Ended processes beyond KEEP_ENDED go, oldest first.
  const prune = (spaceId: string) => {
    const list = listOf(spaceId)
    const ended = list.filter((p) => p.status !== 'running')
    for (const proc of ended.slice(0, Math.max(0, ended.length - KEEP_ENDED))) {
      removeLogs(proc)
      list.splice(list.indexOf(proc), 1)
    }
  }

  const launch = async (host: ModHost, proc: Proc) => {
    // stderr joins stdout, so the log reads as a terminal would.
    const handle = await host.spawn('/bin/sh', ['-c', `exec 2>&1\n${proc.command}`], {
      cwd: proc.cwd,
      chat: proc.spaceId,
    })
    proc.handle = handle
    handle.onOutput((chunk) => {
      writeLog(proc, chunk)
      addLines(proc, chunk)
      changed(proc.spaceId)
    })
    handle.onExit((code, stderrTail) => {
      if (proc.handle !== handle) return
      if (proc.partial) addLines(proc, '\n')
      if (stderrTail.trim()) addLines(proc, `${stderrTail.trimEnd()}\n`)
      proc.status = proc.stopping ? 'stopped' : 'exited'
      proc.code = code
      proc.endedAt = now()
      delete proc.handle
      delete proc.stopping
      proc.end()
      prune(proc.spaceId)
      changed(proc.spaceId)
    })
  }

  const newProc = (spaceId: string, fields: Pick<Proc, 'name' | 'command' | 'cwd' | 'startedBy' | 'log' | 'id'>) => {
    let end = () => {}
    const ended = new Promise<void>((resolve) => (end = resolve))
    const proc: Proc = { ...fields, spaceId, status: 'running', startedAt: now(), lines: [], partial: '', ended, end }
    return proc
  }

  type Spec = Pick<Proc, 'command' | 'cwd' | 'name' | 'startedBy'>
  const start = async (host: ModHost, space: SpaceDetail, spec: Spec) => {
    const list = listOf(space.id)
    const running = list.filter((p) => p.status === 'running')
    const same = running.find((p) => p.name === spec.name || (p.command === spec.command && p.cwd === spec.cwd))
    if (same) {
      throw new Error(
        `"${same.name}" (${same.id}) is already running ${same.command} in ${same.cwd}. Use it, or stop it with ` +
          'stop_process first.',
      )
    }
    if (running.length >= MAX_RUNNING) {
      throw new Error(`This space already runs ${MAX_RUNNING} processes. Stop one with stop_process first.`)
    }
    // A space's first process this run clears logs left from the last.
    if (!spaces.has(space.id)) rmSync(logDir(host, space.id), { recursive: true, force: true })
    mkdirSync(logDir(host, space.id), { recursive: true })
    const n = (counters.get(space.id) ?? 0) + 1
    counters.set(space.id, n)
    const id = `p${n}`
    const proc = newProc(space.id, { id, ...spec, log: join(logDir(host, space.id), `${id}.log`) })
    spaces.set(space.id, [...list, proc])
    try {
      await launch(host, proc)
    } catch (error) {
      spaces.set(space.id, listOf(space.id).filter((p) => p !== proc))
      throw error
    }
    changed(space.id)
    return proc
  }

  const stop = (proc: Proc) => {
    if (proc.status !== 'running' || !proc.handle) return
    proc.stopping = true
    proc.handle.stop()
  }

  const stopSpace = (spaceId: string) => listOf(spaceId).forEach(stop)

  const waitFor = (promise: Promise<unknown>, ms: number) =>
    Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))])

  const summary = (proc: Proc) => ({
    id: proc.id,
    name: proc.name,
    status: proc.status,
    ...(proc.code !== undefined && proc.status === 'exited' && { exitCode: proc.code }),
    command: proc.command,
    cwd: proc.cwd,
    startedBy: proc.startedBy,
    [proc.status === 'running' ? 'uptime' : 'ran']: duration((proc.endedAt ?? now()) - proc.startedAt),
    ...(proc.url && { url: proc.url }),
  })

  const tail = (proc: Proc, lines: number) => {
    const all = proc.partial ? [...proc.lines, proc.partial] : proc.lines
    return lines > 0 ? all.slice(-lines).join('\n') : ''
  }

  const mod: Mod = {
    id: 'processes',
    name: 'Processes',
    description:
      'Lets agents run dev servers, watchers and other long-running commands that keep going between messages. ' +
      'They belong to the space, not the chat that started them, and stop when you or an agent stops them, the ' +
      'space is deleted or archived, or Hotrod quits.',
    enabledByDefault: true,
    instructions: ({ tools }) =>
      tools
        ? 'Start anything long-running (a dev server, a watcher, anything that doesn’t exit on its own) with the ' +
          'start_process tool, never in your shell’s background (`&`, nohup, run_in_background): your session ends ' +
          'with your turn and takes those with it. A process from start_process belongs to the space, keeps running ' +
          'between messages, and the lead, its subagents and the user all see it. Call list_processes before ' +
          'starting one and use what is already running instead of starting it twice. read_output shows what it ' +
          'printed (and its address, once it opens a port); stop_process stops it when it’s no longer needed.'
        : undefined,
    tools: [
      {
        name: 'start_process',
        description:
          'Start a long-running command (a dev server, a watcher) for this space. It keeps running after your turn ' +
          'ends, until stop_process, and its output is kept. Runs with sh -c in cwd (default: where your shell ' +
          'starts; it must be inside the space’s work folder or a checkout). Refuses a duplicate of one already ' +
          'running. Returns its id, status, the first lines it printed, and its address once it opens a port.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', minLength: 1, description: 'The shell command, e.g. npm run dev' },
            cwd: { type: 'string', description: 'Folder to run it in, absolute or relative' },
            name: { type: 'string', description: 'A short name to know it by, e.g. web' },
          },
          required: ['command'],
        },
        offered: () => true,
        async run(input, { caller, host }) {
          const command = text(input.command)
          if (!command) throw new Error('command is empty')
          const space = spaceOf(host, caller)
          const cwd = cwdOf(space, text(input.cwd))
          const name = text(input.name) || (command.length > 40 ? `${command.slice(0, 39)}…` : command)
          const proc = await start(host, space, { command, cwd, name, startedBy: caller.name })
          // Long enough to catch a command that fails at once, or the port a server opens.
          const ready = new Promise<void>((resolve) => {
            const check = setInterval(() => (proc.port !== undefined || proc.status !== 'running') && done(), 50)
            const done = () => (clearInterval(check), resolve())
            void proc.ended.then(done)
            setTimeout(done, settleMs)
          })
          await ready
          return { ...summary(proc), output: tail(proc, 20) }
        },
      },
      {
        name: 'list_processes',
        description:
          'List this space’s processes from start_process, running ones and recently ended ones, with their ids, ' +
          'status, uptime and address.',
        inputSchema: { type: 'object', properties: {} },
        offered: () => true,
        run(_input, { caller, host }) {
          const list = listOf(spaceOf(host, caller).id)
          return list.length ? list.map(summary) : 'No processes in this space.'
        },
      },
      {
        name: 'read_output',
        description:
          'The last lines a process printed, stdout and stderr together ' +
          `(default ${READ_DEFAULT_LINES}, at most ${READ_MAX_LINES}).`,
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Its id or name' },
            lines: { type: 'integer', minimum: 1, maximum: READ_MAX_LINES },
          },
          required: ['id'],
        },
        offered: () => true,
        run(input, { caller, host }) {
          const proc = find(spaceOf(host, caller).id, input.id)
          const asked = Number(input.lines ?? READ_DEFAULT_LINES)
          const lines = Number.isFinite(asked) ? Math.min(READ_MAX_LINES, Math.max(1, Math.floor(asked))) : 0
          const output = tail(proc, lines || READ_DEFAULT_LINES)
          return { ...summary(proc), output: output || '(no output yet)' }
        },
      },
      {
        name: 'stop_process',
        description: 'Stop a process from start_process, with everything it started.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Its id or name' } },
          required: ['id'],
        },
        offered: () => true,
        async run(input, { caller, host }) {
          const proc = find(spaceOf(host, caller).id, input.id)
          if (proc.status !== 'running') return { ...summary(proc), note: 'It had already ended.' }
          stop(proc)
          await waitFor(proc.ended, stopWaitMs)
          return summary(proc)
        },
      },
    ],
    onChatArchived(chat, archived) {
      if (archived && chat.parentId === undefined) stopSpace(chat.id)
    },
    onChatRemoved(chat, { host }) {
      if (chat.parentId !== undefined) return
      stopSpace(chat.id)
      // Its logs go once everything in it has ended.
      const list = listOf(chat.id)
      void Promise.all(list.map((p) => p.ended)).then(() => {
        rmSync(logDir(host, chat.id), { recursive: true, force: true })
        spaces.delete(chat.id)
      })
    },
  }

  return {
    mod,
    // For the panel and tests.
    processes: (spaceId: string) => [...listOf(spaceId)],
    stop,
    onChange: (listener: (spaceId: string) => void) => void changeListeners.push(listener),
  }
}

export default createProcessesMod().mod
