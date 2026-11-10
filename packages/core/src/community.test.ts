import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Extension, ExtensionHost, ExtensionManifest } from '@kothar/extension-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeAdapter } from './adapters/fake.ts'
import { sandboxingMachine } from './adapters/test-machine.ts'
import { openCore, type Core } from './core.ts'
import { communityDir, openMarketplace, type Fetch } from './marketplace.ts'
import { FREE_HOST_CALLS, guardHost, HOST_USES, loadCommunityExtensions, nodeUsesOf, usesOf } from './extensions.ts'
import { approvalsFile, historyFile } from './approvals.ts'
import { checkExtensionManifest, type CatalogEntry, type CoreMessage } from './shared.ts'
import { CATALOG_URL, fakeGitHub } from './test-github.ts'
import { runRestartable, savedOn, savedSwitch } from './main.ts'

let dirs: string[] = []
let cores: Core[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(cores.map((core) => core.close(true)))
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
  cores = []
})

function tempGarage() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-community-')))
  dirs.push(dir)
  return dir
}

const manifestOf = (id: string, change: Partial<ExtensionManifest> = {}): ExtensionManifest => ({
  id,
  name: `Extension ${id}`,
  version: '1.0.0',
  author: 'Someone',
  description: 'Does a thing.',
  api: 1,
  uses: ['commands'],
  ...change,
})

const source = (id: string, body = '') =>
  `globalThis.kotharLoaded = [...(globalThis.kotharLoaded ?? []), '${id}']\n` +
  `export default { id: '${id}', name: 'Extension ${id}', description: 'Does a thing.', enabledByDefault: true${body} }\n`

// Installs an extension into the garage as the marketplace would.
function install(garage: string, id: string, main = source(id), manifest = manifestOf(id), from: object = {}) {
  const dir = join(communityDir(garage), id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'main.mjs'), main)
  const record = { source: 'marketplace', repo: `someone/${id}`, tag: 'v1', version: manifest.version, installedAt: '', sha256: {} }
  writeFileSync(join(dir, 'installed.json'), JSON.stringify({ ...record, ...from }))
  return dir
}

const loadedIds = () => (globalThis as { kotharLoaded?: string[] }).kotharLoaded ?? []

