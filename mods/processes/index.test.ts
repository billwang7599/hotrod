import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatSummary, Mod, ModHost } from '@hotrod/mod-api'
import { createFakeAdapter } from '@hotrod/core/fake'
import { startCore } from '@hotrod/core/main'
import type { ClientMessage, Machine, Sandbox } from '@hotrod/core/shared'
import { sandboxingMachine as localMachine } from '@hotrod/core/test-machine'
import { createProcessesMod, duration, plain, portOf } from './index.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hotrod-processes-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function until(check: () => boolean, tries = 600) {
  for (let i = 0; i < tries && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  if (!check()) throw new Error('timed out')
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const at = '2026-01-01T00:00:00.000Z'

// A core on the fake engine with the Processes mod. Processes really run, on this computer, but unsandboxed: the
// machine notes the sandbox each was given, so the tests run where sandbox-exec doesn't.
async function start(options: { logMaxBytes?: number } = {}) {
  const garage = tempDir()
  const work = join(garage, 'work')
  // A space and its subagent, saved as if from before, so the subagent exists without running a model.
  const spaceId = 'space001'
  const workDir = join(work, spaceId)
  mkdirSync(workDir, { recursive: true })
  const saved = (id: string, fields: object) => {
    mkdirSync(join(garage, 'chats', id), { recursive: true })
    const chat = { id, engine: 'fake', createdAt: at, ...fields }
    writeFileSync(join(garage, 'chats', id, 'chat.json'), JSON.stringify(chat))
  }
  saved(spaceId, { name: 'Web', folders: [], files: [], archived: false, workDir })
  saved('sub001', { name: 'Builder', parentId: spaceId, subagent: true })

  const spawned: { command: string; args: string[]; cwd: string; sandbox?: Sandbox }[] = []
  const machine: Machine = {
    ...localMachine,
    canSandbox: true,
    spawn(command, args, { sandbox, ...rest }) {
      spawned.push({ command, args, cwd: rest.cwd, ...(sandbox && { sandbox }) })
      return localMachine.spawn(command, args, rest)
    },
  }
  const made = createProcessesMod({ settleMs: 300, stopWaitMs: 3000, ...options })
  let host: ModHost | undefined
  const mod: Mod = { ...made.mod, onChatCreated: (_chat, context) => void (host = context.host) }
  const env = { HOTROD_ENGINE: 'fake', HOTROD_GARAGE: garage, HOTROD_WORK: work, HOTROD_PORT: '0' }
  const hotrod = await startCore({ env, adapters: [createFakeAdapter([], 0)], mods: [mod], machine })
  let closed = false
  const close = async () => {
    if (!closed) await hotrod.close(true)
    closed = true
  }
  cleanups.push(close)
  const { core } = hotrod
  const handle = (m: ClientMessage) => core.handle(m, () => {})
  // Any chat made hands the test the mod's host.
  handle({ type: 'chat.create', name: 'Other' })
  const caller = (id: string): ChatSummary => {
    const chat = core.chats().find((c) => c.id === id)!
    return { id: chat.id, name: chat.name, engine: chat.engine, ...(chat.parentId && { parentId: chat.parentId }) }
  }
  const tool = async (name: string, input: Record<string, unknown>, from = spaceId): Promise<any> => {
    const found = mod.tools!.find((t) => t.name === name)!
    return found.run(input, { caller: caller(from), values: {}, host: host! })
  }
  const logDir = join(garage, 'mods', 'processes')
  return { core, garage, workDir, spaceId, handle, tool, spawned, made, close, logDir }
}

describe('output', () => {
  it('finds the local address a server prints', () => {
    expect(portOf('  ➜  Local:   http://localhost:5173/')).toEqual({ port: 5173, url: 'http://localhost:5173/' })
    expect(portOf('\x1b[32mready\x1b[0m on http://0.0.0.0:3000')).toEqual({ port: 3000, url: 'http://localhost:3000/' })
    expect(portOf('Serving at https://127.0.0.1:8443/app')).toEqual({ port: 8443, url: 'https://localhost:8443/app' })
    expect(portOf('Server listening on port 8080')).toEqual({ port: 8080, url: 'http://localhost:8080/' })
    expect(portOf('connected to localhost:5432')).toEqual({ port: 5432, url: 'http://localhost:5432/' })
    expect(portOf('Network: http://192.168.1.4:5173/')).toBeUndefined()
    expect(portOf('compiled 3 files in 120ms')).toBeUndefined()
    expect(portOf('http://localhost:99999')).toBeUndefined()
  })

  it('strips colours and turns carriage returns into lines', () => {
    expect(plain('\x1b[1m\x1b[32mok\x1b[0m\rnext')).toBe('ok\nnext')
  })

  it('says how long something ran', () => {
    expect([duration(5_000), duration(125_000), duration(3_725_000), duration(90_000_000)]).toEqual([
      '5s',
      '2m 5s',
      '1h 2m',
      '1d 1h',
    ])
  })
})

describe('the tools', () => {
  it('start a process that keeps running, list it, read its output and stop it with what it started', async () => {
    const t = await start()
    const started = await t.tool('start_process', {
      command: 'echo "pid $$"; sleep 300 & echo "child $!"; echo oops >&2; wait',
      name: 'server',
    })
    expect(started).toMatchObject({ id: 'p1', name: 'server', status: 'running', cwd: t.workDir, startedBy: 'Web' })
    expect(started.output).toContain('oops')
    const listed = await t.tool('list_processes', {})
    expect(listed).toMatchObject([{ id: 'p1', status: 'running', uptime: expect.any(String) }])
    const read = await t.tool('read_output', { id: 'server', lines: 2 })
    expect(read.output.split('\n')).toEqual([expect.stringMatching(/^child \d+$/), 'oops'])
    const child = Number(/child (\d+)/.exec(read.output)![1])
    expect(alive(child)).toBe(true)

    expect(await t.tool('stop_process', { id: 'p1' })).toMatchObject({ id: 'p1', status: 'stopped' })
    await until(() => !alive(child))
    expect(await t.tool('stop_process', { id: 'p1' })).toMatchObject({ note: 'It had already ended.' })
  })

  it('report a command that fails at once, and its exit code', async () => {
    const t = await start()
    const started = await t.tool('start_process', { command: 'echo nope; exit 3' })
    expect(started).toMatchObject({ status: 'exited', exitCode: 3, output: 'nope', name: 'echo nope; exit 3' })
  })

  it('give the address a server opens', async () => {
    const t = await start()
    const started = await t.tool('start_process', { command: 'echo "  Local: http://localhost:5173/"; sleep 300' })
    expect(started).toMatchObject({ status: 'running', url: 'http://localhost:5173/' })
  })

  it('run in the space’s sandbox, in its work folder unless told where', async () => {
    const t = await start()
    mkdirSync(join(t.workDir, 'app'))
    await t.tool('start_process', { command: 'sleep 300', cwd: 'app' })
    expect(t.spawned.at(-1)).toMatchObject({
      command: '/bin/sh',
      args: ['-c', 'exec 2>&1\nsleep 300'],
      cwd: join(t.workDir, 'app'),
      sandbox: { writable: [t.workDir], tmpDir: join(t.workDir, '.tmp') },
    })
    t.handle({ type: 'chat.setPermission', chatId: t.spaceId, name: 'editAnywhere', enabled: true })
    await t.tool('start_process', { command: 'sleep 301' })
    expect(t.spawned.at(-1)?.sandbox).toBeUndefined()
  })

  it('refuse a folder outside the space, a duplicate, and an unknown id', async () => {
    const t = await start()
    await expect(t.tool('start_process', { command: 'sleep 300', cwd: tempDir() })).rejects.toThrow(/inside the space/)
    await expect(t.tool('start_process', { command: 'sleep 300', cwd: '..' })).rejects.toThrow(/inside the space/)
    await expect(t.tool('start_process', { command: 'sleep 300', cwd: 'missing' })).rejects.toThrow(/No such folder/)
    await t.tool('start_process', { command: 'sleep 300', name: 'web' })
    await expect(t.tool('start_process', { command: 'sleep 300' })).rejects.toThrow(/already running/)
    await expect(t.tool('start_process', { command: 'sleep 9', name: 'web' })).rejects.toThrow(/already running/)
    await expect(t.tool('read_output', { id: 'p9' })).rejects.toThrow(/No process "p9"/)
  })

  it('belong to the space: a subagent’s process is the lead’s to see and stop', async () => {
    const t = await start()
    await t.tool('start_process', { command: 'sleep 300', name: 'watch' }, 'sub001')
    const listed = await t.tool('list_processes', {})
    expect(listed).toMatchObject([{ id: 'p1', name: 'watch', startedBy: 'Builder' }])
    expect(await t.tool('stop_process', { id: 'watch' })).toMatchObject({ status: 'stopped' })
  })
})

describe('logs', () => {
  it('go to a plain file per process, moved aside once past the cap', async () => {
    const t = await start({ logMaxBytes: 2000 })
    await t.tool('start_process', { command: 'for i in $(seq 1 300); do echo "line $i"; done; sleep 300' })
    const log = join(t.logDir, t.spaceId, 'p1.log')
    await until(() => existsSync(log) && readFileSync(log, 'utf8').includes('line 300'))
    expect(readFileSync(log, 'utf8').length).toBeLessThanOrEqual(2000)
    expect(readFileSync(`${log}.1`, 'utf8').length).toBeLessThanOrEqual(2000)
    const read = await t.tool('read_output', { id: 'p1', lines: 1 })
    expect(read.output).toBe('line 300')
  })
})

describe('stopping', () => {
  const running = async (t: Awaited<ReturnType<typeof start>>) => {
    const started = await t.tool('start_process', { command: 'echo "pid $$"; exec sleep 300' })
    return Number(/pid (\d+)/.exec(started.output)![1])
  }

  it('happens when the space is deleted, and its logs go', async () => {
    const t = await start()
    const pid = await running(t)
    t.handle({ type: 'chat.delete', chatId: t.spaceId })
    await until(() => !alive(pid))
    await until(() => !existsSync(join(t.logDir, t.spaceId)))
  })

  it('happens when the space is archived', async () => {
    const t = await start()
    const pid = await running(t)
    t.handle({ type: 'chat.archive', chatId: t.spaceId, archived: true })
    await until(() => !alive(pid))
    expect(t.made.processes(t.spaceId)).toMatchObject([{ status: 'stopped' }])
  })

  it('happens when the mod is turned off', async () => {
    const t = await start()
    const pid = await running(t)
    t.handle({ type: 'mod.setEnabled', modId: 'processes', enabled: false })
    await until(() => !alive(pid))
  })

  it('happens when Hotrod quits', async () => {
    const t = await start()
    const pid = await running(t)
    await t.close()
    expect(alive(pid)).toBe(false)
  })
})
