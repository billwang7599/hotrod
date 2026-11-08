import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createFakeAdapter, type FakeStep } from '@hotrod/core/fake'
import { startCore } from '@hotrod/core/main'
import type { SessionOptions } from '@hotrod/core/shared'
import { sandboxingMachine } from '@hotrod/core/test-machine'
import rotation, { createAccountRotation, resetText, UNKNOWN_RESET_MS } from './index.ts'

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
// doesn't say); the rest reply.
async function start(names: string[]) {
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
    return [{ type: 'limit.reached', message: 'Out of usage', ...(resetsAt && { resetsAt }) }, ...replied]
  }
  const mod = createAccountRotation(() => clock.now)
  const garage = realpathSync(mkdtempSync(join(tmpdir(), 'hotrod-rotation-')))
  const env = { HOTROD_ENGINE: 'fake', HOTROD_GARAGE: garage, HOTROD_WORK: join(garage, 'work'), HOTROD_PORT: '0' }
  const fake = createFakeAdapter(script, 0)
  const hotrod = await startCore({ env, adapters: [fake], mods: [mod], machine: sandboxingMachine })
  cleanups.push(async () => {
    await hotrod.close(true)
    rmSync(garage, { recursive: true, force: true })
  })
  const { core } = hotrod
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
  return { clock, limited, used, handle, send, shown, active }
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
