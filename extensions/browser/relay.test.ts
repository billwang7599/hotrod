import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { until as waitUntil } from '@kothar/core/test-wait'
import { createAgent, parseCode } from './chrome-extension/agent.js'
import type { ChatDetail, ExtensionHost, ExtensionTool, ExtensionWait } from '@kothar/extension-api'
import browser, { createBrowserExtension, HAND_OFF_TOOL, SHOW_TOOL, YOUR_CHROME } from './index.ts'
import { CdpClient, Pages } from './client.ts'
import { extensionId, EXTENSION_DIR, NOT_CONNECTED, type Relay, startRelay } from './relay.ts'

const dirs: string[] = []
const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
const until = (check: () => boolean | Promise<boolean>, ms = 3000) => waitUntil(check, { tries: ms / 10, everyMs: 10 })

const ORIGIN = `chrome-extension://${extensionId()}`

// A fake Chrome: windows, tabs and tab groups in memory, and a debugger that answers a few calls and records the rest.
function fakeChrome() {
  type Tab = { id: number; url: string; title: string; groupId: number; windowId: number; active: boolean; openerTabId?: number }
  const tabs = new Map<number, Tab>()
  const groups = new Map<number, { id: number; windowId: number; title?: string; color?: string; collapsed?: boolean }>()
  const attached = new Set<number>()
  const sent: { tabId: number; sessionId?: string; method: string }[] = []
  const focused: number[] = []
  const store: Record<string, Record<string, unknown>> = { session: {}, local: {} }
  let next = 100
  let window = 1
  const area = (name: string) => ({
    get: async (key: string) => (key in store[name]! ? { [key]: store[name]![key] } : {}),
    set: async (values: Record<string, unknown>) => void Object.assign(store[name]!, values),
    remove: async (key: string) => void delete store[name]![key],
  })
  const addTab = (fields: Partial<Tab> = {}) => {
    const tab: Tab = { id: next++, url: 'about:blank', title: '', groupId: -1, windowId: 1, active: false, ...fields }
    tabs.set(tab.id, tab)
    return tab
  }
  const chrome = {
    storage: { session: area('session'), local: area('local') },
    tabs: {
      get: async (id: number) => {
        const tab = tabs.get(id)
        if (!tab) throw new Error('No tab with id')
        return { ...tab }
      },
      query: async (q: { groupId?: number; windowId?: number }) =>
        [...tabs.values()].filter((t) => (q.groupId === undefined || t.groupId === q.groupId) && (q.windowId === undefined || t.windowId === q.windowId)),
      create: async (p: { windowId: number; url: string; active: boolean }) => addTab({ windowId: p.windowId, url: p.url, active: p.active }),
      group: async (p: { groupId?: number; tabIds: number[]; createProperties?: { windowId: number } }) => {
        let id = p.groupId
        if (id === undefined) {
          id = next++
          groups.set(id, { id, windowId: p.createProperties!.windowId })
        }
        for (const tabId of p.tabIds) tabs.get(tabId)!.groupId = id
        return id
      },
      remove: async (id: number) => void tabs.delete(id),
      update: async (id: number, p: { active?: boolean }) => Object.assign(tabs.get(id)!, p),
    },
    tabGroups: {
      get: async (id: number) => {
        const group = groups.get(id)
        if (!group) throw new Error('No group')
        return { ...group }
      },
      update: async (id: number, p: object) => Object.assign(groups.get(id)!, p),
    },
    windows: {
      create: async (p: { url: string }) => {
        const id = ++window
        return { id, tabs: [addTab({ windowId: id, url: p.url, active: true })] }
      },
      update: async (id: number) => void focused.push(id),
    },
    debugger: {
      attach: async ({ tabId }: { tabId: number }) => void attached.add(tabId),
      detach: async ({ tabId }: { tabId: number }) => void attached.delete(tabId),
      sendCommand: async ({ tabId, sessionId }: { tabId: number; sessionId?: string }, method: string) => {
        sent.push({ tabId, ...(sessionId && { sessionId }), method })
        const tab = tabs.get(tabId)!
        if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: `T${tabId}`, type: 'page', url: tab.url, title: tab.title } }
        if (method === 'Runtime.evaluate') return { result: { value: tab.url } }
        return {}
      },
    },
  }
  return { chrome, tabs, groups, attached, sent, focused, addTab }
}

