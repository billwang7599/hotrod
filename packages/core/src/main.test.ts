import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createFakeAdapter } from './adapters/fake.ts'
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
