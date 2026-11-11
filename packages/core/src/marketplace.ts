import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { ExtensionManifest, ExtensionUse } from '@kothar/extension-api'
import { moveCommunityDir } from './vocab-move.ts'
import { garageHolder } from './garage-lock.ts'
import {
  type CatalogEntry,
  checkCatalog,
  checkExtensionManifest,
  checkTheme,
  type InstalledItem,
  isItemId,
  type MarketEntry,
  type MarketKind,
  MAX_MANIFEST_BYTES,
  MAX_EXTENSION_BYTES,
  MAX_THEME_BYTES,
  previewOf,
  type ThemeFile,
} from './shared.ts'
import { messageOf } from './util.ts'

// The catalog is its own repo of pointers; each entry's files come from the author's repo. KOTHAR_MARKETPLACE_URL points
// it elsewhere (a fork, or a local server).
export const MARKETPLACE_URL = 'https://raw.githubusercontent.com/billwang7599/kothar-marketplace/main/catalog.json'
export const GITHUB_API = 'https://api.github.com'

const MAX_CATALOG_BYTES = 1024 * 1024
const MAX_RELEASE_BYTES = 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000
// GitHub allows 60 API requests an hour without a token, so a repo's latest release is asked for at most this often.
const RELEASE_CACHE_MS = 10 * 60_000
// How much of a release's notes the listing carries: enough for a tooltip; the rest is on GitHub.
const MAX_NOTES_CHARS = 600

export type Fetch = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>

type Asset = { name: string; size: number; download: string; api: string }
type Release = { tag: string; assets: Asset[]; notes?: string }

// installed.json, beside what it describes: where it came from and the sha256 of each file as installed.
type InstallRecord = { version: string; installedAt: string; sha256: Record<string, string> } & (
  | { source: 'marketplace'; repo: string; tag: string }
  | { source: 'local'; path: string }
)

const RECORD = 'installed.json'
const THEME_FILE = 'theme.json'
const MANIFEST = 'manifest.json'
export const EXTENSION_MAIN = 'main.mjs'

// Community extensions live apart from <garage>/extensions/<id>/, which is every extension's own storage and stays on
// uninstall.
export const communityDir = (garage: string) => join(garage, 'community')

export type CommunityInstall = { manifest: ExtensionManifest; item: InstalledItem; dir: string }

