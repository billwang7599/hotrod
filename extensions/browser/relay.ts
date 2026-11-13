// Agents in the user's own Chrome, through the Kothar Chrome extension (chrome-extension/). One local server, on
// 127.0.0.1 only, with two kinds of connection:
//
// - The extension's, at ws://127.0.0.1:<port>/extension?token=<token>. The token is the one in the pairing code the
//   user pasted into the extension (Settings → Extensions → Browser shows it), and the Origin must be the extension's
//   own chrome-extension:// address, so no web page can connect even if it learned the code. One at a time: a newer
//   one replaces the old.
// - Playwright MCP's, one per chat, given http://127.0.0.1:<port>/<cdpToken>/<space> as --cdp-endpoint. Its
//   /json/version points Playwright at a WebSocket here that speaks enough of a browser's DevTools protocol for
//   Playwright to drive the space's tabs: the tabs in the space's Kothar tab group, each driven with chrome.debugger in
//   the extension. Browser-wide calls that would read, change or end the user's own browser (every cookie, closing it,
//   new profiles) are refused.
//
// The model follows Playwright's own extension relay (playwright-core's cdpRelay and browserModel), with the tab group
// per space and pairing of Kothar's own.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'

export const EXTENSION_DIR = fileURLToPath(new URL('./chrome-extension', import.meta.url))
// A port of its own, so the pairing code stays the same across Kothar's restarts; another is picked if it's taken.
export const DEFAULT_PORT = 41751
const CALL_MS = 15_000

// The extension's id comes from the key in its manifest, so it's the same wherever it's loaded unpacked from.
export function extensionId(manifest = readFileSync(`${EXTENSION_DIR}/manifest.json`, 'utf8')): string {
  const { key } = JSON.parse(manifest) as { key: string }
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
  return [...hex].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join('')
}

// Browser-wide calls refused on any session: every cookie of every site, changing them, permissions, ending the browser.
export const REFUSED = new Set([
  'Browser.close',
  'Browser.crash',
  'Browser.crashGpuProcess',
  'Browser.grantPermissions',
  'Browser.resetPermissions',
  'Browser.setPermission',
  'Network.getAllCookies',
  'Network.clearBrowserCookies',
  'Network.clearBrowserCache',
  'Storage.getCookies',
  'Storage.setCookies',
  'Storage.clearCookies',
  'Storage.clearDataForOrigin',
  'Target.createBrowserContext',
  'Target.disposeBrowserContext',
])

export const NOT_CONNECTED =
  "Kothar's Chrome extension isn't connected, so there's no browser. Ask the user to open Chrome and check the " +
  'Kothar extension says Connected (Settings → Extensions → Browser has the steps).'

export type RelayTab = { url: string; title: string; active: boolean }

export type Relay = {
  readonly port: number
  readonly connected: boolean
  // What the user pastes into the extension: KOTHAR:<port>:<token>.
  readonly code: string
  // A new token: the paired extension is dropped until it's given the new code.
  repair(): void
  cdpUrl(spaceId: string): string
  // Brings the space's group in front; false when there's no group yet.
  focus(spaceId: string): Promise<boolean>
  tabs(spaceId: string): Promise<RelayTab[]>
  close(): Promise<void>
}

export type RelayOptions = {
  // Where the port and token are kept, so pairing survives restarts.
  stateFile: string
  port?: number
  // The Origin the extension's connection must have; its chrome-extension:// address by default.
  origin?: string
  nameOf?: (spaceId: string) => string | undefined
  onChange?: () => void
  callMs?: number
}

type TabState = { tabId: number; sessionId: string; targetInfo: Record<string, unknown>; children: Set<string> }
type Client = { ws: WebSocket; space: string; autoAttach: boolean }
type SpaceState = { tabs: Map<number, TabState>; attaching: Map<number, Promise<TabState>>; clients: Set<Client> }
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

