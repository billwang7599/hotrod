import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createFakeAdapter, type FakeStep } from '@kotharhq/core/fake'
import { startCore } from '@kotharhq/core/main'
import type { SessionOptions } from '@kotharhq/core/shared'
import { sandboxingMachine } from '@kotharhq/core/test-machine'
import rotation, { CONTINUE_PROMPT, createAccountRotation, resetText, UNKNOWN_RESET_MS } from './index.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const HOUR = 60 * 60_000
const replied: FakeStep[] = [{ type: 'text.completed', text: 'Done' }]

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
  if (!check()) throw new Error('timed out')
}

// Accounts in `limited` run out of usage, resetting `resetsIn` ms from the mod's clock (undefined: the engine
// doesn't say); the rest reply. `before` plays ahead of the limit on a limited account.
async function start(names: string[], before: FakeStep[] = []) {
  const clock = { now: Date.parse('2026-11-08T09:00:00Z') }
  const limited = new Map<string, number | undefined>()
  const accountOf = (options: SessionOptions) => (options.accountDir ? basename(options.accountDir) : 'default')
  const used: string[] = []
  const script = (options: SessionOptions): FakeStep[] => {
    const account = accountOf(options)
    used.push(account)
    if (!limited.has(account)) return replied
    const resetsIn = limited.get(account)
    const resetsAt = resetsIn === undefined ? undefined : new Date(clock.now + resetsIn).toISOString()
    return [...before, { type: 'limit.reached', message: 'Out of usage', ...(resetsAt && { resetsAt }) }, ...replied]
  }
  const mod = createAccountRotation(() => clock.now)
  const garage = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-rotation-')))
  const env = { KOTHAR_ENGINE: 'fake', KOTHAR_GARAGE: garage, KOTHAR_WORK: join(garage, 'work'), KOTHAR_PORT: '0' }
  const base = createFakeAdapter(script, 0)
  // What each session was prompted with.
  const prompts: string[] = []
  const fake: typeof base = {
    ...base,
    start(machine, options, emit) {
      const session = base.start(machine, options, emit)
      return { ...session, prompt: (text, images) => (prompts.push(text), session.prompt(text, images)) }
    },
  }
  const kothar = await startCore({ env, adapters: [fake], mods: [mod], machine: sandboxingMachine })
  cleanups.push(async () => {
    await kothar.close(true)
    rmSync(garage, { recursive: true, force: true })
  })
  const { core } = kothar
  const handle = (message: Parameters<typeof core.handle>[0]) => core.handle(message, () => {})
  for (const name of names) handle({ type: 'account.addApiKey', engine: 'fake', name, key: `sk-${name}` })
  handle({ type: 'mod.setEnabled', modId: 'account-rotation', enabled: true })
  handle({ type: 'chat.create', name: 'Space' })
  const chatId = core.chats().find((c) => c.name === 'Space')!.id
  const chat = () => core.chats().find((c) => c.id === chatId)!
  const active = () => core.accounts().find((a) => a.engine === 'fake')!.active
  const send = async (text: string) => {
    const before = chat().entries.length
    handle({ type: 'chat.send', chatId, text })
    await until(() => chat().status === 'idle' && chat().entries.at(-1)?.type !== 'user.message')
    // The mod notes after the turn ends; let anything it sent again finish.
    await until(() => chat().status === 'idle' && !chat().queue.length)
    return chat().entries.slice(before)
  }
  const shown = (entries: ReturnType<typeof chat>['entries']) =>
    entries.flatMap((e) => {
      if (e.type === 'user.message') return [`> ${e.text}`]
      return e.type === 'mod.note' || e.type === 'text.completed' ? [e.text] : []
    })
  return { clock, limited, used, handle, send, shown, active, prompts, chat, chatId }
}

it('is off by default, with a setting for which accounts take part', () => {
  expect(rotation.enabledByDefault).toBe(false)
  expect(rotation.settings?.map((s) => s.key)).toEqual(['accounts'])
})

it('switches to the next account in order, skipping limited ones, and sends the message again', async () => {
  const t = await start(['A', 'B'])
  t.limited.set('default', HOUR)
  t.limited.set('a', 2 * HOUR)
  expect(t.shown(await t.send('Build it'))).toEqual([
    '> Build it',
    'Default hit its usage limit, switched to A',
    '> Build it',
    'A hit its usage limit, switched to B',
    '> Build it',
    'Done',
  ])
  expect(t.active()).toBe('b')
  expect(t.used).toEqual(['default', 'a', 'b'])

  // Default and A are still limited, so the next message on B goes nowhere new.
  t.limited.set('b', 3 * HOUR)
  const resets = resetText(t.clock.now + HOUR, t.clock.now)
  expect(t.shown(await t.send('More'))).toEqual([
    '> More',
    `Every account in the rotation has hit its usage limit. The first resets at ${resets}.`,
  ])
  expect(t.active()).toBe('b')

  // Once Default's limit has passed, B wraps round to it.
  t.clock.now += HOUR
  t.limited.delete('default')
  expect(t.shown(await t.send('Again'))).toEqual([
    '> Again',
    'B hit its usage limit, switched to Default',
    '> Again',
    'Done',
  ])
  expect(t.active()).toBe('default')
})