describe('the manifest', () => {
  it('names the extension and lists what it uses through the extension API', () => {
    const manifest = manifestOf('word-count', { uses: ['panels', 'run'] })
    expect(checkExtensionManifest(manifest)).toEqual({ ...manifest, uses: ['run', 'panels'] })
    const bad: unknown[] = [
      { ...manifest, api: 2 },
      { ...manifest, uses: ['everything'] },
      { ...manifest, uses: 'run' },
      { ...manifest, main: 'evil.js' },
      { ...manifest, id: '../x' },
      { ...manifest, version: 'latest' },
    ]
    for (const value of bad) expect(() => checkExtensionManifest(value), JSON.stringify(value)).toThrow()
  })

  it('reads what an extension uses from the fields it sets', () => {
    const extension: Extension = {
      id: 'x',
      name: 'X',
      description: '',
      enabledByDefault: false,
      tools: [],
      panels: [{ id: 'p', title: 'P', render: () => ({ type: 'divider' }) }],
      onTurnCompleted() {},
      transformOutput: (text) => text,
      onPermissionRequested: () => undefined,
    }
    expect(usesOf(extension)).toEqual(['permissions', 'transforms', 'events', 'panels'])
  })

  it('refuses host calls the manifest did not list, and allows the rest', () => {
    const host = { run: vi.fn(), spawn: vi.fn(), note: vi.fn(), read: vi.fn(), send: vi.fn() } as unknown as ExtensionHost
    const guarded = guardHost(host, { name: 'Sneaky' }, ['readChats'])
    expect(() => guarded.run('rm', ['-rf', '/'])).toThrow(`Sneaky can't use host.run: its manifest doesn't list "run"`)
    expect(() => guarded.spawn('x', [])).toThrow('host.spawn')
    expect(() => guarded.send('c', 'hi')).toThrow('"sendMessages"')
    guarded.read('c')
    guarded.note('c', 'hi')
    expect(host.read).toHaveBeenCalled()
    expect(host.note).toHaveBeenCalled()
  })

  it('refuses a host call Kothar has given no use, so new host calls start closed to community extensions', () => {
    const host = { note: vi.fn(), somethingNew: vi.fn() } as unknown as ExtensionHost
    const guarded = guardHost(host, { name: 'Sneaky' }, ['readChats', 'run', 'network', 'files'])
    expect(() => (guarded as unknown as { somethingNew: () => void }).somethingNew()).toThrow(
      "Sneaky can't use host.somethingNew: community extensions can't use it yet",
    )
    guarded.note('c', 'hi')
    expect(host.note).toHaveBeenCalled()
  })

  it('gives every host call in the extension API a use or marks it free', () => {
    const source = readFileSync(new URL('../../extension-api/index.ts', import.meta.url), 'utf8')
    const body = source.slice(source.indexOf('export type ExtensionHost = {'))
    const calls = [...body.slice(0, body.indexOf('\n}\n')).matchAll(/^  (\w+)[?(:]/gm)].map((m) => m[1]!)
    expect(calls.length).toBeGreaterThan(20)
    const open = calls.filter((call) => !Object.hasOwn(HOST_USES, call) && !FREE_HOST_CALLS.includes(call as keyof ExtensionHost))
    expect(open).toEqual([])
  })

  it("reads what main.mjs needs from Node's own APIs", () => {
    expect(nodeUsesOf(`import { readFileSync } from 'node:fs'`)).toEqual(['files'])
    expect(nodeUsesOf(`import fs from "fs/promises"`)).toEqual(['files'])
    expect(nodeUsesOf(`const { exec } = await import('node:child_process')`)).toEqual(['run'])
    expect(nodeUsesOf(`await fetch(url)`)).toEqual(['network'])
    expect(nodeUsesOf(`const ws = new WebSocket(url)`)).toEqual(['network'])
    expect(nodeUsesOf(`import https from 'node:https'`)).toEqual(['network'])
    expect(nodeUsesOf(`process.getBuiltinModule('fs')`)).toEqual(['run', 'network', 'files'])
    expect(nodeUsesOf(`prefetch(x); const fsName = 'fsx'; host.run('ls', [])`)).toEqual([])
    expect(nodeUsesOf(`const { exec } = require('child_process')`)).toEqual(['run'])
    expect(nodeUsesOf(`import 'node:net'`)).toEqual(['network'])
    expect(nodeUsesOf(`export { readFile } from 'fs'`)).toEqual(['files'])
    expect(nodeUsesOf('const fs = await import(`node:fs`)')).toEqual(['files'])
    expect(nodeUsesOf(`const page = await globalThis.fetch(url)`)).toEqual(['network'])
    expect(nodeUsesOf(`const x = 1 /* fine */; fetch(url)`)).toEqual(['network'])
  })

  it("doesn't count method names, comments or plain strings as Node use", () => {
    expect(nodeUsesOf(`const hit = cache.fetch(key)`)).toEqual([])
    expect(nodeUsesOf(`// we never call fetch() here\nconst a = 1`)).toEqual([])
    expect(nodeUsesOf(`/* import fs from 'node:fs' */ const a = 1`)).toEqual([])
    expect(nodeUsesOf(`const kinds = ['fs', 'net', 'child_process']`)).toEqual([])
    expect(nodeUsesOf(`host.note('call fetch(url) yourself')`)).toEqual([])
    expect(nodeUsesOf(`const url = /https?:\\/\\//; fetch(url)`)).toEqual(['network'])
    expect(nodeUsesOf(`const s = 'it\\'s fine'; require('node:fs')`)).toEqual(['files'])
  })
})

describe('loading community extensions', () => {
  it("imports only the extensions that are on, so installing one runs none of its code", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const garage = tempGarage()
    install(garage, 'loaded-on')
    install(garage, 'loaded-off')
    const found = await loadCommunityExtensions(garage, (id) => id === 'loaded-on')
    expect(found.map((m) => [m.manifest.id, m.extension?.id])).toEqual([
      ['loaded-off', undefined],
      ['loaded-on', 'loaded-on'],
    ])
    expect(loadedIds()).toContain('loaded-on')
    expect(loadedIds()).not.toContain('loaded-off')
  })

  it("won't run an extension that does more than its manifest lists, names itself otherwise, or imports what it didn't bundle", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const garage = tempGarage()
    install(garage, 'sneaky', source('sneaky', ', mcpServers: () => [], onEvent() {}'))
    install(garage, 'renamed', source('other'))
    install(garage, 'unbundled', `import 'left-pad-for-kothar-tests'\n${source('unbundled')}`)
    install(garage, 'no-default', 'export const x = 1')
    install(garage, 'phones-home', `${source('phones-home')}fetch('https://example.com/collect')\nglobalThis.kotharLoaded.push('phoned')\n`)
    install(
      garage,
      'listed-net',
      `${source('listed-net')}if (false) fetch('https://example.com')\n`,
      manifestOf('listed-net', { uses: ['commands', 'network'] }),
    )
    const found = await loadCommunityExtensions(garage, () => true)
    const errors = Object.fromEntries(found.map((m) => [m.manifest.id, m.loadError]))
    expect(loadedIds()).not.toContain('phones-home')
    expect(loadedIds()).toContain('listed-net')
    expect(errors).toEqual({
      'listed-net': undefined,
      'phones-home': `its main.mjs uses Node's own APIs for "network" (reaches the internet) without listing it in its manifest`,
      'no-default': 'main.mjs has no default export',
      renamed: `its id "other" is not its manifest's "renamed"`,
      sneaky: 'it uses "mcpServers", "events" without listing it in its manifest',
      unbundled: "it imports left-pad-for-kothar-tests, which its main.mjs doesn't bundle",
    })
  })

  it('skips folders without a valid manifest, main.mjs or record', async () => {
    const garage = tempGarage()
    const broken = install(garage, 'broken')
    writeFileSync(join(broken, 'manifest.json'), '{')
    rmSync(join(install(garage, 'no-main'), 'main.mjs'))
    rmSync(join(install(garage, 'no-record'), 'installed.json'))
    install(garage, 'misnamed', source('misnamed'), manifestOf('other'))
    expect(await loadCommunityExtensions(garage, () => false)).toEqual([])
  })
})

