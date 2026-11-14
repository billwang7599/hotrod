import { afterEach, describe, expect, it } from 'vitest'
import type { ExtensionHost, ExtensionPermissionRequest, ExtensionTool } from '@kothar/extension-api'
import { checkCdp } from './safety.ts'
import type { AXNode } from './snapshot.ts'
import { fakeBrowser, type Peer } from './test-cdp.ts'
import { CDP_RESULT_CHARS, createBrowserTools, trimmed } from './tools.ts'

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

// One tab's page, as getFullAXTree gives it: a heading, a link, a field, a checkbox, a button, and n more links.
function pageTree(title: string, extra = 0, checked = false): AXNode[] {
  const specs: [string, string | undefined, string, string, Record<string, unknown>, number][] = [
    ['1', undefined, 'RootWebArea', title, { url: 'https://shop.test/' }, 1],
    ['2', '1', 'heading', title, { level: 1 }, 2],
    ['3', '1', 'link', 'Docs', { focusable: true, url: 'https://shop.test/docs' }, 3],
    ['4', '1', 'textbox', 'Search', { focusable: true }, 4],
    ['5', '1', 'checkbox', 'Remember me', { focusable: true, checked }, 5],
    ['6', '1', 'button', 'Go', { focusable: true }, 6],
    ...Array.from({ length: extra }, (_, i): [string, string, string, string, Record<string, unknown>, number] => [`x${i}`, '1', 'link', `More ${i}`, { focusable: true, url: `https://shop.test/${i}` }, 100 + i]),
  ]
  return specs.map(([nodeId, parentId, role, name, props, backend]) => ({
    nodeId,
    ...(parentId && { parentId }),
    role: { value: role },
    name: { value: name },
    properties: Object.entries(props).map(([n, value]) => ({ name: n, value: { value } })),
    childIds: specs.filter((s) => s[1] === nodeId).map((s) => s[0]),
    backendDOMNodeId: backend,
  }))
}

// A browser with one blank tab; navigating loads a page whose tree the test can change.
async function setup(more: { ask?: (request: ExtensionPermissionRequest) => boolean; values?: Record<string, unknown> } = {}) {
  const state = { tree: pageTree('Blank'), url: 'about:blank', title: '', history: [] as string[], checked: false, callResult: undefined as unknown, tabs: 1 }
  const browser = await fakeBrowser((method, params, sessionId, peer) => {
    switch (method) {
      case 'Target.setAutoAttach':
        if (!sessionId) peer.emit('Target.attachedToTarget', { sessionId: 'S1', targetInfo: { targetId: 'T1', type: 'page', url: 'about:blank', title: '' } })
        return {}
      case 'Target.createTarget': {
        const id = ++state.tabs
        setTimeout(() => peer.emit('Target.attachedToTarget', { sessionId: `S${id}`, targetInfo: { targetId: `T${id}`, type: 'page', url: params.url, title: '' } }), 1)
        return { targetId: `T${id}` }
      }
      case 'Target.closeTarget':
        setTimeout(() => peer.emit('Target.detachedFromTarget', { sessionId: `S${params.targetId.slice(1)}` }), 1)
        return { success: true }
      case 'Page.navigate':
        state.history.push(params.url)
        state.url = params.url
        state.title = 'Shop'
        state.tree = pageTree('Shop')
        setTimeout(() => {
          peer.emit('Page.frameStartedLoading', { frameId: 'T1' }, sessionId)
          peer.emit('Page.frameNavigated', { frame: { id: 'T1', url: params.url } }, sessionId)
          peer.emit('Page.loadEventFired', {}, sessionId)
        }, 5)
        return { frameId: 'T1' }
      case 'Page.getNavigationHistory':
        return { currentIndex: state.history.length - 1, entries: state.history.map((url, id) => ({ id, url })) }
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: 'T1' } } }
      case 'Accessibility.getFullAXTree':
        return { nodes: state.tree }
      case 'Runtime.evaluate':
        return { result: { value: { url: state.url, title: state.title } } }
      case 'DOM.getContentQuads':
        return { quads: [[10, 20, 30, 20, 30, 40, 10, 40]] }
      case 'DOM.resolveNode':
        return { object: { objectId: `obj-${params.backendNodeId}` } }
      case 'Runtime.callFunctionOn':
        if (String(params.functionDeclaration).includes('this.checked')) return { result: { value: state.checked } }
        return { result: { value: state.callResult } }
      case 'Input.dispatchMouseEvent':
        if (params.type === 'mouseReleased' && state.checked === false) state.tree = pageTree('Shop', 0, true)
        return {}
      case 'Page.captureScreenshot':
        return { data: 'aW1hZ2U=' }
      case 'Page.getLayoutMetrics':
        return { cssContentSize: { width: 800, height: 3000 }, cssVisualViewport: { pageX: 0, pageY: 100 } }
      case 'DOM.getBoxModel':
        return { model: { border: [10, 20, 30, 20, 30, 40, 10, 40] } }
      case 'Runtime.getHeapUsage':
        peer.emit('Runtime.consoleAPICalled', { type: 'log' }, sessionId)
        return { usedSize: 'x'.repeat(CDP_RESULT_CHARS + 100) }
      default:
        return {}
    }
  })
  cleanups.push(browser.close)
  const asked: ExtensionPermissionRequest[] = []
  const activity: string[] = []
  const host = {
    requestPermission: async (_chatId: string, request: ExtensionPermissionRequest) => {
      asked.push(request)
      return { allow: more.ask ? more.ask(request) : true, rule: 'You' }
    },
  } as unknown as ExtensionHost
  const made = createBrowserTools({
    host: () => host,
    spaceIdOf: (chatId) => (chatId === 'nowhere' ? undefined : 'space'),
    endpointOf: async () => browser.endpoint,
    activity: (_chatId, title) => void activity.push(title),
    ready: () => true,
    settleMs: 10,
  })
  cleanups.push(made.stop)
  const values = { askEachAction: false, ...more.values }
  const call = async (name: string, input: Record<string, unknown> = {}, chatId = 'space') => {
    const tool = made.tools.find((t) => t.name === name) as ExtensionTool
    return tool.run(input, { caller: { id: chatId } as never, values, host }) as Promise<unknown>
  }
  const sent = (method: string) => browser.peer.calls.filter((c) => c.method === method)
  return { state, peer: browser.peer as Peer, call, sent, asked, activity, tools: made.tools }
}