// The extension's own WebSocket, which Chrome opens with the extension's Origin.
const socketWith = (origin: string) =>
  class extends WebSocket {
    constructor(url: string) {
      super(url, { origin })
      // A browser's WebSocket reports a refused connection by closing; ws would also throw it.
      this.on('error', () => {})
    }
  }

async function setup(options: { origin?: string } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-relay-')))
  dirs.push(dir)
  const names: Record<string, string> = { sales: 'Sales', web: 'Website' }
  const relay = await startRelay({ stateFile: join(dir, 'relay.json'), port: 0, nameOf: (id) => names[id] })
  cleanups.push(() => relay.close())
  const fake = fakeChrome()
  const agent = createAgent({ chrome: fake.chrome, WebSocket: socketWith(options.origin ?? ORIGIN), setTimer: () => 0 })
  cleanups.push(() => agent.unpair())
  return { relay, fake, agent, dir }
}

async function paired(options: { origin?: string } = {}) {
  const s = await setup(options)
  await s.agent.pair(s.relay.code)
  await until(() => s.relay.connected)
  return s
}

// A DevTools client on the space's endpoint, as Kothar's browser tools connect.
async function cdpClient(relay: Relay, space: string) {
  const version = await (await fetch(`${relay.cdpUrl(space)}/json/version/`)).json()
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject)))
  const events: { method: string; params: any; sessionId?: string }[] = []
  const answers = new Map<number, (message: any) => void>()
  let next = 0
  let closed = false
  ws.on('message', (data) => {
    const message = JSON.parse(String(data))
    if (message.id !== undefined) answers.get(message.id)?.(message)
    else events.push(message)
  })
  ws.on('close', () => (closed = true))
  cleanups.push(() => ws.close())
  const send = (method: string, params: object = {}, sessionId?: string) =>
    new Promise<any>((resolve, reject) => {
      const id = ++next
      answers.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)))
      ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }))
    })
  return { send, events, closed: () => closed }
}

it('pairing codes carry the port and token, and only well-formed ones are taken', () => {
  expect(parseCode('KOTHAR:41751:abcdefghijklmnopqrstuvwx')).toEqual({ port: 41751, token: 'abcdefghijklmnopqrstuvwx' })
  expect(parseCode(' KOTHAR:41751:abcdefghijklmnopqrstuvwx\n')).toBeDefined()
  expect(parseCode('KOTHAR:99999:abcdefghijklmnopqrstuvwx')).toBeUndefined()
  expect(parseCode('KOTHAR:41751:short')).toBeUndefined()
  expect(parseCode('http://evil')).toBeUndefined()
})

it('the extension id comes from its manifest key, so it is the same wherever it is loaded from', () => {
  const manifest = readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8')
  expect(extensionId(manifest)).toMatch(/^[a-p]{32}$/)
  expect(JSON.parse(manifest).permissions).toEqual(['tabs', 'tabGroups', 'debugger', 'storage', 'alarms'])
})

it('refuses an extension connection without the token, with a wrong one, or from another origin', async () => {
  const { relay } = await setup()
  const status = (url: string, origin?: string) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(url, origin ? { origin } : {})
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      ws.on('open', () => (ws.close(), resolve(101)))
      ws.on('error', () => {})
    })
  const token = relay.code.split(':')[2]!
  const base = `ws://127.0.0.1:${relay.port}/extension`
  expect(await status(base, ORIGIN)).toBe(401)
  expect(await status(`${base}?token=wrong-token-wrong-token`, ORIGIN)).toBe(401)
  expect(await status(`${base}?token=${token}`, 'https://evil.example')).toBe(403)
  expect(await status(`${base}?token=${token}`)).toBe(403)
  expect(await status(`${base}?token=${token}`, 'chrome-extension://abcdefghijklmnopabcdefghijklmnop')).toBe(403)
  expect(await status(`${base}?token=${token}`, ORIGIN)).toBe(101)
})

it('an extension paired with the right code connects; pairing again drops it until it has the new code', async () => {
  const { relay, agent } = await paired()
  expect(agent.status).toBe('connected')
  const old = relay.code
  relay.repair()
  expect(relay.code).not.toBe(old)
  await until(() => !relay.connected)
  await agent.pair(old)
  await new Promise((r) => setTimeout(r, 100))
  expect(relay.connected).toBe(false)
  await agent.pair(relay.code)
  await until(() => relay.connected)
})

