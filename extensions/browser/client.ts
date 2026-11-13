// Kothar's own connection to a browser over the Chrome DevTools Protocol, for the browser tools (tools.ts): one
// WebSocket to the browser target, calls and events, and the browser's tabs as sessions. The same code drives both
// kinds of browser a space can have: Kothar's own Chrome (its DevTools endpoint, http://127.0.0.1:<port>) and the
// user's Chrome through the Kothar extension (relay.cdpUrl, which answers /json/version the same way and speaks enough
// of the protocol for this). So it only uses what both have: Target.setAutoAttach to learn the tabs (no
// Target.getTargets or attachToTarget), Target.createTarget, closeTarget and activateTarget, and calls on a tab's
// session.

export type TargetInfo = { targetId: string; type: string; url: string; title: string; [key: string]: unknown }
type Listener = (params: any, sessionId: string | undefined) => void

export type ClientOptions = {
  // How long the connection may take, and each call.
  connectMs?: number
  callMs?: number
}

// The browser's WebSocket address, from the DevTools endpoint's /json/version.
export async function socketUrl(endpoint: string, timeoutMs = 5000): Promise<string> {
  const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error((await response.text().catch(() => '')) || `The browser answered ${response.status}`)
  const { webSocketDebuggerUrl } = (await response.json()) as { webSocketDebuggerUrl?: string }
  if (!webSocketDebuggerUrl) throw new Error('The browser gave no DevTools address')
  return webSocketDebuggerUrl
}

// A CDP error the browser answered with, kept apart from transport failures so tools can pass it on as it is.
export class CdpError extends Error {
  readonly method: string
  readonly code?: number
  constructor(method: string, message: string, code?: number) {
    super(message)
    this.method = method
    if (code !== undefined) this.code = code
  }
}

export class CdpClient {
  private next = 0
  private readonly calls = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; method: string }>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly closers = new Set<(why: string) => void>()
  private gone?: string
  private readonly socket: WebSocket
  private readonly callMs: number

  private constructor(socket: WebSocket, callMs: number) {
    this.socket = socket
    this.callMs = callMs
    socket.addEventListener('message', (event) => this.received(String(event.data)))
    socket.addEventListener('close', () => this.ended('The browser closed the DevTools connection'))
    // A WebSocket that fails closes too, and close says it the same way either way.
    socket.addEventListener('error', () => {})
  }

  // Connects to a DevTools endpoint (http://…) or straight to a browser's WebSocket (ws://…).
  static async connect(endpoint: string, options: ClientOptions = {}): Promise<CdpClient> {
    const connectMs = options.connectMs ?? 10_000
    const url = endpoint.startsWith('ws') ? endpoint : await socketUrl(endpoint, connectMs)
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => (socket.close(), reject(new Error('The browser did not accept a DevTools connection'))), connectMs)
      socket.addEventListener('open', () => (clearTimeout(timer), resolve()), { once: true })
      socket.addEventListener('error', () => (clearTimeout(timer), reject(new Error('DevTools connection failed'))), { once: true })
    })
    return new CdpClient(socket, options.callMs ?? 30_000)
  }

  get closed() {
    return this.gone !== undefined
  }

  private received(data: string) {
    let message: { id?: number; result?: unknown; error?: { message?: string; code?: number }; method?: string; params?: unknown; sessionId?: string }
    try {
      message = JSON.parse(data)
    } catch {
      return
    }
    if (message.id !== undefined) {
      const call = this.calls.get(message.id)
      if (!call) return
      this.calls.delete(message.id)
      if (message.error) call.reject(new CdpError(call.method, message.error.message ?? 'DevTools call failed', message.error.code))
      else call.resolve(message.result ?? {})
      return
    }
    if (!message.method) return
    const call = (listeners: Set<Listener> | undefined, params: unknown) => {
      for (const listener of [...(listeners ?? [])]) {
        try {
          listener(params, message.sessionId)
        } catch {
          // A listener's failure is its own.
        }
      }
    }
    call(this.listeners.get(message.method), message.params ?? {})
    call(this.listeners.get('*'), { method: message.method, params: message.params ?? {} })
  }

  private ended(why: string) {
    if (this.gone) return
    this.gone = why
    for (const call of this.calls.values()) call.reject(new Error(why))
    this.calls.clear()
    for (const closer of this.closers) closer(why)
  }

  send<T = Record<string, any>>(method: string, params: object = {}, sessionId?: string, timeoutMs = this.callMs): Promise<T> {
    if (this.gone) return Promise.reject(new Error(this.gone))
    const id = ++this.next
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id)
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.calls.set(id, {
        method,
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }))
    })
  }

  // Calls listener on each event of this method ('*': every event, as { method, params }). Returns how to stop.
  on(method: string, listener: Listener): () => void {
    let set = this.listeners.get(method)
    if (!set) this.listeners.set(method, (set = new Set()))
    set.add(listener)
    return () => void set.delete(listener)
  }

  onClose(listener: (why: string) => void): () => void {
    if (this.gone) listener(this.gone)
    this.closers.add(listener)
    return () => void this.closers.delete(listener)
  }

  // The next event of this method (on this session, if given) that passes the test, or undefined after timeoutMs.
  waitFor<T = any>(method: string, test: (params: T, sessionId?: string) => boolean = () => true, timeoutMs = this.callMs, sessionId?: string): Promise<T | undefined> {
    return new Promise((resolve) => {
      const done = (value: T | undefined) => {
        clearTimeout(timer)
        off()
        offClose()
        resolve(value)
      }
      const timer = setTimeout(() => done(undefined), timeoutMs)
      const off = this.on(method, (params, from) => {
        if (sessionId !== undefined && from !== sessionId) return
        if (test(params, from)) done(params)
      })
      const offClose = this.onClose(() => done(undefined))
    })
  }

  close() {
    this.ended('Closed')
    try {
      this.socket.close()
    } catch {}
  }
}

