// One extension depending on another: optionalDependencies and onDependencyChanged, requires, a setting's requires,
// and host.extensionEnabled. Fake engine only.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Extension, ExtensionHost } from '@kothar/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeAdapter } from './adapters/fake.ts'
import { sandboxingMachine } from './adapters/test-machine.ts'
import { openCore } from './core.ts'
import type { ClientMessage, CoreMessage } from './shared.ts'
import { until } from './test-wait.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function start(extensions: Extension[]) {
  const garage = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-deps-')))
  cleanups.push(() => rmSync(garage, { recursive: true, force: true }))
  const core = openCore({
    garage,
    adapters: [createFakeAdapter([{ type: 'text.completed', text: 'Done' }], 0)],
    defaultEngine: 'fake',
    machine: sandboxingMachine,
    extensions,
  })
  cleanups.push(() => core.close(true))
  const errors: string[] = []
  const messages: CoreMessage[] = []
  core.onMessage((m) => messages.push(m))
  const handle = (m: ClientMessage) => {
    try {
      core.handle(m, (reply) => {
        if (reply.type === 'error') errors.push(reply.message)
      })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  handle({ type: 'engine.setEnabled', engine: 'fake', enabled: true })
  handle({ type: 'workFolder.set', path: join(garage, 'work') })
  await core.refreshEngines()
  const info = (id: string) => core.extensions().find((e) => e.id === id)!
  const setEnabled = (id: string, enabled: boolean) => handle({ type: 'extension.setEnabled', extensionId: id, enabled })
  return { core, handle, errors, messages, info, setEnabled }
}

const base = (id: string, parts: Partial<Extension> = {}): Extension => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  description: '',
  enabledByDefault: true,
  ...parts,
})

describe('optionalDependencies', () => {
  it('hears when a dependency is turned off and on, and reads it with host.extensionEnabled', async () => {
    const heard: string[] = []
    let host: ExtensionHost | undefined
    const t = await start([
      base('helper'),
      base('main', {
        optionalDependencies: ['helper'],
        onStart: (context) => void (host = context.host),
        onDependencyChanged: (change, context) =>
          void heard.push(`${change.id} ${change.enabled} ${context.host.extensionEnabled('helper')}`),
      }),
    ])
    await until(() => host !== undefined)
    expect(host!.extensionEnabled('helper')).toBe(true)
    t.setEnabled('helper', false)
    expect(host!.extensionEnabled('helper')).toBe(false)
    t.setEnabled('helper', true)
    expect(heard).toEqual(['helper false false', 'helper true true'])
    // The main extension runs throughout: an optional dependency doesn't stop it.
    expect(t.info('main').enabled).toBe(true)
    expect(t.info('main').blocked).toBeUndefined()
  })

  it('isn’t told about extensions it doesn’t list, nor while it is off itself', async () => {
    const heard: string[] = []
    const t = await start([
      base('helper'),
      base('other'),
      base('main', { optionalDependencies: ['helper'], onDependencyChanged: (change) => void heard.push(change.id) }),
    ])
    t.setEnabled('other', false)
    t.setEnabled('main', false)
    t.setEnabled('helper', false)
    expect(heard).toEqual([])
  })

  it('knows an unknown id as off; workers are the core’s, not an extension', async () => {
    let host: ExtensionHost | undefined
    await start([base('main', { onStart: (context) => void (host = context.host) })])
    await until(() => host !== undefined)
    expect(host!.extensionEnabled('main')).toBe(true)
    expect(host!.extensionEnabled('no-such-extension')).toBe(false)
    expect(host!.extensionEnabled('workers')).toBe(false)
  })

  it('checks a chat’s setup with chatId', async () => {
    let host: ExtensionHost | undefined
    const t = await start([base('helper'), base('main', { onStart: (context) => void (host = context.host) })])
    await until(() => host !== undefined)
    let saved: string | undefined
    t.core.handle({ type: 'setup.save', setup: { name: 'Plain', extensionsOff: ['helper'] } }, (reply) => {
      if (reply.type === 'setup.saved') saved = reply.setup.id
    })
    expect(saved).toBeDefined()
    t.handle({ type: 'chat.create', name: 'Space' })
    const space = t.core.chats().findLast((c) => c.name === 'Space')!
    t.handle({ type: 'chat.setSetup', chatId: space.id, setup: saved })
    expect(host!.extensionEnabled('helper')).toBe(true)
    expect(host!.extensionEnabled('helper', space.id)).toBe(false)
  })
})

