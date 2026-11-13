import { afterEach, describe, expect, it } from 'vitest'
import { until as waitUntil } from '@kothar/core/test-wait'
import { CdpClient, CdpError, nextLoad, Pages, settle } from './client.ts'
import { fakeBrowser as fake } from './test-cdp.ts'
import { type AXNode, changes, format, paginate, readFrames, Refs, render } from './snapshot.ts'

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const until = (check: () => boolean) => waitUntil(check, { tries: 300, everyMs: 10 })
const fakeBrowser = async (handler: Parameters<typeof fake>[0]) => {
  const browser = await fake(handler)
  cleanups.push(browser.close)
  return browser
}

const page = (targetId: string, url = 'about:blank', type = 'page') => ({ targetId, type, url, title: '' })

describe('CdpClient', () => {
  it('connects through the endpoint, answers calls, passes errors on and times out', async () => {
    const { endpoint } = await fakeBrowser((method) => {
      if (method === 'Browser.getVersion') return { product: 'Chrome/1' }
      if (method === 'Nope.never') return 'never'
      throw new Error(`'${method}' wasn't found`)
    })
    const client = await CdpClient.connect(endpoint, { callMs: 200 })
    cleanups.push(() => client.close())
    expect(await client.send('Browser.getVersion')).toEqual({ product: 'Chrome/1' })
    const error = await client.send('Bad.method').catch((e) => e)
    expect(error).toBeInstanceOf(CdpError)
    expect(error).toMatchObject({ method: 'Bad.method', message: "'Bad.method' wasn't found", code: -32000 })
    await expect(client.send('Nope.never')).rejects.toThrow('Nope.never timed out')
  })

  it('hands events to listeners, by method and all of them, and waits for one', async () => {
    const { endpoint, peer } = await fakeBrowser(() => ({}))
    const client = await CdpClient.connect(endpoint)
    cleanups.push(() => client.close())
    const seen: unknown[] = []
    const all: unknown[] = []
    const off = client.on('Page.loadEventFired', (params, sessionId) => seen.push([params, sessionId]))
    client.on('*', (event) => all.push(event))
    const waited = client.waitFor('Page.frameNavigated', (p) => p.frame.id === 'B', 2000, 'S1')
    peer.emit('Page.loadEventFired', { timestamp: 1 }, 'S1')
    peer.emit('Page.frameNavigated', { frame: { id: 'A' } }, 'S1')
    peer.emit('Page.frameNavigated', { frame: { id: 'B' } }, 'S2')
    peer.emit('Page.frameNavigated', { frame: { id: 'B' } }, 'S1')
    expect(await waited).toEqual({ frame: { id: 'B' } })
    expect(seen).toEqual([[{ timestamp: 1 }, 'S1']])
    expect(all[0]).toEqual({ method: 'Page.loadEventFired', params: { timestamp: 1 } })
    off()
    peer.emit('Page.loadEventFired', { timestamp: 2 })
    await client.send('Any.call')
    expect(seen).toHaveLength(1)
    expect(await client.waitFor('Never.comes', () => true, 30)).toBeUndefined()
  })

  it('fails the calls in flight when the browser goes, and every call after', async () => {
    const { endpoint, peer } = await fakeBrowser((method) => (method === 'Slow.call' ? 'never' : {}))
    const client = await CdpClient.connect(endpoint)
    const closed: string[] = []
    client.onClose((why) => closed.push(why))
    const pending = client.send('Slow.call')
    peer.drop()
    await expect(pending).rejects.toThrow('closed the DevTools connection')
    await expect(client.send('Any.call')).rejects.toThrow('closed the DevTools connection')
    expect(client.closed).toBe(true)
    expect(closed).toHaveLength(1)
  })
})

