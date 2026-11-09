import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Mod, ModHost, ModManifest } from '@kotharhq/mod-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeAdapter } from './adapters/fake.ts'
import { sandboxingMachine } from './adapters/test-machine.ts'
import { openCore, type Core } from './core.ts'
import { communityDir, openMarketplace, type Fetch } from './marketplace.ts'
import { guardHost, loadCommunityMods, usesOf } from './mods.ts'
import { checkModManifest, type CatalogEntry, type CoreMessage } from './shared.ts'
import { CATALOG_URL, fakeGitHub } from './test-github.ts'

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

const manifestOf = (id: string, change: Partial<ModManifest> = {}): ModManifest => ({
  id,
  name: `Mod ${id}`,
  version: '1.0.0',
  author: 'Someone',
  description: 'Does a thing.',
  api: 1,
  uses: ['commands'],
  ...change,
})

const source = (id: string, body = '') =>
  `globalThis.kotharLoaded = [...(globalThis.kotharLoaded ?? []), '${id}']\n` +
  `export default { id: '${id}', name: 'Mod ${id}', description: 'Does a thing.', enabledByDefault: true${body} }\n`

// Installs a mod into the garage as the marketplace would.
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
  it('names the mod and lists what it uses through the mod API', () => {
    const manifest = manifestOf('word-count', { uses: ['panels', 'run'] })
    expect(checkModManifest(manifest)).toEqual({ ...manifest, uses: ['run', 'panels'] })
    const bad: unknown[] = [
      { ...manifest, api: 2 },
      { ...manifest, uses: ['everything'] },
      { ...manifest, uses: 'run' },
      { ...manifest, main: 'evil.js' },
      { ...manifest, id: '../x' },
      { ...manifest, version: 'latest' },
    ]
    for (const value of bad) expect(() => checkModManifest(value), JSON.stringify(value)).toThrow()
  })

  it('reads what a mod uses from the fields it sets', () => {
    const mod: Mod = {
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
    expect(usesOf(mod)).toEqual(['permissions', 'transforms', 'events', 'panels'])
  })

  it('refuses host calls the manifest did not list, and allows the rest', () => {
    const host = { run: vi.fn(), spawn: vi.fn(), note: vi.fn(), read: vi.fn(), send: vi.fn() } as unknown as ModHost
    const guarded = guardHost(host, { name: 'Sneaky' }, ['readChats'])
    expect(() => guarded.run('rm', ['-rf', '/'])).toThrow(`Sneaky can't use host.run: its manifest doesn't list "run"`)
    expect(() => guarded.spawn('x', [])).toThrow('host.spawn')
    expect(() => guarded.send('c', 'hi')).toThrow('"sendMessages"')
    guarded.read('c')
    guarded.note('c', 'hi')
    expect(host.read).toHaveBeenCalled()
    expect(host.note).toHaveBeenCalled()
  })
})

describe('loading community mods', () => {
  it("imports only the mods that are on, so installing one runs none of its code", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const garage = tempGarage()
    install(garage, 'loaded-on')
    install(garage, 'loaded-off')
    const found = await loadCommunityMods(garage, (id) => id === 'loaded-on')
    expect(found.map((m) => [m.manifest.id, m.mod?.id])).toEqual([
      ['loaded-off', undefined],
      ['loaded-on', 'loaded-on'],
    ])
    expect(loadedIds()).toContain('loaded-on')
    expect(loadedIds()).not.toContain('loaded-off')
  })

  it("won't run a mod that does more than its manifest lists, names itself otherwise, or imports what it didn't bundle", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const garage = tempGarage()
    install(garage, 'sneaky', source('sneaky', ', mcpServers: () => [], onEvent() {}'))
    install(garage, 'renamed', source('other'))
    install(garage, 'unbundled', `import 'left-pad-for-kothar-tests'\n${source('unbundled')}`)
    install(garage, 'no-default', 'export const x = 1')
    const found = await loadCommunityMods(garage, () => true)
    const errors = Object.fromEntries(found.map((m) => [m.manifest.id, m.loadError]))
    expect(errors).toEqual({
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
    expect(await loadCommunityMods(garage, () => false)).toEqual([])
  })
})

