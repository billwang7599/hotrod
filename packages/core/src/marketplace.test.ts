import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildIndex } from '../../../marketplace/build-index.ts'
import { createFakeAdapter } from './adapters/fake.ts'
import { sandboxingMachine } from './adapters/test-machine.ts'
import { openCore, type Core } from './core.ts'
import { MARKETPLACE_URL, openMarketplace, type Fetch } from './marketplace.ts'
import { checkCatalog, checkTheme, type CatalogEntry, type CoreMessage, type ThemeFile } from './shared.ts'

const CATALOG_DIR = new URL('../../../marketplace/', import.meta.url)
const URL_BASE = 'https://example.test/marketplace/'
const INDEX_URL = `${URL_BASE}index.json`

const nord: ThemeFile = JSON.parse(readFileSync(new URL('themes/nord.json', CATALOG_DIR), 'utf8'))
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')

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

// A marketplace served from memory: files by path under URL_BASE.
function fakeFetch(files: Record<string, string>) {
  const calls: string[] = []
  const fetch: Fetch = async (url) => {
    calls.push(url)
    const path = url.startsWith(URL_BASE) ? url.slice(URL_BASE.length) : undefined
    const body = path === undefined ? undefined : files[path]
    return body === undefined ? new Response('missing', { status: 404 }) : new Response(body)
  }
  return { fetch: vi.fn(fetch), calls }
}

function entryOf(theme: ThemeFile, bytes: string, change: Partial<CatalogEntry> = {}): CatalogEntry {
  const { id, name, author, description, version } = theme
  return { id, kind: 'theme', name, author, description, version, path: `themes/${id}.json`, sha256: sha(bytes), ...change }
}

function served(themes: ThemeFile[], change: (entry: CatalogEntry) => CatalogEntry = (e) => e) {
  const files: Record<string, string> = {}
  const entries = themes.map((theme) => {
    const bytes = `${JSON.stringify(theme, null, 2)}\n`
    files[`themes/${theme.id}.json`] = bytes
    return change(entryOf(theme, bytes))
  })
  files['index.json'] = JSON.stringify({ version: 1, entries })
  return files
}

