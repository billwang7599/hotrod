import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ImportResult, Library } from './library.ts'
import { MAX_UNPACKED, readZip } from './zip.ts'

// Where skills can come from besides being made in Kothar: a folder, a .zip or .skill file, a GitHub repo, and the
// skills folders of engines the user has used on their own.

export type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>

// Skills from the internet start off: their names and descriptions would go into every session's instructions, and
// their text into the agent's when it reads one, so the user reads them first. Skills from the user's own computer
// (a folder, an archive they picked, an engine's skills folder) start on: they chose to bring them in.
export const ON_FROM_INTERNET = false

export type GitHubSource = { owner: string; repo: string; ref?: string; path?: string }

// github.com/<owner>/<repo>, optionally /tree/<ref>/<path> (a folder) or /blob/<ref>/<path>/SKILL.md (its folder). A
// ref with a / in it can't be told from the path; the first part is taken as the ref.
export function parseGitHub(text: string): GitHubSource | undefined {
  const match = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(tree|blob)\/([^/?#]+)((?:\/[^?#]*)?))?\/?(?:[?#].*)?$/.exec(
    text.trim(),
  )
  if (!match) return undefined
  const [, owner, repo, kind, ref, rest] = match
  let path = decodeURIComponent(rest ?? '').replace(/^\/+|\/+$/g, '')
  if (kind === 'blob') path = path.split('/').slice(0, -1).join('/')
  return { owner: owner!, repo: repo!, ...(ref && { ref: decodeURIComponent(ref) }), ...(path && { path }) }
}

export const gitHubLabel = (source: GitHubSource) =>
  `GitHub ${source.owner}/${source.repo}${source.path ? `/${source.path}` : ''}${source.ref ? ` (${source.ref})` : ''}`

// Downloads the repo's archive at the ref (the default branch without one) and reads it, capped in size. Nothing in it is
// run: it's unpacked into the library's scratch folder and copied as files.
async function downloadZip(fetch: Fetch, source: GitHubSource, timeoutMs: number) {
  const url = `https://api.github.com/repos/${source.owner}/${source.repo}/zipball${source.ref ? `/${encodeURIComponent(source.ref)}` : ''}`
  const response = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'Kothar' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (response.status === 404) throw new Error(`GitHub has no public repo ${source.owner}/${source.repo}${source.ref ? ` at ${source.ref}` : ''}`)
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_UNPACKED) throw new Error('The repo is too big to import')
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body?.getReader()
  if (!reader) throw new Error('GitHub sent nothing')
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_UNPACKED) {
      void reader.cancel()
      throw new Error('The repo is too big to import')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

export async function importGitHub(library: Library, fetch: Fetch, url: string, timeoutMs = 60_000): Promise<ImportResult> {
  const source = parseGitHub(url)
  if (!source) throw new Error(`${url} isn't a GitHub repo or folder link`)
  const zip = await downloadZip(fetch, source, timeoutMs)
  return library.importEntries(readZip(zip), gitHubLabel(source), { on: ON_FROM_INTERNET, strip: true, under: source.path })
}

export const isArchive = (path: string) => /\.(zip|skill)$/i.test(path)

export function importArchive(library: Library, path: string): ImportResult {
  return library.importEntries(readZip(readFileSync(path)), `File ${path}`, { on: true })
}

export function importFolder(library: Library, path: string): ImportResult {
  return library.importDir(path, `Folder ${path}`, { on: true, follow: true })
}

// A path the user typed: ~ is their home folder.
export const expandHome = (path: string, home: string) => resolve(path.replace(/^~(?=$|\/)/, home))

// Imports what the user typed or picked: a GitHub link, a .zip or .skill file, or a folder.
export async function importAny(library: Library, fetch: Fetch, home: string, input: string): Promise<ImportResult> {
  const text = input.trim()
  if (!text) throw new Error('Type a folder, a .zip or .skill file, or a GitHub link')
  if (/^(https?:\/\/)?(www\.)?github\.com\//i.test(text)) return importGitHub(library, fetch, text)
  if (/^https?:\/\//i.test(text)) throw new Error('Only GitHub links can be imported')
  const path = expandHome(text, home)
  let stat
  try {
    stat = statSync(path)
  } catch {
    throw new Error(`${path} doesn't exist`)
  }
  if (stat.isDirectory()) return importFolder(library, path)
  if (isArchive(path)) return importArchive(library, path)
  throw new Error(`${path} isn't a folder, a .zip or a .skill file`)
}

// The skills folders of engines the user may have used outside Kothar. Kothar never loads these into its sessions
// (engines start clean); importing copies them into its own library.
export type EngineSource = { id: string; label: string; dir: string }

export const engineSources = (home: string, env: Record<string, string | undefined>): EngineSource[] => [
  { id: 'claude', label: 'Claude Code', dir: join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'skills') },
  { id: 'codex', label: 'Codex', dir: join(env.CODEX_HOME || join(home, '.codex'), 'skills') },
  { id: 'agents', label: 'Shared agents', dir: join(home, '.agents', 'skills') },
  { id: 'pi', label: 'pi', dir: join(env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'), 'skills') },
]

export function importEngine(library: Library, source: EngineSource): ImportResult {
  return library.importDir(source.dir, source.label, { on: true, follow: true })
}
