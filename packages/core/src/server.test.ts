import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createFakeAdapter } from './adapters/fake.ts'
import { openCore } from './core.ts'
import { localMachine } from './machine.ts'
import { startServer } from './server.ts'
import type { CoreMessage } from './types.ts'

const origin = 'http://localhost:4318'
const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function start() {
  const garage = mkdtempSync(join(tmpdir(), 'hotrod-test-'))
  const project = mkdtempSync(join(tmpdir(), 'hotrod-test-'))
  const core = openCore({ garage, adapter: createFakeAdapter(undefined, 0), machine: localMachine })
  const server = await startServer({
    core,
    engine: { id: 'fake', installed: true, signedIn: true },
    port: 0,
    uiOrigin: origin,
  })
  cleanups.push(() => {
    core.close()
    rmSync(garage, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  })
  cleanups.push(() => server.close())
  return { url: `ws://127.0.0.1:${server.port}`, project }
}

function connect(url: string, headers: { origin?: string }) {
  const socket = new WebSocket(url, headers)
  const messages: CoreMessage[] = []
  socket.on('message', (data) => messages.push(JSON.parse(String(data))))
  socket.on('error', () => {})
  cleanups.push(() => socket.terminate())
  return { socket, messages }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
  if (!check()) throw new Error('timed out')
}

it('rejects other origins', async () => {
  const { url } = await start()
  for (const headers of [{ origin: 'http://evil.example' }, {}]) {
    const { socket } = connect(url, headers)
    const status = await new Promise<number>((resolve) =>
      socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)),
    )
    expect(status).toBe(403)
  }
})

it('sends a snapshot, then broadcasts to every client', async () => {
  const { url, project } = await start()
  const a = connect(url, { origin })
  const b = connect(url, { origin })
  await until(() => a.messages.length > 0 && b.messages.length > 0)
  expect(a.messages[0]).toEqual({
    type: 'snapshot',
    engine: { id: 'fake', installed: true, signedIn: true },
    projects: [],
  })

  a.socket.send(JSON.stringify({ type: 'project.add', path: project }))
  await until(() => b.messages.some((m) => m.type === 'project.added'))
  const added = b.messages.find((m) => m.type === 'project.added')
  if (added?.type !== 'project.added') throw new Error('no project')

  a.socket.send(JSON.stringify({ type: 'chat.send', projectId: added.project.id, text: 'hi' }))
  await until(() => b.messages.some((m) => m.type === 'chat.status' && m.status === 'waiting'))
  expect(b.messages.some((m) => m.type === 'chat.delta')).toBe(true)

  a.socket.send(JSON.stringify({ type: 'chat.send', projectId: added.project.id, text: 'again' }))
  await until(() => a.messages.some((m) => m.type === 'error'))
  expect(b.messages.some((m) => m.type === 'error')).toBe(false)
})

it('answers bad messages with an error', async () => {
  const { url } = await start()
  const a = connect(url, { origin })
  await until(() => a.messages.length > 0)
  a.socket.send('not json')
  a.socket.send(JSON.stringify({ type: 'chat.send', projectId: 'nope', text: 'hi' }))
  await until(() => a.messages.filter((m) => m.type === 'error').length === 2)
})
