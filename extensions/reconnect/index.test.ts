import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Extension, ExtensionHost } from '@kothar/extension-api'
import { createFakeAdapter, type FakeStep } from '@kothar/core/fake'
import { startCore } from '@kothar/core/main'
import { sandboxingMachine } from '@kothar/core/test-machine'
import reconnect, { classify, CONTINUE_PROMPT, createReconnect, delayOf, MAX_TRIES } from './index.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const replied: FakeStep[] = [{ type: 'text.completed', text: 'Done' }]
const dropped = (error = 'API Error: Connection error.'): FakeStep[] => [
  { type: 'text.completed', text: 'Half done' },
  { type: 'turn.completed', error },
]

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
  if (!check()) throw new Error('timed out')
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Each session plays the next plan, then replies. The network is up while `online` is true.
async function start() {
  const plans: FakeStep[][] = []
  const net = { online: false, probes: 0 }
  const clock = { now: Date.parse('2026-11-10T02:00:00Z') }
  const extension = createReconnect({
    probe: async () => (net.probes++, net.online),
    now: () => clock.now,
    firstMs: 5,
    capMs: 20,
  })
  // Hands the test a host, to make a worker.
  let host: ExtensionHost | undefined
  const helper: Extension = { id: 'helper', name: 'Helper', description: '', enabledByDefault: true }
  helper.onChatCreated = (_chat, context) => void (host = context.host)
  const garage = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-reconnect-')))
  const env = { KOTHAR_ENGINE: 'fake', KOTHAR_GARAGE: garage, KOTHAR_WORK: join(garage, 'work'), KOTHAR_PORT: '0' }
  const base = createFakeAdapter(() => plans.shift() ?? replied, 0)
  const prompts: string[] = []
  const fake: typeof base = {
    ...base,
    start(machine, options, emit) {
      const session = base.start(machine, options, emit)
      return { ...session, prompt: (text, images) => (prompts.push(text), session.prompt(text, images)) }
    },
  }
  const kothar = await startCore({ env, adapters: [fake], extensions: [extension, helper], machine: sandboxingMachine })
  cleanups.push(async () => {
    await kothar.close(true)
    rmSync(garage, { recursive: true, force: true })
  })
  const { core } = kothar
  const handle = (message: Parameters<typeof core.handle>[0]) => core.handle(message, () => {})
  const notified: { title: string; body: string; chatId?: string }[] = []
  core.onMessage((m) => m.type === 'notify' && notified.push({ title: m.title, body: m.body, ...(m.chatId && { chatId: m.chatId }) }))
  handle({ type: 'chat.create', name: 'Space' })
  const chatId = core.chats().find((c) => c.name === 'Space')!.id
  const chatOf = (id: string) => core.chats().find((c) => c.id === id)
  const chat = () => chatOf(chatId)!
  const shown = (id = chatId) =>
    chatOf(id)!.entries.flatMap((e) => {
      if (e.type === 'user.message') return [`> ${e.text}`]
      if (e.type === 'worker.report') return [`[report] ${e.text}${e.error ? ` (${e.error})` : ''}`]
      return e.type === 'extension.note' || e.type === 'text.completed' ? [e.text] : []
    })
  const settled = (id = chatId) => until(() => chatOf(id)?.status === 'idle' && !chatOf(id)!.queue.length)
  const send = (text: string, id = chatId) => handle({ type: 'chat.send', chatId: id, text })
  return { plans, net, clock, handle, chat, chatOf, chatId, shown, settled, send, prompts, notified, host: () => host! }
}

it('is on by default, with a longest-wait setting', () => {
  expect(reconnect.enabledByDefault).toBe(true)
  expect(reconnect.settings?.map((s) => s.key)).toEqual(['maxWait'])
})

