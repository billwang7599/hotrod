// The Kothar Chrome extension's logic, apart from background.js so tests can run it with a fake `chrome`.
//
// Kothar's core (extensions/browser/relay.ts) connects agents to this over one WebSocket on 127.0.0.1, with the token
// the user pasted from Settings → Extensions → Browser. Agents act only in tabs inside their space's tab group (blue,
// "Kothar · <space>"): every command names its space, and a tab is driven only while it's in that space's group. A tab
// the user drags out of the group is detached and the agents lose it. Tabs are driven with chrome.debugger, so Chrome
// shows its "Kothar started debugging this browser" bar while any tab is attached; that bar is Chrome's and stays.

export const PROTOCOL = 1
const KEEPALIVE_MS = 20_000
const GROUP_PREFIX = 'Kothar · '

// "KOTHAR:<port>:<token>", as Settings shows it.
export function parseCode(code) {
  const match = /^KOTHAR:(\d{1,5}):([A-Za-z0-9_-]{16,})$/.exec(String(code ?? '').trim())
  if (!match) return undefined
  const port = Number(match[1])
  return port > 0 && port < 65536 ? { port, token: match[2] } : undefined
}

// chrome.debugger rejects with the DevTools error as JSON text; Kothar's client wants its message.
export function errorText(error) {
  const text = String(error?.message ?? error)
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.message === 'string') return parsed.message
  } catch {}
  return text
}

