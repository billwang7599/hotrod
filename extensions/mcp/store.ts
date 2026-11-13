// The user's MCP servers and their secrets, in the extension's own storage (<garage>/extensions/mcp/):
// - servers.json: each server's settings, with no secret in it;
// - secrets.json: API keys, tokens and sign-ins, by server, readable by the user only (0600), never logged, never
//   shown in full, and never passed to an engine: Kothar is the only MCP client, so they go to the server alone;
// - tools/<id>.json: the tools each server listed when Kothar last connected, so a session's tool list is ready at
//   once without starting every server.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { oauthSecretValues } from './oauth.ts'

export type Transport = 'stdio' | 'http' | 'sse'
// Who may call a server's tools without asking: nobody (ask each time), its read-only tools, or all of them.
export type Approval = 'ask' | 'reads' | 'all'
export type AuthKind = 'none' | 'token' | 'oauth'

export type ServerConfig = {
  // Letters, digits, - and _; the start of its tools' names (github__create_issue). Fixed once added.
  id: string
  name: string
  enabled: boolean
  transport: Transport
  // stdio: what to run, and plain environment variables. Secret ones are in secrets.json (secretEnv names them).
  command?: string
  args?: string[]
  env?: Record<string, string>
  secretEnv?: string[]
  // http and sse: where, and plain headers. Secret ones are in secrets.json (secretHeaders names them).
  url?: string
  headers?: Record<string, string>
  secretHeaders?: string[]
  approval: Approval
  // On in every space, or only in these (space ids).
  spaces: 'all' | string[]
  auth?: AuthKind
  // From the catalog, if picked there.
  catalogId?: string
  publisher?: string
  official?: boolean
  addedAt: string
}

export type ServerSecrets = { env?: Record<string, string>; headers?: Record<string, string>; oauth?: Record<string, unknown> }

export type CachedTool = {
  name: string
  description?: string
  inputSchema: { type: 'object'; [keyword: string]: unknown }
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string }
}

export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,19}$/
// Names that would read as Kothar's own or another built-in's.
export const RESERVED_IDS = ['kothar', 'browser', 'mcp']

const readJson = (file: string): unknown => {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
  } catch {
    return undefined
  }
}

// Written whole, then moved into place, so a crash leaves the old file rather than half a new one.
const writeJson = (file: string, value: unknown, mode?: number) => {
  mkdirSync(join(file, '..'), { recursive: true })
  const fresh = `${file}.tmp`
  writeFileSync(fresh, `${JSON.stringify(value, null, 2)}\n`, mode === undefined ? undefined : { mode })
  if (mode !== undefined) chmodSync(fresh, mode)
  renameSync(fresh, file)
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown) =>
  isRecord(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : undefined
const stringList = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined)

