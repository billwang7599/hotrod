import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createFakeAdapter } from './adapters/fake.ts'
import { openCore } from './core.ts'
import { localMachine } from './machine.ts'
import { startServer } from './server.ts'
import { BAD_TOKEN_CLOSE_CODE, type CoreMessage } from './types.ts'

const origin = 'http://localhost:4318'
const token = 'test-token-0123456789'
const engines = [{ id: 'fake', installed: true, signedIn: true }]
const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function start() {
  const garage = mkdtempSync(join(tmpdir(), 'hotrod-test-'))
  const project = mkdtempSync(join(tmpdir(), 'hotrod-test-'))
  const core = openCore({
    garage,
    adapters: [createFakeAdapter(undefined, 0)],
    defaultEngine: 'fake',
    machine: localMachine,
  })
  const server = await startServer({
    core,
    engines,
    port: 0,
    uiOrigin: origin,
    token,
  })
  cleanups.push(() => {
    core.close()
    rmSync(garage, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  })
  cleanups.push(() => server.close())
  const base = `ws://127.0.0.1:${server.port}`
  return { base, url: `${base}/?token=${token}`, project }
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

it('closes connections without the right token before sending anything', async () => {
  const { base } = await start()
  for (const query of ['', '?token=', '?token=wrong', `?token=${token.slice(0, -1)}X`, `?token=${token}x`]) {
    const { socket, messages } = connect(`${base}/${query}`, { origin })
    const close = await new Promise<{ code: number; reason: string }>((resolve) =>
      socket.on('close', (code, reason) => resolve({ code, reason: String(reason) })),
    )
    expect(close).toEqual({ code: BAD_TOKEN_CLOSE_CODE, reason: 'Missing or wrong token' })
    expect(messages).toEqual([])
  }
})

it('sends a snapshot, then broadcasts to every client', async () => {
  const { url, project } = await start()
  const a = connect(url, { origin })
  const b = connect(url, { origin })
  await until(() => a.messages.length > 0 && b.messages.length > 0)
  expect(a.messages[0]).toMatchObject({
    type: 'snapshot',
    engines,
    projects: [],
    chats: [expect.objectContaining({ id: 'main', title: 'Main' })],
    accounts: [{ engine: 'fake', active: 'default' }],
  })

  a.socket.send(JSON.stringify({ type: 'project.add', path: project }))
  await until(() => b.messages.some((m) => m.type === 'project.added'))
  const added = b.messages.find((m) => m.type === 'project.added')
  if (added?.type !== 'project.added') throw new Error('no project')

  a.socket.send(JSON.stringify({ type: 'chat.setEngine', chatId: added.chat.id, engine: 'nope' }))
  await until(() => a.messages.some((m) => m.type === 'error'))
  a.socket.send(JSON.stringify({ type: 'chat.setEngine', chatId: added.chat.id, engine: 'fake' }))
  await until(() => b.messages.some((m) => m.type === 'chat.updated'))
  expect(b.messages.some((m) => m.type === 'error')).toBe(false)

  a.socket.send(JSON.stringify({ type: 'chat.send', chatId: added.chat.id, text: 'hi' }))
  await until(() => b.messages.some((m) => m.type === 'chat.status' && m.status === 'waiting'))
  expect(b.messages.some((m) => m.type === 'chat.delta')).toBe(true)

  a.socket.send(JSON.stringify({ type: 'chat.send', chatId: added.chat.id, text: 'again' }))
  await until(() => a.messages.filter((m) => m.type === 'error').length === 2)
  expect(b.messages.some((m) => m.type === 'error')).toBe(false)
})

it('answers bad messages with an error', async () => {
  const { url } = await start()
  const a = connect(url, { origin })
  await until(() => a.messages.length > 0)
  a.socket.send('not json')
  a.socket.send(JSON.stringify({ type: 'chat.send', chatId: 'nope', text: 'hi' }))
  await until(() => a.messages.filter((m) => m.type === 'error').length === 2)
})

it('serves the UI folder when given one', async () => {
  const garage = mkdtempSync(join(tmpdir(), 'hotrod-test-'))
  const uiDir = mkdtempSync(join(tmpdir(), 'hotrod-test-'))
  mkdirSync(join(uiDir, 'assets'))
  writeFileSync(join(uiDir, 'index.html'), '<html>hotrod</html>')
  writeFileSync(join(uiDir, 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(garage, 'secret.txt'), 'secret')
  const core = openCore({
    garage,
    adapters: [createFakeAdapter(undefined, 0)],
    defaultEngine: 'fake',
    machine: localMachine,
  })
  const server = await startServer({
    core,
    engines,
    port: 0,
    uiOrigin: origin,
    token,
    uiDir,
  })
  cleanups.push(() => {
    core.close()
    rmSync(garage, { recursive: true, force: true })
    rmSync(uiDir, { recursive: true, force: true })
  })
  cleanups.push(() => server.close())
  const base = `http://127.0.0.1:${server.port}`

  const index = await fetch(`${base}/`)
  expect(index.headers.get('content-type')).toContain('text/html')
  expect(await index.text()).toBe('<html>hotrod</html>')
  const script = await fetch(`${base}/assets/app.js`)
  expect(script.headers.get('content-type')).toContain('text/javascript')
  expect(await script.text()).toBe('console.log(1)')
  expect(await (await fetch(`${base}/projects/x`)).text()).toBe('<html>hotrod</html>')
  const escaped = await fetch(`${base}/..%2f${basename(garage)}%2fsecret.txt`)
  expect(await escaped.text()).not.toContain('secret')
})

it('serves no files without a UI folder', async () => {
  const { base } = await start()
  const response = await fetch(base.replace('ws:', 'http:'))
  expect(response.ok).toBe(false)
})