describe('browser tools', () => {
  it('opens a page in the chat’s blank tab, waits for it to load and returns its snapshot', async () => {
    const t = await setup()
    const text = String(await t.call('browser_open', { url: 'shop.test' }))
    expect(t.sent('Page.navigate')).toEqual([{ method: 'Page.navigate', params: { url: 'https://shop.test' }, sessionId: 'S1' }])
    expect(text).toBe(
      [
        'Tab: Shop — https://shop.test',
        '- heading 1 "Shop"',
        '- link "Docs" [e1] /docs',
        '- textbox "Search" [e2]',
        '- checkbox "Remember me" [e3]',
        '- button "Go" [e4]',
      ].join('\n'),
    )
    expect(t.activity).toEqual(['browser_open: shop.test'])
    await expect(t.call('browser_open', { url: ' ' })).rejects.toThrow('Give a URL')
    await expect(t.call('browser_open', { url: 'forward' })).rejects.toThrow('no page to go forward')
    await expect(t.call('browser_open', { url: 'x' }, 'nowhere')).rejects.toThrow('This chat has no browser')
  })

  it('pages a long snapshot with a cursor, and gives only what changed when asked', async () => {
    const t = await setup()
    await t.call('browser_open', { url: 'https://shop.test/' })
    t.state.tree = pageTree('Shop', 600)
    const first = String(await t.call('browser_snapshot'))
    const cursor = Number(/browser_snapshot with cursor (\d+)\]$/.exec(first)![1])
    expect(first.length).toBeLessThan(12_500)
    const rest = String(await t.call('browser_snapshot', { cursor }))
    expect(rest).toContain('More 599')
    expect(rest).not.toContain('more lines')
    expect(String(await t.call('browser_snapshot', { changes: true }))).toContain('Nothing on the page changed.')
    t.state.tree = pageTree('Shop', 601)
    expect(String(await t.call('browser_snapshot', { changes: true }))).toBe('Tab: Shop — https://shop.test/\nChanged (+ new lines):\n+- link "More 600" [e605] /600')
  })

  it('clicks an element in the middle of it, in its own session, and returns what changed', async () => {
    const t = await setup()
    await t.call('browser_open', { url: 'https://shop.test/' })
    const text = String(await t.call('browser_act', { ref: 'e3', action: 'click' }))
    const mouse = t.sent('Input.dispatchMouseEvent').map((c) => [c.params.type, c.params.x, c.params.y, c.sessionId])
    expect(mouse).toEqual([
      ['mouseMoved', 20, 30, 'S1'],
      ['mousePressed', 20, 30, 'S1'],
      ['mouseReleased', 20, 30, 'S1'],
    ])
    expect(t.sent('DOM.scrollIntoViewIfNeeded')[0]!.params).toEqual({ backendNodeId: 5 })
    expect(text).toContain('Changed (+ new lines, 1 gone):\n+- checkbox "Remember me" [checked] [e3]')
    await expect(t.call('browser_act', { ref: 'e99', action: 'click' })).rejects.toThrow('No element e99')
    await expect(t.call('browser_act', { action: 'click' })).rejects.toThrow('Give the ref')
  })

  it('checks only what is unchecked, selects an option, and presses keys', async () => {
    const t = await setup()
    await t.call('browser_open', { url: 'https://shop.test/' })
    t.state.checked = true
    await t.call('browser_act', { ref: 'e3', action: 'check' })
    expect(t.sent('Input.dispatchMouseEvent')).toEqual([])
    t.state.callResult = 'Canada'
    await t.call('browser_act', { ref: 'e2', action: 'select', value: 'Canada' })
    expect(t.sent('Runtime.callFunctionOn').at(-1)!.params).toMatchObject({ objectId: 'obj-4', arguments: [{ value: 'Canada' }] })
    t.state.callResult = null
    await expect(t.call('browser_act', { ref: 'e2', action: 'select', value: 'Mars' })).rejects.toThrow('No option "Mars"')
    await t.call('browser_act', { action: 'press', value: 'Control+a' })
    await t.call('browser_act', { ref: 'e2', action: 'press', value: 'Enter' })
    const keys = t.sent('Input.dispatchKeyEvent').map((c) => [c.params.type, c.params.key, c.params.modifiers, c.params.text])
    expect(keys).toEqual([
      ['rawKeyDown', 'a', 2, undefined],
      ['keyUp', 'a', 2, undefined],
      ['keyDown', 'Enter', 0, '\r'],
      ['keyUp', 'Enter', 0, undefined],
    ])
    expect(t.sent('DOM.focus')[0]!.params).toEqual({ backendNodeId: 4 })
    await expect(t.call('browser_act', { action: 'press', value: 'Hyper+x' })).rejects.toThrow('Unknown modifier')
  })

  it('asks the user before each upload, and uploads nothing they refuse', async () => {
    const t = await setup({ ask: (r) => !r.summary.includes('secret') })
    await t.call('browser_open', { url: 'https://shop.test/' })
    await t.call('browser_act', { ref: 'e2', action: 'upload', files: ['/work/cv.pdf'] })
    expect(t.asked.at(-1)).toMatchObject({ name: 'browser_upload', summary: 'Browser: upload /work/cv.pdf to https://shop.test/' })
    expect(t.sent('DOM.setFileInputFiles')[0]!.params).toEqual({ files: ['/work/cv.pdf'], backendNodeId: 4 })
    await expect(t.call('browser_act', { ref: 'e2', action: 'upload', files: ['/home/secret'] })).rejects.toThrow('said no')
    await expect(t.call('browser_act', { ref: 'e2', action: 'upload', files: ['relative.txt'] })).rejects.toThrow('absolute paths')
    expect(t.sent('DOM.setFileInputFiles')).toHaveLength(1)
  })

  it('types into a field, replacing what was there, and submits', async () => {
    const t = await setup()
    await t.call('browser_open', { url: 'https://shop.test/' })
    await t.call('browser_type', { ref: 'e2', text: 'shoes', submit: true })
    const order = t.peer.calls.map((c) => c.method).filter((m) => ['DOM.focus', 'Runtime.callFunctionOn', 'Input.insertText', 'Input.dispatchKeyEvent'].includes(m))
    expect(order).toEqual(['DOM.focus', 'Runtime.callFunctionOn', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent'])
    expect(t.sent('Input.insertText')[0]!.params).toEqual({ text: 'shoes' })
    await t.call('browser_type', { ref: 'e2', text: ' more', append: true })
    expect(t.sent('Input.insertText')).toHaveLength(2)
    expect(t.sent('Runtime.callFunctionOn')).toHaveLength(1)
  })

  it('lists, switches and closes tabs, each chat keeping its own', async () => {
    const t = await setup()
    await t.call('browser_open', { url: 'https://shop.test/' })
    // Another chat in the space gets a tab of its own, not this one's.
    await t.call('browser_open', { url: 'https://other.test/' }, 'worker')
    expect(t.sent('Target.createTarget')).toHaveLength(1)
    expect(t.sent('Page.navigate').map((c) => c.sessionId)).toEqual(['S1', 'S2'])
    const list = String(await t.call('browser_tabs', { action: 'list' }))
    expect(list.split('\n')).toHaveLength(2)
    expect(list).toMatch(/^0: \(yours\) /)
    await t.call('browser_tabs', { action: 'switch', tab: 1 })
    expect(t.sent('Target.activateTarget')[0]!.params).toEqual({ targetId: 'T2' })
    await t.call('browser_tabs', { action: 'close', tab: 1 })
    expect(t.sent('Target.closeTarget')[0]!.params).toEqual({ targetId: 'T2' })
    await expect(t.call('browser_tabs', { action: 'switch', tab: 7 })).rejects.toThrow('No tab 7')
  })

  it('takes a screenshot of the view, an element or the whole page, as a picture', async () => {
    const t = await setup()
    await t.call('browser_open', { url: 'https://shop.test/' })
    expect(await t.call('browser_screenshot')).toEqual({ content: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/jpeg' }] })
    await t.call('browser_screenshot', { ref: 'e4' })
    expect(t.sent('Page.captureScreenshot')[1]!.params.clip).toEqual({ x: 10, y: 120, width: 20, height: 20, scale: 1 })
    await t.call('browser_screenshot', { fullPage: true })
    expect(t.sent('Page.captureScreenshot')[2]!.params).toMatchObject({ captureBeyondViewport: true, clip: { width: 800, height: 3000 } })
    const tool = t.tools.find((x) => x.name === 'browser_screenshot')!
    expect(tool.result).toBe('mcp')
  })

  it('asks before every call when the setting says so, as a read for the ones that only read', async () => {
    const t = await setup({ values: { askEachAction: true }, ask: (r) => r.name !== 'browser_act' })
    await t.call('browser_open', { url: 'https://shop.test/' })
    await t.call('browser_snapshot')
    expect(t.asked.map((r) => r.name)).toEqual(['browser_open', 'browser_snapshot'])
    await expect(t.call('browser_act', { ref: 'e3', action: 'click' })).rejects.toThrow('said no')
    expect(t.sent('Input.dispatchMouseEvent')).toEqual([])
  })

  it('keeps the tool list short', () => {
    const { tools } = { tools: createBrowserTools({ host: () => undefined, spaceIdOf: () => 's', endpointOf: async () => '', activity: () => {}, ready: () => true }).tools }
    const listed = JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })))
    // About 1,000 tokens at 3.57 characters a token.
    expect(listed.length).toBeLessThan(4_500)
  })
})