// The community extensions installed in the garage: each <garage>/community/<id>/ with a valid manifest.json, its
// main.mjs and installed.json. Folders that don't pass are skipped and left on disk.
export function installedExtensions(garage: string): CommunityInstall[] {
  // Moving folders is for the core that holds the garage; one reading it before (or without) the lock leaves them.
  const holder = garageHolder(garage)
  if (holder === undefined || holder === process.pid) moveCommunityDir(garage)
  const root = communityDir(garage)
  if (!existsSync(root)) return []
  return readdirSync(root)
    .sort()
    .flatMap((id): CommunityInstall[] => {
      const dir = join(root, id)
      if (!isItemId(id) || !statSync(dir).isDirectory() || !existsSync(join(dir, EXTENSION_MAIN))) return []
      try {
        const manifest = checkExtensionManifest(JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')))
        const record = JSON.parse(readFileSync(join(dir, RECORD), 'utf8')) as InstallRecord
        if (manifest.id !== id) return []
        return [{ manifest, item: itemOf('extension', manifest, record), dir }]
      } catch {
        return []
      }
    })
}

// What's installed is plain files: <garage>/themes/<id>/theme.json, each with its installed.json. Themes installed by
// the Kothar that kept them as <garage>/themes/<id>.json still load, as "legacy", until they're updated or removed.
export function openMarketplace(options: {
  garage: string
  url?: string
  fetch?: Fetch
  // A GitHub token, to lift the limit of 60 API requests an hour.
  token?: string
  now?: () => number
}) {
  const { url = MARKETPLACE_URL, fetch = globalThis.fetch, token, now = Date.now } = options
  const themesDir = join(options.garage, 'themes')
  // Each repo's latest release, or the request for it in flight, so entries sharing a repo ask GitHub once.
  const releases = new Map<string, { at: number; release: Promise<Release> }>()
  // Bytes of release assets by download URL; a tag's assets don't change, so these never go stale.
  const assets = new Map<string, Buffer>()

  async function download(from: string, max: number, what: string, headers?: Record<string, string>) {
    let response: Response
    try {
      response = await fetch(from, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(headers && { headers }) })
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'it took too long' : messageOf(error)
      throw new Error(`Couldn't reach ${what}: ${reason}`)
    }
    if (from.startsWith(GITHUB_API) && rateLimited(response)) throw new Error(rateLimitMessage(response))
    if (!response.ok) throw new HttpError(response.status, `${what} answered ${response.status}`)
    const length = Number(response.headers.get('content-length'))
    if (length > max) throw new Error(`${what} is over ${max} bytes`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > max) throw new Error(`${what} is over ${max} bytes`)
    return bytes
  }

  function githubHeaders(accept: string): Record<string, string> {
    return {
      accept,
      'x-github-api-version': '2022-11-28',
      ...(token && { authorization: `Bearer ${token}` }),
    }
  }

  async function catalog(): Promise<CatalogEntry[]> {
    const bytes = await download(url, MAX_CATALOG_BYTES, 'the marketplace')
    try {
      return checkCatalog(JSON.parse(bytes.toString('utf8')))
    } catch (error) {
      throw new Error(`The marketplace catalog is broken: ${messageOf(error)}`)
    }
  }

  function latestRelease(repo: string): Promise<Release> {
    const cached = releases.get(repo)
    if (cached && now() - cached.at < RELEASE_CACHE_MS) return cached.release
    const release = (async () => {
      let bytes: Buffer
      try {
        const from = `${GITHUB_API}/repos/${repo}/releases/latest`
        bytes = await download(from, MAX_RELEASE_BYTES, 'GitHub', githubHeaders('application/vnd.github+json'))
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) throw new Error(`${repo} has no published release`)
        throw error
      }
      return releaseOf(JSON.parse(bytes.toString('utf8')), repo)
    })()
    releases.set(repo, { at: now(), release })
    // A failure isn't kept, so Try again asks again.
    release.catch(() => releases.get(repo)?.release === release && releases.delete(repo))
    return release
  }

  // GitHub's download link first, which uses up none of the hourly limit; its API if that link fails.
  async function assetBytes(release: Release, repo: string, name: string, max: number) {
    const asset = release.assets.find((a) => a.name === name)
    if (!asset) throw new Error(`${repo}'s latest release (${release.tag}) has no ${name}`)
    if (asset.size > max) throw new Error(`${name} in ${repo} is over ${max} bytes`)
    const known = assets.get(asset.download)
    if (known) return known
    let bytes: Buffer
    try {
      bytes = await download(asset.download, max, `${name} in ${repo}`)
    } catch (error) {
      if (error instanceof Error && error.message.includes(`over ${max} bytes`)) throw error
      bytes = await download(asset.api, max, `${name} in ${repo}`, githubHeaders('application/octet-stream'))
    }
    assets.set(asset.download, bytes)
    return bytes
  }

  async function latestTheme(entry: CatalogEntry) {
    const release = await latestRelease(entry.repo)
    const bytes = await assetBytes(release, entry.repo, `${entry.id}.json`, MAX_THEME_BYTES)
    let theme: ThemeFile
    try {
      theme = checkTheme(JSON.parse(bytes.toString('utf8')))
    } catch (error) {
      throw new Error(`"${entry.name}" isn't a valid theme: ${messageOf(error)}`)
    }
    if (theme.id !== entry.id) throw new Error(`"${entry.name}" names itself "${theme.id}", not "${entry.id}"`)
    return { release, bytes, theme }
  }

  // The manifest is downloaded to show what the extension uses; main.mjs only once it's installed.
  async function latestExtension(entry: CatalogEntry) {
    const release = await latestRelease(entry.repo)
    const bytes = await assetBytes(release, entry.repo, MANIFEST, MAX_MANIFEST_BYTES)
    let manifest: ExtensionManifest
    try {
      manifest = checkExtensionManifest(JSON.parse(bytes.toString('utf8')))
    } catch (error) {
      throw new Error(`"${entry.name}" has a broken manifest: ${messageOf(error)}`)
    }
    if (manifest.id !== entry.id) throw new Error(`"${entry.name}" names itself "${manifest.id}", not "${entry.id}"`)
    const main = release.assets.find((a) => a.name === EXTENSION_MAIN)
    if (!main) throw new Error(`${entry.repo}'s latest release (${release.tag}) has no ${EXTENSION_MAIN}`)
    if (main.size > MAX_EXTENSION_BYTES) throw new Error(`${EXTENSION_MAIN} in ${entry.repo} is over ${MAX_EXTENSION_BYTES} bytes`)
    return { release, bytes, manifest }
  }

  // The catalog with each entry's latest release, read in parallel; an entry that can't be read says why.
  async function listing(): Promise<MarketEntry[]> {
    const entries = await catalog()
    return Promise.all(
      entries.map(async (entry): Promise<MarketEntry> => {
        try {
          if (entry.kind === 'extension') {
            const { release, manifest } = await latestExtension(entry)
            const notes = release.notes && { notes: release.notes }
            return { ...entry, latest: { tag: release.tag, version: manifest.version, ...notes, uses: manifest.uses } }
          }
          const { release, theme } = await latestTheme(entry)
          const notes = release.notes && { notes: release.notes }
          return { ...entry, latest: { tag: release.tag, version: theme.version, ...notes, preview: previewOf(theme) } }
        } catch (error) {
          return { ...entry, problem: messageOf(error) }
        }
      }),
    )
  }

  function readRecord(dir: string): InstallRecord | undefined {
    try {
      return JSON.parse(readFileSync(join(dir, RECORD), 'utf8')) as InstallRecord
    } catch {
      return undefined
    }
  }

  function readTheme(file: string) {
    try {
      return checkTheme(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      return undefined
    }
  }

  // Themes that fail the check (edited by hand, or from a newer Kothar) are left on disk but not offered.
  function installedThemes(): { theme: ThemeFile; item: InstalledItem }[] {
    if (!existsSync(themesDir)) return []
    const found = new Map<string, { theme: ThemeFile; item: InstalledItem }>()
    for (const name of readdirSync(themesDir).sort()) {
      const path = join(themesDir, name)
      if (isItemId(name) && statSync(path).isDirectory()) {
        const theme = readTheme(join(path, THEME_FILE))
        const record = readRecord(path)
        if (!theme || theme.id !== name || !record) continue
        found.set(name, { theme, item: itemOf('theme', theme, record) })
      } else if (name.endsWith('.json')) {
        const theme = readTheme(path)
        if (!theme || name !== `${theme.id}.json` || found.has(theme.id)) continue
        const { id, name: shown, version } = theme
        found.set(theme.id, { theme, item: { kind: 'theme', id, name: shown, version, source: 'legacy' } })
      }
    }
    return [...found.values()].sort((a, b) => a.theme.name.localeCompare(b.theme.name))
  }

  // Writes the files and installed.json into a fresh folder, then swaps it in for the old one.
  function writeItem(dir: string, files: Record<string, Buffer>, record: InstallRecord) {
    mkdirSync(join(dir, '..'), { recursive: true })
    const fresh = `${dir}.${randomBytes(4).toString('hex')}.tmp`
    mkdirSync(fresh)
    try {
      for (const [name, bytes] of Object.entries(files)) writeFileSync(join(fresh, name), bytes)
      writeFileSync(join(fresh, RECORD), `${JSON.stringify(record, null, 2)}\n`)
      rmSync(dir, { recursive: true, force: true })
      renameSync(fresh, dir)
    } catch (error) {
      rmSync(fresh, { recursive: true, force: true })
      throw error
    }
  }

  // Installs or updates. For an extension, added is what the new version uses that the installed one didn't.
  async function install(kind: MarketKind, id: unknown): Promise<{ added: ExtensionUse[] }> {
    if (!isItemId(id)) throw new Error(`Not a marketplace id: ${String(id)}`)
    if (kind !== 'theme' && kind !== 'extension') throw new Error(`Not something Kothar installs: ${String(kind)}`)
    const entry = (await catalog()).find((e) => e.kind === kind && e.id === id)
    if (!entry) throw new Error(`The marketplace has no ${kind} "${id}"`)
    const installedAt = new Date(now()).toISOString()
    if (kind === 'theme') {
      const { release, bytes, theme } = await latestTheme(entry)
      writeItem(join(themesDir, id), { [THEME_FILE]: bytes }, {
        source: 'marketplace',
        repo: entry.repo,
        tag: release.tag,
        version: theme.version,
        installedAt,
        sha256: { [THEME_FILE]: sha256(bytes) },
      })
      rmSync(join(themesDir, `${id}.json`), { force: true })
      return { added: [] }
    }
    const { release, bytes, manifest } = await latestExtension(entry)
    const main = await assetBytes(release, entry.repo, EXTENSION_MAIN, MAX_EXTENSION_BYTES)
    const before = installedExtensions(options.garage).find((m) => m.manifest.id === id)?.manifest.uses
    writeItem(join(communityDir(options.garage), id), { [MANIFEST]: bytes, [EXTENSION_MAIN]: main }, {
      source: 'marketplace',
      repo: entry.repo,
      tag: release.tag,
      version: manifest.version,
      installedAt,
      sha256: { [MANIFEST]: sha256(bytes), [EXTENSION_MAIN]: sha256(main) },
    })
    return { added: before ? manifest.uses.filter((use) => !before.includes(use)) : [] }
  }

  function uninstall(kind: MarketKind, id: unknown) {
    if (!isItemId(id)) throw new Error(`Not a marketplace id: ${String(id)}`)
    if (kind === 'extension') return rmSync(join(communityDir(options.garage), id), { recursive: true, force: true })
    if (kind !== 'theme') throw new Error(`Not something Kothar installs: ${String(kind)}`)
    rmSync(join(themesDir, id), { recursive: true, force: true })
    rmSync(join(themesDir, `${id}.json`), { force: true })
  }

  // Copies a folder an author is working on, without publishing it: an extension (manifest.json and main.mjs), or
  // themes (<id>.json files in the folder or its themes/ folder). Installs are marked local, with the folder, so they
  // can be copied again after a rebuild, and the marketplace never offers to update them.
  function installLocal(path: unknown): { kind: MarketKind; ids: string[]; added: ExtensionUse[] } {
    if (typeof path !== 'string' || !isAbsolute(path.trim())) throw new Error('Pick a folder, or type its full path')
    const folder = path.trim()
    if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(`${folder} isn't a folder`)
    const installedAt = new Date(now()).toISOString()
    if (existsSync(join(folder, MANIFEST))) {
      const bytes = readCapped(join(folder, MANIFEST), MAX_MANIFEST_BYTES)
      let manifest: ExtensionManifest
      try {
        manifest = checkExtensionManifest(JSON.parse(bytes.toString('utf8')))
      } catch (error) {
        throw new Error(`${folder}/${MANIFEST} is broken: ${messageOf(error)}`)
      }
      if (!existsSync(join(folder, EXTENSION_MAIN))) throw new Error(`${folder} has no ${EXTENSION_MAIN}. Build the extension first.`)
      const main = readCapped(join(folder, EXTENSION_MAIN), MAX_EXTENSION_BYTES)
      const before = installedExtensions(options.garage).find((m) => m.manifest.id === manifest.id)?.manifest.uses
      writeItem(join(communityDir(options.garage), manifest.id), { [MANIFEST]: bytes, [EXTENSION_MAIN]: main }, {
        source: 'local',
        path: folder,
        version: manifest.version,
        installedAt,
        sha256: { [MANIFEST]: sha256(bytes), [EXTENSION_MAIN]: sha256(main) },
      })
      return { kind: 'extension', ids: [manifest.id], added: before ? manifest.uses.filter((use) => !before.includes(use)) : [] }
    }
    const dirs = [folder, join(folder, 'themes')].filter((dir) => existsSync(dir) && statSync(dir).isDirectory())
    const files = dirs.flatMap((dir) => readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => join(dir, n)))
    const problems: string[] = []
    const themes = files.flatMap((file) => {
      try {
        const bytes = readCapped(file, MAX_THEME_BYTES)
        const theme = checkTheme(JSON.parse(bytes.toString('utf8')))
        if (file !== join(file, '..', `${theme.id}.json`)) throw new Error(`it must be named ${theme.id}.json`)
        return [{ bytes, theme }]
      } catch (error) {
        problems.push(`${file}: ${messageOf(error)}`)
        return []
      }
    })
    if (!themes.length) {
      throw new Error(
        problems.length
          ? `No theme in ${folder} passed the check. ${problems[0]}`
          : `${folder} has no manifest.json (an extension) or <id>.json theme files`,
      )
    }
    for (const { bytes, theme } of themes) {
      writeItem(join(themesDir, theme.id), { [THEME_FILE]: bytes }, {
        source: 'local',
        path: folder,
        version: theme.version,
        installedAt,
        sha256: { [THEME_FILE]: sha256(bytes) },
      })
      rmSync(join(themesDir, `${theme.id}.json`), { force: true })
    }
    return { kind: 'theme', ids: themes.map(({ theme }) => theme.id), added: [] }
  }

  return {
    url,
    catalog,
    installLocal,
    listing,
    themes: () => installedThemes().map(({ theme }) => theme),
    installed: (): InstalledItem[] => [
      ...installedThemes().map(({ item }) => item),
      ...installedExtensions(options.garage).map(({ item }) => item),
    ],
    install,
    uninstall,
  }
}