describe('the core', () => {
  function start(options: { garage?: string; community?: Parameters<typeof openCore>[0]['community']; fetch?: Fetch } = {}) {
    const garage = options.garage ?? tempGarage()
    const adapter = createFakeAdapter([], 0)
    const stock: Extension = { id: 'home', name: 'Home', description: '', enabledByDefault: true }
    const core = openCore({
      garage,
      adapters: [adapter],
      defaultEngine: adapter.id,
      machine: sandboxingMachine,
      extensions: [stock],
      community: options.community,
      marketplaceUrl: CATALOG_URL,
      ...(options.fetch && { fetch: options.fetch }),
    })
    cores.push(core)
    const messages: CoreMessage[] = []
    core.onMessage((m) => messages.push(m))
    const replies: CoreMessage[] = []
    const handle = (m: Parameters<Core['handle']>[0]) => core.handle(m, (r) => replies.push(r))
    return { core, garage, messages, replies, handle }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
  const settingsOf = (garage: string) => JSON.parse(readFileSync(join(garage, 'settings.json'), 'utf8'))

  it('lists an installed extension as off, whatever it says, with what it uses and where it came from', async () => {
    const garage = tempGarage()
    install(garage, 'counter')
    const t = start({ garage, community: await loadCommunityExtensions(garage, () => false) })
    expect(t.core.extensions().find((m) => m.id === 'counter')).toEqual({
      id: 'counter',
      name: 'Extension counter',
      description: 'Does a thing.',
      enabled: false,
      settings: [],
      values: {},
      community: { version: '1.0.0', author: 'Someone', uses: ['commands'], source: 'marketplace', repo: 'someone/counter', tag: 'v1' },
    })
  })

  it('turns an extension on for the next start, and runs it once loaded', async () => {
    const garage = tempGarage()
    const commands = `, commands: [{ id: 'hi', label: 'Say hi', run() {} }]`
    install(garage, 'greeter', source('greeter', commands))
    const t = start({ garage, community: await loadCommunityExtensions(garage, () => false) })
    t.handle({ type: 'communityExtensions.setEnabled', enabled: true })
    t.handle({ type: 'extension.setEnabled', extensionId: 'greeter', enabled: true })
    expect(settingsOf(garage).extensions.greeter.enabled).toBe(true)
    const info = t.core.extensions().find((m) => m.id === 'greeter')!
    expect(info.enabled).toBe(true)
    expect(info.community?.running).toBeUndefined()

    const next = start({ garage, community: await loadCommunityExtensions(garage, (id) => settingsOf(garage).extensions?.[id]?.enabled) })
    expect(next.core.extensions().find((m) => m.id === 'greeter')!.community?.running).toBe('1.0.0')
  })

  it('runs a loaded extension with a host that refuses calls its manifest did not list', async () => {
    const garage = tempGarage()
    const command = `, commands: [{ id: 'go', label: 'Go', run(chat, { host }) { host.note(chat.id, 'noted'); host.run('echo', ['hi']) } }]`
    install(garage, 'runner', source('runner', command))
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ communityExtensions: true, extensions: { runner: { enabled: true } } }))
    const t = start({ garage, community: await loadCommunityExtensions(garage, () => true) })
    t.handle({ type: 'chat.create', name: 'A space' })
    const added = t.messages.findLast((m) => m.type === 'chat.added')
    const id = added?.type === 'chat.added' ? added.chat.id : ''
    t.handle({ type: 'extension.command', chatId: id, extension: 'runner', command: 'go' })
    expect(t.messages).toContainEqual({
      type: 'error',
      message: `Extension runner: Extension runner can't use host.run: its manifest doesn't list "run" (Runs programs on your computer)`,
    })
    expect(t.messages).toContainEqual({ type: 'chat.entry', chatId: id, entry: expect.objectContaining({ text: 'noted' }) })
  })

  it('keeps an extension that clashes with a built-in out, and refuses to install one under a built-in id', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const garage = tempGarage()
    install(garage, 'home')
    const t = start({ garage, community: await loadCommunityExtensions(garage, () => true) })
    expect(t.core.extensions().filter((m) => m.id === 'home')).toHaveLength(1)
    expect(t.core.extensions().find((m) => m.id === 'home')!.community).toBeUndefined()
    t.handle({ type: 'market.install', kind: 'extension', id: 'home' })
    expect(t.replies.at(-1)).toEqual({
      type: 'market.installFailed',
      kind: 'extension',
      id: 'home',
      error: 'A built-in extension is already called "home"',
    })
  })

  it('shows an extension that failed to load, and still lets it be turned off', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const garage = tempGarage()
    install(garage, 'crashy', 'throw new Error("boom")')
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ communityExtensions: true, extensions: { crashy: { enabled: true } } }))
    const t = start({ garage, community: await loadCommunityExtensions(garage, () => true) })
    expect(t.core.extensions().find((m) => m.id === 'crashy')).toMatchObject({ enabled: true, loadError: 'boom' })
    t.handle({ type: 'extension.setEnabled', extensionId: 'crashy', enabled: false })
    expect(t.core.extensions().find((m) => m.id === 'crashy')!.enabled).toBe(false)
  })

  it('installs an extension from its repo, off, then uninstalls it and forgets that it was on', async () => {
    const manifest = manifestOf('counter')
    const entry: CatalogEntry = { id: 'counter', kind: 'extension', name: 'Counter', author: 'Someone', description: 'Counts.', repo: 'someone/counter' }
    const files = { 'manifest.json': JSON.stringify(manifest), 'main.mjs': source('counter') }
    const { fetch } = fakeGitHub([entry], { 'someone/counter': { tag: 'v1.0.0', files } })
    const t = start({ fetch })

    t.handle({ type: 'marketplace.list' })
    await settle()
    expect(t.replies.at(-1)).toMatchObject({
      type: 'marketplace.catalog',
      entries: [{ id: 'counter', kind: 'extension', latest: { tag: 'v1.0.0', version: '1.0.0', uses: ['commands'] } }],
    })

    t.handle({ type: 'market.install', kind: 'extension', id: 'counter' })
    await settle()
    const dir = join(communityDir(t.garage), 'counter')
    expect(readFileSync(join(dir, 'main.mjs'), 'utf8')).toBe(files['main.mjs'])
    expect(JSON.parse(readFileSync(join(dir, 'installed.json'), 'utf8'))).toMatchObject({ source: 'marketplace', tag: 'v1.0.0' })
    expect(t.messages).toContainEqual({ type: 'extension.updated', extension: expect.objectContaining({ id: 'counter', enabled: false }) })
    expect(t.messages.at(-1)).toEqual({ type: 'market.installed', items: [expect.objectContaining({ kind: 'extension', id: 'counter' })] })
    // Nothing was imported.
    expect(t.core.extensions().find((m) => m.id === 'counter')!.community?.running).toBeUndefined()

    t.handle({ type: 'communityExtensions.setEnabled', enabled: true })
    t.handle({ type: 'extension.setEnabled', extensionId: 'counter', enabled: true })
    t.handle({ type: 'market.uninstall', kind: 'extension', id: 'counter' })
    expect(existsSync(dir)).toBe(false)
    expect(settingsOf(t.garage).extensions.counter.enabled).toBeUndefined()
    expect(t.messages).toContainEqual({ type: 'extension.removed', extensionId: 'counter' })
    expect(t.core.extensions().some((m) => m.id === 'counter')).toBe(false)
  })

  it('turns an extension off when an update uses more than the version the user turned on, and says why', async () => {
    const garage = tempGarage()
    install(garage, 'counter')
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ communityExtensions: true, extensions: { counter: { enabled: true } } }))
    const newer = manifestOf('counter', { version: '2.0.0', uses: ['commands', 'run'] })
    const entry: CatalogEntry = { id: 'counter', kind: 'extension', name: 'Counter', author: 'Someone', description: 'Counts.', repo: 'someone/counter' }
    const files = { 'manifest.json': JSON.stringify(newer), 'main.mjs': source('counter') }
    const t = start({
      garage,
      community: await loadCommunityExtensions(garage, () => true),
      fetch: fakeGitHub([entry], { 'someone/counter': { tag: 'v2.0.0', files } }).fetch,
    })
    expect(t.core.restart().changes).toEqual([])
    t.handle({ type: 'market.install', kind: 'extension', id: 'counter' })
    await settle()
    const info = t.core.extensions().find((m) => m.id === 'counter')!
    expect(info).toMatchObject({ enabled: false, community: { version: '2.0.0', running: '1.0.0', uses: ['run', 'commands'] } })
    expect(t.messages).toContainEqual({
      type: 'error',
      message: 'Extension counter was turned off: its update also runs programs on your computer. Turn it on again in Community hub to allow that.',
    })
    // Its old code is still loaded.
    expect(t.core.restart().changes).toEqual([{ id: 'counter', name: 'Extension counter', change: 'stop' }])
  })

  it('turns off any update, even one that uses no more, until the user turns it on again', async () => {
    const garage = tempGarage()
    install(garage, 'counter')
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ communityExtensions: true, extensions: { counter: { enabled: true } } }))
    const newer = manifestOf('counter', { version: '1.1.0' })
    const entry: CatalogEntry = { id: 'counter', kind: 'extension', name: 'Counter', author: 'Someone', description: 'Counts.', repo: 'someone/counter' }
    const t = start({
      garage,
      community: await loadCommunityExtensions(garage, () => true),
      fetch: fakeGitHub([entry], {
        'someone/counter': { tag: 'v1.1.0', files: { 'manifest.json': JSON.stringify(newer), 'main.mjs': source('counter') } },
      }).fetch,
    })
    t.handle({ type: 'market.install', kind: 'extension', id: 'counter' })
    await settle()
    expect(t.core.extensions().find((m) => m.id === 'counter')).toMatchObject({
      enabled: false,
      community: { version: '1.1.0', running: '1.0.0', approved: { version: '1.0.0', uses: ['commands'], tag: 'v1' } },
    })
    expect(t.messages).toContainEqual({
      type: 'error',
      message: "Extension counter was turned off: 1.1.0 isn't the version you turned on. Read the changes, then turn it on again in Community hub.",
    })
    // Turning it on approves 1.1.0, which runs from the next start.
    t.handle({ type: 'extension.setEnabled', extensionId: 'counter', enabled: true })
    expect(t.core.extensions().find((m) => m.id === 'counter')).toMatchObject({
      enabled: true,
      community: { approved: { version: '1.1.0', tag: 'v1.1.0' } },
    })
    expect(t.core.restart().changes).toEqual([{ id: 'counter', name: 'Extension counter', change: 'update' }])
    const history = readFileSync(historyFile(garage), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(history.map((h) => [h.event, h.version])).toEqual([
      ['approved', '1.0.0'],
      ['updated', '1.1.0'],
      ['approved', '1.1.0'],
    ])
    expect(history[1]).toMatchObject({ repo: 'someone/counter', tag: 'v1.1.0', sha256: { 'main.mjs': expect.any(String) } })
  })

  it('keeps a reinstall of the same files on', async () => {
    const garage = tempGarage()
    const folder = join(garage, 'src')
    mkdirSync(folder)
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifestOf('local-one')))
    writeFileSync(join(folder, 'main.mjs'), source('local-one'))
    const t = start({ garage, community: await loadCommunityExtensions(garage, () => false) })
    t.handle({ type: 'communityExtensions.setEnabled', enabled: true })
    t.handle({ type: 'market.installLocal', path: folder })
    t.handle({ type: 'extension.setEnabled', extensionId: 'local-one', enabled: true })
    t.handle({ type: 'market.installLocal', path: folder })
    expect(t.core.extensions().find((m) => m.id === 'local-one')!.enabled).toBe(true)
    writeFileSync(join(folder, 'main.mjs'), source('local-one', ", commands: []"))
    t.handle({ type: 'market.installLocal', path: folder })
    expect(t.core.extensions().find((m) => m.id === 'local-one')!.enabled).toBe(false)
  })

  it('runs a community extension turned on under the old mods settings', async () => {
    const garage = tempGarage()
    install(garage, 'counter')
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ communityMods: true, mods: { counter: { enabled: true } } }))
    expect(savedOn(garage, 'counter')).toBe(true)
    const t = start({ garage, community: await loadCommunityExtensions(garage, (id) => savedOn(garage, id)) })
    expect(t.core.communityExtensions()).toBe(true)
    expect(t.core.extensions().find((m) => m.id === 'counter')).toMatchObject({ enabled: true, community: { running: '1.0.0' } })
    const settings = JSON.parse(readFileSync(join(garage, 'settings.json'), 'utf8'))
    expect(settings).toMatchObject({ communityExtensions: true, extensions: { counter: { enabled: true } } })
    expect(settings).not.toHaveProperty('mods')
  })

  it('keeps every community extension off while the master switch is off, which it is by default', async () => {
    const garage = tempGarage()
    install(garage, 'counter')
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ extensions: { counter: { enabled: true } } }))
    // Its own switch is on, but nothing is imported at startup.
    expect(savedOn(garage, 'counter')).toBe(false)
    const t = start({ garage, community: await loadCommunityExtensions(garage, (id) => savedOn(garage, id)) })
    expect(t.core.communityExtensions()).toBe(false)
    expect(t.core.extensions().find((m) => m.id === 'counter')).toMatchObject({ enabled: true, community: { version: '1.0.0' } })
    expect(t.core.extensions().find((m) => m.id === 'counter')!.community?.running).toBeUndefined()
    install(garage, 'other')
    const u = start({ garage, community: await loadCommunityExtensions(garage, () => false) })
    expect(() => u.handle({ type: 'extension.setEnabled', extensionId: 'other', enabled: true })).toThrow(
      'Turn on community extensions before turning on Extension other',
    )

    t.handle({ type: 'communityExtensions.setEnabled', enabled: true })
    expect(settingsOf(garage).communityExtensions).toBe(true)
    expect(t.messages).toContainEqual({ type: 'communityExtensions.updated', enabled: true })
    expect(savedOn(garage, 'counter')).toBe(true)
  })

  it('stops a loaded extension at once when the master switch goes off, until it goes on again', async () => {
    const garage = tempGarage()
    const command = `, commands: [{ id: 'go', label: 'Go', run(chat, { host }) { host.note(chat.id, 'went') } }]`
    install(garage, 'runner', source('runner', command))
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ communityExtensions: true, extensions: { runner: { enabled: true } } }))
    const t = start({ garage, community: await loadCommunityExtensions(garage, (id) => savedOn(garage, id)) })
    t.handle({ type: 'chat.create', name: 'A space' })
    const added = t.messages.findLast((m) => m.type === 'chat.added')
    const id = added?.type === 'chat.added' ? added.chat.id : ''
    t.handle({ type: 'communityExtensions.setEnabled', enabled: false })
    expect(() => t.handle({ type: 'extension.command', chatId: id, extension: 'runner', command: 'go' })).toThrow('Extension runner is off')
    expect(t.core.restart().changes).toEqual([{ id: 'runner', name: 'Extension runner', change: 'stop' }])
    t.handle({ type: 'communityExtensions.setEnabled', enabled: true })
    t.handle({ type: 'extension.command', chatId: id, extension: 'runner', command: 'go' })
    expect(t.messages).toContainEqual({ type: 'chat.entry', chatId: id, entry: expect.objectContaining({ text: 'went' }) })
    expect(t.core.restart().changes).toEqual([])
  })

  it('says what waits for a restart, comparing what this run loaded with the settings', async () => {
    const garage = tempGarage()
    install(garage, 'loaded')
    install(garage, 'fresh')
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ communityExtensions: true, extensions: { loaded: { enabled: true } } }))
    const t = start({ garage, community: await loadCommunityExtensions(garage, (id) => savedOn(garage, id)) })
    expect(t.core.restart()).toEqual({ changes: [], canRestart: false })

    t.handle({ type: 'extension.setEnabled', extensionId: 'fresh', enabled: true })
    expect(t.core.restart().changes).toEqual([{ id: 'fresh', name: 'Extension fresh', change: 'start' }])
    t.handle({ type: 'extension.setEnabled', extensionId: 'loaded', enabled: false })
    expect(t.core.restart().changes).toEqual([
      { id: 'fresh', name: 'Extension fresh', change: 'start' },
      { id: 'loaded', name: 'Extension loaded', change: 'stop' },
    ])
    // Back as it started: nothing waits.
    t.handle({ type: 'extension.setEnabled', extensionId: 'fresh', enabled: false })
    t.handle({ type: 'extension.setEnabled', extensionId: 'loaded', enabled: true })
    expect(t.core.restart().changes).toEqual([])
    expect(t.messages.filter((m) => m.type === 'restart.updated').at(-1)).toEqual({
      type: 'restart.updated',
      restart: { changes: [], canRestart: false },
    })
    // Uninstalled, its code is still loaded until a restart.
    t.handle({ type: 'market.uninstall', kind: 'extension', id: 'loaded' })
    expect(t.core.restart().changes).toEqual([{ id: 'loaded', name: 'Extension loaded', change: 'stop' }])
  })

  it('restarts through its host, and says so where it has none', () => {
    const t = start()
    expect(() => t.handle({ type: 'app.restart' })).toThrow("This Kothar can't restart itself")
    const restart = vi.fn()
    const garage = tempGarage()
    const adapter = createFakeAdapter([], 0)
    const core = openCore({ garage, adapters: [adapter], defaultEngine: adapter.id, machine: sandboxingMachine, restart })
    cores.push(core)
    expect(core.restart().canRestart).toBe(true)
    core.handle({ type: 'app.restart' }, () => {})
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it("refuses an extension release with a broken manifest, a missing main.mjs or one that's too big", async () => {
    const garage = tempGarage()
    const entry: CatalogEntry = { id: 'counter', kind: 'extension', name: 'Counter', author: 'Someone', description: 'Counts.', repo: 'someone/counter' }
    const tryWith = (files: Record<string, string>) =>
      openMarketplace({ garage, url: CATALOG_URL, fetch: fakeGitHub([entry], { 'someone/counter': { tag: 'v1', files } }).fetch }).install(
        'extension',
        'counter',
      )
    const manifest = JSON.stringify(manifestOf('counter'))
    await expect(tryWith({ 'manifest.json': '{', 'main.mjs': 'x' })).rejects.toThrow('has a broken manifest')
    await expect(tryWith({ 'manifest.json': manifest })).rejects.toThrow('has no main.mjs')
    await expect(tryWith({ 'manifest.json': JSON.stringify(manifestOf('other')), 'main.mjs': 'x' })).rejects.toThrow('names itself "other"')
    await expect(tryWith({ 'manifest.json': manifest, 'main.mjs': 'x'.repeat(5 * 1024 * 1024 + 1) })).rejects.toThrow('over')
    expect(existsSync(communityDir(garage))).toBe(false)
  })

  it('installs an extension from a folder on this computer as local, and copies it again on Reinstall', async () => {
    const t = start()
    const folder = join(tempGarage(), 'my-extension')
    mkdirSync(folder)
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifestOf('mine')))
    t.handle({ type: 'market.installLocal', path: folder })
    expect(t.replies.at(-1)).toEqual({ type: 'market.localFailed', path: folder, error: `${folder} has no main.mjs. Build the extension first.` })

    writeFileSync(join(folder, 'main.mjs'), source('mine'))
    t.handle({ type: 'market.installLocal', path: folder })
    expect(t.replies.at(-1)).toEqual({ type: 'market.localInstalled', path: folder, kind: 'extension', ids: ['mine'] })
    const info = t.core.extensions().find((m) => m.id === 'mine')!
    expect(info).toMatchObject({ enabled: false, community: { source: 'local', path: folder, version: '1.0.0' } })
    expect(t.core.installed()).toEqual([{ kind: 'extension', id: 'mine', name: 'Extension mine', version: '1.0.0', source: 'local', path: folder }])

    writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifestOf('mine', { version: '1.0.1' })))
    t.handle({ type: 'market.installLocal', path: folder })
    expect(t.core.extensions().find((m) => m.id === 'mine')!.community?.version).toBe('1.0.1')
  })

  it('installs themes from a folder, or its themes/ folder', async () => {
    const t = start()
    const nord = JSON.parse(readFileSync(new URL('test-themes/nord.json', import.meta.url), 'utf8'))
    const repo = join(tempGarage(), 'my-themes')
    mkdirSync(join(repo, 'themes'), { recursive: true })
    writeFileSync(join(repo, 'themes', 'nord.json'), JSON.stringify(nord))
    writeFileSync(join(repo, 'package.json'), '{}')
    t.handle({ type: 'market.installLocal', path: repo })
    expect(t.replies.at(-1)).toEqual({ type: 'market.localInstalled', path: repo, kind: 'theme', ids: ['nord'] })
    expect(t.core.themes()).toEqual([nord])
    expect(t.messages).toContainEqual({ type: 'themes.updated', themes: [nord] })
    expect(t.core.installed()[0]).toMatchObject({ kind: 'theme', id: 'nord', source: 'local', path: repo })
  })

  it('says why a folder could not be installed', () => {
    const t = start()
    const empty = tempGarage()
    const bad = join(tempGarage(), 'bad-theme')
    mkdirSync(bad)
    writeFileSync(join(bad, 'x.json'), JSON.stringify({ id: 'x', css: 'body{}' }))
    const broken = join(tempGarage(), 'broken-extension')
    mkdirSync(broken)
    writeFileSync(join(broken, 'manifest.json'), '{')
    const home = join(tempGarage(), 'home-extension')
    mkdirSync(home)
    writeFileSync(join(home, 'manifest.json'), JSON.stringify(manifestOf('home')))
    const cases: [string, string | RegExp][] = [
      ['relative/path', 'Pick a folder, or type its full path'],
      [join(empty, 'missing'), `${join(empty, 'missing')} isn't a folder`],
      [empty, `${empty} has no manifest.json (an extension) or <id>.json theme files`],
      [bad, /^No theme in .* passed the check\. .*x\.json: The theme has an unknown field "css"$/],
      [broken, /manifest\.json is broken/],
      [home, 'A built-in extension is already called "home"'],
    ]
    for (const [path, error] of cases) {
      t.handle({ type: 'market.installLocal', path })
      const reply = t.replies.at(-1)
      expect(reply?.type, path).toBe('market.localFailed')
      if (reply?.type === 'market.localFailed') expect(reply.error, path).toMatch(error)
    }
    expect(existsSync(communityDir(t.garage))).toBe(false)
  })
})

