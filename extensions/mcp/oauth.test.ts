// Signing in to a remote MCP server, against a fake authorization server and a fake MCP HTTP server on spare ports.
// No real accounts or third-party servers.
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActivityInput } from '@kothar/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import { openClients } from './clients.ts'
import { openOAuth, oauthSecretValues, RegistrationNotAllowed } from './oauth.ts'
import { masked, openStore, type ServerConfig } from './store.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const tempDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-mcp-oauth-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

type FakeOptions = { registration?: boolean; expiresIn?: number }

// One server playing both parts: the MCP server at /mcp and its authorization server at the root.
async function fakeServers(options: FakeOptions = {}) {
  const { McpServer } = await import('@modelcontextprotocol/server')
  const { NodeStreamableHTTPServerTransport } = await import('@modelcontextprotocol/node')
  const z = await import('zod')
  const seen: string[] = []
  const access = new Set<string>()
  const refresh = new Set<string>()
  const codes = new Map<string, { challenge: string; resource: string; redirect: string; clientId: string }>()
  const authorizeRequests: URL[] = []
  const tokenRequests: URLSearchParams[] = []
  let registered = 0
  let issued = 0
  let base = ''
  const issue = () => {
    issued++
    const tokens = { access_token: `acc-secret-${issued}-xyz`, refresh_token: `ref-secret-${issued}-xyz`, token_type: 'Bearer', expires_in: options.expiresIn ?? 3600 }
    access.add(tokens.access_token)
    refresh.add(tokens.refresh_token)
    return tokens
  }
  const json = (response: import('node:http').ServerResponse, status: number, body: unknown) =>
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  const body = (request: import('node:http').IncomingMessage) =>
    new Promise<string>((resolve) => {
      let text = ''
      request.on('data', (chunk) => (text += chunk))
      request.on('end', () => resolve(text))
    })

  const http = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', base)
    seen.push(`${request.method} ${url.pathname}`)
    if (url.pathname === '/mcp') {
      const token = request.headers.authorization?.replace(/^Bearer /, '')
      if (!token || !access.has(token)) {
        return void response
          .writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="read"` })
          .end()
      }
      const server = new McpServer({ name: 'remote', version: '1.0.0' })
      server.registerTool('whoami', { description: 'Who you are', inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text' as const, text: 'you' }] }))
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      await server.connect(transport)
      return void (await transport.handleRequest(request, response))
    }
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json(response, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['read'] })
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(response, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        ...(options.registration !== false && { registration_endpoint: `${base}/register` }),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true,
      })
    }
    if (url.pathname === '/register' && request.method === 'POST') {
      registered++
      const metadata = JSON.parse(await body(request)) as { redirect_uris: string[] }
      return json(response, 201, { ...metadata, client_id: `client-${registered}` })
    }
    if (url.pathname === '/authorize') {
      // The user said yes: straight back to Kothar with a code.
      authorizeRequests.push(url)
      const code = `code-${authorizeRequests.length}`
      const redirect = url.searchParams.get('redirect_uri')!
      codes.set(code, { challenge: url.searchParams.get('code_challenge')!, resource: url.searchParams.get('resource')!, redirect, clientId: url.searchParams.get('client_id')! })
      const back = new URL(redirect)
      back.searchParams.set('code', code)
      back.searchParams.set('state', url.searchParams.get('state') ?? '')
      back.searchParams.set('iss', base)
      return void response.writeHead(302, { location: back.href }).end()
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      const form = new URLSearchParams(await body(request))
      tokenRequests.push(form)
      if (form.get('grant_type') === 'authorization_code') {
        const saved = codes.get(form.get('code') ?? '')
        codes.delete(form.get('code') ?? '')
        const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
        if (!saved || saved.challenge !== challenge || saved.redirect !== form.get('redirect_uri') || form.get('resource') !== `${base}/mcp`) {
          return json(response, 400, { error: 'invalid_grant' })
        }
        return json(response, 200, issue())
      }
      if (form.get('grant_type') === 'refresh_token') {
        const old = form.get('refresh_token') ?? ''
        if (!refresh.has(old)) return json(response, 400, { error: 'invalid_grant', error_description: 'revoked' })
        refresh.delete(old)
        return json(response, 200, issue())
      }
      return json(response, 400, { error: 'unsupported_grant_type' })
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => http.close(() => resolve())))
  base = `http://127.0.0.1:${(http.address() as { port: number }).port}`
  return {
    url: `${base}/mcp`,
    base,
    seen,
    access,
    refresh,
    authorizeRequests,
    tokenRequests,
    registrations: () => registered,
    revokeAll: () => {
      access.clear()
      refresh.clear()
    },
  }
}

const remoteServer = (url: string): ServerConfig => ({
  id: 'remote',
  name: 'Remote',
  enabled: true,
  transport: 'http',
  url,
  headers: {},
  secretHeaders: [],
  approval: 'ask',
  spaces: 'all',
  auth: 'oauth',
  addedAt: '2026-11-12T00:00:00.000Z',
})

// Kothar's parts, as the extension wires them, with a clock the test moves and a browser that follows redirects.
function kothar(follow: (url: string) => void | Promise<void> = (url) => void fetch(url).catch(() => {}), timeoutMs?: number) {
  const store = openStore(tempDir())
  const events: ActivityInput[] = []
  let clock = Date.parse('2026-11-12T12:00:00Z')
  const opened: string[] = []
  let clients: ReturnType<typeof openClients>
  const oauth = openOAuth({
    store,
    now: () => clock,
    record: (event) => clients.record(event),
    openUrl: (url) => {
      opened.push(url)
      return follow(url)
    },
    ...(timeoutMs && { timeoutMs }),
  })
  clients = openClients({
    store,
    now: () => clock,
    record: (event) => events.push(event),
    idleMs: () => 60_000,
    authProvider: (server) => (server.auth === 'oauth' ? oauth.provider(server) : undefined),
    beforeConnect: (server) => (server.auth === 'oauth' ? oauth.refreshIfDue(server) : Promise.resolve()),
  })
  cleanups.push(() => clients.stopAll())
  return { store, events, oauth, clients, opened, tick: (ms: number) => (clock += ms) }
}

// The loopback redirect named in the authorization request.
const redirectOf = (authorizeUrl: string) => new URL(authorizeUrl).searchParams.get('redirect_uri')!
const closed = async (url: string) => {
  await expect(fetch(url, { signal: AbortSignal.timeout(2000) })).rejects.toThrow()
}

describe('MCP OAuth sign-in', () => {
  it('discovers from the 401, registers, signs in with PKCE, state and resource, and connects', async () => {
    const fake = await fakeServers()
    const k = kothar()
    const server = remoteServer(fake.url)
    k.store.put(server)

    await expect(k.clients.test(server)).rejects.toThrow(/sign in/)
    expect(k.clients.status('remote').state).toBe('needs-sign-in')

    const started = await k.oauth.signIn(server)
    expect(k.oauth.signingIn('remote')).toBeDefined()
    await started.done
    expect(k.oauth.signingIn('remote')).toBeUndefined()

    // Discovery: the resource metadata the 401 named, then the authorization server's metadata.
    expect(fake.seen).toContain('GET /.well-known/oauth-protected-resource/mcp')
    expect(fake.seen).toContain('GET /.well-known/oauth-authorization-server')
    expect(fake.registrations()).toBe(1)
    const authorize = fake.authorizeRequests[0]!
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/)
    expect(authorize.searchParams.get('resource')).toBe(fake.url)
    expect(authorize.searchParams.get('scope')).toContain('read')
    expect(authorize.searchParams.get('state')!.length).toBeGreaterThanOrEqual(32)
    expect(redirectOf(k.opened[0]!)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    // The token request proved the verifier (the fake checks the challenge) and named the resource.
    expect(fake.tokenRequests[0]!.get('grant_type')).toBe('authorization_code')

    expect(k.oauth.signedIn('remote')).toBe(true)
    expect((await k.clients.test(server)).tools.map((t) => t.name)).toEqual(['whoami'])
    expect((await k.clients.call(server, 'whoami', {}, 'c')).content).toEqual([{ type: 'text', text: 'you' }])

    // The loopback server stopped after its one answer.
    await closed(redirectOf(k.opened[0]!))

    // Tokens only in the 0600 secrets file; none in servers.json or the Activity.
    expect(readFileSync(join(k.store.dir, 'servers.json'), 'utf8')).not.toContain('acc-secret')
    expect(readFileSync(join(k.store.dir, 'secrets.json'), 'utf8')).toContain('acc-secret-1-xyz')
    expect(statSync(join(k.store.dir, 'secrets.json')).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(k.events)).not.toMatch(/acc-secret|ref-secret|code_verifier/)
    const titles = k.events.map((e) => e.title)
    expect(titles).toContain('Started signing in to MCP server Remote')
    expect(titles).toContain('Signed in to MCP server Remote')
  })

  it('refuses an answer whose state doesn’t match, and closes the loopback server', async () => {
    const fake = await fakeServers()
    const k = kothar(async (url) => {
      // Something other than the authorization server calls back, with its own state.
      const back = new URL(redirectOf(url))
      back.searchParams.set('code', 'stolen')
      back.searchParams.set('state', 'not-the-one')
      const response = await fetch(back)
      expect(response.status).toBe(400)
    })
    const server = remoteServer(fake.url)
    k.store.put(server)
    const started = await k.oauth.signIn(server)
    await expect(started.done).rejects.toThrow(/state mismatch/)
    expect(fake.tokenRequests).toEqual([])
    expect(k.oauth.signedIn('remote')).toBe(false)
    await closed(redirectOf(k.opened[0]!))
    expect(k.events.map((e) => e.title)).toContain('Sign-in to MCP server Remote failed')
  })

  it('gives up and closes the loopback server when nobody comes back', async () => {
    const fake = await fakeServers()
    const k = kothar(() => {}, 200)
    const server = remoteServer(fake.url)
    k.store.put(server)
    const started = await k.oauth.signIn(server)
    await expect(started.done).rejects.toThrow(/too long/)
    await closed(redirectOf(k.opened[0]!))
  })

  it('says to use a token when the server doesn’t allow registration', async () => {
    const fake = await fakeServers({ registration: false })
    const k = kothar()
    const server = remoteServer(fake.url)
    k.store.put(server)
    const failure = await k.oauth.signIn(server).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(RegistrationNotAllowed)
    expect(String(failure)).toMatch(/doesn't allow sign-in from other apps\. Use a token/)
    expect(k.opened).toEqual([])
  })

  it('refreshes a token about to expire before connecting', async () => {
    const fake = await fakeServers({ expiresIn: 600 })
    const k = kothar()
    const server = remoteServer(fake.url)
    k.store.put(server)
    await (await k.oauth.signIn(server)).done
    k.tick(599_000)
    await k.clients.test(server)
    expect(fake.tokenRequests.map((f) => f.get('grant_type'))).toEqual(['authorization_code', 'refresh_token'])
    expect(fake.tokenRequests[1]!.get('resource')).toBe(fake.url)
    expect(k.events.map((e) => e.title)).toContain('Refreshed the sign-in for MCP server Remote')
    expect(JSON.stringify(k.events)).not.toMatch(/acc-secret|ref-secret/)
  })

  it('refreshes on a 401 and tries once more', async () => {
    const fake = await fakeServers()
    const k = kothar()
    const server = remoteServer(fake.url)
    k.store.put(server)
    await (await k.oauth.signIn(server)).done
    // The server forgets the access token (but not the refresh token).
    fake.access.clear()
    expect((await k.clients.test(server)).tools.map((t) => t.name)).toEqual(['whoami'])
    expect(fake.tokenRequests.at(-1)!.get('grant_type')).toBe('refresh_token')
  })

  it('falls back to needs sign-in when the refresh token is revoked', async () => {
    const fake = await fakeServers()
    const k = kothar()
    const server = remoteServer(fake.url)
    k.store.put(server)
    await (await k.oauth.signIn(server)).done
    fake.revokeAll()
    await expect(k.clients.test(server)).rejects.toThrow(/sign in/)
    expect(k.clients.status('remote').state).toBe('needs-sign-in')
    expect(k.oauth.signedIn('remote')).toBe(false)
    expect(k.events.map((e) => e.title)).toContain('Sign-in for MCP server Remote failed')
    // A background connection never opens the browser.
    expect(k.opened).toHaveLength(1)
  })

  it('signs out: forgets the tokens and the registration', async () => {
    const fake = await fakeServers()
    const k = kothar()
    const server = remoteServer(fake.url)
    k.store.put(server)
    await (await k.oauth.signIn(server)).done
    k.oauth.signOut(server)
    expect(k.oauth.signedIn('remote')).toBe(false)
    expect(readFileSync(join(k.store.dir, 'secrets.json'), 'utf8')).not.toContain('acc-secret')
    expect(k.events.map((e) => e.title)).toContain('Signed out of MCP server Remote')
    await (await k.oauth.signIn(server)).done
    expect(fake.registrations()).toBe(2)
  })

  it('masks tokens and client secrets, but not addresses', async () => {
    const fake = await fakeServers()
    const k = kothar()
    const server = remoteServer(fake.url)
    k.store.put(server)
    await (await k.oauth.signIn(server)).done
    const values = k.store.secretValues()
    expect(values).toContain('acc-secret-1-xyz')
    expect(values).toContain('ref-secret-1-xyz')
    expect(values).not.toContain(fake.base)
    expect(masked(`token acc-secret-1-xyz at ${fake.url}`, values)).toBe(`token [secret] at ${fake.url}`)
    expect(oauthSecretValues({ tokens: { access_token: 'a1b2c3d4' }, client: { client_id: 'id', client_secret: 'shh-secret' } })).toEqual(['a1b2c3d4', 'shh-secret'])
  })
})