it('the pairing token and port are kept for the next start', async () => {
  const { relay, dir } = await setup()
  const saved = JSON.parse(readFileSync(join(dir, 'relay.json'), 'utf8'))
  expect(`KOTHAR:${saved.port}:${saved.token}`).toBe(relay.code)
  await relay.close()
  const again = await startRelay({ stateFile: join(dir, 'relay.json'), port: 0 })
  cleanups.push(() => again.close())
  expect(again.code.split(':')[2]).toBe(saved.token)
})

it("a space's group is made on its first tab: blue, named for the space, in a window of its own", async () => {
  const { relay, fake } = await paired()
  const userTab = fake.addTab({ url: 'https://mail.example', active: true })
  const cdp = await cdpClient(relay, 'sales')
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
  expect(cdp.events).toEqual([])
  const { targetId } = await cdp.send('Target.createTarget', { url: 'https://example.com' })
  const groups = [...fake.groups.values()]
  expect(groups).toHaveLength(1)
  expect(groups[0]).toMatchObject({ title: 'Kothar · Sales', color: 'blue' })
  expect(groups[0]!.windowId).not.toBe(userTab.windowId)
  const attached = cdp.events.find((e) => e.method === 'Target.attachedToTarget')!
  expect(attached.params.targetInfo).toMatchObject({ targetId, type: 'page', attached: true })
  const { result } = await cdp.send('Runtime.evaluate', { expression: 'location.href' }, attached.params.sessionId)
  expect(result.value).toBe('https://example.com')

  // A second tab joins the same group, and the user's own tab was never touched.
  await cdp.send('Target.createTarget', { url: 'https://example.org' })
  expect(fake.groups.size).toBe(1)
  expect([...fake.tabs.values()].filter((t) => t.groupId === groups[0]!.id)).toHaveLength(2)
  expect(fake.attached.has(userTab.id)).toBe(false)
  expect(fake.sent.some((s) => s.tabId === userTab.id)).toBe(false)
})