describe('the core', () => {
  function start(options: { garage?: string; community?: Parameters<typeof openCore>[0]['community']; fetch?: Fetch } = {}) {
    const garage = options.garage ?? tempGarage()
    const adapter = createFakeAdapter([], 0)
    const stock: Mod = { id: 'home', name: 'Home', description: '', enabledByDefault: true }
    const core = openCore({
      garage,
      adapters: [adapter],
      defaultEngine: adapter.id,
      machine: sandboxingMachine,
      mods: [stock],
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

  it('lists an installed mod as off, whatever it says, with what it uses and where it came from', async () => {
    const garage = tempGarage()
    install(garage, 'counter')
    const t = start({ garage, community: await loadCommunityMods(garage, () => false) })
    expect(t.core.mods().find((m) => m.id === 'counter')).toEqual({
      id: 'counter',
      name: 'Mod counter',
      description: 'Does a thing.',
      enabled: false,
      settings: [],
      values: {},
      community: { version: '1.0.0', author: 'Someone', uses: ['commands'], source: 'marketplace', repo: 'someone/counter' },
    })
  })

  it('turns a mod on for the next start, and runs it once loaded', async () => {
    const garage = tempGarage()
    const commands = `, commands: [{ id: 'hi', label: 'Say hi', run() {} }]`
    install(garage, 'greeter', source('greeter', commands))
    const t = start({ garage, community: await loadCommunityMods(garage, () => false) })
    t.handle({ type: 'mod.setEnabled', modId: 'greeter', enabled: true })
    expect(settingsOf(garage).mods.greeter.enabled).toBe(true)
    const info = t.core.mods().find((m) => m.id === 'greeter')!
    expect(info.enabled).toBe(true)
    expect(info.community?.running).toBeUndefined()

    const next = start({ garage, community: await loadCommunityMods(garage, (id) => settingsOf(garage).mods?.[id]?.enabled) })
    expect(next.core.mods().find((m) => m.id === 'greeter')!.community?.running).toBe('1.0.0')
  })

  it('runs a loaded mod with a host that refuses calls its manifest did not list', async () => {
    const garage = tempGarage()
    const command = `, commands: [{ id: 'go', label: 'Go', run(chat, { host }) { host.note(chat.id, 'noted'); host.run('echo', ['hi']) } }]`
    install(garage, 'runner', source('runner', command))
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ mods: { runner: { enabled: true } } }))
    const t = start({ garage, community: await loadCommunityMods(garage, () => true) })
    t.handle({ type: 'chat.create', name: 'A space' })
    const added = t.messages.findLast((m) => m.type === 'chat.added')
    const id = added?.type === 'chat.added' ? added.chat.id : ''
    t.handle({ type: 'mod.command', chatId: id, mod: 'runner', command: 'go' })
    expect(t.messages).toContainEqual({
      type: 'error',
      message: `Mod runner: Mod runner can't use host.run: its manifest doesn't list "run" (Runs programs on your computer)`,
    })
    expect(t.messages).toContainEqual({ type: 'chat.entry', chatId: id, entry: expect.objectContaining({ text: 'noted' }) })
  })

  it('keeps a mod that clashes with a built-in out, and refuses to install one under a built-in id', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const garage = tempGarage()
    install(garage, 'home')
    const t = start({ garage, community: await loadCommunityMods(garage, () => true) })
    expect(t.core.mods().filter((m) => m.id === 'home')).toHaveLength(1)
    expect(t.core.mods().find((m) => m.id === 'home')!.community).toBeUndefined()
    t.handle({ type: 'market.install', kind: 'mod', id: 'home' })
    expect(t.replies.at(-1)).toEqual({
      type: 'market.installFailed',
      kind: 'mod',
      id: 'home',
      error: 'A built-in mod is already called "home"',
    })
  })

  it('shows a mod that failed to load, and still lets it be turned off', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const garage = tempGarage()
    install(garage, 'crashy', 'throw new Error("boom")')
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ mods: { crashy: { enabled: true } } }))
    const t = start({ garage, community: await loadCommunityMods(garage, () => true) })
    expect(t.core.mods().find((m) => m.id === 'crashy')).toMatchObject({ enabled: true, loadError: 'boom' })
    t.handle({ type: 'mod.setEnabled', modId: 'crashy', enabled: false })
    expect(t.core.mods().find((m) => m.id === 'crashy')!.enabled).toBe(false)
  })

  it('installs a mod from its repo, off, then uninstalls it and forgets that it was on', async () => {
    const manifest = manifestOf('counter')
    const entry: CatalogEntry = { id: 'counter', kind: 'mod', name: 'Counter', author: 'Someone', description: 'Counts.', repo: 'someone/counter' }
    const files = { 'manifest.json': JSON.stringify(manifest), 'main.mjs': source('counter') }
    const { fetch } = fakeGitHub([entry], { 'someone/counter': { tag: 'v1.0.0', files } })
    const t = start({ fetch })

    t.handle({ type: 'marketplace.list' })
    await settle()
    expect(t.replies.at(-1)).toMatchObject({
      type: 'marketplace.catalog',
      entries: [{ id: 'counter', kind: 'mod', latest: { tag: 'v1.0.0', version: '1.0.0', uses: ['commands'] } }],
    })

    t.handle({ type: 'market.install', kind: 'mod', id: 'counter' })
    await settle()
    const dir = join(communityDir(t.garage), 'counter')
    expect(readFileSync(join(dir, 'main.mjs'), 'utf8')).toBe(files['main.mjs'])
    expect(JSON.parse(readFileSync(join(dir, 'installed.json'), 'utf8'))).toMatchObject({ source: 'marketplace', tag: 'v1.0.0' })
    expect(t.messages).toContainEqual({ type: 'mod.updated', mod: expect.objectContaining({ id: 'counter', enabled: false }) })
    expect(t.messages.at(-1)).toEqual({ type: 'market.installed', items: [expect.objectContaining({ kind: 'mod', id: 'counter' })] })
    // Nothing was imported.
    expect(t.core.mods().find((m) => m.id === 'counter')!.community?.running).toBeUndefined()

    t.handle({ type: 'mod.setEnabled', modId: 'counter', enabled: true })
    t.handle({ type: 'market.uninstall', kind: 'mod', id: 'counter' })
    expect(existsSync(dir)).toBe(false)
    expect(settingsOf(t.garage).mods.counter.enabled).toBeUndefined()
    expect(t.messages).toContainEqual({ type: 'mod.removed', modId: 'counter' })
    expect(t.core.mods().some((m) => m.id === 'counter')).toBe(false)
  })

  it('turns a mod off when an update uses more than the version the user turned on, and says why', async () => {
    const garage = tempGarage()
    install(garage, 'counter')
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ mods: { counter: { enabled: true } } }))
    const newer = manifestOf('counter', { version: '2.0.0', uses: ['commands', 'run'] })
    const entry: CatalogEntry = { id: 'counter', kind: 'mod', name: 'Counter', author: 'Someone', description: 'Counts.', repo: 'someone/counter' }
    const files = { 'manifest.json': JSON.stringify(newer), 'main.mjs': source('counter') }
    const t = start({
      garage,
      community: await loadCommunityMods(garage, () => true),
      fetch: fakeGitHub([entry], { 'someone/counter': { tag: 'v2.0.0', files } }).fetch,
    })
    t.handle({ type: 'market.install', kind: 'mod', id: 'counter' })
    await settle()
    const info = t.core.mods().find((m) => m.id === 'counter')!
    expect(info).toMatchObject({ enabled: false, community: { version: '2.0.0', running: '1.0.0', uses: ['run', 'commands'] } })
    expect(t.messages).toContainEqual({
      type: 'error',
      message: 'Mod counter was turned off: its update also runs programs on your computer. Turn it on again in Community mods to allow that.',
    })
  })

  it('keeps an update that uses no more on', async () => {
    const garage = tempGarage()
    install(garage, 'counter')
    writeFileSync(join(garage, 'settings.json'), JSON.stringify({ mods: { counter: { enabled: true } } }))
    const newer = manifestOf('counter', { version: '1.1.0' })
    const entry: CatalogEntry = { id: 'counter', kind: 'mod', name: 'Counter', author: 'Someone', description: 'Counts.', repo: 'someone/counter' }
    const t = start({
      garage,
      community: await loadCommunityMods(garage, () => true),
      fetch: fakeGitHub([entry], {
        'someone/counter': { tag: 'v1.1.0', files: { 'manifest.json': JSON.stringify(newer), 'main.mjs': source('counter') } },
      }).fetch,
    })
    t.handle({ type: 'market.install', kind: 'mod', id: 'counter' })
    await settle()
    expect(t.core.mods().find((m) => m.id === 'counter')).toMatchObject({ enabled: true, community: { version: '1.1.0', running: '1.0.0' } })
  })

  it("refuses a mod release with a broken manifest, a missing main.mjs or one that's too big", async () => {
    const garage = tempGarage()
    const entry: CatalogEntry = { id: 'counter', kind: 'mod', name: 'Counter', author: 'Someone', description: 'Counts.', repo: 'someone/counter' }
    const tryWith = (files: Record<string, string>) =>
      openMarketplace({ garage, url: CATALOG_URL, fetch: fakeGitHub([entry], { 'someone/counter': { tag: 'v1', files } }).fetch }).install(
        'mod',
        'counter',
      )
    const manifest = JSON.stringify(manifestOf('counter'))
    await expect(tryWith({ 'manifest.json': '{', 'main.mjs': 'x' })).rejects.toThrow('has a broken manifest')
    await expect(tryWith({ 'manifest.json': manifest })).rejects.toThrow('has no main.mjs')
    await expect(tryWith({ 'manifest.json': JSON.stringify(manifestOf('other')), 'main.mjs': 'x' })).rejects.toThrow('names itself "other"')
    await expect(tryWith({ 'manifest.json': manifest, 'main.mjs': 'x'.repeat(5 * 1024 * 1024 + 1) })).rejects.toThrow('over')
    expect(existsSync(communityDir(garage))).toBe(false)
  })

  it('installs a mod from a folder on this computer as local, and copies it again on Reinstall', async () => {
    const t = start()
    const folder = join(tempGarage(), 'my-mod')
    mkdirSync(folder)
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifestOf('mine')))
    t.handle({ type: 'market.installLocal', path: folder })
    expect(t.replies.at(-1)).toEqual({ type: 'market.localFailed', path: folder, error: `${folder} has no main.mjs. Build the mod first.` })

    writeFileSync(join(folder, 'main.mjs'), source('mine'))
    t.handle({ type: 'market.installLocal', path: folder })
    expect(t.replies.at(-1)).toEqual({ type: 'market.localInstalled', path: folder, kind: 'mod', ids: ['mine'] })
    const info = t.core.mods().find((m) => m.id === 'mine')!
    expect(info).toMatchObject({ enabled: false, community: { source: 'local', path: folder, version: '1.0.0' } })
    expect(t.core.installed()).toEqual([{ kind: 'mod', id: 'mine', name: 'Mod mine', version: '1.0.0', source: 'local', path: folder }])

    writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifestOf('mine', { version: '1.0.1' })))
    t.handle({ type: 'market.installLocal', path: folder })
    expect(t.core.mods().find((m) => m.id === 'mine')!.community?.version).toBe('1.0.1')
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
    const broken = join(tempGarage(), 'broken-mod')
    mkdirSync(broken)
    writeFileSync(join(broken, 'manifest.json'), '{')
    const home = join(tempGarage(), 'home-mod')
    mkdirSync(home)
    writeFileSync(join(home, 'manifest.json'), JSON.stringify(manifestOf('home')))
    const cases: [string, string | RegExp][] = [
      ['relative/path', 'Pick a folder, or type its full path'],
      [join(empty, 'missing'), `${join(empty, 'missing')} isn't a folder`],
      [empty, `${empty} has no manifest.json (a mod) or <id>.json theme files`],
      [bad, /^No theme in .* passed the check\. .*x\.json: The theme has an unknown field "css"$/],
      [broken, /manifest\.json is broken/],
      [home, 'A built-in mod is already called "home"'],
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