describe('browser_cdp', () => {
  it('sends an allowed command to the chat’s own tab and returns its result, trimmed, with events if asked', async () => {
    const t = await setup()
    await t.call('browser_open', { url: 'https://shop.test/' })
    const text = String(await t.call('browser_cdp', { method: 'Runtime.getHeapUsage', events: true }))
    expect(t.sent('Runtime.getHeapUsage')[0]!.sessionId).toBe('S1')
    expect(text).toContain('more characters cut')
    expect(text).toContain('"method":"Runtime.consoleAPICalled"')
    expect(t.asked).toEqual([])
  })

  it('refuses browser-wide and cookie commands without sending them, and says why', async () => {
    const t = await setup()
    await t.call('browser_open', { url: 'https://shop.test/' })
    for (const method of ['Network.getAllCookies', 'Storage.getCookies', 'Network.setCookie', 'Browser.close', 'Target.attachToTarget', 'Target.createTarget', 'SystemInfo.getInfo', 'not a method']) {
      await expect(t.call('browser_cdp', { method })).rejects.toThrow('is refused')
      expect(t.sent(method)).toEqual([])
    }
    expect(t.activity.filter((a) => a.startsWith('Refused'))).toHaveLength(8)
    expect(t.asked).toEqual([])
  })

  it('keeps to the chat’s own tab and its frames', async () => {
    const t = await setup()
    await t.call('browser_open', { url: 'https://shop.test/' })
    await expect(t.call('browser_cdp', { method: 'DOM.getDocument', sessionId: 'S9' })).rejects.toThrow("isn't your tab's")
    expect(t.sent('DOM.getDocument')).toEqual([])
  })

  it('asks the user, showing the method and params, for what is not a plain read or page interaction', async () => {
    const t = await setup({ ask: (r) => r.input !== undefined && JSON.stringify(r.input).includes('ok') })
    await t.call('browser_open', { url: 'https://shop.test/' })
    await t.call('browser_cdp', { method: 'Fetch.enable', params: { patterns: ['ok'] } })
    expect(t.asked[0]).toMatchObject({ name: 'browser_cdp', summary: 'Browser: DevTools Fetch.enable', input: { method: 'Fetch.enable', params: { patterns: ['ok'] } } })
    await expect(t.call('browser_cdp', { method: 'Security.setIgnoreCertificateErrors', params: { ignore: true } })).rejects.toThrow('said no')
    expect(t.sent('Fetch.enable')).toHaveLength(1)
    expect(t.sent('Security.setIgnoreCertificateErrors')).toEqual([])
  })
})

