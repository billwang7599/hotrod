// A fake GitHub and marketplace catalog for tests: no network. Serves the catalog at CATALOG_URL, each repo's latest
// release from the API, and its assets from both the download link and the API.
import { vi } from 'vitest'
import { GITHUB_API, type Fetch } from './marketplace.ts'
import type { CatalogEntry } from './shared.ts'

export const CATALOG_URL = 'https://example.test/catalog.json'

// notes: the release's notes (GitHub's body).
export type FakeRepo = { tag: string; files: Record<string, string | Uint8Array<ArrayBuffer>>; notes?: string } | undefined

export function fakeGitHub(
  catalog: CatalogEntry[] | string,
  repos: Record<string, FakeRepo>,
  options: { downloadsFail?: boolean; rateLimited?: boolean } = {},
) {
  const calls: string[] = []
  const fetch: Fetch = async (url, init) => {
    calls.push(url)
    if (url === CATALOG_URL) {
      return new Response(typeof catalog === 'string' ? catalog : JSON.stringify({ version: 2, entries: catalog }))
    }
    if (url.startsWith(GITHUB_API) && options.rateLimited) {
      const headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' }
      return new Response('{"message":"API rate limit exceeded"}', { status: 403, headers })
    }
    const latest = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/releases\/latest$/.exec(url)
    if (latest) {
      const repo = repos[latest[1]!]
      if (repo === undefined) return new Response('{"message":"Not Found"}', { status: 404 })
      const { tag } = repo
      const assets = Object.entries(repo.files).map(([name, body], i) => ({
        name,
        size: typeof body === 'string' ? Buffer.byteLength(body) : body.length,
        browser_download_url: `https://github.com/${latest[1]}/releases/download/${tag}/${name}`,
        url: `${GITHUB_API}/repos/${latest[1]}/releases/assets/${i}`,
      }))
      return new Response(JSON.stringify({ tag_name: tag, assets, ...(repo.notes !== undefined && { body: repo.notes }) }))
    }
    const download = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(url)
    if (download) {
      if (options.downloadsFail) return new Response('Gateway Timeout', { status: 504 })
      const repo = repos[download[1]!]
      const body = repo && repo.tag === download[2] ? repo.files[download[3]!] : undefined
      return body === undefined ? new Response('missing', { status: 404 }) : new Response(body)
    }
    const asset = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/releases\/assets\/(\d+)$/.exec(url)
    if (asset && init?.headers?.accept === 'application/octet-stream') {
      const body = Object.values(repos[asset[1]!]?.files ?? {})[Number(asset[2])]
      return body === undefined ? new Response('missing', { status: 404 }) : new Response(body)
    }
    return new Response('missing', { status: 404 })
  }
  return { fetch: vi.fn(fetch), calls }
}
