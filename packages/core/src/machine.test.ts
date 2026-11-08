import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createLocalMachine, RUN_TIMEOUT_MS, STDERR_TAIL_CHARS, STRIPPED_ENV_KEYS } from './machine.ts'

const cwd = process.cwd()
const node = process.execPath
const TEST_KILL_GRACE_MS = 100
const fast = createLocalMachine({ killGraceMs: TEST_KILL_GRACE_MS, runTimeoutMs: 300 })

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitFor = async (check: () => boolean, timeoutMs = 2000) => {
  const start = performance.now()
  while (!check()) {
    if (performance.now() - start > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const spawnGrandchild = (code: string, options = '{}') =>
  `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(code)}], ${options})`

const leftovers: number[] = []
afterEach(() => {
  for (const pid of leftovers.splice(0)) if (alive(pid)) process.kill(pid, 'SIGKILL')
})

describe('localMachine', () => {
  it('keeps login-overriding keys out of the engine env, but lets options.env set them', async () => {
    for (const key of STRIPPED_ENV_KEYS) process.env[key] = 'leaked'
    process.env.HOTROD_TEST_KEPT = 'kept'
    try {
      const print = `console.log(JSON.stringify(process.env))`
      const { stdout } = await fast.run(node, ['-e', print], { cwd })
      const env = JSON.parse(stdout)
      for (const key of STRIPPED_ENV_KEYS) expect(env[key]).toBeUndefined()
      expect(env.HOTROD_TEST_KEPT).toBe('kept')

      const key = STRIPPED_ENV_KEYS[0]
      const explicit = await fast.run(node, ['-e', print], { cwd, env: { [key]: 'chosen' } })
      expect(JSON.parse(explicit.stdout)[key]).toBe('chosen')
    } finally {
      for (const key of STRIPPED_ENV_KEYS) delete process.env[key]
      delete process.env.HOTROD_TEST_KEPT
    }
  })

  it("keeps the core's UI token from engines, so an agent can't approve its own tool calls", () => {
    expect(STRIPPED_ENV_KEYS).toContain('HOTROD_TOKEN')
  })

  it('hands only the tail of stderr to exit listeners', async () => {
    const write = `process.stderr.write('a'.repeat(${STDERR_TAIL_CHARS}) + 'b'.repeat(${STDERR_TAIL_CHARS}))`
    const proc = fast.spawn(node, ['-e', write], { cwd })
    const [code, stderrTail] = await new Promise<[number | null, string]>((resolve) =>
      proc.onExit((code, stderrTail) => resolve([code, stderrTail])),
    )
    expect(code).toBe(0)
    expect(stderrTail).toBe('b'.repeat(STDERR_TAIL_CHARS))
  })

  it('waits the kill grace for a process that ignores SIGTERM, then sends SIGKILL', async () => {
    const proc = fast.spawn(
      node,
      ['-e', `process.on('SIGTERM', () => console.log('term')); console.log('ready'); setInterval(() => {}, 1000)`],
      { cwd },
    )
    const lines: string[] = []
    await new Promise<void>((resolve) =>
      proc.onStdout((chunk) => {
        lines.push(...chunk.trim().split('\n'))
        resolve()
      }),
    )
    const exited = new Promise<number | null>((resolve) => proc.onExit(resolve))
    const start = performance.now()
    proc.kill()
    expect(await exited).toBeNull()
    expect(lines).toEqual(['ready', 'term'])
    expect(performance.now() - start).toBeGreaterThanOrEqual(TEST_KILL_GRACE_MS - 10)
  })

  it('keeps the first kill grace when killed again', async () => {
    const machine = createLocalMachine({ killGraceMs: 300 })
    const stubborn = `process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)`
    const proc = machine.spawn(node, ['-e', stubborn], { cwd })
    await new Promise<void>((resolve) => proc.onStdout(() => resolve()))
    const exited = new Promise<number | null>((resolve) => proc.onExit(resolve))
    const start = performance.now()
    proc.kill()
    await new Promise((resolve) => setTimeout(resolve, 200))
    proc.kill()
    await exited
    expect(performance.now() - start).toBeLessThan(450)
  })

  it('kills the processes an engine started', async () => {
    const grandchild = spawnGrandchild('setInterval(() => {}, 1000)')
    const parent = `const c = ${grandchild}; console.log(c.pid); setInterval(() => {}, 1000)`
    const proc = fast.spawn(node, ['-e', parent], { cwd })
    const pid = await new Promise<number>((resolve) => proc.onStdout((chunk) => resolve(Number(chunk.trim()))))
    leftovers.push(pid)
    expect(alive(pid)).toBe(true)
    proc.kill()
    await waitFor(() => !alive(pid))
  })

  it('force-kills a started process that ignores SIGTERM after the engine has exited', async () => {
    const stubborn = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`
    const grandchild = spawnGrandchild(stubborn, `{ stdio: 'ignore' }`)
    const parent = `const c = ${grandchild}; setTimeout(() => console.log(c.pid), 200); setInterval(() => {}, 1000)`
    const proc = fast.spawn(node, ['-e', parent], { cwd })
    const pid = await new Promise<number>((resolve) => proc.onStdout((chunk) => resolve(Number(chunk.trim()))))
    leftovers.push(pid)
    const exited = new Promise<number | null>((resolve) => proc.onExit(resolve))
    proc.kill()
    await exited
    expect(alive(pid)).toBe(true)
    await waitFor(() => !alive(pid))
  })

  it('sends SIGTERM to a run that times out and SIGKILL only after the kill grace', async () => {
    const machine = createLocalMachine({ killGraceMs: 200, runTimeoutMs: 100 })
    const hang = `process.on('SIGTERM', () => console.log('term')); setInterval(() => {}, 1000)`
    const start = performance.now()
    const result = await machine.run(node, ['-e', hang], { cwd })
    expect(result.code).toBeNull()
    expect(result.stdout.trim()).toBe('term')
    expect(performance.now() - start).toBeGreaterThanOrEqual(290)
  })

  it('lets one run take longer than the default timeout', async () => {
    const result = await fast.run(node, ['-e', 'setTimeout(() => console.log("done"), 500)'], { cwd, timeoutMs: 2000 })
    expect(result).toMatchObject({ code: 0, stdout: 'done\n' })
  })

  it('gives up on a run that takes too long', async () => {
    const start = performance.now()
    const hang = `process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000)`
    const result = await fast.run(node, ['-e', hang], { cwd })
    expect(result.code).toBeNull()
    expect(result.stderr).toMatch(/timed out after 300ms/)
    expect(performance.now() - start).toBeLessThan(RUN_TIMEOUT_MS)
    const pid = Number(result.stdout.trim())
    leftovers.push(pid)
    await waitFor(() => !alive(pid))
  })

  it('writes the input to a run, then closes its stdin', async () => {
    const echo = `process.stdin.pipe(process.stdout)`
    expect((await fast.run(node, ['-e', echo], { cwd, input: 'one\ntwo\n' })).stdout).toBe('one\ntwo\n')
    expect((await fast.run(node, ['-e', echo], { cwd })).stdout).toBe('')
  })

  it('reports a missing command without rejecting', async () => {
    const result = await fast.run('hotrod-no-such-command', [], { cwd })
    expect(result.code).toBeNull()
    expect(result.stderr).toMatch(/ENOENT/)
  })

  it('stopAll waits for an engine that ignores SIGTERM until it is force-killed', async () => {
    const machine = createLocalMachine({ killGraceMs: 200 })
    const stubborn = `process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000)`
    const proc = machine.spawn(node, ['-e', stubborn], { cwd })
    const pid = await new Promise<number>((resolve) => proc.onStdout((chunk) => resolve(Number(chunk.trim()))))
    leftovers.push(pid)
    const start = performance.now()
    await machine.stopAll()
    expect(performance.now() - start).toBeGreaterThanOrEqual(190)
    expect(alive(pid)).toBe(false)
  })

  it('stopAll returns as soon as engines and the processes they started have exited', async () => {
    const machine = createLocalMachine({ killGraceMs: 5000 })
    const grandchild = spawnGrandchild('setInterval(() => {}, 1000)', `{ stdio: 'ignore' }`)
    const parent = `const c = ${grandchild}; setTimeout(() => console.log(c.pid), 200); setInterval(() => {}, 1000)`
    const proc = machine.spawn(node, ['-e', parent], { cwd })
    const pid = await new Promise<number>((resolve) => proc.onStdout((chunk) => resolve(Number(chunk.trim()))))
    leftovers.push(pid)
    const start = performance.now()
    await machine.stopAll()
    expect(alive(pid)).toBe(false)
    expect(performance.now() - start).toBeLessThan(1000)
  })

  it('says whether it can sandbox: only on macOS so far', () => {
    expect(createLocalMachine({ platform: 'darwin' }).canSandbox).toBe(true)
    expect(createLocalMachine({ platform: 'linux' }).canSandbox).toBe(false)
  })

  it('refuses to start a sandboxed process where it has no sandbox, rather than run it unsandboxed', async () => {
    const linux = createLocalMachine({ platform: 'linux' })
    const options = { cwd, sandbox: { writable: [cwd] } }
    expect(() => linux.spawn(node, ['-e', ''], options)).toThrow(/can't sandbox engines on linux/)
    await expect(linux.run(node, ['-e', ''], options)).rejects.toThrow(/can't sandbox engines on linux/)
  })
})

describe.skipIf(process.platform !== 'darwin')('a sandboxed process', () => {
  const root = mkdtempSync(join(tmpdir(), 'hotrod-sandbox-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  let dirs = 0
  const newDir = () => {
    const dir = join(root, `dir-${++dirs}`)
    mkdirSync(dir)
    return dir
  }
  const tryWrites = (paths: string[]) => `
    const fs = require('node:fs')
    console.log(JSON.stringify(${JSON.stringify(paths)}.map((path) => {
      try {
        fs.writeFileSync(path, 'x')
        return 'ok'
      } catch (error) {
        return error.code
      }
    })))`
  const writes = async (writable: string[], paths: string[]) => {
    const { stdout, stderr } = await fast.run(node, ['-e', tryWrites(paths)], { cwd, sandbox: { writable } })
    if (!stdout) throw new Error(stderr)
    return JSON.parse(stdout)
  }

  it('writes only inside its writable folders', async () => {
    const [inside, outside] = [newDir(), newDir()]
    const paths = [join(inside, 'a'), join(outside, 'b'), join(root, 'c')]
    expect(await writes([inside], paths)).toEqual(['ok', 'EPERM', 'EPERM'])
  })

  it('passes the limit on to every process it starts', async () => {
    const [inside, outside] = [newDir(), newDir()]
    const write = (path: string) => JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(path)}, 'x')`)
    const child = (path: string) =>
      `console.log(require('node:child_process').spawnSync(process.execPath, ['-e', ${write(path)}], { stdio: 'inherit' }).status)`
    const run = (path: string) => fast.run(node, ['-e', child(path)], { cwd, sandbox: { writable: [inside] } })
    expect((await run(join(inside, 'a'))).stdout.trim()).toBe('0')
    const denied = await run(join(outside, 'b'))
    expect(denied.stdout.trim()).toBe('1')
    expect(denied.stderr).toMatch(/EPERM/)
  })

  it('matches folders by their real path, so a symlinked one stays writable', async () => {
    const real = newDir()
    const link = join(root, `link-${dirs}`)
    symlinkSync(real, link)
    expect(await writes([link], [join(link, 'a'), join(real, 'b'), join(root, 'c')])).toEqual(['ok', 'ok', 'EPERM'])
  })

  it('allows a writable folder that does not exist yet', async () => {
    const later = join(newDir(), 'later')
    const script = `require('node:fs').mkdirSync(${JSON.stringify(later)}); ${tryWrites([join(later, 'a'), join(root, 'b')])}`
    const { stdout } = await fast.run(node, ['-e', script], { cwd, sandbox: { writable: [later] } })
    expect(JSON.parse(stdout)).toEqual(['ok', 'EPERM'])
  })

  it('treats a writable path ending in * as a prefix, for lock and temp files next to a file', async () => {
    const dir = newDir()
    const file = join(dir, 'login.keychain-db')
    const paths = [file, `${file}.sb-123`, join(dir, 'login.keychain'), join(dir, 'other')]
    expect(await writes([`${file}*`], paths)).toEqual(['ok', 'ok', 'EPERM', 'EPERM'])
  })

  it('keeps read-only paths inside a writable folder read-only, a file or a whole folder', async () => {
    const dir = newDir()
    const [ref, locked] = [join(dir, 'main'), join(dir, 'locked')]
    mkdirSync(locked)
    const paths = [ref, `${ref}.lock`, join(locked, 'a'), join(dir, 'other')]
    const { stdout } = await fast.run(node, ['-e', tryWrites(paths)], {
      cwd,
      sandbox: { writable: [dir], readOnly: [ref, `${ref}.lock`, locked] },
    })
    expect(JSON.parse(stdout)).toEqual(['EPERM', 'EPERM', 'EPERM', 'ok'])
  })

  it('takes any path as it is, quotes and newlines included', async () => {
    const odd = join(newDir(), 'we"ird\\ (dir)\n")(allow file-write*)')
    mkdirSync(odd)
    expect(await writes([odd], [join(odd, 'a'), join(root, 'escaped')])).toEqual(['ok', 'EPERM'])
  })

  it('can still use /dev/null, its own output and a terminal', async () => {
    const script = `
      const fs = require('node:fs')
      fs.writeFileSync('/dev/null', 'x')
      fs.writeFileSync('/dev/stdout', 'out ')
      fs.writeFileSync('/dev/fd/1', 'fd ')
      fs.closeSync(fs.openSync('/dev/ptmx', 'r+'))
      console.log('pty')`
    const { stdout, stderr } = await fast.run(node, ['-e', script], { cwd, sandbox: { writable: [] } })
    expect(stderr).toBe('')
    expect(stdout).toBe('out fd pty\n')
  })

  it('points temp files and caches into its temp folder, made if missing, which it can write', async () => {
    const tmpDir = join(newDir(), '.tmp')
    const script = `${tryWrites([join(tmpDir, 'a')])}; console.log(JSON.stringify(process.env))`
    const { stdout, stderr } = await fast.run(node, ['-e', script], { cwd, sandbox: { writable: [], tmpDir } })
    const [writes, env] = stdout.trim().split('\n').map((line) => JSON.parse(line))
    expect(stderr).toBe('')
    expect(writes).toEqual(['ok'])
    expect(env).toMatchObject({
      TMPDIR: tmpDir,
      TMPPREFIX: join(tmpDir, 'zsh'),
      XDG_CACHE_HOME: join(tmpDir, 'cache'),
      npm_config_cache: join(tmpDir, 'cache', 'npm'),
    })
  })

  it('lets zsh here-documents and mktemp work in a process with a temp folder', async () => {
    const sandbox = { writable: [], tmpDir: join(newDir(), '.tmp') }
    const heredoc = await fast.run('/bin/zsh', ['-c', 'cat <<EOF\nhere\nEOF'], { cwd, sandbox })
    expect(heredoc).toMatchObject({ code: 0, stdout: 'here\n' })
    const mktemp = await fast.run('/usr/bin/mktemp', ['-t', 'hotrod'], { cwd, sandbox })
    expect(mktemp.stderr).toBe('')
    rmSync(mktemp.stdout.trim(), { force: true })
  })

  it('is still stopped with the processes it started', async () => {
    const grandchild = spawnGrandchild('setInterval(() => {}, 1000)')
    const parent = `const c = ${grandchild}; console.log(c.pid); setInterval(() => {}, 1000)`
    const proc = fast.spawn(node, ['-e', parent], { cwd, sandbox: { writable: [] } })
    const pid = await new Promise<number>((resolve) => proc.onStdout((chunk) => resolve(Number(chunk.trim()))))
    leftovers.push(pid)
    proc.kill()
    await waitFor(() => !alive(pid))
  })
})

describe('when the core dies', () => {
  const machineUrl = new URL('./machine.ts', import.meta.url).href
  const runCore = async (death: string) => {
    const engine = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`
    const script = `
      import { localMachine } from ${JSON.stringify(machineUrl)}
      const proc = localMachine.spawn(process.execPath, ['-e', ${JSON.stringify(`console.log(process.pid); ${engine}`)}], { cwd: process.cwd() })
      proc.onStdout((chunk) => { console.log(chunk.trim()); ${death} })
      setInterval(() => {}, 1000)`
    const core = spawn(node, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'ignore'] })
    const pid = await new Promise<number>((resolve) => core.stdout.on('data', (chunk) => resolve(Number(String(chunk).trim()))))
    leftovers.push(pid)
    await new Promise((resolve) => core.on('exit', resolve))
    return pid
  }

  it('kills its engines when it crashes', async () => {
    const pid = await runCore(`setTimeout(() => { throw new Error('crash') })`)
    await waitFor(() => !alive(pid))
  })

  it('kills its engines when it exits', async () => {
    const pid = await runCore(`process.exit(3)`)
    await waitFor(() => !alive(pid))
  })
})
