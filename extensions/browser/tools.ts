// The browser tools agents call, as Kothar extension tools on the Kothar MCP server: a few small ones for the usual
// jobs (open a page, read it, click, type, tabs, a screenshot) and browser_cdp, the raw DevTools protocol on the chat's
// own tab, for the rest. All of them drive the space's browser over Kothar's own CDP client (client.ts): Kothar's own
// Chrome through the extension's endpoint (which launches it on the first call), or the user's Chrome through the
// Kothar extension's relay.
import type { ExtensionHost, ExtensionTool, ExtensionValues, McpToolResult } from '@kothar/extension-api'
import { CdpClient, CdpError, nextLoad, type Page, Pages, settle } from './client.ts'
import { checkCdp } from './safety.ts'
import { changes, format, paginate, readFrames, Refs, render, SNAPSHOT_CHARS } from './snapshot.ts'

// What the tools need from the extension.
export type ToolsOptions = {
  host: () => ExtensionHost | undefined
  spaceIdOf: (chatId: string) => string | undefined
  // The space's DevTools endpoint: Kothar's own (launching the browser) or the relay's. Throws when there's none.
  endpointOf: (spaceId: string) => Promise<string>
  // Listed in the chat's Activity.
  activity: (chatId: string, title: string, detail?: string) => void
  // Whether the browser can be offered at all now (started, or the extension connected).
  ready: () => boolean
  // Tests: shorter waits.
  settleMs?: number
}

// The longest a browser_cdp answer or its events may be, in characters.
export const CDP_RESULT_CHARS = 8_000
const EVENTS_MAX = 50

type Tab = { refs: Refs; last?: string[] }
type Connection = { endpoint: string; client: CdpClient; pages: Pages; tabs: Map<string, Tab> }

export function trimmed(text: string, max = CDP_RESULT_CHARS) {
  return text.length > max ? `${text.slice(0, max)}… (${(text.length - max).toLocaleString()} more characters cut)` : text
}

// Keys browser_act's press understands besides a single character: [key, code, keyCode].
const KEYS: Record<string, [string, string, number]> = {
  Enter: ['Enter', 'Enter', 13],
  Tab: ['Tab', 'Tab', 9],
  Escape: ['Escape', 'Escape', 27],
  Backspace: ['Backspace', 'Backspace', 8],
  Delete: ['Delete', 'Delete', 46],
  Space: [' ', 'Space', 32],
  ArrowUp: ['ArrowUp', 'ArrowUp', 38],
  ArrowDown: ['ArrowDown', 'ArrowDown', 40],
  ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37],
  ArrowRight: ['ArrowRight', 'ArrowRight', 39],
  Home: ['Home', 'Home', 36],
  End: ['End', 'End', 35],
  PageUp: ['PageUp', 'PageUp', 33],
  PageDown: ['PageDown', 'PageDown', 34],
}
const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

