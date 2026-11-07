import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalMachine, RUN_TIMEOUT_MS, STRIPPED_ENV_KEYS } from './machine.ts'

const cwd = process.cwd()
const node = process.execPath
const fast = createLocalMachine({ killGraceMs: 100, runTimeoutMs: 300 })

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

  it('force-kills a process that ignores SIGTERM after the grace', async () => {
    const proc = fast.spawn(
      node,
      ['-e', `process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)`],
      { cwd },
    )
    await new Promise<void>((resolve) => proc.onStdout(() => resolve()))
    const exited = new Promise<number | null>((resolve) => proc.onExit(resolve))
    const start = performance.now()
    proc.kill()
    expect(await exited).toBeNull()
    expect(performance.now() - start).toBeGreaterThanOrEqual(90)
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