// A tab and what Kothar knows of it. children: the sessions of its cross-site iframes (each its own target), by the
// frame's id, which is the target's.
export type Page = {
  targetId: string
  sessionId: string
  url: string
  title: string
  children: Map<string, string>
  // Requests the page has going, for waiting until the network is quiet, and when the last one ended.
  inflight: Set<string>
  quietSince: number
  prepared?: Promise<void>
}

// The browser's tabs, as sessions: auto-attached, so Kothar's own Chrome and the relay show them the same way.
export class Pages {
  private readonly pages = new Map<string, Page>()
  private readonly offs: (() => void)[] = []
  private started?: Promise<void>

  readonly client: CdpClient
  constructor(client: CdpClient) {
    this.client = client
  }

  start(): Promise<void> {
    return (this.started ??= this.begin())
  }

  private async begin() {
    const c = this.client
    this.offs.push(
      c.on('Target.attachedToTarget', (params, sessionId) => {
        const info = params.targetInfo as TargetInfo
        if (sessionId === undefined) {
          if (info.type !== 'page') return
          this.pages.set(info.targetId, {
            targetId: info.targetId,
            sessionId: params.sessionId,
            url: info.url ?? '',
            title: info.title ?? '',
            children: new Map(),
            inflight: new Set(),
            quietSince: Date.now(),
          })
          return
        }
        const page = this.bySession(sessionId)
        if (page && info.type === 'iframe') page.children.set(info.targetId, params.sessionId)
      }),
      c.on('Target.detachedFromTarget', (params, sessionId) => {
        if (sessionId === undefined) {
          for (const [id, page] of this.pages) if (page.sessionId === params.sessionId) this.pages.delete(id)
          return
        }
        const page = this.bySession(sessionId)
        if (page) for (const [id, child] of page.children) if (child === params.sessionId) page.children.delete(id)
      }),
      c.on('Target.targetInfoChanged', (params) => {
        const info = params.targetInfo as TargetInfo
        const page = this.pages.get(info.targetId)
        if (page) Object.assign(page, { url: info.url ?? page.url, title: info.title ?? page.title })
      }),
      c.on('Page.frameNavigated', (params, sessionId) => {
        const page = sessionId && this.bySession(sessionId)
        if (page && !params.frame?.parentId) page.url = params.frame?.url ?? page.url
      }),
      c.on('Network.requestWillBeSent', (params, sessionId) => {
        const page = sessionId && this.bySession(sessionId)
        if (page) page.inflight.add(params.requestId)
      }),
      c.on('Network.loadingFinished', (params, sessionId) => this.requestEnded(params.requestId, sessionId)),
      c.on('Network.loadingFailed', (params, sessionId) => this.requestEnded(params.requestId, sessionId)),
    )
    // The browser's own Chrome tells of new tabs with targetInfoChanged only with discovery on; the relay ignores it.
    await c.send('Target.setDiscoverTargets', { discover: true }).catch(() => {})
    await c.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  }

