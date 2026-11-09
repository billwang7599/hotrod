import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type CatalogEntry,
  checkCatalog,
  checkTheme,
  type InstalledItem,
  isItemId,
  type MarketEntry,
  type MarketKind,
  MAX_THEME_BYTES,
  previewOf,
  type ThemeFile,
} from './shared.ts'

// The catalog is its own repo of pointers; each entry's files come from the author's repo. KOTHAR_MARKETPLACE_URL points
// it elsewhere (a fork, or a local server).
export const MARKETPLACE_URL = 'https://raw.githubusercontent.com/billwang7599/kothar-marketplace/main/catalog.json'
export const GITHUB_API = 'https://api.github.com'

const MAX_CATALOG_BYTES = 1024 * 1024
const MAX_RELEASE_BYTES = 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000
// GitHub allows 60 API requests an hour without a token, so a repo's latest release is asked for at most this often.
const RELEASE_CACHE_MS = 10 * 60_000

export type Fetch = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>

type Asset = { name: string; size: number; download: string; api: string }
type Release = { tag: string; assets: Asset[] }

// installed.json, beside what it describes: where it came from and the sha256 of each file as installed.
type InstallRecord = { version: string; installedAt: string; sha256: Record<string, string> } & (
  | { source: 'marketplace'; repo: string; tag: string }
  | { source: 'local'; path: string }
)

const RECORD = 'installed.json'
const THEME_FILE = 'theme.json'

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

  // The catalog with each entry's latest release, read in parallel; an entry that can't be read says why.
  async function listing(): Promise<MarketEntry[]> {
    const entries = (await catalog()).filter((entry) => entry.kind === 'theme')
    return Promise.all(
      entries.map(async (entry): Promise<MarketEntry> => {
        try {
          const { release, theme } = await latestTheme(entry)
          return { ...entry, latest: { tag: release.tag, version: theme.version, preview: previewOf(theme) } }
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

  async function install(kind: MarketKind, id: unknown) {
    if (!isItemId(id)) throw new Error(`Not a marketplace id: ${String(id)}`)
    if (kind !== 'theme') throw new Error(`Only themes install from the marketplace`)
    const entry = (await catalog()).find((e) => e.kind === kind && e.id === id)
    if (!entry) throw new Error(`The marketplace has no theme "${id}"`)
    const { release, bytes, theme } = await latestTheme(entry)
    writeItem(join(themesDir, id), { [THEME_FILE]: bytes }, {
      source: 'marketplace',
      repo: entry.repo,
      tag: release.tag,
      version: theme.version,
      installedAt: new Date(now()).toISOString(),
      sha256: { [THEME_FILE]: sha256(bytes) },
    })
    rmSync(join(themesDir, `${id}.json`), { force: true })
    return theme
  }

  function uninstall(kind: MarketKind, id: unknown) {
    if (!isItemId(id)) throw new Error(`Not a marketplace id: ${String(id)}`)
    if (kind !== 'theme') throw new Error(`Not something Kothar installs: ${String(kind)}`)
    rmSync(join(themesDir, id), { recursive: true, force: true })
    rmSync(join(themesDir, `${id}.json`), { force: true })
  }

  return {
    url,
    catalog,
    listing,
    themes: () => installedThemes().map(({ theme }) => theme),
    installed: (): InstalledItem[] => installedThemes().map(({ item }) => item),
    install,
    uninstall,
  }
}

function itemOf(kind: MarketKind, about: { id: string; name: string; version: string }, record: InstallRecord): InstalledItem {
  const { id, name, version } = about
  const from =
    record.source === 'marketplace' ? { repo: record.repo, tag: record.tag } : { path: (record as { path: string }).path }
  return { kind, id, name, version, source: record.source, ...from }
}

// Only what Kothar uses of GitHub's answer, and only links that stay on GitHub.
function releaseOf(value: unknown, repo: string): Release {
  const release = value as { tag_name?: unknown; assets?: unknown }
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
  return { tag: release.tag_name, assets }
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

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