describe('Pages', () => {
  // A browser with two tabs and a service worker; new tabs attach as Chrome attaches them.
  async function browser() {
    let next = 3
    const fake = await fakeBrowser((method, params, sessionId, peer) => {
      if (method === 'Target.setAutoAttach' && !sessionId) {
        peer.emit('Target.attachedToTarget', { sessionId: 'S1', targetInfo: page('T1', 'https://a.test/') })
        peer.emit('Target.attachedToTarget', { sessionId: 'S2', targetInfo: page('T2', 'https://b.test/') })
        peer.emit('Target.attachedToTarget', { sessionId: 'SW', targetInfo: page('W1', 'https://a.test/sw.js', 'service_worker') })
      }
      if (method === 'Target.setAutoAttach' && sessionId === 'S1') {
        peer.emit('Target.attachedToTarget', { sessionId: 'F1', targetInfo: page('FRAME1', 'https://pay.test/', 'iframe') }, 'S1')
      }
      if (method === 'Target.createTarget') {
        const id = `T${next++}`
        setTimeout(() => peer.emit('Target.attachedToTarget', { sessionId: `S${id}`, targetInfo: page(id, params.url) }), 5)
        return { targetId: id }
      }
      if (method === 'Target.closeTarget') {
        setTimeout(() => peer.emit('Target.detachedFromTarget', { sessionId: `S${params.targetId.slice(1)}`, targetId: params.targetId }), 5)
        return { success: true }
      }
      if (method === 'Runtime.evaluate') return { result: { value: { url: 'https://a.test/now', title: 'Now' } } }
      return {}
    })
    const client = await CdpClient.connect(fake.endpoint)
    cleanups.push(() => client.close())
    const pages = new Pages(client)
    await pages.start()
    await until(() => pages.list().length === 2)
    return { ...fake, client, pages }
  }

  it('learns the tabs by auto-attaching, leaving out what is not a page', async () => {
    const { pages, peer } = await browser()
    expect(pages.list().map((p) => [p.targetId, p.sessionId, p.url])).toEqual([
      ['T1', 'S1', 'https://a.test/'],
      ['T2', 'S2', 'https://b.test/'],
    ])
    expect(peer.calls.find((c) => c.method === 'Target.setAutoAttach')).toBeDefined()
    peer.emit('Target.targetInfoChanged', { targetInfo: { ...page('T2', 'https://b.test/x'), title: 'X' } })
    await until(() => pages.get('T2')!.title === 'X')
    peer.emit('Target.detachedFromTarget', { sessionId: 'S2', targetId: 'T2' })
    await until(() => pages.list().length === 1)
  })

  it('opens, describes and closes tabs, and prepares one once, with its cross-site frames', async () => {
    const { pages, peer } = await browser()
    const made = await pages.create('https://c.test/')
    expect(made).toMatchObject({ targetId: 'T3', sessionId: 'ST3' })
    const first = pages.get('T1')!
    await Promise.all([pages.prepare(first), pages.prepare(first)])
    expect(peer.calls.filter((c) => c.method === 'Page.enable' && c.sessionId === 'S1')).toHaveLength(1)
    await until(() => first.children.get('FRAME1') === 'F1')
    expect(await pages.describe(first)).toEqual({ url: 'https://a.test/now', title: 'Now' })
    await pages.close('T3')
    expect(pages.get('T3')).toBeUndefined()
  })

  it('waits for the load and a quiet network, and says when it runs out of time', async () => {
    const { client, pages, peer } = await browser()
    const tab = pages.get('T1')!
    peer.emit('Network.requestWillBeSent', { requestId: 'r1' }, 'S1')
    peer.emit('Network.requestWillBeSent', { requestId: 'r2' }, 'S1')
    await until(() => tab.inflight.size === 2)
    const load = nextLoad(client, tab, 2000)
    const settled = settle(client, tab, { load, timeoutMs: 2000, quietMs: 30 })
    peer.emit('Page.loadEventFired', {}, 'S1')
    peer.emit('Network.loadingFinished', { requestId: 'r1' }, 'S1')
    peer.emit('Network.loadingFailed', { requestId: 'r2' }, 'S1')
    expect(await settled).toBe('settled')
    peer.emit('Network.requestWillBeSent', { requestId: 'r3' }, 'S1')
    await until(() => tab.inflight.size === 1)
    expect(await settle(client, tab, { timeoutMs: 80, quietMs: 10 })).toBe('timeout')
    expect(await settle(client, tab, { load: new Promise(() => {}), timeoutMs: 30 })).toBe('timeout')
  })
})

