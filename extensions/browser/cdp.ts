// The few Chrome DevTools Protocol calls the Browser extension makes itself, outside Playwright: which tabs are open,
// moving cookies across a relaunch, bringing a window forward, closing the browser. Over the browser's own HTTP
// endpoint and one WebSocket at a time, with Node's built-in fetch and WebSocket.

export type Tab = { id: string; url: string; title: string }

// The browser's tabs (page targets), as its HTTP endpoint lists them.
export async function listTabs(endpoint: string, timeoutMs = 2000): Promise<Tab[]> {
  const response = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`The browser answered ${response.status}`)
  const targets = (await response.json()) as { id: string; type: string; url: string; title: string }[]
  return targets.filter((t) => t.type === 'page').map(({ id, url, title }) => ({ id, url, title }))
}

export async function version(endpoint: string, timeoutMs = 2000): Promise<Record<string, string>> {
  const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`The browser answered ${response.status}`)
  return (await response.json()) as Record<string, string>
}

export type Cdp = {
  send<T = Record<string, unknown>>(method: string, params?: object, sessionId?: string): Promise<T>
  close(): void
}

// One connection to the browser target. Calls time out rather than hang on a browser that stopped answering.
export async function connect(endpoint: string, timeoutMs = 5000): Promise<Cdp> {
  const url = (await version(endpoint, timeoutMs)).webSocketDebuggerUrl
  if (!url) throw new Error('The browser gave no DevTools address')
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The browser did not accept a DevTools connection')), timeoutMs)
    socket.addEventListener('open', () => (clearTimeout(timer), resolve()), { once: true })
    socket.addEventListener('error', () => (clearTimeout(timer), reject(new Error('DevTools connection failed'))), {
      once: true,
    })
  })
  let next = 0
  const calls = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    const call = message.id === undefined ? undefined : calls.get(message.id)
    if (!call) return
    calls.delete(message.id)
    if (message.error) call.reject(new Error(message.error.message ?? 'DevTools call failed'))
    else call.resolve(message.result ?? {})
  })
  socket.addEventListener('close', () => {
    for (const call of calls.values()) call.reject(new Error('The browser closed the DevTools connection'))
    calls.clear()
  })
  return {
    send(method, params = {}, sessionId) {
      const id = ++next
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          calls.delete(id)
          reject(new Error(`${method} timed out`))
        }, timeoutMs)
        calls.set(id, {
          resolve: (value) => (clearTimeout(timer), resolve(value)),
          reject: (error) => (clearTimeout(timer), reject(error)),
        })
        socket.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }))
      })
    },
    close: () => socket.close(),
  }
}

export type Cookie = Record<string, unknown>

// Every cookie, session cookies too: a relaunch keeps only what the profile saved, and session cookies aren't saved.
export async function getCookies(endpoint: string): Promise<Cookie[]> {
  const cdp = await connect(endpoint)
  try {
    return (await cdp.send<{ cookies: Cookie[] }>('Storage.getCookies')).cookies
  } finally {
    cdp.close()
  }
}

// Sets the cookies the browser doesn't have (by name, domain and path), leaving the ones it has as they are.
export async function addMissingCookies(endpoint: string, cookies: Cookie[]) {
  const cdp = await connect(endpoint)
  try {
    const keyOf = (c: Cookie) => `${c.name}\n${c.domain}\n${c.path}`
    const have = new Set((await cdp.send<{ cookies: Cookie[] }>('Storage.getCookies')).cookies.map(keyOf))
    const missing = cookies.filter((c) => !have.has(keyOf(c)))
    if (missing.length) await cdp.send('Storage.setCookies', { cookies: missing })
    return missing.length
  } finally {
    cdp.close()
  }
}

// Which tab the user (or the agent) looked at last: the one whose page is visible and focused, else visible, else
// the first listed.
export async function activeTab(endpoint: string, tabs: Tab[]): Promise<Tab | undefined> {
  if (tabs.length < 2) return tabs[0]
  const cdp = await connect(endpoint)
  try {
    const states = await Promise.all(
      tabs.map(async (tab) => {
        try {
          const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
            targetId: tab.id,
            flatten: true,
          })
          const { result } = await cdp.send<{ result: { value?: string } }>(
            'Runtime.evaluate',
            { expression: "document.visibilityState + (document.hasFocus() ? ' focus' : '')", returnByValue: true },
            sessionId,
          )
          return result.value ?? ''
        } catch {
          return ''
        }
      }),
    )
    const pick = (want: string) => tabs[states.findIndex((state) => state === want)]
    return pick('visible focus') ?? pick('visible') ?? tabs[0]
  } finally {
    cdp.close()
  }
}

// Into a browser just launched on about:blank: the cookies first, so the pages load logged in, then the tabs, the
// active one last so it's in front, then the blank tab goes.
export async function restore(endpoint: string, cookies: Cookie[], urls: string[], active?: number) {
  const blank = await listTabs(endpoint)
  const cdp = await connect(endpoint)
  try {
    if (cookies.length) await cdp.send('Storage.setCookies', { cookies })
    const order = urls.map((url, index) => ({ url, index }))
    if (active !== undefined && order[active]) order.push(...order.splice(active, 1))
    for (const { url } of order) await cdp.send('Target.createTarget', { url })
    if (urls.length) for (const tab of blank) await cdp.send('Target.closeTarget', { targetId: tab.id }).catch(() => {})
  } finally {
    cdp.close()
  }
}

// Brings the tab, its window and the browser app in front of the user's other windows.
export async function bringToFront(endpoint: string, tabId?: string) {
  const tabs = await listTabs(endpoint)
  const tab = tabs.find((t) => t.id === tabId) ?? tabs[0]
  if (!tab) return
  const cdp = await connect(endpoint)
  try {
    await cdp.send('Target.activateTarget', { targetId: tab.id })
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: tab.id,
      flatten: true,
    })
    await cdp.send('Page.bringToFront', {}, sessionId)
  } finally {
    cdp.close()
  }
}

// Asks the browser to quit, which saves its profile cleanly. Resolves once it has the request.
export async function closeBrowser(endpoint: string) {
  const cdp = await connect(endpoint, 2000)
  try {
    await cdp.send('Browser.close').catch(() => {})
  } finally {
    cdp.close()
  }
}
