import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeAdapter } from './adapters/fake.ts'
import { sandboxingMachine } from './adapters/test-machine.ts'
import { openCore, type Core } from './core.ts'
import { MARKETPLACE_URL, openMarketplace, sha256, type Fetch } from './marketplace.ts'
import { checkCatalog, checkTheme, previewOf, type CatalogEntry, type CoreMessage, type ThemeFile } from './shared.ts'
import { CATALOG_URL, fakeGitHub } from './test-github.ts'

const themeFile = (id: string): ThemeFile =>
  checkTheme(JSON.parse(readFileSync(new URL(`test-themes/${id}.json`, import.meta.url), 'utf8')))
const nord = themeFile('nord')
const gruvbox = themeFile('gruvbox')
const REPO = 'someone/themes'
const bytesOf = (theme: unknown) => `${JSON.stringify(theme, null, 2)}\n`

const entryOf = (theme: ThemeFile, change: Partial<CatalogEntry> = {}): CatalogEntry => {
  const { id, name, author, description } = theme
  return { id, kind: 'theme', name, author, description, repo: REPO, ...change }
}

// The catalog lists the themes, and REPO's latest release (tag) carries each as <id>.json.
function served(themes: ThemeFile[], tag = 'v1.0.0', options?: Parameters<typeof fakeGitHub>[2]) {
  const files = Object.fromEntries(themes.map((theme) => [`${theme.id}.json`, bytesOf(theme)]))
  return fakeGitHub(themes.map((theme) => entryOf(theme)), { [REPO]: { tag, files } }, options)
}

let dirs: string[] = []
let cores: Core[] = []
afterEach(async () => {
  await Promise.all(cores.map((core) => core.close(true)))
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
  cores = []
})

function tempGarage() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-market-')))
  dirs.push(dir)
  return dir
}

const open = (garage: string, fetch: Fetch, now?: () => number) =>
  openMarketplace({ garage, url: CATALOG_URL, fetch, ...(now && { now }) })

describe('the catalog', () => {
  it("lives in the marketplace's own repo", () => {
    expect(MARKETPLACE_URL).toBe('https://raw.githubusercontent.com/billwang7599/kothar-marketplace/main/catalog.json')
  })

  it('holds pointers only: an id, kind, name, author, description and repo', () => {
    const entry = entryOf(nord)
    expect(checkCatalog({ version: 2, entries: [entry, { ...entry, kind: 'mod' }] })).toEqual([entry, { ...entry, kind: 'mod' }])
    const bad: unknown[] = [
      { version: 1, entries: [] },
      { version: 2, entries: {} },
      { version: 2, entries: [{ ...entry, path: 'themes/nord.json' }] },
      { version: 2, entries: [{ ...entry, sha256: '0'.repeat(64) }] },
      { version: 2, entries: [{ ...entry, kind: 'plugin' }] },
      { version: 2, entries: [{ ...entry, repo: 'no-slash' }] },
      { version: 2, entries: [{ ...entry, repo: 'a/b/c' }] },
      { version: 2, entries: [{ ...entry, repo: 'a/..' }] },
      { version: 2, entries: [{ ...entry, repo: 'https://evil.test/x' }] },
      { version: 2, entries: [{ ...entry, id: '../x' }] },
      { version: 2, entries: [entry, entry] },
    ]
    for (const catalog of bad) expect(() => checkCatalog(catalog), JSON.stringify(catalog).slice(0, 90)).toThrow()
  })
})