describe('checkCdp', () => {
  it('refuses the browser-wide, allows the page, and asks about the rest', () => {
    const verdicts = Object.fromEntries(
      [
        'Network.getAllCookies', 'Network.getCookies', 'Network.deleteCookies', 'Network.clearBrowserCookies', 'Storage.setCookies',
        'Storage.clearCookies', 'Storage.clearDataForOrigin', 'Browser.close', 'Browser.crash', 'Browser.grantPermissions',
        'Browser.setDownloadBehavior', 'Page.setDownloadBehavior', 'Target.getTargets', 'Target.closeTarget', 'SystemInfo.getProcessInfo',
        'Browser.getVersion', 'DOM.getDocument', 'Runtime.evaluate', 'Input.dispatchKeyEvent', 'Page.navigate', 'Page.captureScreenshot',
        'Network.getResponseBody', 'DOMStorage.getDOMStorageItems', 'Fetch.enable', 'Security.setIgnoreCertificateErrors',
        'DOMStorage.setDOMStorageItem', 'ServiceWorker.unregister', 'Network.setExtraHTTPHeaders', 'Made.up',
      ].map((m) => [m, checkCdp(m).verdict]),
    )
    expect(verdicts).toEqual({
      'Network.getAllCookies': 'refuse', 'Network.getCookies': 'refuse', 'Network.deleteCookies': 'refuse',
      'Network.clearBrowserCookies': 'refuse', 'Storage.setCookies': 'refuse', 'Storage.clearCookies': 'refuse',
      'Storage.clearDataForOrigin': 'refuse', 'Browser.close': 'refuse', 'Browser.crash': 'refuse', 'Browser.grantPermissions': 'refuse',
      'Browser.setDownloadBehavior': 'refuse', 'Page.setDownloadBehavior': 'refuse', 'Target.getTargets': 'refuse',
      'Target.closeTarget': 'refuse', 'SystemInfo.getProcessInfo': 'refuse',
      'Browser.getVersion': 'allow', 'DOM.getDocument': 'allow', 'Runtime.evaluate': 'allow', 'Input.dispatchKeyEvent': 'allow',
      'Page.navigate': 'allow', 'Page.captureScreenshot': 'allow', 'Network.getResponseBody': 'allow', 'DOMStorage.getDOMStorageItems': 'allow',
      'Fetch.enable': 'ask', 'Security.setIgnoreCertificateErrors': 'ask', 'DOMStorage.setDOMStorageItem': 'ask',
      'ServiceWorker.unregister': 'ask', 'Network.setExtraHTTPHeaders': 'ask', 'Made.up': 'ask',
    })
  })

  it('trims long text and says how much it cut', () => {
    expect(trimmed('abc', 5)).toBe('abc')
    expect(trimmed('abcdefgh', 5)).toBe('abcde… (3 more characters cut)')
  })
})