describe('readFrames', () => {
  const node = (nodeId: string, parentId: string | undefined, role: string, name = '', backend?: number, props: Record<string, unknown> = {}): AXNode => ({
    nodeId,
    ...(parentId && { parentId }),
    role: { value: role },
    name: { value: name },
    properties: Object.entries(props).map(([n, value]) => ({ name: n, value: { value } })),
    ...(backend !== undefined && { backendDOMNodeId: backend }),
  })
  const kids = (nodes: AXNode[]) => nodes.map((n) => ({ ...n, childIds: nodes.filter((c) => c.parentId === n.nodeId).map((c) => c.nodeId) }))
  const trees: Record<string, AXNode[]> = {
    main: kids([node('1', undefined, 'RootWebArea', 'Shop', 1), node('2', '1', 'Iframe', 'Ad', 20), node('3', '1', 'Iframe', 'Pay', 30), node('4', '1', 'Iframe', 'Gone', 40)]),
    same: kids([node('1', undefined, 'RootWebArea', 'Ad', 1), node('2', '1', 'link', 'Buy', 5, { focusable: true })]),
    cross: kids([node('1', undefined, 'RootWebArea', 'Pay', 1), node('2', '1', 'button', 'Pay now', 5)]),
  }
  const send = async (method: string, params: any = {}, session?: string) => {
    if (method === 'Page.getFrameTree') {
      if (session === 'F1') return { frameTree: { frame: { id: 'PAY' } } }
      return { frameTree: { frame: { id: 'MAIN' }, childFrames: [{ frame: { id: 'AD' } }, { frame: { id: 'PAY' } }, { frame: { id: 'GONE' } }] } }
    }
    if (method === 'DOM.getFrameOwner') return { backendNodeId: { AD: 20, PAY: 30, GONE: 40 }[params.frameId as string] }
    if (method === 'Accessibility.getFullAXTree') {
      if (session === 'F1') return { nodes: trees.cross }
      if (params.frameId === 'AD') return { nodes: trees.same }
      if (params.frameId === 'GONE') throw new Error('Frame not found')
      return { nodes: trees.main }
    }
    throw new Error(method)
  }

  it("reads every frame's tree, a cross-site one through its own session, and refs reach each frame's elements", async () => {
    const tree = await readFrames(send, 'S1', new Map([['PAY', 'F1']]))
    const refs = new Refs()
    expect(format(render(tree, { refs }))).toEqual([
      '- iframe "Ad"',
      '  - link "Buy" [e1]',
      '- iframe "Pay"',
      '  - button "Pay now" [e2]',
      '- iframe "Gone" (not loaded)',
    ])
    expect(refs.get('e1')).toEqual({ session: 'S1', backendNodeId: 5 })
    expect(refs.get('e2')).toEqual({ session: 'F1', backendNodeId: 5 })
  })
})

describe('paginate and changes', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `- line ${i}`)

  it('gives what fits and a cursor for the rest, always at least one line', () => {
    expect(paginate(lines, { maxChars: 30 })).toEqual({ lines: lines.slice(0, 3), next: 3, total: 10 })
    expect(paginate(lines, { cursor: 9, maxChars: 30 })).toEqual({ lines: [lines[9]], total: 10 })
    expect(paginate(['x'.repeat(100)], { maxChars: 10 }).lines).toHaveLength(1)
    expect(paginate(lines, { cursor: 50 })).toEqual({ lines: [], total: 10 })
  })

  it('marks new lines under the lines they sit in, and counts the ones that went', () => {
    const before = ['- main', '  - list', '    - item "a"', '    - item "b"', '- footer', '  - text "old"']
    const after = ['- main', '  - list', '    - item "a"', '    - item "c"', '    - item "d"', '- footer']
    expect(changes(before, after)).toEqual({
      lines: [' - main', '   - list', '+    - item "c"', '+    - item "d"'],
      added: 2,
      removed: 2,
    })
    expect(changes(after, after)).toEqual({ lines: [], added: 0, removed: 0 })
  })
})