  private requestEnded(requestId: string, sessionId: string | undefined) {
    const page = sessionId && this.bySession(sessionId)
    if (!page || !page.inflight.delete(requestId)) return
    if (!page.inflight.size) page.quietSince = Date.now()
  }

  bySession(sessionId: string): Page | undefined {
    for (const page of this.pages.values()) if (page.sessionId === sessionId) return page
    return undefined
  }

  list(): Page[] {
    return [...this.pages.values()]
  }

  get(targetId: string): Page | undefined {
    return this.pages.get(targetId)
  }

  // Turns on what the tools need on a tab, once: page and network events, and attaching to its cross-site iframes.
  prepare(page: Page): Promise<void> {
    page.prepared ??= (async () => {
      const s = page.sessionId
      await Promise.all([
        this.client.send('Page.enable', {}, s),
        this.client.send('Network.enable', {}, s).catch(() => {}),
        this.client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, s).catch(() => {}),
      ])
    })().catch((error) => {
      page.prepared = undefined
      throw error
    })
    return page.prepared
  }

  // Opens a tab and waits for its session.
  async create(url: string, timeoutMs = 10_000): Promise<Page> {
    await this.start()
    const attached = this.client.waitFor('Target.attachedToTarget', (p) => p.targetInfo?.type === 'page', timeoutMs)
    const { targetId } = await this.client.send<{ targetId: string }>('Target.createTarget', { url })
    const known = this.pages.get(targetId)
    if (known) return known
    for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
      await Promise.race([attached, new Promise((r) => setTimeout(r, 50))])
      const page = this.pages.get(targetId)
      if (page) return page
    }
    throw new Error('The new tab never came up')
  }

  async close(targetId: string) {
    await this.client.send('Target.closeTarget', { targetId })
    this.pages.delete(targetId)
  }

  async activate(targetId: string) {
    await this.client.send('Target.activateTarget', { targetId })
  }

  // The tab's address and title as it says now, read from the page itself (the relay doesn't tell of changes).
  async describe(page: Page): Promise<{ url: string; title: string }> {
    try {
      const { result } = await this.client.send<{ result: { value?: { url: string; title: string } } }>(
        'Runtime.evaluate',
        { expression: '({ url: location.href, title: document.title })', returnByValue: true },
        page.sessionId,
        5000,
      )
      if (result.value) Object.assign(page, result.value)
    } catch {}
    return { url: page.url, title: page.title }
  }

  stop() {
    for (const off of this.offs.splice(0)) off()
  }
}

// Waits for a tab's page to load (its load event, or the main frame to stop loading), then for the network to be
// quiet for quietMs (no request going), all within timeoutMs. Says how it ended rather than throwing: a page that never
// settles is still worth a look.
export async function settle(
  client: CdpClient,
  page: Page,
  { load, timeoutMs = 15_000, quietMs = 500 }: { load?: Promise<unknown>; timeoutMs?: number; quietMs?: number } = {},
): Promise<'settled' | 'timeout'> {
  const end = Date.now() + timeoutMs
  if (load) {
    const loaded = await Promise.race([load.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), timeoutMs))])
    if (!loaded) return 'timeout'
  }
  while (Date.now() < end) {
    if (client.closed) return 'timeout'
    if (!page.inflight.size && Date.now() - page.quietSince >= quietMs) return 'settled'
    await new Promise((r) => setTimeout(r, Math.min(50, quietMs)))
  }
  return 'timeout'
}

// The promise of a tab's next load: its load event, or its main frame stopping loading, whichever comes first.
export function nextLoad(client: CdpClient, page: Page, timeoutMs = 15_000): Promise<unknown> {
  return Promise.race([
    client.waitFor('Page.loadEventFired', () => true, timeoutMs, page.sessionId),
    client.waitFor('Page.frameStoppedLoading', (p) => p.frameId === page.targetId, timeoutMs, page.sessionId),
  ])
}
