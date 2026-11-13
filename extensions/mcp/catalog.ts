// The catalog of popular MCP servers to pick from: catalog.json, bundled and checked by hand (see "checked"), plus an
// optional remote list in the same format (the "Catalog address" setting), as the extensions Marketplace reads its
// JSON. A remote entry with a bundled entry's id replaces it.
import { readFileSync } from 'node:fs'
import { ID_PATTERN, type AuthKind, type ServerConfig } from './store.ts'

export type CatalogToken = { label: string; header?: string; env?: string; prefix?: string; help?: string }
export type CatalogEntry = {
  id: string
  name: string
  description: string
  publisher: string
  official: boolean
  docs?: string
  transport: 'stdio' | 'http' | 'sse'
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  // The user picks folders for it, added after args (the Filesystem server).
  folders?: boolean
  auth: { kinds: AuthKind[]; token?: CatalogToken }
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined)

// An entry as listed, checked; one Kothar can't add is dropped.
export function checkedEntry(value: unknown): CatalogEntry | undefined {
  if (!isRecord(value)) return undefined
  const id = text(value.id)
  const name = text(value.name)
  const transport = value.transport
  if (!id || !ID_PATTERN.test(id) || !name) return undefined
  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') return undefined
  if (transport === 'stdio' && !text(value.command)) return undefined
  if (transport !== 'stdio' && !/^https?:\/\//.test(text(value.url) ?? '')) return undefined
  const auth = isRecord(value.auth) ? value.auth : {}
  const kinds = (Array.isArray(auth.kinds) ? auth.kinds : ['none']).filter((k): k is AuthKind => k === 'none' || k === 'token' || k === 'oauth')
  const token = isRecord(auth.token) && text(auth.token.label) && (text(auth.token.header) || text(auth.token.env)) ? (auth.token as CatalogToken) : undefined
  if (!kinds.length || (kinds.includes('token') && !token)) return undefined
  // A token goes in a header for a remote server, in the environment for a local one.
  if (token && (transport === 'stdio' ? !token.env : !token.header)) return undefined
  return {
    id,
    name,
    description: text(value.description) ?? '',
    publisher: text(value.publisher) ?? 'Unknown',
    official: value.official === true,
    ...(text(value.docs) && /^https:\/\//.test(value.docs as string) && { docs: value.docs as string }),
    transport,
    ...(transport === 'stdio'
      ? {
          command: value.command as string,
          args: Array.isArray(value.args) ? value.args.filter((a): a is string => typeof a === 'string') : [],
          ...(isRecord(value.env) && { env: Object.fromEntries(Object.entries(value.env).filter((e): e is [string, string] => typeof e[1] === 'string')) }),
          ...(value.folders === true && { folders: true }),
        }
      : { url: value.url as string }),
    auth: { kinds, ...(token && { token }) },
  }
}

export function parseCatalog(json: string): CatalogEntry[] {
  try {
    const parsed: unknown = JSON.parse(json)
    const list = isRecord(parsed) && Array.isArray(parsed.servers) ? parsed.servers : []
    const seen = new Set<string>()
    return list.flatMap((value) => {
      const entry = checkedEntry(value)
      if (!entry || seen.has(entry.id)) return []
      seen.add(entry.id)
      return [entry]
    })
  } catch {
    return []
  }
}

export const BUNDLED = parseCatalog(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'))

export const mergedCatalog = (remote: CatalogEntry[]) => {
  const byId = new Map(BUNDLED.map((entry) => [entry.id, entry]))
  for (const entry of remote) byId.set(entry.id, entry)
  return [...byId.values()]
}

// The entries a search matches, by name, publisher and description; all of them for an empty search.
export function searched(entries: CatalogEntry[], query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return entries.filter((entry) => {
    const hay = `${entry.name} ${entry.publisher} ${entry.description}`.toLowerCase()
    return words.every((word) => hay.includes(word))
  })
}

// An id for a new server from the catalog's, made unique among the user's servers (github, github-2, …).
export function freeId(base: string, taken: string[]) {
  const clean = base.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 17) || 'server'
  if (!taken.includes(clean)) return clean
  for (let i = 2; ; i++) if (!taken.includes(`${clean}-${i}`)) return `${clean}-${i}`
}

// A new server (off until the user turns it on) and its secrets, from a catalog entry and what the user gave.
export function serverFromEntry(
  entry: CatalogEntry,
  given: { auth: AuthKind; token?: string; folders?: string[] },
  taken: string[],
  now: Date,
): { server: ServerConfig; secrets?: { env?: Record<string, string>; headers?: Record<string, string> } } {
  const id = freeId(entry.id, taken)
  const token = given.auth === 'token' ? given.token?.trim() : undefined
  if (given.auth === 'token' && !token) throw new Error(`${entry.name} needs its ${entry.auth.token?.label ?? 'token'}`)
  if (entry.folders && !given.folders?.length) throw new Error(`Pick at least one folder for ${entry.name}`)
  const value = token && `${entry.auth.token?.prefix ?? ''}${token}`
  const common = {
    id,
    name: taken.length && id !== entry.id ? `${entry.name} (${id})` : entry.name,
    enabled: false,
    approval: 'ask' as const,
    spaces: 'all' as const,
    auth: given.auth,
    catalogId: entry.id,
    publisher: entry.publisher,
    official: entry.official,
    addedAt: now.toISOString(),
  }
  if (entry.transport === 'stdio') {
    const name = entry.auth.token?.env
    return {
      server: {
        ...common,
        transport: 'stdio',
        command: entry.command!,
        args: [...(entry.args ?? []), ...(given.folders ?? [])],
        env: entry.env ?? {},
        secretEnv: value && name ? [name] : [],
      },
      ...(value && name && { secrets: { env: { [name]: value } } }),
    }
  }
  const header = entry.auth.token?.header
  return {
    server: { ...common, transport: entry.transport, url: entry.url!, headers: {}, secretHeaders: value && header ? [header] : [] },
    ...(value && header && { secrets: { headers: { [header]: value } } }),
  }
}

// A custom server from the Settings form. Lines: arguments one a line; KEY=value for the environment; Name: value
// for headers. Secrets go to the secrets file, the rest to servers.json.
export function serverFromForm(
  form: Record<string, string>,
  taken: string[],
  now: Date,
): { server: ServerConfig; secrets: { env?: Record<string, string>; headers?: Record<string, string> } } {
  const name = form.name?.trim()
  const target = form.target?.trim()
  if (!name) throw new Error('Give the server a name')
  if (!target) throw new Error('Give a command to run, or the address of a remote server')
  const lines = (value = '') => value.split('\n').map((line) => line.trim()).filter(Boolean)
  const pairs = (value: string | undefined, separator: '=' | ':') =>
    Object.fromEntries(
      lines(value).map((line) => {
        const at = line.indexOf(separator)
        if (at < 1) throw new Error(`"${line.slice(0, 40)}" isn't ${separator === '=' ? 'KEY=value' : 'Name: value'}`)
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()]
      }),
    )
  const id = freeId(form.id?.trim() || name, taken)
  const common = { id, name, enabled: false, approval: 'ask' as const, spaces: 'all' as const, publisher: 'You', official: false, addedAt: now.toISOString() }
  if (/^https?:\/\//.test(target)) {
    const secretHeaders = pairs(form.secretHeaders, ':')
    return {
      server: {
        ...common,
        transport: /\/sse\/?$/.test(target) ? 'sse' : 'http',
        url: target,
        headers: pairs(form.headers, ':'),
        secretHeaders: Object.keys(secretHeaders),
        auth: Object.keys(secretHeaders).length ? 'token' : 'none',
      },
      secrets: { headers: secretHeaders },
    }
  }
  const [command, ...rest] = target.split(/\s+/)
  const secretEnv = pairs(form.secretEnv, '=')
  return {
    server: {
      ...common,
      transport: 'stdio',
      command: command!,
      args: [...rest, ...lines(form.args)],
      env: pairs(form.env, '='),
      secretEnv: Object.keys(secretEnv),
      auth: Object.keys(secretEnv).length ? 'token' : 'none',
    },
    secrets: { env: secretEnv },
  }
}