const readState = (file: string): { port?: number; token?: string } => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export async function startRelay(options: RelayOptions): Promise<Relay> {
  const saved = readState(options.stateFile)
  let token = saved.token ?? randomBytes(24).toString('base64url')
  const origin = options.origin ?? `chrome-extension://${extensionId()}`
  const cdpToken = randomBytes(18).toString('base64url')
  const callMs = options.callMs ?? CALL_MS
  const spaces = new Map<string, SpaceState>()
  let extension: WebSocket | undefined
  let nextId = 0
  const pending = new Map<number, Pending>()

  const spaceOf = (id: string) => {
    let space = spaces.get(id)
    if (!space) spaces.set(id, (space = { tabs: new Map(), attaching: new Map(), clients: new Set() }))
    return space
  }

  const toClient = (client: Client, message: object) => {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(message))
  }
  const toAttached = (space: SpaceState, message: object) => {
    for (const client of space.clients) if (client.autoAttach) toClient(client, message)
  }

  // A call to the extension, answered or timed out.
  const call = <T = any>(method: string, params: Record<string, unknown>): Promise<T> => {
    const ws = extension
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(NOT_CONNECTED))
    const id = ++nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Chrome didn't answer ${method} in time`))
      }, callMs)
      pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  const attachedFor = (tab: TabState) => ({
    method: 'Target.attachedToTarget',
    params: { sessionId: tab.sessionId, targetInfo: { ...tab.targetInfo, attached: true }, waitingForDebugger: false },
  })

  const attach = (spaceId: string, tabId: number): Promise<TabState> => {
    const space = spaceOf(spaceId)
    const known = space.tabs.get(tabId)
    if (known) return Promise.resolve(known)
    let attaching = space.attaching.get(tabId)
    if (attaching) return attaching
    attaching = call<{ targetInfo: Record<string, unknown> }>('attach', { space: spaceId, tabId })
      .then(({ targetInfo }) => {
        const tab: TabState = { tabId, sessionId: `kothar-tab-${tabId}`, targetInfo, children: new Set() }
        space.tabs.set(tabId, tab)
        toAttached(space, attachedFor(tab))
        return tab
      })
      .finally(() => space.attaching.delete(tabId))
    space.attaching.set(tabId, attaching)
    return attaching
  }

  const drop = (spaceId: string, tabId: number) => {
    const space = spaces.get(spaceId)
    const tab = space?.tabs.get(tabId)
    if (!space || !tab) return
    space.tabs.delete(tabId)
    toAttached(space, {
      method: 'Target.detachedFromTarget',
      params: { sessionId: tab.sessionId, targetId: tab.targetInfo.targetId },
    })
  }

  const findTab = (tabId: number): [string, TabState] | undefined => {
    for (const [id, space] of spaces) {
      const tab = space.tabs.get(tabId)
      if (tab) return [id, tab]
    }
    return undefined
  }

  const onExtensionMessage = (data: string) => {
    let message: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: any }
    try {
      message = JSON.parse(data)
    } catch {
      return
    }
    if (message.id !== undefined) {
      const call = pending.get(message.id)
      if (!call) return
      pending.delete(message.id)
      clearTimeout(call.timer)
      if (message.error) call.reject(new Error(message.error.message ?? 'Chrome refused'))
      else call.resolve(message.result ?? {})
      return
    }
    const params = message.params ?? {}
    switch (message.method) {
      case 'event': {
        const found = findTab(params.tabId)
        if (!found) return
        const [spaceId, tab] = found
        const child = params.params?.sessionId
        if (params.method === 'Target.attachedToTarget' && child) tab.children.add(child)
        if (params.method === 'Target.detachedFromTarget' && child) tab.children.delete(child)
        toAttached(spaceOf(spaceId), {
          sessionId: params.sessionId || tab.sessionId,
          method: params.method,
          params: params.params,
        })
        return
      }
      case 'tabAdded': {
        const space = spaces.get(params.space)
        if (space && [...space.clients].some((c) => c.autoAttach)) void attach(params.space, params.tabId).catch(() => {})
        return
      }
      case 'tabRemoved':
        return drop(params.space, params.tabId)
      case 'detached': {
        const found = findTab(params.tabId)
        if (found) drop(found[0], params.tabId)
        return
      }
    }
  }

  // The extension went: every agent's connection closes, and their next browser call hears why.
  const extensionGone = (ws: WebSocket) => {
    if (extension !== ws) return
    extension = undefined
    for (const [id, call] of pending) {
      clearTimeout(call.timer)
      call.reject(new Error(NOT_CONNECTED))
      pending.delete(id)
    }
    for (const space of spaces.values()) {
      space.tabs.clear()
      for (const client of space.clients) client.ws.close(1011, "Kothar's Chrome extension disconnected")
    }
    options.onChange?.()
  }

  // A Playwright call: some answered here, the rest sent to the tab its session is.
  const handle = async (client: Client, method: string, params: any, sessionId?: string): Promise<unknown> => {
    if (REFUSED.has(method)) throw new Error(`${method} isn't allowed in your own Chrome`)
    const spaceId = client.space
    const space = spaceOf(spaceId)
    if (!sessionId) {
      switch (method) {
        case 'Browser.getVersion':
          return { protocolVersion: '1.3', product: 'Chrome/Kothar-Extension', revision: '', userAgent: '', jsVersion: '' }
        case 'Browser.setDownloadBehavior':
        case 'Target.setDiscoverTargets':
          return {}
        case 'Target.getBrowserContexts':
          return { browserContextIds: [] }
        case 'Target.getTargetInfo':
          return { targetInfo: { targetId: 'kothar-browser', type: 'browser', title: '', url: '', attached: true } }
        case 'Target.setAutoAttach': {
          client.autoAttach = true
          const tabs = await call<{ tabId: number }[]>('tabs', { space: spaceId })
          for (const { tabId } of tabs) {
            const known = space.tabs.get(tabId)
            if (known) toClient(client, attachedFor(known))
            else await attach(spaceId, tabId).catch(() => {})
          }
          return {}
        }
        case 'Target.createTarget': {
          const name = options.nameOf?.(spaceId) ?? 'space'
          const { tabId } = await call<{ tabId: number }>('create', { space: spaceId, name, url: params?.url })
          const tab = await attach(spaceId, tabId)
          return { targetId: tab.targetInfo.targetId }
        }
        case 'Target.closeTarget':
        case 'Target.activateTarget': {
          const tab = [...space.tabs.values()].find((t) => t.targetInfo.targetId === params?.targetId)
          if (!tab) throw new Error('No such tab in this space')
          if (method === 'Target.activateTarget') return await call('focus', { space: spaceId, tabId: tab.tabId })
          await call('close', { space: spaceId, tabId: tab.tabId })
          return { success: true }
        }
      }
      // Browser-wide, through any of the space's tabs.
      const any = space.tabs.values().next().value
      if (!any) throw new Error(`${method} needs a tab open in this space`)
      return await call('send', { space: spaceId, tabId: any.tabId, method, params })
    }
    for (const tab of space.tabs.values()) {
      if (tab.sessionId === sessionId) {
        if (method === 'Target.getTargetInfo') return { targetInfo: tab.targetInfo }
        return await call('send', { space: spaceId, tabId: tab.tabId, method, params })
      }
      if (tab.children.has(sessionId)) {
        return await call('send', { space: spaceId, tabId: tab.tabId, sessionId, method, params })
      }
    }
    throw new Error(`No tab in this space for session ${sessionId}`)
  }

  const onClient = (ws: WebSocket, spaceId: string) => {
    const client: Client = { ws, space: spaceId, autoAttach: false }
    const space = spaceOf(spaceId)
    space.clients.add(client)
    ws.on('message', async (data) => {
      let message: { id: number; method: string; params?: unknown; sessionId?: string }
      try {
        message = JSON.parse(String(data))
      } catch {
        return
      }
      try {
        const result = await handle(client, message.method, message.params, message.sessionId)
        toClient(client, { id: message.id, sessionId: message.sessionId, result: result ?? {} })
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        toClient(client, { id: message.id, sessionId: message.sessionId, error: { code: -32000, message: text } })
      }
    })
    ws.on('close', () => space.clients.delete(client))
  }

  // /<cdpToken>/<space>/json/version etc., as a browser's DevTools endpoint answers them.
  const parts = (request: IncomingMessage) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    return { url, segments: url.pathname.split('/').filter(Boolean).map(decodeURIComponent) }
  }

  let port = 0
  const server: Server = createServer((request, response) => {
    const { segments } = parts(request)
    const [given, spaceId, ...rest] = segments
    const path = rest.join('/')
    if (!given || !same(given, cdpToken) || !spaceId || !/^json(\/(version|list))?$/.test(path)) {
      return void response.writeHead(404).end()
    }
    // A web page could make this request; it has no Origin from Playwright.
    if (request.headers.origin) return void response.writeHead(403).end()
    if (!extension) return void response.writeHead(503, { 'content-type': 'text/plain' }).end(NOT_CONNECTED)
    const body =
      path === 'json/version'
        ? {
            Browser: 'Chrome/Kothar-Extension',
            'Protocol-Version': '1.3',
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/${encodeURIComponent(given)}/${encodeURIComponent(spaceId)}/cdp`,
          }
        : []
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    const { url, segments } = parts(request)
    const refuse = (status: number) => {
      socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Not Found'}\r\n\r\n`)
      socket.destroy()
    }
    if (segments.length === 1 && segments[0] === 'extension') {
      if (request.headers.origin !== origin) return refuse(403)
      if (!same(url.searchParams.get('token') ?? '', token)) return refuse(401)
      return wss.handleUpgrade(request, socket, head, (ws) => {
        const old = extension
        if (old) {
          extensionGone(old)
          old.close(1000, 'Replaced by a newer connection')
        }
        extension = ws
        ws.on('message', (data) => onExtensionMessage(String(data)))
        ws.on('close', () => extensionGone(ws))
        ws.on('error', () => {})
        options.onChange?.()
      })
    }
    const [given, spaceId, last] = segments
    if (segments.length !== 3 || last !== 'cdp' || !given || !same(given, cdpToken) || !spaceId) return refuse(404)
    if (request.headers.origin) return refuse(403)
    if (!extension) return refuse(404)
    wss.handleUpgrade(request, socket, head, (ws) => onClient(ws, spaceId))
  })

  const listen = (at: number) =>
    new Promise<number>((resolve, reject) => {
      const failed = (error: Error) => reject(error)
      server.once('error', failed)
      server.listen(at, '127.0.0.1', () => {
        server.off('error', failed)
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : at)
      })
    })
  const wanted = options.port ?? saved.port ?? DEFAULT_PORT
  try {
    port = await listen(wanted)
  } catch {
    port = await listen(0)
  }
  const save = () => {
    mkdirSync(dirname(options.stateFile), { recursive: true })
    writeFileSync(options.stateFile, `${JSON.stringify({ port, token })}\n`, { mode: 0o600 })
  }
  if (saved.port !== port || saved.token !== token) save()

  return {
    get port() {
      return port
    },
    get connected() {
      return !!extension && extension.readyState === WebSocket.OPEN
    },
    get code() {
      return `KOTHAR:${port}:${token}`
    },
    repair() {
      token = randomBytes(24).toString('base64url')
      save()
      const old = extension
      if (old) {
        extensionGone(old)
        old.close(4001, 'Paired again')
      }
      options.onChange?.()
    },
    cdpUrl: (spaceId) => `http://127.0.0.1:${port}/${cdpToken}/${encodeURIComponent(spaceId)}`,
    async focus(spaceId) {
      const { focused } = await call<{ focused: boolean }>('focus', { space: spaceId })
      return focused
    },
    async tabs(spaceId) {
      const tabs = await call<{ url: string; title: string; active: boolean }[]>('tabs', { space: spaceId })
      return tabs.map(({ url, title, active }) => ({ url, title, active }))
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate()
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
