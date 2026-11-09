import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createFakeAdapter } from './adapters/fake.ts'
import { defaultGarage, envVar, startCore } from './main.ts'
import { BAD_TOKEN_CLOSE_CODE, type Adapter, type CoreMessage } from './shared.ts'

const port = 4451
const adapters: Adapter[] = [
  createFakeAdapter(),
  { ...createFakeAdapter(), id: 'broken', detect: () => Promise.reject(new Error('no binary')) },
]
const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'kothar-test-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function firstMessage(origin: string, token: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`, { origin })
  cleanups.push(() => socket.terminate())
  return new Promise<CoreMessage | number>((resolve) => {
    socket.on('message', (data) => resolve(JSON.parse(String(data))))
    socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
    socket.on('close', (code) => resolve(code))
    socket.on('error', () => {})
  })
}

it('a fresh install gets the Kothar garage', () => {
  expect(defaultGarage('/Users/u', () => false)).toBe('/Users/u/Library/Application Support/Kothar')
})

it('a garage from when Kothar was Hotrod stays in use where it is, unless a Kothar one exists', () => {
  const old = '/Users/u/Library/Application Support/Hotrod'
  const kothar = '/Users/u/Library/Application Support/Kothar'
  expect(defaultGarage('/Users/u', (path) => path === old)).toBe(old)
  expect(defaultGarage('/Users/u', (path) => path === old || path === kothar)).toBe(kothar)
})

it('reads each KOTHAR_ variable, falling back to its HOTROD_ name', () => {
  expect(envVar({ HOTROD_GARAGE: '/old' }, 'GARAGE')).toBe('/old')
  expect(envVar({ KOTHAR_GARAGE: '/new', HOTROD_GARAGE: '/old' }, 'GARAGE')).toBe('/new')
  expect(envVar({}, 'GARAGE')).toBeUndefined()
})

it('starts from HOTROD_ variables set before the rename', async () => {
  const garage = tempDir()
  const env = { HOTROD_ENGINE: 'fake', HOTROD_GARAGE: garage, HOTROD_PORT: String(port), HOTROD_TOKEN: 'old-token' }
  const kothar = await startCore({ env, adapters })
  cleanups.push(() => kothar.close(true))
  expect(kothar.garage).toBe(garage)
  expect(kothar.port).toBe(port)
  expect(kothar.token).toBe('old-token')
  expect(kothar.core.engines().find((e) => e.id === 'fake')?.enabled).toBe(true)
})

it('starts the core from the environment and stops it', async () => {
  const garage = tempDir()
  const env = {
    KOTHAR_ENGINE: 'fake',
    KOTHAR_GARAGE: garage,
    KOTHAR_PORT: String(port),
    KOTHAR_UI_ORIGIN: 'http://ui.test',
  }
  const kothar = await startCore({ env, adapters })
  expect(kothar.port).toBe(port)
  expect(await firstMessage('http://ui.test', kothar.token)).toMatchObject({
    type: 'snapshot',
    engines: [
      { id: 'fake', enabled: true, installed: true, signedIn: true },
      { id: 'broken', enabled: false, installed: false, signedIn: false, detail: 'no binary' },
    ],
  })
  expect(await firstMessage('http://localhost:4318', kothar.token)).toBe(403)
  expect(await firstMessage('http://ui.test', 'wrong')).toBe(BAD_TOKEN_CLOSE_CODE)

  kothar.core.handle({ type: 'chat.create', name: 'App', folders: [tempDir()] }, () => {})
  expect(kothar.core.chats()).toHaveLength(2)

  await kothar.close()
  const again = await startCore({ env, adapters })
  await again.close()
  expect(again.token).not.toBe(kothar.token)
  expect(again.token.length).toBeGreaterThanOrEqual(32)
})

it('turns no engine on without KOTHAR_ENGINE', async () => {
  const kothar = await startCore({ env: { KOTHAR_GARAGE: tempDir(), KOTHAR_PORT: String(port) }, adapters })
  cleanups.push(() => kothar.close())
  expect(kothar.core.engines().map((e) => e.enabled)).toEqual([false, false])
})

it('takes its token from KOTHAR_TOKEN and hands the UI a link that carries it', async () => {
  const env = { KOTHAR_ENGINE: 'fake', KOTHAR_GARAGE: tempDir(), KOTHAR_PORT: String(port), KOTHAR_TOKEN: 'dev-token' }
  const kothar = await startCore({ env, adapters })
  cleanups.push(() => kothar.close())
  expect(kothar.token).toBe('dev-token')
  expect(kothar.openUrl).toBe('http://localhost:4318/#token=dev-token')
  expect(await firstMessage('http://localhost:4318', 'dev-token')).toMatchObject({ type: 'snapshot' })
})

it('accepts only its own origin when it serves the UI', async () => {
  const kothar = await startCore({
    env: { KOTHAR_ENGINE: 'fake', KOTHAR_GARAGE: tempDir(), KOTHAR_PORT: String(port) },
    uiDir: tempDir(),
    adapters,
  })
  cleanups.push(() => kothar.close())
  expect(kothar.uiUrl).toBe(`http://127.0.0.1:${port}`)
  expect(kothar.openUrl).toBe(`http://127.0.0.1:${port}/#token=${kothar.token}`)
  expect(await firstMessage(kothar.uiUrl, kothar.token)).toMatchObject({ type: 'snapshot' })
  expect(await firstMessage('http://localhost:4318', kothar.token)).toBe(403)
})