export function createAgent({ chrome, WebSocket, setTimer = setTimeout }) {
  // Which space each Kothar group is: spaceId → groupId, kept for the browser session (group ids change on restart).
  let groups = {}
  // Tabs in a Kothar group, by the space they belong to, and the ones attached to the debugger.
  const members = new Map()
  const attached = new Set()
  let socket
  let status = 'unpaired'
  let keepalive
  let loaded

  const load = () =>
    (loaded ??= chrome.storage.session.get('groups').then((saved) => {
      groups = saved.groups ?? {}
    }))
  const saveGroups = () => chrome.storage.session.set({ groups })
  const spaceOfGroup = (groupId) => Object.keys(groups).find((space) => groups[space] === groupId)

  const emit = (method, params) => {
    if (socket?.readyState === 1) socket.send(JSON.stringify({ method, params }))
  }

  // The space's group, if it still exists.
  async function groupOf(space) {
    await load()
    const groupId = groups[space]
    if (groupId === undefined) return undefined
    try {
      return await chrome.tabGroups.get(groupId)
    } catch {
      delete groups[space]
      await saveGroups()
      return undefined
    }
  }

  // The tab, if it's in the space's group now; otherwise an error the agent sees.
  async function tabIn(space, tabId) {
    const group = await groupOf(space)
    const tab = group && (await chrome.tabs.get(tabId).catch(() => undefined))
    if (!tab || tab.groupId !== group.id) throw new Error(`Tab ${tabId} isn't in this space's Kothar tab group`)
    members.set(tabId, space)
    return tab
  }

  function leave(tabId) {
    const space = members.get(tabId)
    if (space === undefined) return
    members.delete(tabId)
    if (attached.delete(tabId)) chrome.debugger.detach({ tabId }).catch(() => {})
    emit('tabRemoved', { space, tabId })
  }

  function join(tabId, space) {
    if (members.get(tabId) === space) return
    if (members.has(tabId)) leave(tabId)
    members.set(tabId, space)
    emit('tabAdded', { space, tabId })
  }

  const commands = {
    async tabs({ space }) {
      const group = await groupOf(space)
      if (!group) return []
      const tabs = await chrome.tabs.query({ groupId: group.id })
      for (const tab of tabs) members.set(tab.id, space)
      return tabs.map((t) => ({ tabId: t.id, url: t.url ?? t.pendingUrl ?? '', title: t.title ?? '', active: !!t.active }))
    },

    async attach({ space, tabId }) {
      await tabIn(space, tabId)
      if (!attached.has(tabId)) {
        try {
          await chrome.debugger.attach({ tabId }, '1.3')
        } catch (error) {
          // Left attached by this extension before a restart of its service worker: start over.
          if (!/already attached/i.test(String(error?.message ?? error))) throw error
          await chrome.debugger.detach({ tabId }).catch(() => {})
          await chrome.debugger.attach({ tabId }, '1.3')
        }
        attached.add(tabId)
      }
      const { targetInfo } = await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')
      return { targetInfo }
    },

    async send({ space, tabId, sessionId, method, params }) {
      if (members.get(tabId) !== space || !attached.has(tabId)) await tabIn(space, tabId)
      if (!attached.has(tabId)) throw new Error(`Tab ${tabId} isn't attached`)
      return await chrome.debugger.sendCommand(sessionId ? { tabId, sessionId } : { tabId }, method, params ?? {})
    },

    // A new tab in the space's group. The first one opens in a window of its own, behind the user's, so agents never
    // take over a window the user is in; later ones open wherever the group is now.
    async create({ space, name, url }) {
      const title = `${GROUP_PREFIX}${name || 'space'}`
      const target = url || 'about:blank'
      let group = await groupOf(space)
      let tab
      if (!group) {
        const window = await chrome.windows.create({ url: target, focused: false })
        tab = window.tabs[0]
        const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: window.id } })
        await chrome.tabGroups.update(groupId, { title, color: 'blue' })
        groups[space] = groupId
        await saveGroups()
      } else {
        const inWindow = await chrome.tabs.query({ windowId: group.windowId })
        const onlyOurs = inWindow.every((t) => t.groupId === group.id)
        tab = await chrome.tabs.create({ windowId: group.windowId, url: target, active: onlyOurs })
        await chrome.tabs.group({ groupId: group.id, tabIds: [tab.id] })
      }
      members.set(tab.id, space)
      return { tabId: tab.id }
    },

    async close({ space, tabId }) {
      await tabIn(space, tabId)
      await chrome.tabs.remove(tabId)
      return {}
    },

    // Brings the space's group in front of the user: its window focused, the group open, one of its tabs showing.
    async focus({ space, tabId }) {
      const group = await groupOf(space)
      if (!group) return { focused: false }
      await chrome.tabGroups.update(group.id, { collapsed: false })
      const tabs = await chrome.tabs.query({ groupId: group.id })
      const pick = tabs.find((t) => t.id === tabId) ?? tabs.find((t) => t.active) ?? tabs[0]
      if (pick) await chrome.tabs.update(pick.id, { active: true })
      await chrome.windows.update(group.windowId, { focused: true })
      return { focused: true }
    },

    async rename({ space, name }) {
      const group = await groupOf(space)
      if (group) await chrome.tabGroups.update(group.id, { title: `${GROUP_PREFIX}${name}` })
      return {}
    },
  }

  // One command from Kothar, by name; anything else is refused.
  async function call(method, params) {
    const run = Object.hasOwn(commands, method) ? commands[method] : undefined
    if (!run) throw new Error(`Unknown command ${method}`)
    if (typeof params?.space !== 'string' || !params.space) throw new Error('No space given')
    return await run(params)
  }

  async function onMessage(data) {
    let message
    try {
      message = JSON.parse(String(data))
    } catch {
      return
    }
    if (message.id === undefined) return
    try {
      const result = await call(message.method, message.params)
      socket?.send(JSON.stringify({ id: message.id, result: result ?? {} }))
    } catch (error) {
      socket?.send(JSON.stringify({ id: message.id, error: { message: errorText(error) } }))
    }
  }

  async function connect() {
    if (socket && socket.readyState <= 1) return
    const { pairing } = await chrome.storage.local.get('pairing')
    if (!pairing) return void (status = 'unpaired')
    status = 'connecting'
    const ws = new WebSocket(`ws://127.0.0.1:${pairing.port}/extension?token=${encodeURIComponent(pairing.token)}`)
    socket = ws
    ws.onopen = () => {
      status = 'connected'
      ws.send(JSON.stringify({ method: 'hello', params: { protocol: PROTOCOL } }))
      clearInterval(keepalive)
      // Traffic keeps the service worker alive while Kothar is connected.
      keepalive = setInterval(() => emit('ping', {}), KEEPALIVE_MS)
    }
    ws.onmessage = (event) => void onMessage(event.data)
    ws.onclose = () => {
      if (socket !== ws) return
      socket = undefined
      clearInterval(keepalive)
      // The debugger stays only while Kothar is there to use it.
      for (const tabId of attached) chrome.debugger.detach({ tabId }).catch(() => {})
      attached.clear()
      status = status === 'connected' || status === 'connecting' ? 'offline' : status
      setTimer(() => void connect(), 3000)
    }
  }

  function disconnect() {
    const ws = socket
    socket = undefined
    clearInterval(keepalive)
    for (const tabId of attached) chrome.debugger.detach({ tabId }).catch(() => {})
    attached.clear()
    ws?.close()
  }

  // Chrome's events, wired by background.js.
  const events = {
    onTabCreated(tab) {
      void load().then(async () => {
        const space = spaceOfGroup(tab.groupId)
        if (space !== undefined) return join(tab.id, space)
        // A popup or link opened from an agent's tab joins its group.
        const from = tab.openerTabId === undefined ? undefined : members.get(tab.openerTabId)
        if (from !== undefined && groups[from] !== undefined) {
          await chrome.tabs.group({ groupId: groups[from], tabIds: [tab.id] }).catch(() => {})
        }
      })
    },
    onTabUpdated(tabId, change) {
      if (!('groupId' in change)) return
      void load().then(() => {
        const space = spaceOfGroup(change.groupId)
        if (space === undefined) leave(tabId)
        else join(tabId, space)
      })
    },
    onTabRemoved(tabId) {
      attached.delete(tabId)
      leave(tabId)
    },
    onGroupRemoved(group) {
      void load().then(() => {
        const space = spaceOfGroup(group.id)
        if (space === undefined) return
        delete groups[space]
        void saveGroups()
      })
    },
    onDebuggerEvent(source, method, params) {
      if (source.tabId === undefined || !members.has(source.tabId)) return
      emit('event', { tabId: source.tabId, sessionId: source.sessionId, method, params })
    },
    // The user clicked Cancel on Chrome's debugging bar, or the tab went: agents lose the tab until they attach again.
    onDebuggerDetach(source, reason) {
      if (source.tabId === undefined || !attached.delete(source.tabId)) return
      emit('detached', { tabId: source.tabId, reason })
    },
  }

  // From the popup.
  async function pair(code) {
    const pairing = parseCode(code)
    if (!pairing) throw new Error('That isn’t a Kothar pairing code. Copy it from Settings → Extensions → Browser.')
    await chrome.storage.local.set({ pairing })
    disconnect()
    await connect()
  }
  async function unpair() {
    await chrome.storage.local.remove('pairing')
    disconnect()
    status = 'unpaired'
  }

  return {
    call,
    connect,
    pair,
    unpair,
    events,
    get status() {
      return status
    },
  }
}