it("agents can't reach tabs outside their space's group, nor another space's", async () => {
  const { relay, fake, agent } = await paired()
  const userTab = fake.addTab({ url: 'https://bank.example' })
  const sales = await cdpClient(relay, 'sales')
  await sales.send('Target.setAutoAttach', { autoAttach: true, flatten: true })
  await sales.send('Target.createTarget', { url: 'https://example.com' })
  const web = await cdpClient(relay, 'web')
  await web.send('Target.setAutoAttach', { autoAttach: true, flatten: true })
  const salesSession = sales.events.find((e) => e.method === 'Target.attachedToTarget')!.params.sessionId
  const salesTab = Number(salesSession.replace('kothar-tab-', ''))

  // Web's client sees none of Sales' tabs and can't use Sales' session.
  expect(web.events).toEqual([])
  await expect(web.send('Runtime.evaluate', { expression: '1' }, salesSession)).rejects.toThrow(/No tab in this space/)
  await expect(sales.send('Runtime.evaluate', { expression: '1' }, `kothar-tab-${userTab.id}`)).rejects.toThrow(/No tab/)
  // And the extension itself refuses, whatever it's asked.
  await expect(agent.call('attach', { space: 'sales', tabId: userTab.id })).rejects.toThrow(/isn't in this space/)
  await expect(agent.call('send', { space: 'web', tabId: salesTab, method: 'Runtime.evaluate' })).rejects.toThrow(/isn't in this space/)
  await expect(agent.call('close', { space: 'sales', tabId: userTab.id })).rejects.toThrow(/isn't in this space/)
  await expect(agent.call('send', { tabId: salesTab, method: 'Runtime.evaluate' })).rejects.toThrow(/No space/)
  await expect(agent.call('eval', { space: 'sales' })).rejects.toThrow(/Unknown command/)
  expect(fake.attached.has(userTab.id)).toBe(false)
  expect(fake.tabs.has(userTab.id)).toBe(true)
})

it('a tab dragged out of the group is lost to agents and detached', async () => {
  const { relay, fake, agent } = await paired()
  const cdp = await cdpClient(relay, 'sales')
  await cdp.send('Target.setAutoAttach', { autoAttach: true, flatten: true })
  await cdp.send('Target.createTarget', { url: 'https://example.com' })
  const { sessionId } = cdp.events.find((e) => e.method === 'Target.attachedToTarget')!.params
  const tabId = Number(sessionId.replace('kothar-tab-', ''))
  expect(fake.attached.has(tabId)).toBe(true)

  fake.tabs.get(tabId)!.groupId = -1
  agent.events.onTabUpdated(tabId, { groupId: -1 })
  await until(() => cdp.events.some((e) => e.method === 'Target.detachedFromTarget'))
  expect(fake.attached.has(tabId)).toBe(false)
  await expect(cdp.send('Runtime.evaluate', { expression: '1' }, sessionId)).rejects.toThrow(/No tab/)

  // Dragged back in, it's the agents' again.
  const group = [...fake.groups.keys()][0]!
  fake.tabs.get(tabId)!.groupId = group
  agent.events.onTabUpdated(tabId, { groupId: group })
  await until(() => cdp.events.filter((e) => e.method === 'Target.attachedToTarget').length === 2)
})

it("a popup from an agent's tab joins its group, and Chrome's events reach the space's clients only", async () => {
  const { relay, fake, agent } = await paired()
  const sales = await cdpClient(relay, 'sales')
  await sales.send('Target.setAutoAttach', { autoAttach: true, flatten: true })
  await sales.send('Target.createTarget', { url: 'https://example.com' })
  const web = await cdpClient(relay, 'web')
  await web.send('Target.setAutoAttach', { autoAttach: true, flatten: true })
  const opener = Number(sales.events[0]!.params.sessionId.replace('kothar-tab-', ''))

  agent.events.onDebuggerEvent({ tabId: opener }, 'Page.loadEventFired', { timestamp: 1 })
  await until(() => sales.events.some((e) => e.method === 'Page.loadEventFired'))
  expect(sales.events.find((e) => e.method === 'Page.loadEventFired')!.sessionId).toBe(`kothar-tab-${opener}`)

  const popup = fake.addTab({ url: 'https://example.com/popup', openerTabId: opener, windowId: fake.tabs.get(opener)!.windowId })
  agent.events.onTabCreated(popup)
  await until(() => popup.groupId === fake.tabs.get(opener)!.groupId)
  agent.events.onTabUpdated(popup.id, { groupId: popup.groupId })
  await until(() => sales.events.filter((e) => e.method === 'Target.attachedToTarget').length === 2)
  expect(web.events).toEqual([])

  // A user's own tab opening a page is left alone.
  const mine = fake.addTab({ url: 'https://mine.example' })
  const theirs = fake.addTab({ url: 'https://other.example', openerTabId: mine.id })
  agent.events.onTabCreated(theirs)
  await new Promise((r) => setTimeout(r, 30))
  expect(theirs.groupId).toBe(-1)
})

it("Kothar's own CDP client drives a space's tabs through the relay as it does its own Chrome", async () => {
  const { relay, fake } = await paired()
  const client = await CdpClient.connect(relay.cdpUrl('sales'))
  cleanups.push(() => client.close())
  const pages = new Pages(client)
  await pages.start()
  expect(pages.list()).toEqual([])
  const tab = await pages.create('https://example.com/')
  expect(pages.list()).toHaveLength(1)
  const tabId = [...fake.tabs.values()].find((t) => t.url === 'https://example.com/')!.id
  expect(tab.targetId).toBe(`T${tabId}`)
  const { result } = await client.send<{ result: { value: string } }>('Runtime.evaluate', { expression: 'location.href' }, tab.sessionId)
  expect(result.value).toBe('https://example.com/')
  await expect(client.send('Storage.getCookies')).rejects.toThrow("isn't allowed in your own Chrome")
})

it("refuses browser-wide calls that would read or change the user's own browser", async () => {
  const { relay } = await paired()
  const cdp = await cdpClient(relay, 'sales')
  await cdp.send('Target.setAutoAttach', { autoAttach: true, flatten: true })
  await cdp.send('Target.createTarget', { url: 'https://example.com' })
  const { sessionId } = cdp.events[0]!.params
  for (const method of ['Storage.getCookies', 'Browser.close', 'Target.createBrowserContext']) {
    await expect(cdp.send(method)).rejects.toThrow(/isn't allowed/)
  }
  await expect(cdp.send('Network.getAllCookies', {}, sessionId)).rejects.toThrow(/isn't allowed/)
  expect(await cdp.send('Browser.getVersion')).toMatchObject({ product: 'Chrome/Kothar-Extension' })
})

it('focus brings the space’s group to the front, and says so when there is none', async () => {
  const { relay, fake } = await paired()
  expect(await relay.focus('sales')).toBe(false)
  const cdp = await cdpClient(relay, 'sales')
  await cdp.send('Target.setAutoAttach', { autoAttach: true, flatten: true })
  await cdp.send('Target.createTarget', { url: 'https://example.com' })
  expect(await relay.focus('sales')).toBe(true)
  const group = [...fake.groups.values()][0]!
  expect(fake.focused).toEqual([group.windowId])
  expect(group.collapsed).toBe(false)
  expect(await relay.tabs('sales')).toEqual([{ url: 'https://example.com', title: '', active: true }])
})

it('when the extension disconnects, agents’ connections close and their next call says why', async () => {
  const { relay, agent } = await paired()
  const cdp = await cdpClient(relay, 'sales')
  await agent.unpair()
  await until(() => !relay.connected && cdp.closed())
  const answer = await fetch(`${relay.cdpUrl('sales')}/json/version/`)
  expect(answer.status).toBe(503)
  expect(await answer.text()).toBe(NOT_CONNECTED)
  await expect(relay.focus('sales')).rejects.toThrow(NOT_CONNECTED)
})

it("the agents' endpoint refuses a wrong token and requests from web pages", async () => {
  const { relay } = await paired()
  const url = relay.cdpUrl('sales')
  expect((await fetch(url.replace(/\/[^/]+\/sales$/, '/wrong/sales') + '/json/version')).status).toBe(404)
  expect((await fetch(`${url}/json/version`, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
  expect((await fetch(`${url}/json/version`)).status).toBe(200)
})


// The Browser extension with "Your Chrome (Kothar extension)" picked: no browser of its own ever launches.
async function yourChrome() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-your-chrome-')))
  dirs.push(dir)
  const defaults = Object.fromEntries(browser.settings!.map((setting) => [setting.key, setting.default]))
  const values = { ...defaults, profile: YOUR_CHROME }
  const launches: unknown[] = []
  const { extension, cdpUrl } = createBrowserExtension({
    launch: () => async (given) => {
      launches.push(given)
      throw new Error('launched')
    },
    relay: { port: 0, origin: ORIGIN },
  })
  const chats: ChatDetail[] = []
  const waits = new Map<string, ExtensionWait>()
  const host = {
    chats: () => chats,
    space: (chatId: string) => (chats.some((c) => c.id === chatId) ? { id: chatId, name: 'Sales', folders: [], checkouts: [] } : undefined),
    wait: (chatId: string, wait: ExtensionWait) => void waits.set(chatId, wait),
    endWait: (chatId: string) => void waits.delete(chatId),
    processesChanged: () => {},
    storage: { dir },
  } as unknown as ExtensionHost
  const space: ChatDetail = { id: 'sales', name: 'Sales', engine: 'fake', status: 'running', archived: false, keepsContext: true, folders: [], files: [], createdAt: '' } as ChatDetail
  chats.push(space)
  await extension.onStart!({ values, host })
  cleanups.push(() => extension.onStop!({ values, host }))
  const fake = fakeChrome()
  const agent = createAgent({ chrome: fake.chrome, WebSocket: socketWith(ORIGIN), setTimer: () => 0 })
  cleanups.push(() => agent.unpair())
  const view = () => JSON.stringify(extension.settingsView!.render({ values, host }))
  const endpoint = () => cdpUrl('sales')
  const tool = (name: string) => extension.tools!.find((t) => t.name === name) as ExtensionTool
  return { extension, values, host, space, waits, fake, agent, view, endpoint, tool, launches }
}

it('Your Chrome: Settings shows the setup steps and code, and pairing turns it Connected', async () => {
  const { view, agent } = await yourChrome()
  expect(view()).toContain('Not connected')
  expect(view()).toContain('Load unpacked')
  expect(view()).toContain(EXTENSION_DIR.replaceAll('\\', '\\\\'))
  const code = /KOTHAR:\d+:[\w-]+/.exec(view())![0]
  await agent.pair(code)
  await until(() => view().includes('"Connected"'))
  expect(view()).not.toContain('Load unpacked')
})

it("Your Chrome: the browser tools get the space's endpoint on the relay, and no browser is launched", async () => {
  const { endpoint, agent, view, launches, fake, tool, space, values, host } = await yourChrome()
  await agent.pair(/KOTHAR:\d+:[\w-]+/.exec(view())![0])
  await until(() => view().includes('"Connected"'))
  const url = await endpoint()
  const port = /KOTHAR:(\d+):/.exec(view())![1]
  expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/[\\w-]+/sales$`))
  const version = await (await fetch(`${url}/json/version/`)).json()
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolve) => ws.once('open', resolve))
  const answer = new Promise<any>((resolve) => ws.once('message', (d) => resolve(JSON.parse(String(d)))))
  ws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'https://example.com' } }))
  expect((await answer).result.targetId).toMatch(/^T\d+$/)
  ws.close()
  expect([...fake.groups.values()][0]).toMatchObject({ title: 'Kothar · Sales', color: 'blue' })
  // The agent's browser_tabs reaches the same tab through the relay.
  expect(String(await tool('browser_tabs').run({ action: 'list' }, { caller: space, values, host }))).toBe('0: https://example.com')
  expect(launches).toEqual([])
})

it("Your Chrome: show_browser focuses the space's group and waits for Done, which closes the bar at once", async () => {
  const { agent, view, tool, space, host, values, waits, fake, extension, endpoint } = await yourChrome()
  await agent.pair(/KOTHAR:\d+:[\w-]+/.exec(view())![0])
  await until(() => view().includes('"Connected"'))
  // No tabs yet: the agent hears to open the page first.
  await expect(tool(SHOW_TOOL).run({ reason: 'Look' }, { caller: space, values, host })).rejects.toThrow(/no tabs/)
  const version = await (await fetch(`${await endpoint()}/json/version/`)).json()
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolve) => ws.once('open', resolve))
  const made = new Promise((resolve) => ws.once('message', resolve))
  ws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'https://example.com' } }))
  await made
  ws.close()

  let returned: string | undefined
  void Promise.resolve(tool(SHOW_TOOL).run({ reason: 'The chart is empty' }, { caller: space, values, host })).then((t) => (returned = String(t)))
  await until(() => waits.has('sales'))
  const group = [...fake.groups.values()][0]!
  expect(fake.focused).toEqual([group.windowId])
  expect(waits.get('sales')!.buttons.find((b) => b.id === 'done')).toMatchObject({ closes: true })
  await extension.onWaitAction!(space, { button: 'done' }, { values, host })
  await until(() => returned !== undefined)
  expect(returned).toContain('The user is done.')
  expect(returned).toContain("Kothar tab group in the user's Chrome")
  expect(returned).toContain('https://example.com')
  expect(waits.has('sales')).toBe(false)
})

it("Your Chrome: with the extension disconnected, the agent's tools say so and nothing launches", async () => {
  const { tool, space, values, host, launches, agent, view } = await yourChrome()
  await expect(tool(HAND_OFF_TOOL).run({ reason: 'Log in' }, { caller: space, values, host })).rejects.toThrow(NOT_CONNECTED)
  await agent.pair(/KOTHAR:\d+:[\w-]+/.exec(view())![0])
  await until(() => view().includes('"Connected"'))
  await agent.unpair()
  await until(() => view().includes('Not connected'))
  await expect(tool(SHOW_TOOL).run({ reason: 'Look' }, { caller: space, values, host })).rejects.toThrow(NOT_CONNECTED)
  expect(launches).toEqual([])
})

it('Your Chrome: picking another profile closes the relay', async () => {
  const { extension, host, values, view } = await yourChrome()
  const port = Number(/KOTHAR:(\d+):/.exec(view())![1])
  const own = { ...values, profile: 'kothar' }
  await extension.onSettingsChanged!({ key: 'profile', value: 'kothar', previous: YOUR_CHROME }, { values: own, host })
  await until(async () => (await fetch(`http://127.0.0.1:${port}/x`).then(() => false, () => true)))
})