describe('checkTheme', () => {
  it('accepts every hex form', () => {
    for (const color of ['#abc', '#aabbcc', '#aabbccdd', '#AABBCC'])
      expect(() => checkTheme({ ...nord, dark: { ...nord.dark, bg: color } }), color).not.toThrow()
  })

  it('rejects anything that could carry CSS or reach outside the themes folder', () => {
    const bad: unknown[] = [
      { ...nord, dark: { ...nord.dark, bg: 'red' } },
      { ...nord, dark: { ...nord.dark, bg: '#000;}body{display:none' } },
      { ...nord, dark: { ...nord.dark, bg: 'url(https://x.test/a.png)' } },
      { ...nord, dark: { ...nord.dark, bg: 'color-mix(in srgb, #000 50%, #fff)' } },
      { ...nord, dark: { ...nord.dark, bg: '#12345' } },
      { ...nord, dark: { ...nord.dark, 'font-family': '#000000' } },
      { ...nord, light: { ...nord.light, red: undefined } },
      { ...nord, id: '../evil' },
      { ...nord, id: 'Nord' },
      { ...nord, id: 'a/b' },
      { ...nord, id: '' },
      { ...nord, version: 'latest' },
      { ...nord, name: '' },
      { ...nord, css: 'body{}' },
      { ...nord, backdrop: { dark: [], light: [] } },
      { ...nord, variants: { dark: 'D', light: 'L', extra: 'x' } },
      [],
      null,
    ]
    for (const theme of bad) expect(() => checkTheme(theme), JSON.stringify(theme)?.slice(0, 80)).toThrow()
  })
})

