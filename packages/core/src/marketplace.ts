import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CatalogEntry, checkCatalog, checkTheme, isItemId, MAX_THEME_BYTES, type ThemeFile } from './shared.ts'

// The catalog lives in Kothar's own repo; KOTHAR_MARKETPLACE_URL points it elsewhere (a fork, or a local server).
export const MARKETPLACE_URL = 'https://raw.githubusercontent.com/billwang7599/kothar/main/marketplace/index.json'

const MAX_INDEX_BYTES = 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000

export type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>

// Installed themes are plain files, <garage>/themes/<id>.json, kept byte for byte as the catalog served them.
export function openMarketplace(options: { garage: string; url?: string; fetch?: Fetch }) {
  const { url = MARKETPLACE_URL, fetch = globalThis.fetch } = options
  const dir = join(options.garage, 'themes')

  async function download(from: string, max: number) {
    let response: Response
    try {
      response = await fetch(from, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'it took too long' : messageOf(error)
      throw new Error(`Couldn't reach the marketplace: ${reason}`)
    }
    if (!response.ok) throw new Error(`The marketplace answered ${response.status} for ${from}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > max) throw new Error(`${from} is over ${max} bytes`)
    return bytes
  }

  async function catalog(): Promise<CatalogEntry[]> {
    const bytes = await download(url, MAX_INDEX_BYTES)
    try {
      return checkCatalog(JSON.parse(bytes.toString('utf8')))
    } catch (error) {
      throw new Error(`The marketplace index is broken: ${messageOf(error)}`)
    }
  }

  // Themes that fail the check (edited by hand, or from a newer Kothar) are left on disk but not offered.
  function installed(): ThemeFile[] {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) => {
        try {
          const theme = checkTheme(JSON.parse(readFileSync(join(dir, name), 'utf8')))
          return name === `${theme.id}.json` ? [theme] : []
        } catch {
          return []
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async function install(id: unknown): Promise<ThemeFile> {
    if (!isItemId(id)) throw new Error(`Not a marketplace id: ${String(id)}`)
    const entry = (await catalog()).find((e) => e.id === id)
    if (!entry) throw new Error(`The marketplace has no theme "${id}"`)
    const bytes = await download(new URL(entry.path, url).href, MAX_THEME_BYTES)
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw new Error(`"${entry.name}" didn't match the marketplace's checksum, so it wasn't installed`)
    }
    let theme: ThemeFile
    try {
      theme = checkTheme(JSON.parse(bytes.toString('utf8')))
    } catch (error) {
      throw new Error(`"${entry.name}" isn't a valid theme: ${messageOf(error)}`)
    }
    if (theme.id !== id) throw new Error(`"${entry.name}" names itself "${theme.id}", not "${id}"`)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${id}.json`)
    writeFileSync(`${file}.tmp`, bytes)
    renameSync(`${file}.tmp`, file)
    return theme
  }

  function uninstall(id: unknown) {
    if (!isItemId(id)) throw new Error(`Not a marketplace id: ${String(id)}`)
    rmSync(join(dir, `${id}.json`), { force: true })
  }

  return { url, catalog, installed, install, uninstall }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