// A server as saved, checked; one that can't be used is dropped.
export function checkedServer(value: unknown): ServerConfig | undefined {
  if (!isRecord(value)) return undefined
  const { id, name, transport } = value
  if (typeof id !== 'string' || !ID_PATTERN.test(id) || typeof name !== 'string') return undefined
  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') return undefined
  if (transport === 'stdio' && (typeof value.command !== 'string' || !value.command.trim())) return undefined
  if (transport !== 'stdio' && (typeof value.url !== 'string' || !/^https?:\/\//.test(value.url))) return undefined
  const approval = value.approval === 'reads' || value.approval === 'all' ? value.approval : 'ask'
  const spaces = Array.isArray(value.spaces) ? (stringList(value.spaces) ?? []) : 'all'
  const auth = value.auth === 'token' || value.auth === 'oauth' ? value.auth : value.auth === 'none' ? 'none' : undefined
  return {
    id,
    name,
    enabled: value.enabled === true,
    transport,
    ...(transport === 'stdio'
      ? {
          command: value.command as string,
          args: stringList(value.args) ?? [],
          env: strings(value.env) ?? {},
          secretEnv: stringList(value.secretEnv) ?? [],
        }
      : { url: value.url as string, headers: strings(value.headers) ?? {}, secretHeaders: stringList(value.secretHeaders) ?? [] }),
    approval,
    spaces,
    ...(auth && { auth }),
    ...(typeof value.catalogId === 'string' && { catalogId: value.catalogId }),
    ...(typeof value.publisher === 'string' && { publisher: value.publisher }),
    ...(typeof value.official === 'boolean' && { official: value.official }),
    addedAt: typeof value.addedAt === 'string' ? value.addedAt : new Date(0).toISOString(),
  }
}

export function openStore(dir: string) {
  const serversFile = join(dir, 'servers.json')
  const secretsFile = join(dir, 'secrets.json')
  const toolsFile = (id: string) => join(dir, 'tools', `${id}.json`)

  const servers = (): ServerConfig[] => {
    const saved = readJson(serversFile)
    const list = isRecord(saved) && Array.isArray(saved.servers) ? saved.servers : []
    const seen = new Set<string>()
    return list.flatMap((value) => {
      const server = checkedServer(value)
      if (!server || seen.has(server.id)) return []
      seen.add(server.id)
      return [server]
    })
  }
  const saveServers = (list: ServerConfig[]) => writeJson(serversFile, { servers: list })

  const allSecrets = (): Record<string, ServerSecrets> => {
    const saved = readJson(secretsFile)
    return isRecord(saved) ? (saved as Record<string, ServerSecrets>) : {}
  }
  const secrets = (id: string): ServerSecrets => {
    const saved = allSecrets()[id]
    if (!isRecord(saved)) return {}
    return {
      ...(strings(saved.env) && { env: strings(saved.env) }),
      ...(strings(saved.headers) && { headers: strings(saved.headers) }),
      ...(isRecord(saved.oauth) && { oauth: saved.oauth }),
    }
  }
  const setSecrets = (id: string, change: ServerSecrets | undefined) => {
    const all = allSecrets()
    if (change === undefined) delete all[id]
    else all[id] = { ...all[id], ...change }
    writeJson(secretsFile, all, 0o600)
  }

  return {
    dir,
    servers,
    server: (id: string) => servers().find((server) => server.id === id),
    // Adds the server, or replaces the one with its id.
    put(server: ServerConfig) {
      const list = servers()
      const at = list.findIndex((s) => s.id === server.id)
      if (at === -1) list.push(server)
      else list[at] = server
      saveServers(list)
    },
    remove(id: string) {
      saveServers(servers().filter((server) => server.id !== id))
      setSecrets(id, undefined)
    },
    secrets,
    setSecrets,
    // Every secret value, for masking anything shown or recorded.
    secretValues: () =>
      Object.values(allSecrets()).flatMap((saved) => [
        ...Object.values(strings(saved?.env) ?? {}),
        ...Object.values(strings(saved?.headers) ?? {}),
        ...oauthSecretValues(saved?.oauth),
      ]),
    tools(id: string): { at: string; tools: CachedTool[] } | undefined {
      const saved = readJson(toolsFile(id))
      if (!isRecord(saved) || !Array.isArray(saved.tools) || typeof saved.at !== 'string') return undefined
      return { at: saved.at, tools: saved.tools.filter(isTool) }
    },
    setTools: (id: string, tools: CachedTool[], at: string) => writeJson(toolsFile(id), { at, tools }),
  }
}

export type Store = ReturnType<typeof openStore>

const isTool = (value: unknown): value is CachedTool =>
  isRecord(value) && typeof value.name === 'string' && isRecord(value.inputSchema) && value.inputSchema.type === 'object'

// Any secret in text, replaced by [secret]. Short values (under 4 characters) aren't secrets worth the false matches.
export function masked(text: string, secrets: string[]) {
  let out = text
  for (const secret of [...new Set(secrets)].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('[secret]')
  }
  return out
}

// A secret as the Settings page shows it: its last 4 characters at most.
export const hint = (secret: string | undefined) => (!secret ? '' : secret.length <= 8 ? '••••' : `••••${secret.slice(-4)}`)