describe('a restartable core (npm run dev)', () => {
  it('closes the running core, then starts a new one that the next close reaches', async () => {
    const closed: number[] = []
    let started = 0
    let restartOf: (() => void) | undefined
    const start = async (restart: () => void) => {
      const n = ++started
      restartOf = restart
      return { close: async () => void closed.push(n) } as unknown as Awaited<ReturnType<Parameters<typeof runRestartable>[0]>>
    }
    const run = await runRestartable(start)
    expect(started).toBe(1)
    restartOf!()
    restartOf!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(closed).toEqual([1])
    expect(started).toBe(2)
    await run.close()
    expect(closed).toEqual([1, 2])
  })
})

describe('importing a community extension again', () => {
  it('reads main.mjs from disk each time, so a restart in the same process runs an update', async () => {
    const garage = tempGarage()
    const dir = install(garage, 'again', source('again', ", description: 'one'"))
    const first = await loadCommunityExtensions(garage, () => true)
    writeFileSync(join(dir, 'main.mjs'), source('again', ", description: 'two'").replace("description: 'Does a thing.', ", ''))
    const later = Date.now() / 1000 + 5
    utimesSync(join(dir, 'main.mjs'), later, later)
    // As the user turning the new files on would.
    rmSync(approvalsFile(garage))
    const second = await loadCommunityExtensions(garage, () => true)
    expect(first[0]!.extension?.description).toBe('one')
    expect(second[0]!.extension?.description).toBe('two')
  })
})