describe('the marketplace', () => {
  it("lists each entry with its repo's latest release, asking GitHub once per repo", async () => {
    const { fetch, calls } = served([nord, gruvbox], 'v2.0.0')
    const entries = await open(tempGarage(), fetch).listing()
    expect(entries).toEqual([
      { ...entryOf(nord), latest: { tag: 'v2.0.0', version: nord.version, preview: previewOf(nord) } },
      { ...entryOf(gruvbox), latest: { tag: 'v2.0.0', version: gruvbox.version, preview: previewOf(gruvbox) } },
    ])
    expect(calls.filter((url) => url.endsWith('/releases/latest'))).toHaveLength(1)
  })

  it('says which entries it could not read, and lists the rest', async () => {
    const catalog = [entryOf(nord), entryOf(gruvbox, { repo: 'someone/gone' }), entryOf({ ...nord, id: 'nope', name: 'Nope' })]
    const { fetch } = fakeGitHub(catalog, { [REPO]: { tag: 'v1', files: { 'nord.json': bytesOf(nord) } } })
    const entries = await open(tempGarage(), fetch).listing()
    expect(entries[0]!.latest?.version).toBe(nord.version)
    expect(entries[1]!.problem).toBe('someone/gone has no published release')
    expect(entries[2]!.problem).toBe("someone/themes's latest release (v1) has no nope.json")
  })

  it('leaves mods out until Kothar can install them', async () => {
    const { fetch } = fakeGitHub([entryOf(nord), entryOf(nord, { kind: 'mod', id: 'a-mod' })], {
      [REPO]: { tag: 'v1', files: { 'nord.json': bytesOf(nord) } },
    })
    expect((await open(tempGarage(), fetch).listing()).map((e) => e.id)).toEqual(['nord'])
  })

  it('says why the catalog could not be read', async () => {
    const garage = tempGarage()
    const offline: Fetch = async () => {
      throw new TypeError('fetch failed')
    }
    await expect(open(garage, offline).listing()).rejects.toThrow("Couldn't reach the marketplace: fetch failed")
    await expect(open(garage, fakeGitHub('{', {}).fetch).listing()).rejects.toThrow('The marketplace catalog is broken')
    const old = fakeGitHub(JSON.stringify({ version: 1, entries: [] }), {})
    await expect(open(garage, old.fetch).listing()).rejects.toThrow('for another version of Kothar')
  })

  it("explains GitHub's hourly limit instead of failing quietly", async () => {
    const entries = await open(tempGarage(), served([nord], 'v1', { rateLimited: true }).fetch).listing()
    expect(entries[0]!.problem).toMatch(/GitHub's limit of 60 requests an hour is used up; it resets at .+\. Set KOTHAR_GITHUB_TOKEN/)
  })

  it('sends the GitHub token when there is one', async () => {
    const { fetch } = served([nord])
    await openMarketplace({ garage: tempGarage(), url: CATALOG_URL, fetch, token: 'abc' }).listing()
    const api = fetch.mock.calls.find(([url]) => url.endsWith('/releases/latest'))!
    expect(api[1]?.headers?.authorization).toBe('Bearer abc')
  })

  it('asks for a release again only after ten minutes', async () => {
    let time = 0
    const { fetch, calls } = served([nord])
    const market = open(tempGarage(), fetch, () => time)
    await market.listing()
    time += 9 * 60_000
    await market.listing()
    expect(calls.filter((url) => url.endsWith('/releases/latest'))).toHaveLength(1)
    time += 2 * 60_000
    await market.listing()
    expect(calls.filter((url) => url.endsWith('/releases/latest'))).toHaveLength(2)
  })

  it("installs a theme into its own folder with a record of where it came from, and uninstalls it", async () => {
    const garage = tempGarage()
    const market = open(garage, served([nord], 'v1.2.0').fetch, () => Date.parse('2026-11-09T00:00:00Z'))
    expect(market.installed()).toEqual([])
    await market.install('theme', 'nord')
    const dir = join(garage, 'themes', 'nord')
    expect(readFileSync(join(dir, 'theme.json'), 'utf8')).toBe(bytesOf(nord))
    expect(JSON.parse(readFileSync(join(dir, 'installed.json'), 'utf8'))).toEqual({
      source: 'marketplace',
      repo: REPO,
      tag: 'v1.2.0',
      version: nord.version,
      installedAt: '2026-11-09T00:00:00.000Z',
      sha256: { 'theme.json': sha256(Buffer.from(bytesOf(nord))) },
    })
    expect(market.themes()).toEqual([nord])
    expect(market.installed()).toEqual([
      { kind: 'theme', id: 'nord', name: 'Nord', version: nord.version, source: 'marketplace', repo: REPO, tag: 'v1.2.0' },
    ])
    market.uninstall('theme', 'nord')
    expect(existsSync(dir)).toBe(false)
    expect(market.installed()).toEqual([])
  })

  it('updates to the latest release, replacing the old files', async () => {
    const garage = tempGarage()
    await open(garage, served([nord], 'v1').fetch).install('theme', 'nord')
    const newer = { ...nord, version: '2.0.0', dark: { ...nord.dark, accent: '#123456' } }
    await open(garage, served([newer], 'v2').fetch).install('theme', 'nord')
    const market = open(garage, served([]).fetch)
    expect(market.themes()).toEqual([newer])
    expect(market.installed()[0]).toMatchObject({ version: '2.0.0', tag: 'v2' })
    expect(readdirSync(join(garage, 'themes'))).toEqual(['nord'])
  })

  it("falls back to GitHub's API when the download link fails", async () => {
    const garage = tempGarage()
    const { fetch, calls } = served([nord], 'v1', { downloadsFail: true })
    await open(garage, fetch).install('theme', 'nord')
    expect(calls.some((url) => url.includes('/releases/assets/'))).toBe(true)
    expect(open(garage, fetch).themes()).toEqual([nord])
  })

  it('refuses a theme that fails the check, names itself otherwise, or is too big, and writes nothing', async () => {
    const garage = tempGarage()
    const install = (files: Record<string, string>) =>
      open(garage, fakeGitHub([entryOf(nord)], { [REPO]: { tag: 'v1', files } }).fetch).install('theme', 'nord')
    await expect(install({ 'nord.json': bytesOf({ ...nord, dark: { ...nord.dark, bg: '#000;}*{x:y' } }) })).rejects.toThrow(
      "isn't a valid theme",
    )
    await expect(install({ 'nord.json': bytesOf({ ...nord, id: 'other' }) })).rejects.toThrow('names itself "other"')
    await expect(install({ 'nord.json': 'x'.repeat(65 * 1024) })).rejects.toThrow('over 65536 bytes')
    await expect(install({})).rejects.toThrow('has no nord.json')
    expect(existsSync(join(garage, 'themes'))).toBe(false)
  })

  it('refuses ids that are not safe file names, and kinds it does not know, without fetching', async () => {
    const { fetch } = served([nord])
    const market = open(tempGarage(), fetch)
    for (const id of ['../settings', 'a/b', '', 'NORD']) {
      await expect(market.install('theme', id), id).rejects.toThrow('Not a marketplace id')
      expect(() => market.uninstall('theme', id), id).toThrow('Not a marketplace id')
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('still loads themes an older Kothar installed as single files, and moves them on update', async () => {
    const garage = tempGarage()
    mkdirSync(join(garage, 'themes'))
    writeFileSync(join(garage, 'themes', 'nord.json'), JSON.stringify(nord))
    writeFileSync(join(garage, 'themes', 'bad.json'), JSON.stringify({ ...nord, id: 'bad', css: 'x' }))
    writeFileSync(join(garage, 'themes', 'misnamed.json'), JSON.stringify(nord))
    writeFileSync(join(garage, 'themes', 'junk.json'), '{')
    const market = open(garage, served([nord]).fetch)
    expect(market.themes()).toEqual([nord])
    expect(market.installed()).toEqual([{ kind: 'theme', id: 'nord', name: 'Nord', version: nord.version, source: 'legacy' }])
    expect(existsSync(join(garage, 'themes', 'bad.json'))).toBe(true)

    await market.install('theme', 'nord')
    expect(existsSync(join(garage, 'themes', 'nord.json'))).toBe(false)
    expect(market.installed()[0]!.source).toBe('marketplace')
  })

  it('skips a theme folder without its record or with a broken theme', () => {
    const garage = tempGarage()
    mkdirSync(join(garage, 'themes', 'nord'), { recursive: true })
    writeFileSync(join(garage, 'themes', 'nord', 'theme.json'), JSON.stringify(nord))
    mkdirSync(join(garage, 'themes', 'gruvbox'))
    writeFileSync(join(garage, 'themes', 'gruvbox', 'theme.json'), '{')
    writeFileSync(join(garage, 'themes', 'gruvbox', 'installed.json'), '{}')
    expect(openMarketplace({ garage }).installed()).toEqual([])
  })
})

describe('the core', () => {
  function start(fetch: Fetch) {
    const garage = tempGarage()
    const adapter = createFakeAdapter([], 0)
    const core = openCore({
      garage,
      adapters: [adapter],
      defaultEngine: adapter.id,
      machine: sandboxingMachine,
      mods: [],
      marketplaceUrl: CATALOG_URL,
      fetch,
    })
    cores.push(core)
    const messages: CoreMessage[] = []
    core.onMessage((m) => messages.push(m))
    const replies: CoreMessage[] = []
    const handle = (m: Parameters<Core['handle']>[0]) => core.handle(m, (r) => replies.push(r))
    return { core, garage, messages, replies, handle }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

  it('lists the catalog, installs and uninstalls themes, and tells every window', async () => {
    const t = start(served([nord]).fetch)
    t.handle({ type: 'marketplace.list' })
    await settle()
    expect(t.replies.at(-1)).toMatchObject({ type: 'marketplace.catalog', entries: [{ id: 'nord', latest: { tag: 'v1.0.0' } }] })

    t.handle({ type: 'market.install', kind: 'theme', id: 'nord' })
    await settle()
    expect(t.messages.slice(-2)).toEqual([
      { type: 'themes.updated', themes: [nord] },
      { type: 'market.installed', items: [expect.objectContaining({ id: 'nord', source: 'marketplace' })] },
    ])
    expect(t.core.themes()).toEqual([nord])
    t.handle({ type: 'themes.get' })
    expect(t.replies.at(-1)).toEqual({ type: 'themes.updated', themes: [nord] })

    t.handle({ type: 'market.uninstall', kind: 'theme', id: 'nord' })
    expect(t.messages.slice(-2)).toEqual([
      { type: 'themes.updated', themes: [] },
      { type: 'market.installed', items: [] },
    ])
  })

  it('answers offline and failed installs inline instead of failing', async () => {
    const t = start(async () => {
      throw new TypeError('fetch failed')
    })
    t.handle({ type: 'marketplace.list' })
    t.handle({ type: 'market.install', kind: 'theme', id: 'nord' })
    await settle()
    expect(t.replies).toEqual([
      { type: 'marketplace.catalog', error: "Couldn't reach the marketplace: fetch failed" },
      { type: 'market.installFailed', kind: 'theme', id: 'nord', error: "Couldn't reach the marketplace: fetch failed" },
    ])
    expect(t.messages.some((m) => m.type === 'themes.updated')).toBe(false)
  })
})