it('rotates only through the accounts named in its setting, in that order', async () => {
  const t = await start(['A', 'B', 'C'])
  t.handle({ type: 'mod.setValue', modId: 'account-rotation', key: 'accounts', value: 'c\nA' })
  t.limited.set('default', HOUR)
  expect(t.shown(await t.send('Go')).slice(1, 2)).toEqual(['Default hit its usage limit, switched to C'])
  t.limited.set('c', HOUR)
  expect(t.shown(await t.send('Go')).slice(1, 2)).toEqual(['C hit its usage limit, switched to A'])
  expect(t.used).toEqual(['default', 'c', 'c', 'a'])
})

it('counts an account limited for an hour without a reset time, and says when no other takes part', async () => {
  const t = await start([])
  t.limited.set('default', undefined)
  expect(t.shown(await t.send('Go'))).toEqual([
    '> Go',
    "Default hit its usage limit, and there's no other account to switch to",
  ])

  const two = await start(['A'])
  two.limited.set('default', undefined)
  two.limited.set('a', undefined)
  const resets = resetText(two.clock.now + UNKNOWN_RESET_MS, two.clock.now)
  expect(two.shown(await two.send('Go')).at(-1)).toBe(
    `Every account in the rotation has hit its usage limit. The first resets at ${resets}.`,
  )
})

it('does nothing while off', async () => {
  const t = await start(['A'])
  t.handle({ type: 'mod.setEnabled', modId: 'account-rotation', enabled: false })
  t.limited.set('default', HOUR)
  expect(t.shown(await t.send('Go'))).toEqual(['> Go', 'Done'])
  expect(t.active()).toBe('default')
})

it('continues instead of starting over when the turn had done some work, then runs the queued message', async () => {
  const t = await start(
    ['A'],
    [
      { type: 'text.completed', text: 'Half done' },
      { type: 'tool.started', toolId: 'ask', name: 'Ask', kind: 'other', summary: 'Which file?', input: {} },
      {
        type: 'question',
        toolId: 'ask',
        questions: [{ header: 'File', question: 'Which file?', options: [], multiSelect: false }],
      },
    ],
  )
  t.limited.set('default', HOUR)
  const before = t.chat().entries.length
  t.handle({ type: 'chat.send', chatId: t.chatId, text: 'Build it' })
  await until(() => t.chat().status === 'waiting')
  // The user queues a message while the first turn waits, then answers; the limit comes next.
  t.handle({ type: 'chat.send', chatId: t.chatId, text: 'Then test it' })
  const asked = t.chat().entries.findLast((e) => e.type === 'question.asked')!
  const answers = { 'Which file?': ['a.ts'] }
  t.handle({ type: 'question.respond', chatId: t.chatId, requestId: (asked as { requestId: string }).requestId, answers })
  await until(() => t.chat().status === 'idle' && !t.chat().queue.length && t.used.length === 3)

  const entries = t.chat().entries.slice(before)
  // The partial turn stays in the log, the continuation isn't a message, and the queued message runs after.
  expect(t.shown(entries)).toEqual([
    '> Build it',
    'Half done',
    'Default hit its usage limit, switched to A and continued',
    'Done',
    '> Then test it',
    'Done',
  ])
  expect(entries.some((e) => e.type === 'tool.completed' && e.output === 'Which file? a.ts')).toBe(true)
  expect(t.used).toEqual(['default', 'a', 'a'])
  const continued = t.prompts[1]!
  expect(continued).toContain(CONTINUE_PROMPT)
  expect(continued).toContain('Half done')
  expect(continued).not.toContain('New message from the user')
  expect(t.prompts[2]).toContain('New message from the user:\n\nThen test it')
})

it('continues again when a continued turn hits the next account’s limit', async () => {
  const t = await start(['A', 'B'], [{ type: 'text.completed', text: 'Half done' }])
  t.limited.set('default', HOUR)
  t.limited.set('a', HOUR)
  const shown = t.shown(await t.send('Build it'))
  expect(shown).toEqual([
    '> Build it',
    'Half done',
    'Default hit its usage limit, switched to A and continued',
    'Half done',
    'A hit its usage limit, switched to B and continued',
    'Done',
  ])
  expect(t.prompts.slice(1).every((p) => p.includes(CONTINUE_PROMPT))).toBe(true)
})