function readCapped(file: string, max: number) {
  if (statSync(file).size > max) throw new Error(`${file} is over ${max} bytes`)
  return readFileSync(file)
}

function itemOf(kind: MarketKind, about: { id: string; name: string; version: string }, record: InstallRecord): InstalledItem {
  const { id, name, version } = about
  const from =
    record.source === 'marketplace' ? { repo: record.repo, tag: record.tag } : { path: (record as { path: string }).path }
  return { kind, id, name, version, source: record.source, ...from }
}

// Only what Kothar uses of GitHub's answer, and only links that stay on GitHub.
function releaseOf(value: unknown, repo: string): Release {
  const release = value as { tag_name?: unknown; assets?: unknown; body?: unknown }
  if (typeof release?.tag_name !== 'string' || !Array.isArray(release.assets)) {
    throw new Error(`GitHub's answer about ${repo}'s latest release isn't one Kothar can read`)
  }
  const assets = release.assets.flatMap((raw): Asset[] => {
    const a = raw as { name?: unknown; size?: unknown; browser_download_url?: unknown; url?: unknown }
    const { name, size, browser_download_url: download, url: api } = a
    if (typeof name !== 'string' || typeof size !== 'number') return []
    if (typeof download !== 'string' || !download.startsWith(`https://github.com/${repo}/releases/download/`)) return []
    if (typeof api !== 'string' || !api.startsWith(`${GITHUB_API}/repos/${repo}/releases/assets/`)) return []
    return [{ name, size, download, api }]
  })
  const body = typeof release.body === 'string' ? release.body.trim() : ''
  const notes = body.length > MAX_NOTES_CHARS ? `${body.slice(0, MAX_NOTES_CHARS - 1).trimEnd()}…` : body
  return { tag: release.tag_name, assets, ...(notes && { notes }) }
}

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const rateLimited = (response: Response) =>
  (response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0'

function rateLimitMessage(response: Response) {
  const reset = Number(response.headers.get('x-ratelimit-reset'))
  const at = reset > 0 ? new Date(reset * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : undefined
  return (
    `GitHub's limit of 60 requests an hour is used up${at ? `; it resets at ${at}` : ''}. ` +
    'Set KOTHAR_GITHUB_TOKEN to a GitHub token to lift it.'
  )
}

export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