describe('the catalog in this repo', () => {
  it('lists every theme file with its checksum and preview, and is up to date', () => {
    const index = readFileSync(new URL('index.json', CATALOG_DIR), 'utf8')
    expect(index).toBe(buildIndex(realpathSync(CATALOG_DIR) + '/'))
    const entries = checkCatalog(JSON.parse(index))
    const files = readdirSync(new URL('themes/', CATALOG_DIR))
    expect(entries.map((e) => e.path).sort()).toEqual(files.map((f) => `themes/${f}`).sort())
    for (const entry of entries) {
      const bytes = readFileSync(new URL(entry.path, CATALOG_DIR))
      expect(sha(bytes), entry.id).toBe(entry.sha256)
      expect(checkTheme(JSON.parse(bytes.toString('utf8'))).id, entry.id).toBe(entry.id)
    }
  })

  it('holds the themes that used to be built in', () => {
    const ids = checkCatalog(JSON.parse(readFileSync(new URL('index.json', CATALOG_DIR), 'utf8'))).map((e) => e.id)
    expect(ids.sort()).toEqual(
      ['catppuccin', 'everforest', 'gruvbox', 'kanagawa', 'nord', 'rose-pine', 'solarized', 'tokyo-night'].sort(),
    )
  })

  it("points at the catalog on Kothar's main branch", () => {
    expect(MARKETPLACE_URL).toBe('https://raw.githubusercontent.com/billwang7599/kothar/main/marketplace/index.json')
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
  it('lists the catalog, or says why it could not', async () => {
    const garage = tempGarage()
    const { fetch } = fakeFetch(served([nord]))
    const entries = await openMarketplace({ garage, url: INDEX_URL, fetch }).catalog()
    expect(entries.map((e) => e.id)).toEqual(['nord'])

    const offline: Fetch = async () => {
      throw new TypeError('fetch failed')
    }
    await expect(openMarketplace({ garage, url: INDEX_URL, fetch: offline }).catalog()).rejects.toThrow(
      "Couldn't reach the marketplace: fetch failed",
    )
    await expect(openMarketplace({ garage, url: INDEX_URL, fetch: fakeFetch({}).fetch }).catalog()).rejects.toThrow(
      '404',
    )
    const broken = fakeFetch({ 'index.json': JSON.stringify({ entries: [{ id: 'x', kind: 'mod' }] }) })
    await expect(openMarketplace({ garage, url: INDEX_URL, fetch: broken.fetch }).catalog()).rejects.toThrow(
      'The marketplace index is broken',
    )
  })

  it('installs a theme as a plain file, byte for byte, and uninstalls it', async () => {
    const garage = tempGarage()
    const files = served([nord])
    const market = openMarketplace({ garage, url: INDEX_URL, fetch: fakeFetch(files).fetch })
    expect(market.installed()).toEqual([])
    await market.install('nord')
    expect(readFileSync(join(garage, 'themes', 'nord.json'), 'utf8')).toBe(files['themes/nord.json'])
    expect(market.installed()).toEqual([nord])
    market.uninstall('nord')
    expect(existsSync(join(garage, 'themes', 'nord.json'))).toBe(false)
    expect(market.installed()).toEqual([])
  })

  it("refuses a theme whose checksum doesn't match, or that fails the check, and writes nothing", async () => {
    const garage = tempGarage()
    const wrongSum = served([nord], (e) => ({ ...e, sha256: '0'.repeat(64) }))
    await expect(
      openMarketplace({ garage, url: INDEX_URL, fetch: fakeFetch(wrongSum).fetch }).install('nord'),
    ).rejects.toThrow("didn't match the marketplace's checksum")

    const evil = `${JSON.stringify({ ...nord, dark: { ...nord.dark, bg: '#000;}*{x:y' } })}\n`
    const files = { 'themes/nord.json': evil, 'index.json': JSON.stringify({ entries: [entryOf(nord, evil)] }) }
    await expect(openMarketplace({ garage, url: INDEX_URL, fetch: fakeFetch(files).fetch }).install('nord')).rejects.toThrow(
      "isn't a valid theme",
    )

    const other = { ...nord, id: 'other' }
    const renamed = `${JSON.stringify(other)}\n`
    const swapped = { 'themes/nord.json': renamed, 'index.json': JSON.stringify({ entries: [entryOf(nord, renamed)] }) }
    await expect(
      openMarketplace({ garage, url: INDEX_URL, fetch: fakeFetch(swapped).fetch }).install('nord'),
    ).rejects.toThrow('names itself "other"')
    expect(existsSync(join(garage, 'themes'))).toBe(false)
  })

  it('refuses ids that are not safe file names, without fetching', async () => {
    const garage = tempGarage()
    const { fetch } = fakeFetch(served([nord]))
    const market = openMarketplace({ garage, url: INDEX_URL, fetch })
    for (const id of ['../settings', 'a/b', '', 'NORD']) {
      await expect(market.install(id), id).rejects.toThrow('Not a marketplace id')
      expect(() => market.uninstall(id), id).toThrow('Not a marketplace id')
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('skips installed files that fail the check, leaving them on disk', () => {
    const garage = tempGarage()
    mkdirSync(join(garage, 'themes'))
    writeFileSync(join(garage, 'themes', 'nord.json'), JSON.stringify(nord))
    writeFileSync(join(garage, 'themes', 'bad.json'), JSON.stringify({ ...nord, id: 'bad', css: 'x' }))
    writeFileSync(join(garage, 'themes', 'misnamed.json'), JSON.stringify(nord))
    writeFileSync(join(garage, 'themes', 'junk.json'), '{')
    expect(openMarketplace({ garage }).installed().map((t) => t.id)).toEqual(['nord'])
    expect(existsSync(join(garage, 'themes', 'bad.json'))).toBe(true)
  })
})

describe('the core', () => {
  function open(fetch: Fetch) {
    const garage = tempGarage()
    const adapter = createFakeAdapter([], 0)
    const core = openCore({
      garage,
      adapters: [adapter],
      defaultEngine: adapter.id,
      machine: sandboxingMachine,
      mods: [],
      marketplaceUrl: INDEX_URL,
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
    const t = open(fakeFetch(served([nord])).fetch)
    t.handle({ type: 'marketplace.list' })
    await settle()
    expect(t.replies.at(-1)).toMatchObject({ type: 'marketplace.catalog', entries: [{ id: 'nord', kind: 'theme' }] })

    t.handle({ type: 'theme.install', id: 'nord' })
    await settle()
    expect(t.messages.at(-1)).toEqual({ type: 'themes.updated', themes: [nord] })
    expect(t.core.themes()).toEqual([nord])
    t.handle({ type: 'themes.get' })
    expect(t.replies.at(-1)).toEqual({ type: 'themes.updated', themes: [nord] })

    t.handle({ type: 'theme.uninstall', id: 'nord' })
    expect(t.messages.at(-1)).toEqual({ type: 'themes.updated', themes: [] })
  })

  it('answers offline and failed installs inline instead of failing', async () => {
    const t = open(async () => {
      throw new TypeError('fetch failed')
    })
    t.handle({ type: 'marketplace.list' })
    t.handle({ type: 'theme.install', id: 'nord' })
    await settle()
    expect(t.replies).toEqual([
      { type: 'marketplace.catalog', error: "Couldn't reach the marketplace: fetch failed" },
      { type: 'theme.installFailed', id: 'nord', error: "Couldn't reach the marketplace: fetch failed" },
    ])
    expect(t.messages.some((m) => m.type === 'themes.updated')).toBe(false)
  })
})