export function createBrowserTools(options: ToolsOptions) {
  const connections = new Map<string, Promise<Connection>>()
  // Each chat's tab (its target id), so chats in one space each keep to their own.
  const current = new Map<string, string>()
  const settleMs = options.settleMs ?? 500

  const connect = async (spaceId: string): Promise<Connection> => {
    const endpoint = await options.endpointOf(spaceId)
    const pending = connections.get(spaceId)
    const known = await pending?.catch(() => undefined)
    if (known && !known.client.closed && known.endpoint === endpoint) return known
    // Another chat started a connection while this one waited: share it, so two chats in a space never connect twice
    // (each with its own tabs and refs).
    if (connections.get(spaceId) !== pending) return connect(spaceId)
    known?.client.close()
    const made = (async () => {
      const client = await CdpClient.connect(endpoint)
      const pages = new Pages(client)
      const tabs = new Map<string, Tab>()
      // A new document in a tab: its elements are all new, so its refs and last snapshot go.
      client.on('Page.frameNavigated', (params, sessionId) => {
        if (params.frame?.parentId || !sessionId) return
        const page = pages.bySession(sessionId)
        const tab = page && tabs.get(page.targetId)
        if (tab) {
          tab.refs.clear()
          tab.last = undefined
        }
      })
      await pages.start()
      return { endpoint, client, pages, tabs }
    })()
    connections.set(spaceId, made)
    made.catch(() => connections.delete(spaceId))
    return made
  }

  const tabOf = (connection: Connection, page: Page) => {
    let tab = connection.tabs.get(page.targetId)
    if (!tab) connection.tabs.set(page.targetId, (tab = { refs: new Refs() }))
    return tab
  }

  // The chat's tab: the one it last used, else a blank or the first one there is; with none, a new one.
  const pageFor = async (chatId: string, connection: Connection, create = true): Promise<Page> => {
    const pages = connection.pages
    let page = pages.get(current.get(chatId) ?? '')
    if (!page) {
      const taken = new Set(current.values())
      const free = pages.list().filter((p) => !taken.has(p.targetId))
      page = free.find((p) => p.url === 'about:blank') ?? free[0]
    }
    if (!page) {
      if (!create) throw new Error('No tab is open: open a page with browser_open first')
      page = await pages.create('about:blank')
    }
    current.set(chatId, page.targetId)
    await pages.prepare(page)
    return page
  }

  // The space's browser and this chat's tab, or why there's none.
  const open = async (chatId: string, create = true) => {
    const spaceId = options.spaceIdOf(chatId)
    if (!spaceId) throw new Error('This chat has no browser')
    const connection = await connect(spaceId)
    return { connection, page: await pageFor(chatId, connection, create) }
  }

  // The tab's snapshot as lines, refs kept from earlier ones.
  const lines = async (connection: Connection, page: Page) => {
    const send = (method: string, params?: object, sessionId?: string) => connection.client.send(method, params, sessionId)
    return format(render(await readFrames(send, page.sessionId, page.children), { refs: tabOf(connection, page).refs }))
  }

  const header = async (connection: Connection, page: Page) => {
    const { url, title } = await connection.pages.describe(page)
    return `Tab: ${title ? `${title} — ` : ''}${url}`
  }

  // A full snapshot, or a page of one, with the cursor for the rest.
  const snapshotText = async (connection: Connection, page: Page, cursor = 0, maxChars = SNAPSHOT_CHARS) => {
    const all = await lines(connection, page)
    tabOf(connection, page).last = all
    const part = paginate(all, { cursor, maxChars })
    const more =
      part.next !== undefined
        ? `\n[${(part.total - part.next).toLocaleString()} more lines: browser_snapshot with cursor ${part.next}]`
        : ''
    return `${await header(connection, page)}\n${part.lines.join('\n') || '(nothing on the page)'}${more}`
  }

  // What changed since the chat's last snapshot of the tab; a whole snapshot if it has none, or the page is new.
  const changesText = async (connection: Connection, page: Page) => {
    const tab = tabOf(connection, page)
    if (!tab.last) return snapshotText(connection, page)
    const before = tab.last
    const after = await lines(connection, page)
    tab.last = after
    const diff = changes(before, after)
    if (!diff.added && !diff.removed) return `${await header(connection, page)}\nNothing on the page changed.`
    const part = paginate(diff.lines)
    const cut = part.next !== undefined ? `\n[more changes: take a browser_snapshot]` : ''
    const gone = diff.removed ? `, ${diff.removed} gone` : ''
    return `${await header(connection, page)}\nChanged (+ new lines${gone}):\n${part.lines.join('\n')}${cut}`
  }

  // Waits for what an action set off: a navigation to load, then a quiet network, briefly.
  // Says whether the tab went to a new page.
  const afterAction = async (connection: Connection, page: Page, run: () => Promise<unknown>) => {
    const client = connection.client
    const url = page.url
    const loaded = nextLoad(client, page, 10_000)
    let started = false
    const off = client.on('Page.frameStartedLoading', (params, sessionId) => {
      if (sessionId === page.sessionId && params.frameId === page.targetId) started = true
    })
    try {
      await run()
      // A click that navigates starts loading at once, or nearly.
      await new Promise((r) => setTimeout(r, Math.min(150, settleMs)))
    } finally {
      off()
    }
    if (started) await settle(client, page, { load: loaded, timeoutMs: 10_000, quietMs: settleMs })
    else await settle(client, page, { timeoutMs: 3000, quietMs: Math.min(settleMs, 300) })
    return started || page.url !== url
  }

  const target = (connection: Connection, page: Page, ref: unknown) => {
    if (typeof ref !== 'string' || !ref.trim()) throw new Error('Give the ref of an element from the snapshot, e.g. e12')
    const found = tabOf(connection, page).refs.get(ref.trim())
    if (!found) throw new Error(`No element ${ref} on this page: take a browser_snapshot for current refs`)
    return found
  }

  // The element's middle on the screen, scrolled into view first.
  const pointOf = async (client: CdpClient, session: string, backendNodeId: number) => {
    await client.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }, session).catch(() => {})
    const { quads } = await client.send<{ quads: number[][] }>('DOM.getContentQuads', { backendNodeId }, session)
    const quad = quads.find((q) => q.length === 8)
    if (!quad) throw new Error('That element is not visible on the page')
    const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4
    const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4
    return { x, y }
  }

  const click = async (client: CdpClient, session: string, backendNodeId: number) => {
    const { x, y } = await pointOf(client, session, backendNodeId)
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, session)
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, session)
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, session)
  }

  // Runs a function on the element in the page, with its result by value.
  const onElement = async <T>(client: CdpClient, session: string, backendNodeId: number, fn: string, args: unknown[] = []) => {
    const { object } = await client.send<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId }, session)
    try {
      const { result, exceptionDetails } = await client.send<{ result: { value?: T }; exceptionDetails?: { exception?: { description?: string } } }>(
        'Runtime.callFunctionOn',
        { objectId: object.objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true },
        session,
      )
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description?.split('\n')[0] ?? 'The page threw')
      return result.value as T
    } finally {
      void client.send('Runtime.releaseObject', { objectId: object.objectId }, session).catch(() => {})
    }
  }

  const press = async (client: CdpClient, session: string, combo: string) => {
    const parts = combo.split('+').filter(Boolean)
    const name = parts.pop() ?? ''
    let modifiers = 0
    for (const part of parts) {
      const bit = MODIFIERS[part]
      if (!bit) throw new Error(`Unknown modifier ${part}: use Alt, Control, Meta or Shift`)
      modifiers |= bit
    }
    const known = KEYS[name]
    if (!known && [...name].length !== 1) throw new Error(`Unknown key ${name}: a single character, or one of ${Object.keys(KEYS).join(', ')}`)
    const [key, code, keyCode] = known ?? [name, name.length === 1 && /[a-z]/i.test(name) ? `Key${name.toUpperCase()}` : '', name.toUpperCase().charCodeAt(0)]
    const text = modifiers & ~MODIFIERS.Shift! ? undefined : key === 'Enter' ? '\r' : key.length === 1 ? key : undefined
    const base = { key, code, windowsVirtualKeyCode: keyCode, modifiers }
    await client.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text && { text }) }, session)
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, session)
  }

  // Asks the user first when the settings say so, as an engine's own tool would.
  const allowed = async (host: ExtensionHost, chatId: string, values: ExtensionValues, name: string, summary: string, input: unknown, changes = true) => {
    if (!values.askEachAction) return
    const answer = await host.requestPermission(chatId, { name, summary, input }, { changes })
    if (!answer.allow) throw new Error(answer.message ?? 'The user said no')
  }

  type Run = (input: Record<string, any>, call: { caller: { id: string }; values: ExtensionValues; host: ExtensionHost }) => Promise<unknown>
  // Every tool: offered in a space while the browser can run; each call listed in the Activity, and asked about first
  // when the setting says so.
  const tool = (
    name: string,
    description: string,
    properties: Record<string, object>,
    required: string[],
    summary: (input: Record<string, any>) => string,
    run: Run,
    reads = false,
  ): ExtensionTool => ({
    name,
    description,
    inputSchema: { type: 'object', properties, ...(required.length && { required }) },
    offered: (caller) => options.ready() && !!options.spaceIdOf(caller.id),
    async run(input, call) {
      const said = summary(input)
      options.activity(call.caller.id, `${name}${said ? `: ${said}` : ''}`)
      await allowed(call.host, call.caller.id, call.values, name, `Browser: ${name}${said ? ` ${said}` : ''}`, input, !reads)
      try {
        return await run(input, call)
      } catch (error) {
        if (error instanceof CdpError) throw new Error(`${error.method}: ${error.message}`)
        throw error
      }
    },
  })

  const REF = { type: 'string', description: 'An element ref from the snapshot, e.g. e12' }

  const tools: ExtensionTool[] = [
    tool(
      'browser_open',
      'Opens a URL in your tab (or a new tab), waits for it to load and returns its snapshot. url may also be back, forward or reload.',
      { url: { type: 'string' }, newTab: { type: 'boolean' } },
      ['url'],
      (input) => String(input.url ?? ''),
      async (input, { caller }) => {
        const url = String(input.url ?? '').trim()
        if (!url) throw new Error('Give a URL')
        const { connection, page: mine } = await open(caller.id)
        let page = mine
        if (input.newTab) {
          page = await connection.pages.create('about:blank')
          current.set(caller.id, page.targetId)
          await connection.pages.prepare(page)
        }
        const client = connection.client
        const load = nextLoad(client, page, 30_000)
        if (url === 'reload') await client.send('Page.reload', {}, page.sessionId)
        else if (url === 'back' || url === 'forward') {
          const { currentIndex, entries } = await client.send<{ currentIndex: number; entries: { id: number }[] }>('Page.getNavigationHistory', {}, page.sessionId)
          const entry = entries[currentIndex + (url === 'back' ? -1 : 1)]
          if (!entry) throw new Error(`There is no page to go ${url} to`)
          await client.send('Page.navigateToHistoryEntry', { entryId: entry.id }, page.sessionId)
        } else {
          const address = /^[a-z][\w+.-]*:/i.test(url) ? url : `https://${url}`
          const { errorText: failed } = await client.send<{ errorText?: string }>('Page.navigate', { url: address }, page.sessionId)
          if (failed) throw new Error(`${address} didn't open: ${failed}`)
        }
        const how = await settle(client, page, { load, timeoutMs: 30_000, quietMs: settleMs })
        const text = await snapshotText(connection, page)
        return how === 'timeout' ? `(The page was still loading after 30s.)\n${text}` : text
      },
    ),
    tool(
      'browser_snapshot',
      "Your tab's page as text: one line per thing, with refs (e12) for the elements to act on. A long page comes in parts: pass the cursor it gives. changes: only what changed since your last snapshot.",
      { cursor: { type: 'integer', minimum: 0 }, changes: { type: 'boolean' } },
      [],
      (input) => (input.changes ? 'changes' : input.cursor ? `from line ${input.cursor}` : ''),
      async (input, { caller }) => {
        const { connection, page } = await open(caller.id, false)
        if (input.changes) return changesText(connection, page)
        return snapshotText(connection, page, Number(input.cursor) || 0)
      },
      true,
    ),
    tool(
      'browser_act',
      'Acts on an element by its ref: click, hover, check, uncheck, select (value: the option), upload (files: absolute paths) or press (value: a key such as Enter or Control+a; ref optional). Returns what changed.',
      {
        ref: REF,
        action: { type: 'string', enum: ['click', 'hover', 'check', 'uncheck', 'select', 'upload', 'press'] },
        value: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
      },
      ['action'],
      (input) => `${input.action}${input.ref ? ` ${input.ref}` : ''}${input.value ? ` ${input.value}` : ''}`,
      async (input, { caller, host }) => {
        const { connection, page } = await open(caller.id, false)
        const client = connection.client
        const action = String(input.action)
        const navigated = await afterAction(connection, page, async () => {
          if (action === 'press') {
            if (input.ref) {
              const at = target(connection, page, input.ref)
              await client.send('DOM.focus', { backendNodeId: at.backendNodeId }, at.session)
            }
            return press(client, page.sessionId, String(input.value ?? ''))
          }
          const at = target(connection, page, input.ref)
          if (action === 'click') return click(client, at.session, at.backendNodeId)
          if (action === 'hover') {
            const { x, y } = await pointOf(client, at.session, at.backendNodeId)
            return client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, at.session)
          }
          if (action === 'check' || action === 'uncheck') {
            const checked = await onElement<boolean>(client, at.session, at.backendNodeId, 'function () { return this.checked ?? this.getAttribute("aria-checked") === "true" }')
            if (checked !== (action === 'check')) await click(client, at.session, at.backendNodeId)
            return
          }
          if (action === 'select') {
            const wanted = String(input.value ?? '')
            const picked = await onElement<string | null>(
              client,
              at.session,
              at.backendNodeId,
              `function (wanted) {
                if (!(this instanceof HTMLSelectElement)) throw new Error('Not a <select>: click it and the option instead')
                const option = [...this.options].find((o) => o.label === wanted || o.value === wanted || o.text.trim() === wanted)
                if (!option) return null
                option.selected = true
                this.dispatchEvent(new Event('input', { bubbles: true }))
                this.dispatchEvent(new Event('change', { bubbles: true }))
                return option.label
              }`,
              [wanted],
            )
            if (picked === null) throw new Error(`No option ${JSON.stringify(wanted)} in that list`)
            return
          }
          if (action === 'upload') {
            const files = Array.isArray(input.files) ? input.files.map(String) : []
            if (!files.length || files.some((f) => !f.startsWith('/'))) throw new Error('Give files as absolute paths')
            // A file leaves the computer for the site: the user says yes to each upload.
            const answer = await host.requestPermission(caller.id, { name: 'browser_upload', summary: `Browser: upload ${files.join(', ')} to ${page.url}`, input: { files, page: page.url } })
            if (!answer.allow) throw new Error(answer.message ?? 'The user said no to the upload')
            return client.send('DOM.setFileInputFiles', { files, backendNodeId: at.backendNodeId }, at.session)
          }
          throw new Error(`Unknown action ${action}`)
        })
        return navigated ? snapshotText(connection, page) : changesText(connection, page)
      },
    ),
    tool(
      'browser_type',
      'Types text into a field by its ref, replacing what is in it unless append is true; submit presses Enter after. Returns what changed.',
      { ref: REF, text: { type: 'string' }, submit: { type: 'boolean' }, append: { type: 'boolean' } },
      ['ref', 'text'],
      (input) => `${input.ref}${input.submit ? ' and submit' : ''}`,
      async (input, { caller }) => {
        const { connection, page } = await open(caller.id, false)
        const client = connection.client
        const at = target(connection, page, input.ref)
        const navigated = await afterAction(connection, page, async () => {
          await client.send('DOM.focus', { backendNodeId: at.backendNodeId }, at.session)
          if (!input.append) {
            await onElement(
              client,
              at.session,
              at.backendNodeId,
              `function () {
                if ('value' in this && typeof this.select === 'function') this.select()
                else if (this.isContentEditable) { const range = document.createRange(); range.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(range) }
              }`,
            )
            await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }, at.session)
            await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }, at.session)
          }
          await client.send('Input.insertText', { text: String(input.text ?? '') }, at.session)
          if (input.submit) await press(client, at.session, 'Enter')
        })
        return navigated ? snapshotText(connection, page) : changesText(connection, page)
      },
    ),
    tool(
      'browser_tabs',
      "The space's tabs: list them, switch yours to one, or close one (by its number in the list). Another chat's tab is refused unless force: true, which takes it from that chat.",
      {
        action: { type: 'string', enum: ['list', 'switch', 'close'] },
        tab: { type: 'integer', minimum: 0 },
        force: { type: 'boolean', description: "Switch to or close a tab another chat is using; that chat gets another tab" },
      },
      ['action'],
      (input) => `${input.action}${input.tab !== undefined ? ` ${input.tab}` : ''}${input.force ? ' (force)' : ''}`,
      async (input, { caller }) => {
        const spaceId = options.spaceIdOf(caller.id)
        if (!spaceId) throw new Error('This chat has no browser')
        const connection = await connect(spaceId)
        const list = connection.pages.list()
        const action = String(input.action ?? 'list')
        if (action !== 'list') {
          const page = list[Number(input.tab)]
          if (!page) throw new Error(`No tab ${input.tab}: list the tabs first`)
          const holders = [...current].filter(([chat, id]) => id === page.targetId && chat !== caller.id).map(([chat]) => chat)
          if (holders.length && input.force !== true) {
            throw new Error(`Tab ${input.tab} is another chat's tab: use your own, open a new one, or pass force: true to take it from that chat`)
          }
          // Taken from the other chat: its next call gets a free tab or a new one, so two chats never drive one tab.
          for (const chat of holders) current.delete(chat)
          if (action === 'switch') {
            current.set(caller.id, page.targetId)
            await connection.pages.prepare(page)
            await connection.pages.activate(page.targetId).catch(() => {})
            return snapshotText(connection, page)
          }
          if (action === 'close') {
            await connection.pages.close(page.targetId)
            connection.tabs.delete(page.targetId)
            for (const [chat, id] of current) if (id === page.targetId) current.delete(chat)
          }
        }
        const mine = current.get(caller.id)
        const taken = new Set(current.values())
        const rows = await Promise.all(
          connection.pages.list().map(async (page, i) => {
            const { url, title } = await connection.pages.describe(page)
            const whose = page.targetId === mine ? '(yours) ' : taken.has(page.targetId) ? "(another chat's) " : ''
            return `${i}: ${whose}${title ? `${title} — ` : ''}${url}`
          }),
        )
        return rows.join('\n') || '(no tabs)'
      },
      true,
    ),
    {
      // A picture, passed to the agent as one.
      result: 'mcp',
      ...tool(
      'browser_screenshot',
      "A picture of your tab's visible page, of one element (ref), or of the whole page (fullPage). Only when how it looks matters: the snapshot is cheaper.",
      { ref: REF, fullPage: { type: 'boolean' } },
      [],
      (input) => (input.ref ? String(input.ref) : input.fullPage ? 'full page' : ''),
      async (input, { caller }) => {
        const { connection, page } = await open(caller.id, false)
        const client = connection.client
        const params: Record<string, unknown> = { format: 'jpeg', quality: 80 }
        if (input.ref) {
          const at = target(connection, page, input.ref)
          if (at.session !== page.sessionId) throw new Error("That element is in a cross-site frame: take a screenshot of the page instead")
          await client.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: at.backendNodeId }, at.session).catch(() => {})
          const { model } = await client.send<{ model: { border: number[] } }>('DOM.getBoxModel', { backendNodeId: at.backendNodeId }, at.session)
          const xs = model.border.filter((_, i) => i % 2 === 0)
          const ys = model.border.filter((_, i) => i % 2 === 1)
          const { cssVisualViewport: v } = await client.send<{ cssVisualViewport: { pageX: number; pageY: number } }>('Page.getLayoutMetrics', {}, page.sessionId)
          params.clip = { x: Math.min(...xs) + v.pageX, y: Math.min(...ys) + v.pageY, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), scale: 1 }
        } else if (input.fullPage) {
          const { cssContentSize: size } = await client.send<{ cssContentSize: { width: number; height: number } }>('Page.getLayoutMetrics', {}, page.sessionId)
          params.captureBeyondViewport = true
          params.clip = { x: 0, y: 0, width: size.width, height: Math.min(size.height, 16_000), scale: 1 }
        }
        const { data } = await client.send<{ data: string }>('Page.captureScreenshot', params, page.sessionId)
        const result: McpToolResult = { content: [{ type: 'image', data, mimeType: 'image/jpeg' }] }
        return result
      },
      true,
      ),
    },
    tool(
      'browser_cdp',
      "Sends a Chrome DevTools Protocol command to your tab (or one of its frames' sessions) when the other browser tools can't do it, e.g. Runtime.evaluate or Network.getResponseBody. Returns its result; events: also the events it set off. Browser-wide commands are refused.",
      {
        method: { type: 'string', description: 'Domain.method, e.g. DOM.getDocument' },
        params: { type: 'object' },
        sessionId: { type: 'string', description: "A frame's session from Target.attachedToTarget; default your tab" },
        events: { type: 'boolean' },
      },
      ['method'],
      (input) => String(input.method ?? ''),
      async (input, { caller, host }) => {
        const method = String(input.method ?? '').trim()
        const verdict = checkCdp(method)
        if (verdict.verdict === 'refuse') {
          options.activity(caller.id, `Refused browser_cdp ${method}`, verdict.why)
          throw new Error(`${method} is refused: ${verdict.why}`)
        }
        const { connection, page } = await open(caller.id, false)
        const session = input.sessionId ? String(input.sessionId) : page.sessionId
        // Only this chat's tab and its own frames.
        if (session !== page.sessionId && ![...page.children.values()].includes(session)) {
          throw new Error("That session isn't your tab's or one of its frames'")
        }
        const params = input.params && typeof input.params === 'object' ? input.params : {}
        if (verdict.verdict === 'ask') {
          const answer = await host.requestPermission(caller.id, { name: 'browser_cdp', summary: `Browser: DevTools ${method}`, input: { method, params } })
          if (!answer.allow) throw new Error(answer.message ?? `The user said no to ${method}`)
        }
        const events: { method: string; params: unknown }[] = []
        const off = input.events
          ? connection.client.on('*', (event, from) => {
              if ((from === session || from === page.sessionId) && events.length < EVENTS_MAX) events.push(event)
            })
          : undefined
        try {
          const result = await connection.client.send(method, params, session)
          if (off) await new Promise((r) => setTimeout(r, Math.min(settleMs, 500)))
          const text = trimmed(JSON.stringify(result))
          return off ? `${text}\nEvents (${events.length}${events.length === EVENTS_MAX ? ', the first' : ''}):\n${trimmed(events.map((e) => JSON.stringify(e)).join('\n'))}` : text
        } finally {
          off?.()
        }
      },
    ),
  ]

  return {
    tools,
    // Forgets a chat's tab (the chat went), or closes every connection (the extension stopped).
    forget: (chatId: string) => void current.delete(chatId),
    async stop() {
      for (const connection of connections.values()) (await connection.catch(() => undefined))?.client.close()
      connections.clear()
      current.clear()
    },
  }
}

export const BROWSER_TOOL_NAMES = ['browser_open', 'browser_snapshot', 'browser_act', 'browser_type', 'browser_tabs', 'browser_screenshot', 'browser_cdp']
