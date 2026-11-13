// Signing in to remote MCP servers with OAuth, with Kothar as the OAuth client (it's the only MCP client, so engines
// never see these tokens). Follows the MCP authorization spec through the SDK's auth():
// - discovery: Kothar asks the server first, and a 401's WWW-Authenticate resource_metadata (and scope) leads to the
//   protected-resource metadata. Without one, the well-known addresses are tried, then the authorization server's
//   metadata (OAuth, then OpenID Connect, with the path-insertion fallbacks the spec allows);
// - registration: dynamic client registration. A server that doesn't allow it gets a clear message to use a token;
// - authorization code + PKCE (S256), the resource indicator, a random state checked on return, the iss check
//   (RFC 9207), and a loopback redirect on 127.0.0.1 that listens for one answer and closes after it, or after
//   SIGN_IN_TIMEOUT_MS;
// - tokens and the client registration go in the secret store (secrets.json, 0600), never in servers.json, logs, the
//   Activity or the Inspector. They're refreshed shortly before they expire, and on a 401 (the transport retries once).
//   A refused refresh leaves the server needing sign-in.
//
// Two kinds of provider: a sign-in one, which opens the browser, and a background one for each connection. The
// background one never opens anything: if a refresh can't help, it throws UnauthorizedError and the server shows
// "Needs sign-in".
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { ActivityInput } from '@kothar/extension-api'
import {
  auth,
  extractWWWAuthenticateParams,
  RegistrationRejectedError,
  UnauthorizedError,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client'
import type { ServerConfig, Store } from './store.ts'

export const SIGN_IN_TIMEOUT_MS = 5 * 60_000
// Refreshed this long before it expires, so a call doesn't start with a token about to lapse.
export const REFRESH_EARLY_MS = 60_000
export const CALLBACK_PATH = '/callback'

// What the secret store keeps for a server's sign-in (secrets.oauth).
export type SavedOAuth = {
  tokens?: StoredOAuthTokens
  // When the tokens came, for expires_in.
  obtainedAt?: number
  client?: StoredOAuthClientInformation
  // The redirect the client was registered with.
  redirect?: string
  discovery?: OAuthDiscoveryState
}

export type OAuthDeps = {
  store: Store
  now: () => number
  record: (event: ActivityInput) => void
  // Opens the sign-in page in the user's browser.
  openUrl: (url: string) => void | Promise<void>
  fetch?: typeof fetch
  timeoutMs?: number
}

export type SignIn = {
  // The authorization page, for a "Open the sign-in page" link if the browser didn't open.
  url: string
  // Settles when the user finished (or gave up, or it timed out). The loopback server is closed by then.
  done: Promise<void>
  cancel: () => void
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const random = () => randomBytes(32).toString('base64url')

// The secret strings in a saved sign-in: tokens and a client secret. URLs, metadata and the client id aren't secrets,
// and masking them would hide addresses everywhere they're shown.
export function oauthSecretValues(saved: unknown): string[] {
  if (!isRecord(saved)) return []
  const tokens = isRecord(saved.tokens) ? saved.tokens : {}
  const client = isRecord(saved.client) ? saved.client : {}
  return [tokens.access_token, tokens.refresh_token, tokens.id_token, client.client_secret].filter((value): value is string => typeof value === 'string')
}

// A server that won't let Kothar register as a client: GitHub-, Slack-style ones that only take apps they know.
export class RegistrationNotAllowed extends Error {}
const registrationRefused = (error: unknown) =>
  error instanceof RegistrationRejectedError || /dynamic client registration/i.test(messageOf(error))

export function openOAuth(deps: OAuthDeps) {
  const { store } = deps
  const doFetch = deps.fetch ?? fetch
  const saved = (id: string): SavedOAuth => (store.secrets(id).oauth as SavedOAuth | undefined) ?? {}
  const save = (id: string, change: Partial<SavedOAuth>) => {
    const next = { ...saved(id), ...change }
    for (const key of Object.keys(change) as (keyof SavedOAuth)[]) if (change[key] === undefined) delete next[key]
    store.setSecrets(id, { oauth: next as Record<string, unknown> })
  }
  const live = new Map<string, SignIn>()

  const metadata = (redirect: string): OAuthClientMetadata => ({
    client_name: 'Kothar',
    redirect_uris: [redirect],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  })

  // Shared by both kinds: where everything is kept.
  const base = (server: ServerConfig, redirect: string, onTokens: (tokens: StoredOAuthTokens) => void) => {
    let verifier = ''
    const provider: Omit<OAuthClientProvider, 'redirectToAuthorization'> = {
      get redirectUrl() {
        return redirect
      },
      get clientMetadata() {
        return metadata(redirect)
      },
      clientInformation: () => saved(server.id).client,
      saveClientInformation: (client) => save(server.id, { client, redirect }),
      tokens: () => saved(server.id).tokens,
      saveTokens: (tokens) => {
        save(server.id, { tokens, obtainedAt: deps.now() })
        onTokens(tokens)
      },
      saveCodeVerifier: (value) => void (verifier = value),
      codeVerifier: () => verifier,
      saveDiscoveryState: (discovery) => save(server.id, { discovery }),
      discoveryState: () => saved(server.id).discovery,
      invalidateCredentials: (scope) => {
        if (scope === 'all') return save(server.id, { tokens: undefined, obtainedAt: undefined, client: undefined, discovery: undefined })
        if (scope === 'client') return save(server.id, { client: undefined, redirect: undefined })
        if (scope === 'tokens') return save(server.id, { tokens: undefined, obtainedAt: undefined })
        if (scope === 'discovery') return save(server.id, { discovery: undefined })
      },
    }
    return provider
  }

  // The redirect a background connection names: the one the client was registered with (it never redirects anyway).
  const registeredRedirect = (id: string) => saved(id).redirect ?? `http://127.0.0.1${CALLBACK_PATH}`

  // For a connection: refreshes as needed, never opens the browser.
  const background = (server: ServerConfig): OAuthClientProvider => {
    let hadTokens = !!saved(server.id).tokens
    const provider = base(server, registeredRedirect(server.id), () => {
      hadTokens = true
      deps.record({ kind: 'other', title: `Refreshed the sign-in for MCP server ${server.name}` })
    })
    return {
      ...provider,
      // Never signed in: nothing to refresh, and registering now would be wasted (sign-in registers with its own
      // redirect).
      clientInformation: () => {
        const client = saved(server.id).client
        if (!client) throw new UnauthorizedError(`${server.name} needs you to sign in`)
        return client
      },
      // A refresh refused (revoked, expired) drops the tokens; say so once.
      invalidateCredentials: (scope) => {
        if ((scope === 'tokens' || scope === 'all') && hadTokens) {
          hadTokens = false
          deps.record({ kind: 'other', title: `Sign-in for MCP server ${server.name} failed`, error: 'The server refused to refresh it. Sign in again in Settings → Extensions → MCP servers.' })
        }
        return provider.invalidateCredentials!(scope)
      },
      redirectToAuthorization: () => {
        throw new UnauthorizedError(`${server.name} needs you to sign in`)
      },
    }
  }

  // Before a connection: refresh a token that's expired or about to, so the first request isn't refused. A refresh
  // that fails leaves things to the 401 path (which ends at "needs sign-in").
  const refreshIfDue = async (server: ServerConfig) => {
    const { tokens, obtainedAt } = saved(server.id)
    if (!tokens?.refresh_token || !tokens.expires_in || obtainedAt === undefined) return
    if (deps.now() < obtainedAt + tokens.expires_in * 1000 - REFRESH_EARLY_MS) return
    try {
      await auth(background(server), { serverUrl: server.url!, fetchFn: doFetch })
    } catch {
      // The connection finds out, and says it needs sign-in.
    }
  }

  // Asks the server, without a token, what it wants: the resource metadata address and scope from a 401.
  const probe = async (url: string) => {
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kothar', version: '1.0.0' } } }),
        signal: AbortSignal.timeout(15_000),
      })
      await response.body?.cancel().catch(() => {})
      return response.status === 401 ? extractWWWAuthenticateParams(response) : {}
    } catch {
      return {}
    }
  }

  // The loopback server: on the port the client was registered with if it's free (so the registration still fits),
  // otherwise a random one. Answers one callback, then closes.
  const listen = async (id: string): Promise<{ http: Server; redirect: string }> => {
    const http = createServer()
    const at = (port: number) =>
      new Promise<number>((resolve, reject) => {
        http.once('error', reject)
        http.listen(port, '127.0.0.1', () => {
          http.off('error', reject)
          resolve((http.address() as { port: number }).port)
        })
      })
    const was = Number(new URL(registeredRedirect(id)).port || 0)
    let port: number
    try {
      port = await at(was)
    } catch {
      port = await at(0)
    }
    return { http, redirect: `http://127.0.0.1:${port}${CALLBACK_PATH}` }
  }

  const page = (title: string, body: string) =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:4em auto;max-width:32em"><h1 style="font-size:1.4em">${title}</h1><p>${body}</p></body>`
  const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

  const signIn = async (server: ServerConfig): Promise<SignIn> => {
    if (server.transport === 'stdio' || !server.url) throw new Error(`${server.name} runs on your Mac, so it takes keys, not a sign-in`)
    live.get(server.id)?.cancel()
    const { http, redirect } = await listen(server.id)
    const state = random()
    let opened = ''
    let finish: (error?: Error) => void = () => {}
    const finished = new Promise<void>((resolve, reject) => {
      finish = (error) => (error ? reject(error) : resolve())
    })
    const close = () => new Promise<void>((resolve) => http.close(() => resolve()))
    const timer = setTimeout(() => finish(new Error('Signing in took too long; try again')), deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS)
    timer.unref?.()

    // A client registered with another redirect wouldn't be allowed back here: register again.
    if (saved(server.id).client && saved(server.id).redirect !== redirect) save(server.id, { client: undefined, redirect: undefined })

    const provider: OAuthClientProvider = {
      ...base(server, redirect, () => {}),
      state: () => state,
      redirectToAuthorization: (url) => void (opened = url.href),
    }
    const fail = (error: unknown) => {
      const text = registrationRefused(error)
        ? `${server.name} doesn't allow sign-in from other apps. Use a token instead, if it takes one.`
        : messageOf(error)
      deps.record({ kind: 'other', title: `Sign-in to MCP server ${server.name} failed`, error: text })
      return registrationRefused(error) ? new RegistrationNotAllowed(text, { cause: error }) : new Error(text, { cause: error })
    }

    deps.record({ kind: 'other', title: `Started signing in to MCP server ${server.name}`, detail: server.url })
    const challenge = await probe(server.url)
    const options = { serverUrl: server.url, fetchFn: doFetch, ...(challenge.resourceMetadataUrl && { resourceMetadataUrl: challenge.resourceMetadataUrl }), ...(challenge.scope && { scope: challenge.scope }) }
    try {
      await auth(provider, { ...options, forceReauthorization: true })
    } catch (error) {
      clearTimeout(timer)
      await close()
      throw fail(error)
    }
    if (!opened) {
      clearTimeout(timer)
      await close()
      throw fail(new Error('The server gave no sign-in page'))
    }

    http.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', redirect)
      if (url.pathname !== CALLBACK_PATH) return void response.writeHead(404).end()
      const answer = (status: number, title: string, body: string) => response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }).end(page(title, body))
      if (url.searchParams.get('state') !== state) {
        answer(400, 'Sign-in not accepted', 'This answer didn’t come from the sign-in Kothar started. Go back to Kothar and try again.')
        return finish(new Error('The sign-in answer didn’t match the one Kothar started (state mismatch), so it was refused'))
      }
      const code = url.searchParams.get('code')
      const iss = url.searchParams.get('iss') ?? undefined
      if (!code) {
        // An error's text is shown only if it came from the authorization server Kothar expected (RFC 9207).
        const expected = saved(server.id).discovery?.authorizationServerMetadata?.issuer
        const trusted = !iss || iss === expected
        const why = trusted ? (url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? 'no reason given') : 'the answer came from an unexpected server'
        answer(400, 'Sign-in didn’t finish', escape(why))
        return finish(new Error(`The server said no: ${why}`))
      }
      auth(provider, { ...options, authorizationCode: code, ...(iss !== undefined && { iss }) }).then(
        () => {
          answer(200, `Signed in to ${escape(server.name)}`, 'You can close this tab and go back to Kothar.')
          finish()
        },
        (error) => {
          answer(400, 'Sign-in didn’t finish', escape(messageOf(error)))
          finish(error instanceof Error ? error : new Error(messageOf(error)))
        },
      )
    })

    const done = finished.then(
      async () => {
        clearTimeout(timer)
        await close()
        live.delete(server.id)
        deps.record({ kind: 'other', title: `Signed in to MCP server ${server.name}` })
      },
      async (error) => {
        clearTimeout(timer)
        await close()
        live.delete(server.id)
        throw fail(error)
      },
    )
    // Marked handled here: the caller may only look once the browser is open.
    done.catch(() => {})
    const handle: SignIn = { url: opened, done, cancel: () => finish(new Error('Sign-in cancelled')) }
    live.set(server.id, handle)
    try {
      await deps.openUrl(opened)
    } catch {
      // The page shows a link to open it by hand.
    }
    return handle
  }

  return {
    signIn,
    signingIn: (id: string) => live.get(id),
    signedIn: (id: string) => !!saved(id).tokens,
    // Forgets the tokens (and the registration, so the next sign-in starts clean).
    signOut(server: ServerConfig) {
      live.get(server.id)?.cancel()
      save(server.id, { tokens: undefined, obtainedAt: undefined, client: undefined, redirect: undefined, discovery: undefined })
      deps.record({ kind: 'other', title: `Signed out of MCP server ${server.name}` })
    },
    provider: background,
    refreshIfDue,
  }
}

export type OAuth = ReturnType<typeof openOAuth>

// Opens a page in the user's default browser, from Kothar's own process (on the user's computer).
export async function openInBrowser(url: string) {
  if (!/^https?:\/\//.test(url)) throw new Error('Only web addresses open in the browser')
  const { execFile } = await import('node:child_process')
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  await new Promise<void>((resolve, reject) => execFile(command, [url], (error) => (error ? reject(error) : resolve())))
}