it('rejects an unknown engine', async () => {
  await expect(startCore({ env: { KOTHAR_ENGINE: 'nope', KOTHAR_GARAGE: tempDir() } })).rejects.toThrow(
    /Unknown engine "nope"/,
  )
})

async function runCore(engine: string) {
  const garage = tempDir()
  const script = `
    import { closeOnSignals, startCore } from ${JSON.stringify(new URL('./main.ts', import.meta.url).href)}
    const engine = {
      id: 'node',
      detect: async () => ({ installed: true, signedIn: true }),
      start(machine, { cwd }, emit) {
        const proc = machine.spawn(process.execPath, ['-e', ${JSON.stringify(engine)}], { cwd })
        proc.onStdout((chunk) => {
          console.log(chunk.trim())
          if (chunk.includes('turn ended')) emit({ type: 'turn.completed', error: 'Interrupted' })
        })
        return { prompt() {}, interrupt: () => proc.write('interrupt\\n'), respond() {}, close: () => proc.kill() }
      },
    }
    const env = {
      KOTHAR_ENGINE: 'node',
      KOTHAR_GARAGE: ${JSON.stringify(garage)},
      KOTHAR_WORK: ${JSON.stringify(join(garage, 'work'))},
      KOTHAR_PORT: '4551',
    }
    const kothar = await startCore({ env, adapters: [engine] })
    closeOnSignals(kothar.close)
    kothar.core.handle({ type: 'chat.setPermission', chatId: 'main', name: 'editAnywhere', enabled: true }, () => {})
    kothar.core.handle({ type: 'chat.send', chatId: 'main', text: 'hi' }, () => {})`
  const core = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  cleanups.push(() => void core.kill('SIGKILL'))
  const exited = new Promise<number | null>((resolve) => core.on('exit', resolve))
  const lines: string[] = []
  const waiters: { match: RegExp; resolve: (line: string) => void }[] = []
  let buffered = ''
  core.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    const parts = (buffered + chunk).split('\n')
    buffered = parts.pop() ?? ''
    for (const line of parts) {
      lines.push(line)
      for (const waiter of waiters.filter((w) => w.match.test(line))) waiter.resolve(line)
    }
  })
  const nextLine = (match: RegExp) =>
    new Promise<string>((resolve) => {
      const seen = lines.find((line) => match.test(line))
      if (seen) resolve(seen)
      else waiters.push({ match, resolve })
    })
  const enginePid = Number(await nextLine(/^\d+$/))
  cleanups.push(() => void (alive(enginePid) && process.kill(enginePid, 'SIGKILL')))
  return { core, exited, enginePid, garage, lines, nextLine }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const onInterrupt = (reaction: string) =>
  `process.stdin.on('data', () => { console.log('engine got interrupt'); ${reaction} })`

it('asks engines to stop, then waits for them to shut down before exiting on a signal', async () => {
  const marker = 'stopped-cleanly'
  const engine = `console.log(process.pid); setInterval(() => {}, 1000)
    ${onInterrupt(`console.log('turn ended')`)}
    process.on('SIGTERM', () => {
      console.log('engine got SIGTERM')
      setTimeout(() => { require('node:fs').writeFileSync('${marker}', ''); process.exit(0) }, 200)
    })`
  const { core, exited, enginePid, garage, lines, nextLine } = await runCore(engine)
  core.kill('SIGTERM')
  await nextLine(/Ctrl\+C again/)
  await nextLine(/engine got SIGTERM/)
  expect(lines).toContain('engine got interrupt')
  expect(lines.indexOf('engine got interrupt')).toBeLessThan(lines.indexOf('engine got SIGTERM'))
  expect(core.exitCode).toBeNull()
  expect(await exited).toBe(0)
  expect(existsSync(join(realpathSync(garage), 'work', 'home', marker))).toBe(true)
  expect(alive(enginePid)).toBe(false)
})

it('stops waiting for the turn on a second signal: SIGTERM, then exit', async () => {
  const engine = `console.log(process.pid); setInterval(() => {}, 1000)
    ${onInterrupt('')}
    process.on('SIGTERM', () => { console.log('engine got SIGTERM'); process.exit(0) })`
  const { core, exited, enginePid, lines, nextLine } = await runCore(engine)
  core.kill('SIGTERM')
  await nextLine(/engine got interrupt/)
  expect(lines).not.toContain('engine got SIGTERM')
  core.kill('SIGTERM')
  await nextLine(/force quitting/i)
  await nextLine(/engine got SIGTERM/)
  expect(await exited).not.toBe(0)
  expect(alive(enginePid)).toBe(false)
})

it('exits at once on a third signal and still kills engines that ignore SIGTERM', async () => {
  const engine = `console.log(process.pid); setInterval(() => {}, 1000)
    ${onInterrupt('')}
    process.on('SIGTERM', () => console.log('engine ignores SIGTERM'))`
  const { core, exited, enginePid, nextLine } = await runCore(engine)
  core.kill('SIGTERM')
  await nextLine(/engine got interrupt/)
  core.kill('SIGTERM')
  await nextLine(/engine ignores SIGTERM/)
  expect(core.exitCode).toBeNull()
  core.kill('SIGTERM')
  expect(await exited).not.toBe(0)
  await waitFor(() => !alive(enginePid))
})

async function waitFor(check: () => boolean, timeoutMs = 2000) {
  const start = performance.now()
  while (!check()) {
    if (performance.now() - start > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