it('tells network failures and an unavailable service from everything else', () => {
  for (const error of [
    'API Error: Connection error.',
    'getaddrinfo ENOTFOUND api.anthropic.com',
    'read ECONNRESET',
    'connect ETIMEDOUT 160.79.104.10:443',
    'TypeError: fetch failed',
    'API Error: Request timed out.',
    'socket hang up',
  ]) {
    expect(classify(error), error).toBe('network')
  }
  for (const error of [
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    'API Error: 503 Service Unavailable',
    '502 Bad Gateway',
  ]) {
    expect(classify(error), error).toBe('service')
  }
  for (const error of [
    undefined,
    'Interrupted',
    "The account's 5-hour usage limit is reached",
    'API Error: 429 rate_limit_error',
    'Claude Code exited with code 1',
    'Tool failed: file not found',
  ]) {
    expect(classify(error), String(error)).toBeUndefined()
  }
})

it('backs off from the first delay, doubling, up to the cap', () => {
  expect([0, 1, 2, 3, 10].map((n) => delayOf(n))).toEqual([5_000, 10_000, 20_000, 40_000, 300_000])
})

it('holds a dropped turn as waiting, checks the network, and continues once it is back', async () => {
  const t = await start()
  t.plans.push(dropped())
  t.send('Build it')
  await until(() => t.chat().status === 'waiting')
  expect(t.chat().waits).toEqual([
    expect.objectContaining({ extension: 'reconnect', text: 'Offline: will continue when the connection is back' }),
  ])
  await until(() => t.net.probes >= 3)
  // Still offline: nothing more has run.
  expect(t.chat().status).toBe('waiting')
  expect(t.prompts).toHaveLength(1)

  t.net.online = true
  await until(() => t.prompts.length === 2)
  await t.settled()
  expect(t.shown()).toEqual(['> Build it', 'Half done', 'The connection dropped', 'Connection back, continued', 'Done'])
  expect(t.prompts[1]).toContain(CONTINUE_PROMPT)
  expect(t.prompts[1]).toContain('Half done')
  expect(t.chat().waits ?? []).toEqual([])
})

it('waits out an unavailable service without checking the network', async () => {
  const t = await start()
  t.plans.push(dropped('API Error: 529 Overloaded'))
  t.send('Build it')
  await until(() => t.prompts.length === 2)
  await t.settled()
  expect(t.net.probes).toBe(0)
  expect(t.shown()).toEqual([
    '> Build it',
    'Half done',
    'The engine’s service was unavailable',
    'Trying again, continued',
    'Done',
  ])
})

it('leaves Stop, usage limits and ordinary errors alone', async () => {
  const t = await start()
  for (const error of ['Interrupted', 'Out of usage limit', 'Something broke']) {
    t.plans.push(dropped(error))
    t.send('Go')
    await t.settled()
  }
  await pause(40)
  expect(t.prompts).toHaveLength(3)
  expect(t.shown().filter((line) => line.startsWith('The connection'))).toEqual([])
})

it('drops the pending resume when the user sends a message, which runs instead', async () => {
  const t = await start()
  t.plans.push(dropped())
  t.send('Build it')
  await until(() => t.chat().status === 'waiting')
  t.send('Never mind, do this')
  await t.settled()
  t.net.online = true
  await pause(60)
  expect(t.prompts.some((p) => p.includes(CONTINUE_PROMPT))).toBe(false)
  expect(t.shown()).toEqual(['> Build it', 'Half done', 'The connection dropped', '> Never mind, do this', 'Done'])
})

it('drops the pending resume on Stop', async () => {
  const t = await start()
  t.plans.push(dropped())
  t.send('Build it')
  await until(() => t.chat().status === 'waiting')
  t.handle({ type: 'chat.interrupt', chatId: t.chatId })
  expect(t.chat().status).toBe('idle')
  t.net.online = true
  await pause(60)
  expect(t.prompts).toHaveLength(1)
  expect(t.chat().status).toBe('idle')
})

it('Try now checks at once, and Don’t continue ends the turn', async () => {
  const t = await start()
  t.handle({ type: 'extension.setValue', extensionId: 'reconnect', key: 'maxWait', value: 60 })
  t.plans.push(dropped(), dropped())
  t.send('Build it')
  await until(() => t.chat().status === 'waiting')
  const probes = t.net.probes
  t.net.online = true
  t.handle({ type: 'extension.wait.answer', chatId: t.chatId, extension: 'reconnect', button: 'now' })
  await until(() => t.prompts.length === 2)
  expect(t.net.probes).toBeGreaterThan(probes)

  // The continuation drops too; this time the user gives up on it.
  await until(() => t.chat().status === 'waiting')
  t.net.online = false
  t.handle({ type: 'extension.wait.answer', chatId: t.chatId, extension: 'reconnect', button: 'cancel' })
  await t.settled()
  expect(t.shown().at(-1)).toBe('Not continuing the dropped turn')
  // The user said so: nothing to tell them.
  expect(t.notified).toEqual([])
})