describe('requires', () => {
  it('can’t be turned on while what it requires is off, and says which to turn on', async () => {
    const t = await start([base('helper'), base('main', { requires: ['helper'], enabledByDefault: false })])
    t.setEnabled('helper', false)
    expect(t.info('main').blocked).toBe('Needs the Helper extension')
    t.setEnabled('main', true)
    expect(t.errors.at(-1)).toBe('Turn on Helper first: Main needs it')
    expect(t.info('main').enabled).toBe(false)
  })

  it('stops with what it requires and starts again with it, keeping its own switch on', async () => {
    const heard: string[] = []
    const t = await start([
      base('helper'),
      base('main', {
        requires: ['helper'],
        onStart: () => void heard.push('start'),
        onStop: () => void heard.push('stop'),
        onDependencyChanged: () => void heard.push('changed'),
      }),
      base('top', { requires: ['main'], onStart: () => void heard.push('top start'), onStop: () => void heard.push('top stop') }),
    ])
    await until(() => heard.includes('start') && heard.includes('top start'))
    heard.length = 0
    t.setEnabled('helper', false)
    expect(heard).toEqual(['stop', 'top stop'])
    expect(t.info('main')).toMatchObject({ enabled: true, blocked: 'Needs the Helper extension', requires: ['helper'] })
    expect(t.info('top').blocked).toBe('Needs the Main extension')
    heard.length = 0
    t.setEnabled('helper', true)
    expect(heard).toEqual(['start', 'top start'])
    expect(t.info('main').blocked).toBeUndefined()
  })
})

describe('a setting that requires another extension', () => {
  const settings: Extension['settings'] = [
    { key: 'shown', label: 'Show as workers', type: 'boolean', default: false, requires: 'helper' },
    { key: 'depth', label: 'Depth', type: 'number', default: 1 },
  ]

  it('reads as its default and is greyed out while that extension is off, and comes back with it', async () => {
    let values: Record<string, unknown> = {}
    const t = await start([
      base('helper'),
      base('main', {
        settings,
        onDependencyChanged: (_change, context) => void (values = context.values),
      }),
    ])
    t.handle({ type: 'extension.setValue', extensionId: 'main', key: 'shown', value: true })
    expect(t.info('main').values.shown).toBe(true)
    t.setEnabled('helper', false)
    expect(values.shown).toBe(false)
    expect(t.info('main').values.shown).toBe(false)
    expect(t.info('main').blockedSettings).toEqual({ shown: 'Needs the Helper extension' })
    // The page redraws: an update for the main extension follows the helper's switch.
    expect(t.messages.findLast((m) => m.type === 'extension.updated' && m.extension.id === 'main')).toMatchObject({
      extension: { blockedSettings: { shown: 'Needs the Helper extension' } },
    })
    t.handle({ type: 'extension.setValue', extensionId: 'main', key: 'shown', value: true })
    expect(t.errors.at(-1)).toBe('Show as workers: Needs the Helper extension')
    t.setEnabled('helper', true)
    expect(values.shown).toBe(true)
    expect(t.info('main').blockedSettings).toBeUndefined()
  })

  it('names an extension that isn’t installed by its id', async () => {
    const t = await start([base('main', { settings: [{ key: 'x', label: 'X', type: 'boolean', default: false, requires: 'ghost' }] })])
    expect(t.info('main').blockedSettings).toEqual({ x: 'Needs the ghost extension' })
    expect(t.info('main').values.x).toBe(false)
  })
})

describe('capabilities: provides, host.provide and host.use', () => {
  it('shares an API under a capability name, withdraws it when its provider stops, and tells those that list it', async () => {
    const heard: string[] = []
    let consumer: ExtensionHost | undefined
    const provider = base('searcher', {
      provides: ['search'],
      onStart: ({ host }) => host.provide('search', { find: (q: string) => `found ${q}` }),
    })
    const user = base('user', {
      optionalDependencies: ['search'],
      onStart: ({ host }) => void (consumer = host),
      onDependencyChanged: ({ id, enabled }) => void heard.push(`${id} ${enabled}`),
    })
    const t = await start([user, provider])
    await until(() => consumer?.use('search') !== undefined)
    expect(consumer!.use<{ find: (q: string) => string }>('search')!.find('x')).toBe('found x')
    expect(consumer!.use('nothing')).toBeUndefined()
    t.setEnabled('searcher', false)
    expect(consumer!.use('search')).toBeUndefined()
    expect(heard).toContain('search false')
    t.setEnabled('searcher', true)
    await until(() => consumer!.use('search') !== undefined)
    expect(heard.at(-1)).toBe('search true')
    expect(t.errors).toEqual([])
  })

  it('lets another extension provide the same capability, and refuses an undeclared one', async () => {
    let host: ExtensionHost | undefined
    const stock = base('stock', { provides: ['search'], onStart: ({ host }) => host.provide('search', 'stock') })
    const community = base('community', { provides: ['search'], onStart: ({ host }) => host.provide('search', 'community') })
    const sneaky = base('sneaky', { onStart: ({ host: h }) => void (host = h) })
    const t = await start([stock, community, sneaky])
    await until(() => host !== undefined)
    expect(host!.use('search')).toBe('stock')
    t.setEnabled('stock', false)
    expect(host!.use('search')).toBe('community')
    expect(() => host!.provide('search', 1)).toThrow('without declaring it')
  })
})
