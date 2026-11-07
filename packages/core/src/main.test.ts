import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createFakeAdapter } from './adapters/fake.ts'
import { KILL_GRACE_MS } from './machine.ts'
import { startCore } from './main.ts'
import type { Adapter, CoreMessage } from './types.ts'

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
  const dir = mkdtempSync(join(tmpdir(), 'hotrod-test-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function firstMessage(origin: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin })
  cleanups.push(() => socket.terminate())
  return new Promise<CoreMessage | number>((resolve) => {
    socket.on('message', (data) => resolve(JSON.parse(String(data))))
    socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
    socket.on('error', () => {})
  })
}

it('starts the core from the environment and stops it', async () => {
  const garage = tempDir()
  const env = {
    HOTROD_ENGINE: 'fake',
    HOTROD_GARAGE: garage,
    HOTROD_PORT: String(port),
    HOTROD_UI_ORIGIN: 'http://ui.test',
  }
  const hotrod = await startCore({ env, adapters })
  expect(hotrod.port).toBe(port)
  expect(await firstMessage('http://ui.test')).toMatchObject({
    type: 'snapshot',
    engines: [
      { id: 'fake', installed: true, signedIn: true },
      { id: 'broken', installed: false, signedIn: false, detail: 'no binary' },
    ],
  })
  expect(await firstMessage('http://localhost:4318')).toBe(403)

  hotrod.core.handle({ type: 'project.add', path: tempDir() }, () => {})
  expect(hotrod.core.projects()).toHaveLength(1)

  await hotrod.close()
  const again = await startCore({ env, adapters })
  await again.close()
})

it('accepts only its own origin when it serves the UI', async () => {
  const hotrod = await startCore({
    env: { HOTROD_ENGINE: 'fake', HOTROD_GARAGE: tempDir(), HOTROD_PORT: String(port) },
    uiDir: tempDir(),
    adapters,
  })
  cleanups.push(() => hotrod.close())
  expect(hotrod.uiUrl).toBe(`http://127.0.0.1:${port}`)
  expect(await firstMessage(hotrod.uiUrl)).toMatchObject({ type: 'snapshot' })
  expect(await firstMessage('http://localhost:4318')).toBe(403)
})

it('rejects an unknown engine', async () => {
  await expect(startCore({ env: { HOTROD_ENGINE: 'nope', HOTROD_GARAGE: tempDir() } })).rejects.toThrow(
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
      start(machine, { cwd }) {
        const proc = machine.spawn(process.execPath, ['-e', ${JSON.stringify(engine)}], { cwd })
        proc.onStdout((chunk) => console.log(chunk.trim()))
        return { prompt() {}, interrupt() {}, respond() {}, close: () => proc.kill() }
      },
    }
    const env = { HOTROD_ENGINE: 'node', HOTROD_GARAGE: ${JSON.stringify(garage)}, HOTROD_PORT: '4551' }
    const hotrod = await startCore({ env, adapters: [engine] })
    closeOnSignals(hotrod.close)
    hotrod.core.handle({ type: 'project.add', path: ${JSON.stringify(garage)} }, () => {})
    hotrod.core.handle({ type: 'chat.send', projectId: hotrod.core.projects()[0].id, text: 'hi' }, () => {})`
  const core = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  cleanups.push(() => void core.kill('SIGKILL'))
  const exited = new Promise<number | null>((resolve) => core.on('exit', resolve))
  const enginePid = await new Promise<number>((resolve) =>
    core.stdout.on('data', (chunk) => resolve(Number(String(chunk).trim()))),
  )
  cleanups.push(() => void (alive(enginePid) && process.kill(enginePid, 'SIGKILL')))
  return { core, exited, enginePid, garage }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

it('waits for engines to finish shutting down before exiting on a signal', async () => {
  const cleanupMs = 300
  const marker = 'stopped-cleanly'
  const engine = `console.log(process.pid); setInterval(() => {}, 1000)
    process.on('SIGTERM', () => setTimeout(() => { require('node:fs').writeFileSync('${marker}', ''); process.exit(0) }, ${cleanupMs}))`
  const { core, exited, enginePid, garage } = await runCore(engine)
  core.kill('SIGTERM')
  expect(await exited).toBe(0)
  expect(existsSync(join(garage, marker))).toBe(true)
  expect(alive(enginePid)).toBe(false)
})

it('exits at once on a second signal and still kills its engines', async () => {
  const engine = `console.log(process.pid); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`
  const { core, exited, enginePid } = await runCore(engine)
  core.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(core.exitCode).toBeNull()
  const start = performance.now()
  core.kill('SIGTERM')
  expect(await exited).not.toBe(0)
  expect(performance.now() - start).toBeLessThan(KILL_GRACE_MS / 2)
  expect(alive(enginePid)).toBe(false)
})