it('gives up after the longest wait', async () => {
  const t = await start()
  t.handle({ type: 'extension.setValue', extensionId: 'reconnect', key: 'maxWait', value: 1 })
  t.plans.push(dropped())
  t.send('Build it')
  await until(() => t.chat().status === 'waiting')
  t.clock.now += 2 * 60_000
  await t.settled()
  expect(t.shown().at(-1)).toBe('Still offline after 1 min, so Kothar stopped waiting. Send a message to try again.')
  expect(t.prompts).toHaveLength(1)
  expect(t.notified).toEqual([
    {
      chatId: t.chatId,
      title: 'Reconnect gave up',
      body: 'Still offline after 1 min, so Kothar stopped waiting. Send a message to try again.',
    },
  ])
})

it('stops continuing a message after its tries run out', async () => {
  const t = await start()
  t.net.online = true
  for (let i = 0; i <= MAX_TRIES; i++) t.plans.push(dropped())
  t.send('Build it')
  await until(() => t.prompts.length === MAX_TRIES + 1)
  await t.settled()
  expect(t.shown().at(-1)).toBe(`The connection dropped again after ${MAX_TRIES} tries, so Kothar stopped continuing`)
  expect(t.notified.map((n) => n.title)).toEqual(['Reconnect gave up'])

  // A new message starts the count again.
  t.plans.push(dropped())
  t.send('Again')
  await until(() => t.prompts.length === MAX_TRIES + 3)
  await t.settled()
  expect(t.shown().at(-1)).toBe('Done')
})

it('a worker holds instead of reporting, resumes, and reports once', async () => {
  const t = await start()
  const host = t.host()
  const worker = host.createChat({ name: 'Helper', parentId: t.chatId })
  // The worker's first turn drops; the lead's turn for the report replies.
  t.plans.push(dropped())
  host.send(worker.id, 'Do the task')
  await until(() => t.chatOf(worker.id)?.status === 'waiting')
  expect(t.chatOf(worker.id)).toBeDefined()
  expect(t.shown().filter((line) => line.startsWith('[report]'))).toEqual([])

  t.net.online = true
  await until(() => !t.chatOf(worker.id))
  await t.settled()
  expect(t.shown().filter((line) => line.startsWith('[report]'))).toEqual(['[report] Done'])
})

it('a worker that gives up reports the error once', async () => {
  const t = await start()
  t.handle({ type: 'extension.setValue', extensionId: 'reconnect', key: 'maxWait', value: 1 })
  const host = t.host()
  const worker = host.createChat({ name: 'Helper', parentId: t.chatId })
  t.plans.push(dropped())
  host.send(worker.id, 'Do the task')
  await until(() => t.chatOf(worker.id)?.status === 'waiting')
  t.clock.now += 2 * 60_000
  await until(() => !t.chatOf(worker.id))
  await t.settled()
  expect(t.shown().filter((line) => line.startsWith('[report]'))).toEqual([
    '[report] Half done (API Error: Connection error.)',
  ])
})

it('does nothing while off', async () => {
  const t = await start()
  t.handle({ type: 'extension.setEnabled', extensionId: 'reconnect', enabled: false })
  t.plans.push(dropped())
  t.send('Build it')
  await t.settled()
  t.net.online = true
  await pause(40)
  expect(t.prompts).toHaveLength(1)
})

it('turning it off while a chat waits lets the turn end', async () => {
  const t = await start()
  t.plans.push(dropped())
  t.send('Build it')
  await until(() => t.chat().status === 'waiting')
  t.handle({ type: 'extension.setEnabled', extensionId: 'reconnect', enabled: false })
  await t.settled()
  t.net.online = true
  await pause(40)
  expect(t.prompts).toHaveLength(1)
})