describe('reviewed versions', () => {
  it('approves extensions already on the first time, then runs only those exact files', async () => {
    const garage = tempGarage()
    const dir = install(garage, 'pinned', source('pinned', ", description: 'reviewed'"))
    install(garage, 'idle')
    const first = await loadCommunityExtensions(garage, (id) => id === 'pinned')
    expect(first.find((c) => c.manifest.id === 'pinned')!.extension?.description).toBe('reviewed')
    const approvals = JSON.parse(readFileSync(approvalsFile(garage), 'utf8'))
    expect(Object.keys(approvals)).toEqual(['pinned'])
    expect(approvals.pinned).toMatchObject({ version: '1.0.0', carriedOver: true, sha256: { 'main.mjs': expect.stringMatching(/^[0-9a-f]{64}$/) } })

    // Edited by hand (or swapped by anything else): not imported, and says why.
    writeFileSync(join(dir, 'main.mjs'), source('pinned', ", description: 'swapped'"))
    const later = Date.now() / 1000 + 5
    utimesSync(join(dir, 'main.mjs'), later, later)
    const second = await loadCommunityExtensions(garage, () => true)
    expect(second.find((c) => c.manifest.id === 'pinned')).toMatchObject({ held: 'its files changed since you turned on 1.0.0' })
    expect(second.find((c) => c.manifest.id === 'pinned')!.extension).toBeUndefined()
    // One the user never turned on isn't approved by the first run any more.
    expect(second.find((c) => c.manifest.id === 'idle')).toMatchObject({ held: 'it was never turned on in this Kothar' })
  })

  it('turns a held extension off at startup and approves it when the user turns it on again', async () => {
    const garage = tempGarage()
    const dir = install(garage, 'pinned')
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ communityExtensions: true, extensions: { pinned: { enabled: true } } }))
    await loadCommunityExtensions(garage, (id) => savedOn(garage, id))
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifestOf('pinned', { version: '1.2.0', uses: ['commands', 'run'] })))
    const adapter = createFakeAdapter([], 0)
    const core = openCore({
      garage,
      adapters: [adapter],
      defaultEngine: adapter.id,
      machine: sandboxingMachine,
      extensions: [],
      community: await loadCommunityExtensions(garage, (id) => savedOn(garage, id)),
      marketplaceUrl: CATALOG_URL,
    })
    cores.push(core)
    expect(core.extensions().find((m) => m.id === 'pinned')).toMatchObject({
      enabled: false,
      community: { version: '1.2.0', held: 'it changed from 1.0.0, which you turned on, to 1.2.0', approved: { version: '1.0.0', uses: ['commands'] } },
    })
    expect(JSON.parse(readFileSync(join(garage, 'settings.json'), 'utf8')).extensions.pinned.enabled).toBe(false)
    core.handle({ type: 'extension.setEnabled', extensionId: 'pinned', enabled: true }, () => {})
    const info = core.extensions().find((m) => m.id === 'pinned')!
    expect(info.enabled).toBe(true)
    expect(info.community).not.toHaveProperty('held')
    expect(info.community?.approved).toEqual({ version: '1.2.0', uses: ['run', 'commands'], tag: 'v1' })
    const next = await loadCommunityExtensions(garage, (id) => savedOn(garage, id))
    expect(next[0]!.extension?.id).toBe('pinned')
  })

  it('forgets the approval on uninstall, so installing it again starts off and unapproved', async () => {
    const garage = tempGarage()
    install(garage, 'gone')
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ communityExtensions: true, extensions: { gone: { enabled: true } } }))
    const adapter = createFakeAdapter([], 0)
    const core = openCore({
      garage,
      adapters: [adapter],
      defaultEngine: adapter.id,
      machine: sandboxingMachine,
      extensions: [],
      community: await loadCommunityExtensions(garage, (id) => savedOn(garage, id)),
      marketplaceUrl: CATALOG_URL,
    })
    cores.push(core)
    core.handle({ type: 'market.uninstall', kind: 'extension', id: 'gone' }, () => {})
    expect(JSON.parse(readFileSync(approvalsFile(garage), 'utf8'))).toEqual({})
    expect(readFileSync(historyFile(garage), 'utf8')).toContain('"event":"uninstalled"')
    install(garage, 'gone')
    const again = await loadCommunityExtensions(garage, () => true)
    expect(again[0]).toMatchObject({ held: 'it was never turned on in this Kothar' })
  })

  it('carries over extensions that are on while the Community extensions switch is off', async () => {
    const garage = tempGarage()
    install(garage, 'kept')
    install(garage, 'idle')
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ communityExtensions: false, extensions: { kept: { enabled: true } } }))
    // The first launch after the upgrade, with community extensions off: nothing runs, but the user's choice is kept.
    const first = await loadCommunityExtensions(garage, (id) => savedOn(garage, id), (id) => savedSwitch(garage, id))
    expect(first.every((c) => !c.extension && !c.held)).toBe(true)
    expect(Object.keys(JSON.parse(readFileSync(approvalsFile(garage), 'utf8')))).toEqual(['kept'])
    // Turned on again later: it runs instead of being held.
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ communityExtensions: true, extensions: { kept: { enabled: true } } }))
    const next = await loadCommunityExtensions(garage, (id) => savedOn(garage, id), (id) => savedSwitch(garage, id))
    expect(next.find((c) => c.manifest.id === 'kept')!.extension?.id).toBe('kept')
    expect(next.find((c) => c.manifest.id === 'kept')).not.toHaveProperty('held')
  })

  it('approves nothing when the approvals file is unreadable', async () => {
    const garage = tempGarage()
    install(garage, 'pinned')
    writeFileSync(approvalsFile(garage), '{ not json')
    const loaded = await loadCommunityExtensions(garage, () => true)
    expect(loaded[0]).toMatchObject({ held: 'it was never turned on in this Kothar' })
    expect(existsSync(approvalsFile(garage))).toBe(true)
  })
})
