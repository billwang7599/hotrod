import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, expect, it } from 'vitest'
import type { ChatDetail, ExtensionHost, ExtensionProcess, ExtensionRun, ExtensionTool, ExtensionWait } from '@kothar/extension-api'
import { sandboxingMachine } from '@kothar/core/test-machine'
import { getCookies, listTabs } from './cdp.ts'
import { chromiumArgs, chromiumLauncher, freeProfile, type Launch, type Launcher } from './chromium.ts'
import { findChrome } from './profiles.ts'
import { serveEndpoints } from './endpoint.ts'
import { FILTER_SCRIPT, HIDDEN_TOOLS } from './mcp-filter.ts'
import browser, { BROWSER_INSTRUCTIONS, createBrowserExtension, HAND_OFF_TOOL, SHOW_TOOL } from './index.ts'
import { type BrowserOps, SpaceBrowser } from './space-browser.ts'
import { until as waitUntil } from '@kothar/core/test-wait'

const dirs: string[] = []
const tempDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}
const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const run: ExtensionRun = (command, args, options = {}) => sandboxingMachine.run(command, args, { cwd: '/', ...options })
const defaults = Object.fromEntries(browser.settings!.map((setting) => [setting.key, setting.default]))
const valueAfter = (args: string[] = [], flag: string) =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined
const until = (check: () => boolean | Promise<boolean>, ms = 4000) => waitUntil(check, { tries: ms / 10, everyMs: 10 })

// A fake browser: each launch is a "browser" with tabs the test can see and change, so the window step runs without
// a window. ops reads and writes the same tabs, as the CDP calls would.
function fakeBrowsers() {
  type Fake = { launch: Launch; endpoint: string; tabs: { id: string; url: string; title: string }[]; cookies: Record<string, unknown>[]; alive: boolean; quit: () => void; fronted: number; activated: number }
  const launched: Fake[] = []
  const byEndpoint = (endpoint: string) => launched.find((b) => b.endpoint === endpoint)!
  let next = 0
  // The tabs the profile's last browser saved as it quit, which a start with restoreSession reopens.
  let session: Fake['tabs'] = []
  const launch: Launcher = async (options) => {
    let quit!: () => void
    const exited = new Promise<void>((resolve) => (quit = resolve))
    // A browser starts on one blank tab, as Chromium does on about:blank; a plain one on the tabs it was given (it has
    // no DevTools, so no endpoint), and one restoring a session on that session's.
    const tabs = options.urls
      ? options.urls.map((url, i) => ({ id: `p${i}`, url, title: `Page ${i}` }))
      : options.restoreSession
        ? session
        : [{ id: 'blank', url: 'about:blank', title: '' }]
    const endpoint = options.plain ? '' : `http://fake:${++next}`
    const fake: Fake = { launch: options, endpoint, tabs, cookies: [], alive: true, quit: () => {}, fronted: 0, activated: 0 }
    fake.quit = () => {
      fake.alive = false
      session = fake.tabs
      quit()
    }
    launched.push(fake)
    return { endpoint: fake.endpoint, exited, stop: async () => fake.quit(), activate: async () => void fake.activated++ }
  }
  const ops: BrowserOps = {
    listTabs: async (endpoint) => {
      const b = byEndpoint(endpoint)
      if (!b.alive) throw new Error('gone')
      return b.tabs
    },
    activeTab: async (_endpoint, tabs) => tabs.at(-1),
    getCookies: async (endpoint) => byEndpoint(endpoint).cookies,
    restore: async (endpoint, cookies, urls) => {
      const b = byEndpoint(endpoint)
      b.cookies = cookies
      b.tabs = urls.map((url, i) => ({ id: `t${i}`, url, title: `Page ${i}` }))
    },
    bringToFront: async (endpoint) => {
      byEndpoint(endpoint).fronted++
    },
    addMissingCookies: async (endpoint, cookies) => {
      const b = byEndpoint(endpoint)
      const keyOf = (c: Record<string, unknown>) => `${c.name}\n${c.domain}\n${c.path}`
      const have = new Set(b.cookies.map(keyOf))
      const missing = cookies.filter((c) => !have.has(keyOf(c)))
      b.cookies = [...b.cookies, ...missing]
      return missing.length
    },
  }
  return { launch, ops, launched }
}

// A host as the core gives one, for the calls the Browser extension makes, with chats the test sets.
function fakeHost(storage: string) {
  const chats: ChatDetail[] = []
  const waits = new Map<string, ExtensionWait>()
  const changed: string[] = []
  const notified: { chatId?: string; title: string; body?: string }[] = []
  const host = {
    notify: (notification: { chatId?: string; title: string; body?: string }) => void notified.push(notification),
    chats: () => chats,
    space: (chatId: string) => {
      const chat = chats.find((c) => c.id === chatId)
      const id = chat?.parentId ?? chat?.id
      return id ? { id, name: id, folders: [], checkouts: [] } : undefined
    },
    wait: (chatId: string, wait: ExtensionWait) => void waits.set(chatId, wait),
    endWait: (chatId: string) => void waits.delete(chatId),
    processesChanged: (spaceId: string) => void changed.push(spaceId),
    storage: { dir: storage },
    run,
  } as unknown as ExtensionHost
  const chat = (id: string, more: Partial<ChatDetail> = {}): ChatDetail => {
    const detail = { id, name: id, engine: 'fake', status: 'running' as const, archived: false, folders: [], files: [], createdAt: '', ...more }
    chats.push(detail)
    return detail
  }
  return { host, chats, waits, changed, chat, notified }
}

// No Chrome installed, so Kothar's own profile runs on the bundled Chromium, whatever this computer has.
const NO_CHROME = { places: { home: '/nonexistent-home', apps: [] }, platform: 'darwin' as const }

async function startedExtension() {
  const fakes = fakeBrowsers()
  const { extension } = createBrowserExtension({ launch: () => fakes.launch, ops: fakes.ops, pollMs: 10, ...NO_CHROME })
  const storage = tempDir('kothar-browser-extension-')
  const fake = fakeHost(storage)
  await extension.onStart!({ values: defaults, host: fake.host })
  cleanups.push(() => extension.onStop!({ values: defaults, host: fake.host }))
  const tool = extension.tools!.find((t) => t.name === HAND_OFF_TOOL) as ExtensionTool
  const show = extension.tools!.find((t) => t.name === SHOW_TOOL) as ExtensionTool
  return { extension, fakes, storage, tool, show, ...fake }
}

it('attaches Playwright MCP to the space’s browser through Kothar’s endpoint, never launching one itself', async () => {
  const { extension, chat } = await startedExtension()
  chat('space')
  chat('worker', { parentId: 'space', worker: true })
  const serverOf = (id: string, values = defaults) =>
    extension.mcpServers!({ chat: { id, name: id, engine: 'fake' }, workDir: '/work/space', sandboxed: true, values })[0]!
  const { name, command, args, env, allowTools } = serverOf('space')
  expect({ name, command, allowTools }).toEqual({ name: 'browser', command: process.execPath, allowTools: true })
  // Playwright MCP runs behind the filter that leaves out tools agents don't need.
  expect(args!.slice(0, 4)).toEqual(['-e', FILTER_SCRIPT, HIDDEN_TOOLS.join(','), process.execPath])
  expect(args![4]).toMatch(/@playwright[/\\]mcp[/\\]cli\.js$/)
  expect(valueAfter(args, '--cdp-endpoint')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[\w-]+\/space$/)
  expect(valueAfter(args, '--output-dir')).toBe('/work/space/.browser/output')
  for (const flag of ['--headless', '--browser', '--user-data-dir', '--isolated', '--extension', '--no-sandbox']) {
    expect(args).not.toContain(flag)
  }
  expect(env).toEqual({
    ELECTRON_RUN_AS_NODE: '1',
    TMPDIR: tmpdir(),
    PWTEST_SERVER_REGISTRY: join(tmpdir(), 'kothar-browser-registry'),
  })
  // A worker shares its space's browser.
  expect(valueAfter(serverOf('worker').args, '--cdp-endpoint')).toBe(valueAfter(args, '--cdp-endpoint'))
  expect(serverOf('space', { ...defaults, askEachAction: true }).allowTools).toBe(false)
})

it('has no browser before it starts, and drops the old picker settings when it migrates', () => {
  const { extension } = createBrowserExtension()
  expect(extension.mcpServers!({ chat: { id: 'a', name: 'a', engine: 'fake' }, workDir: '/w', sandboxed: true, values: defaults })).toEqual([])
  expect(extension.settings!.map((s) => s.key)).toEqual(['engine', 'profile', 'profileFolder', 'askEachAction', 'idleMinutes'])
  expect(extension.settingsVersion).toBe(1)
  const old = { browser: 'chrome', port: 9333, extensionToken: 'x', background: true, askEachAction: true }
  expect(extension.migrateSettings!(old, 0, {})).toEqual({ askEachAction: true })
})

it('tells agents about snapshots, batching, closing tabs and handing the browser to the user', () => {
  const chat = { id: 'a', name: 'a', engine: 'fake', status: 'idle' as const, archived: false, folders: [], files: [], createdAt: '' }
  const text = browser.instructions!({ chat, tools: true }, { values: defaults, host: {} as never })
  expect(text).toBe(BROWSER_INSTRUCTIONS)
  for (const word of ['snapshot', 'screenshot', 'browser_fill_form', 'Close', HAND_OFF_TOOL]) expect(text).toContain(word)
  expect(browser.instructions!({ chat, tools: false }, { values: defaults, host: {} as never })).toBeUndefined()
  const tool = browser.tools!.find((t) => t.name === HAND_OFF_TOOL)!
  expect(tool.description).toContain('not submitted is lost')
})

it('launches the space’s browser headless on the first browse, and keeps it for the next', async () => {
  const { extension, fakes, storage, chat } = await startedExtension()
  chat('space')
  const endpoint = valueAfter(
    extension.mcpServers!({ chat: { id: 'space', name: 's', engine: 'fake' }, workDir: '/w', sandboxed: true, values: defaults })[0]!.args,
    '--cdp-endpoint',
  )!
  expect(fakes.launched).toHaveLength(0)
  // Playwright's first call: the fake has no real /json/version, so the endpoint answers 503, but it launched.
  await fetch(`${endpoint}/json/version/`)
  await fetch(`${endpoint}/json/version/`)
  expect(fakes.launched).toHaveLength(1)
  expect(fakes.launched[0]!.launch).toEqual({ profile: join(storage, 'profiles', 'space'), headless: true, cold: true })
  // Only Kothar's endpoint, with its token, answers.
  expect((await fetch(endpoint.replace(/\/[\w-]+\/space$/, '/wrong/space/json/version'))).status).toBe(404)
})

it('shows the browser to the user in a window with the same tabs and logins, and goes back headless on Done', async () => {
  const { extension, fakes, show: tool, waits, changed, chat, host, notified } = await startedExtension()
  const space = chat('space')
  // The agent browsed: a headless browser with two tabs and a cookie.
  const servers = extension.mcpServers!({ chat: space, workDir: '/w', sandboxed: true, values: defaults })
  await fetch(`${valueAfter(servers[0]!.args, '--cdp-endpoint')}/json/version/`)
  const headless = fakes.launched[0]!
  headless.tabs = [
    { id: 'a', url: 'https://example.com/', title: 'Example' },
    { id: 'b', url: 'https://example.com/login', title: 'Login' },
    { id: 'c', url: 'about:blank', title: '' },
  ]
  headless.cookies = [{ name: 'session', value: '1', domain: 'example.com' }]

  const call = tool.run({ reason: 'Log in to Example' }, { caller: space, values: defaults, host })
  await until(() => waits.has('space'))
  expect(headless.alive).toBe(false)
  const window = fakes.launched[1]!
  expect(window.launch.headless).toBe(false)
  expect(window.launch.profile).toBe(headless.launch.profile)
  expect(window.tabs.map((t) => t.url)).toEqual(['https://example.com/', 'https://example.com/login'])
  expect(window.cookies).toEqual(headless.cookies)
  expect(window.fronted).toBe(1)
  expect(waits.get('space')).toEqual({
    text: 'Browser: Log in to Example',
    buttons: [
      expect.objectContaining({ id: 'open', label: 'Open browser' }),
      expect.objectContaining({ id: 'done', label: 'Done', primary: true }),
    ],
  })
  expect(extension.processes!('space', { values: defaults, host })).toEqual([
    expect.objectContaining({ label: 'Browser', dot: 'warning', detail: 'Open for you: Log in to Example' }),
  ])
  expect(changed).toContain('space')
  // A notification, once, for when the user is away.
  expect(notified).toEqual([{ chatId: 'space', title: 'An agent wants to show you something', body: 'Log in to Example' }])

  // Open brings it forward again; the user logs in and lands somewhere new.
  await extension.onWaitAction!(space, { button: 'open' }, { values: defaults, host })
  expect(window.fronted).toBe(2)
  window.tabs = [{ id: 'x', url: 'https://example.com/home', title: 'Home' }]
  window.cookies = [{ name: 'session', value: 'logged-in', domain: 'example.com' }]
  await extension.onWaitAction!(space, { button: 'done' }, { values: defaults, host })

  const text = String(await call)
  expect(text).toContain('The user is done.')
  expect(text).toContain('* Home — https://example.com/home')
  expect(window.alive).toBe(false)
  const back = fakes.launched[2]!
  expect(back.launch.headless).toBe(true)
  expect(back.tabs.map((t) => t.url)).toEqual(['https://example.com/home'])
  expect(back.cookies).toEqual(window.cookies)
  expect(waits.has('space')).toBe(false)
  expect(extension.processes!('space', { values: defaults, host })).toEqual([
    expect.objectContaining({ dot: 'success', detail: 'In the background' }),
  ])
})

it('ends a hand-off when the user closes the window, sends a message, or the chat is stopped', async () => {
  const { extension, fakes, show: tool, waits, chat, host } = await startedExtension()
  const space = chat('space')
  const context = { values: defaults, host }
  const handOff = async () => {
    const call = tool.run({ reason: 'Solve the CAPTCHA' }, { caller: space, values: defaults, host })
    await until(() => waits.has('space'))
    return { call, window: fakes.launched.at(-1)! }
  }
  // Closing every tab, as closing the window does on macOS.
  let { call, window } = await handOff()
  window.tabs = []
  expect(String(await call)).toContain('The user closed the browser window.')
  expect(fakes.launched.at(-1)!.launch.headless).toBe(true)

  // A message instead of Done.
  ;({ call, window } = await handOff())
  window.tabs = [{ id: 'y', url: 'https://example.com/next', title: 'Next' }]
  await extension.onWaitAction!(space, { message: 'done, carry on' }, context)
  expect(String(await call)).toContain('The user sent you a message')

  // Quitting the browser.
  ;({ call, window } = await handOff())
  window.quit()
  expect(String(await call)).toContain('The user closed the browser window.')

  // Stop on the chat: the window closes and the browser stays off.
  ;({ call, window } = await handOff())
  const launches = fakes.launched.length
  extension.onStatusChanged!({ ...space, status: 'stopping' }, 'stopping', context)
  expect(String(await call)).toContain('The hand-off was stopped.')
  expect(window.alive).toBe(false)
  expect(fakes.launched).toHaveLength(launches)
  expect(extension.processes!('space', context)).toEqual([])
})

// The Browser extension on fake browsers whose windows take as long to quit as the test says: each window's stop waits
// for slow.release(), or forever if the test never calls it.
async function slowToQuit(finishMs?: number) {
  const fakes = fakeBrowsers()
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const launch: Launcher = async (options) => {
    const running = await fakes.launch(options)
    if (options.headless) return running
    return { ...running, stop: async () => (await gate, running.stop()) }
  }
  const { extension } = createBrowserExtension({
    launch: () => launch,
    ops: fakes.ops,
    pollMs: 10,
    ...(finishMs !== undefined && { finishMs }),
    ...NO_CHROME,
  })
  const h = fakeHost(tempDir('kothar-browser-extension-'))
  await extension.onStart!({ values: defaults, host: h.host })
  cleanups.push(async () => {
    release()
    await extension.onStop!({ values: defaults, host: h.host })
  })
  const space = h.chat('space')
  const context = { values: defaults, host: h.host }
  let returned: string | undefined
  // tool: show_browser, a window Kothar reads, or ask_user_in_browser, a plain one.
  const handOff = async (name = SHOW_TOOL) => {
    const show = extension.tools!.find((t) => t.name === name)!
    returned = undefined
    const call = Promise.resolve(show.run({ reason: 'Look' }, { caller: space, values: defaults, host: h.host })).then(
      (text) => (returned = String(text)),
    )
    await until(() => h.waits.has('space'))
    return { call, window: fakes.launched.at(-1)! }
  }
  return { extension, fakes, space, context, handOff, release, returned: () => returned, ...h }
}

it('ends the wait the moment Done is clicked, while the window is still closing, and the agent hears once it is back', async () => {
  const t = await slowToQuit()
  const { call, window } = await t.handOff()
  // Done marks itself as closing, so the bar goes on the click in the UI and core too.
  expect(t.waits.get('space')!.buttons.find((b) => b.id === 'done')).toMatchObject({ closes: true })
  const finished = t.extension.onWaitAction!(t.space, { button: 'done' }, t.context)
  // Synchronously, before Chrome has quit.
  expect(t.waits.has('space')).toBe(false)
  expect(t.extension.processes!('space', t.context)).toEqual([
    expect.objectContaining({ detail: 'Going back to the background', actions: [expect.objectContaining({ name: 'stop' })] }),
  ])
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(window.alive).toBe(true)
  expect(t.waits.has('space')).toBe(false)
  expect(t.returned()).toBeUndefined()
  // A second click, from the row or a bar that hadn't gone yet, is the same finish: one relaunch, one result.
  const again = t.extension.onWaitAction!(t.space, { button: 'done' }, t.context)
  const fromRow = t.extension.onProcessAction!('space', 'browser', 'done', t.context)
  t.release()
  await Promise.all([finished, again, fromRow])
  const text = await call
  expect(text).toContain('The user is done.')
  expect(text).toContain('The browser is back in the background.')
  expect(t.fakes.launched.filter((b) => b.launch.headless)).toHaveLength(1)
  expect(t.fakes.launched.at(-1)!.launch.headless).toBe(true)
  expect(t.waits.has('space')).toBe(false)
})

it('waits for a plain sign-in window to quit by itself before the browser goes back to the background with DevTools', async () => {
  const t = await slowToQuit()
  const { call, window } = await t.handOff(HAND_OFF_TOOL)
  // Signing in: a plain window, with nothing attached to it.
  expect(window.launch.plain).toBe(true)
  expect(window.endpoint).toBe('')
  const finished = t.extension.onWaitAction!(t.space, { button: 'done' }, t.context)
  // The popup goes on the click, as for any window.
  expect(t.waits.has('space')).toBe(false)
  await new Promise((resolve) => setTimeout(resolve, 30))
  // Nothing starts on the profile while the window is still saving it.
  expect(window.alive).toBe(true)
  expect(t.fakes.launched).toHaveLength(1)
  t.release()
  await finished
  expect(String(await call)).toContain('The user is done.')
  const back = t.fakes.launched[1]!
  expect(back.launch).toMatchObject({ headless: true, restoreSession: true })
  expect(back.launch.plain).toBeUndefined()
  expect(back.endpoint).toMatch(/^http:\/\/fake:/)
  expect(t.fakes.launched).toHaveLength(2)
})

it('lets the agent go on when the window never finishes closing, and says the browser is still on its way back', async () => {
  const t = await slowToQuit(50)
  const { call, window } = await t.handOff()
  void t.extension.onWaitAction!(t.space, { button: 'done' }, t.context)
  expect(t.waits.has('space')).toBe(false)
  const text = await call
  expect(text).toContain('The user is done.')
  expect(text).toContain('still going back to the background; your next browser call waits for it')
  expect(window.alive).toBe(true)
  expect(t.waits.has('space')).toBe(false)
})

it('ends the wait at once when the user closes the window or messages, though the window is slow to close', async () => {
  const t = await slowToQuit()
  // Every tab closed, as closing the window on macOS: noticed by the next read, and the bar goes then, not after.
  let { call, window } = await t.handOff()
  window.tabs = []
  await until(() => !t.waits.has('space'))
  expect(window.alive).toBe(true)
  expect(t.returned()).toBeUndefined()
  t.release()
  expect(await call).toContain('The user closed the browser window.')

  // A message instead of Done.
  ;({ call, window } = await t.handOff())
  void t.extension.onWaitAction!(t.space, { message: 'seen it' }, t.context)
  expect(t.waits.has('space')).toBe(false)
  expect(await call).toContain('The user sent you a message')

  // Quitting the browser: it's gone already, so the bar goes with it.
  ;({ call, window } = await t.handOff())
  window.quit()
  await until(() => !t.waits.has('space'))
  expect(await call).toContain('The user closed the browser window.')
})

it('times out a hand-off nobody answers, and lets only one chat in a space wait at a time', async () => {
  const fakes = fakeBrowsers()
  const { extension } = createBrowserExtension({ launch: () => fakes.launch, ops: fakes.ops, pollMs: 10, handOffMs: 50, ...NO_CHROME })
  const h = fakeHost(tempDir('kothar-browser-extension-'))
  await extension.onStart!({ values: defaults, host: h.host })
  cleanups.push(() => extension.onStop!({ values: defaults, host: h.host }))
  const space = h.chat('space')
  const worker = h.chat('worker', { parentId: 'space', worker: true })
  const tool = extension.tools![0]!
  const call = tool.run({ reason: 'Pay' }, { caller: space, values: defaults, host: h.host })
  await until(() => h.waits.has('space'))
  await expect(
    Promise.resolve(tool.run({ reason: 'Me too' }, { caller: worker, values: defaults, host: h.host })),
  ).rejects.toThrow('Another chat in this space is waiting')
  expect(String(await call)).toContain('did not finish in time')
})

it('opens on demand from Processes, refuses agents while the user has it, and stops', async () => {
  const { extension, fakes, chat, host } = await startedExtension()
  const space = chat('space')
  const context = { values: defaults, host }
  const endpoint = valueAfter(extension.mcpServers!({ chat: space, workDir: '/w', sandboxed: true, values: defaults })[0]!.args, '--cdp-endpoint')!
  await fetch(`${endpoint}/json/version/`)
  expect(extension.processes!('space', context)[0]!.actions.map((a) => a.name)).toEqual(['open', 'signin', 'stop'])
  await extension.onProcessAction!('space', 'browser', 'open', context)
  await until(() => fakes.launched.length === 2 && fakes.launched[1]!.fronted === 1)
  expect(fakes.launched[1]!.launch.headless).toBe(false)
  expect(extension.processes!('space', context)[0]!.actions.map((a) => a.name)).toEqual(['open', 'done', 'stop'])
  const refused = await fetch(`${endpoint}/json/version/`)
  expect(refused.status).toBe(503)
  expect(await refused.text()).toContain('The user has this space’s browser open')
  await extension.onProcessAction!('space', 'browser', 'done', context)
  expect(fakes.launched[2]!.launch.headless).toBe(true)
  await extension.onProcessAction!('space', 'browser', 'stop', context)
  expect(fakes.launched.every((b) => !b.alive)).toBe(true)
  expect(extension.processes!('space', context)).toEqual([])
})

it('closes a space’s browser once the space has been idle a while, and its profile goes with the space', async () => {
  const fakes = fakeBrowsers()
  const { extension } = createBrowserExtension({ launch: () => fakes.launch, ops: fakes.ops, ...NO_CHROME })
  const storage = tempDir('kothar-browser-extension-')
  const h = fakeHost(storage)
  const values = { ...defaults, idleMinutes: 0.001 }
  await extension.onStart!({ values, host: h.host })
  cleanups.push(() => extension.onStop!({ values, host: h.host }))
  const space = h.chat('space')
  const endpoint = valueAfter(extension.mcpServers!({ chat: space, workDir: '/w', sandboxed: true, values })[0]!.args, '--cdp-endpoint')!
  await fetch(`${endpoint}/json/version/`)
  space.status = 'idle'
  extension.onStatusChanged!(space, 'idle', { values, host: h.host })
  await until(() => !fakes.launched[0]!.alive)
  const profile = join(storage, 'profiles', 'space')
  mkdirSync(profile, { recursive: true })
  await extension.onChatRemoved!(space, { values, host: h.host })
  await until(() => !existsSync(profile))
})

it('is ready once Playwright’s Chromium is installed', async () => {
  const fake = (result: object): ExtensionRun => async () => ({ code: 0, stdout: JSON.stringify(result), stderr: '' })
  const chromium = { ...defaults, engine: 'chromium' }
  expect(await browser.setup!.check(fake({ ready: false, name: 'Chrome for Testing 1', path: '/x' }), chromium)).toEqual({
    ready: false,
    message: 'Browser not installed',
  })
  expect(await browser.setup!.check(fake({ ready: true, name: 'Chrome for Testing 1', path: '/x' }), chromium)).toEqual({
    ready: true,
    message: 'Chrome for Testing 1 installed, in the background',
  })
})

it('launches with a profile of its own, headless unless handed off, and the same keychain flags both ways', () => {
  const headless = chromiumArgs({ profile: '/p', headless: true })
  const window = chromiumArgs({ profile: '/p', headless: false })
  for (const args of [headless, window]) {
    for (const flag of ['--user-data-dir=/p', '--remote-debugging-port=0', '--use-mock-keychain', '--password-store=basic']) {
      expect(args).toContain(flag)
    }
  }
  expect(headless).toContain('--headless')
  expect(window).not.toContain('--headless')
})

it('frees a profile from a stale lock, and from a browser of its own still on it, never from another process', async () => {
  const profile = tempDir('kothar-profile-')
  const lock = join(profile, 'SingletonLock')
  const calls: string[][] = []
  // ps and kill as the Machine runs them, with ps answering what the test says each process runs.
  const commands = new Map<number, string>()
  const fakeRun: ExtensionRun = async (command, args) => {
    calls.push([command, ...args])
    if (command === '/bin/ps') return { code: 0, stdout: commands.get(Number(args.at(-1))) ?? '', stderr: '' }
    process.kill(Number(args.at(-1)), args[0] === '-KILL' ? 'SIGKILL' : 'SIGTERM')
    return { code: 0, stdout: '', stderr: '' }
  }
  // A lock whose process is gone.
  symlinkSync('host-999999', lock)
  await freeProfile({ run: fakeRun }, profile)
  expect(() => readlinkSync(lock)).toThrow()
  expect(calls).toEqual([])
  // A live process that isn't a browser on this profile is never signalled.
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'])
  cleanups.push(() => other.kill('SIGKILL'))
  commands.set(other.pid!, `${process.execPath} -e setTimeout`)
  symlinkSync(`host-${other.pid}`, lock)
  await freeProfile({ run: fakeRun }, profile)
  expect(calls.map((c) => c[0])).toEqual(['/bin/ps'])
  expect(other.exitCode).toBeNull()
  expect(other.signalCode).toBeNull()
  // A browser of Kothar's own left on this profile is asked to go.
  const stale = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'])
  cleanups.push(() => stale.kill('SIGKILL'))
  const gone = new Promise((resolve) => stale.once('exit', resolve))
  commands.set(stale.pid!, `Chromium --user-data-dir=${profile} --headless`)
  symlinkSync(`host-${stale.pid}`, lock)
  await freeProfile({ run: fakeRun }, profile)
  expect(await gone).not.toBeUndefined()
  expect(calls.at(-1)).toEqual(['/bin/kill', '-TERM', String(stale.pid)])
  expect(() => readlinkSync(lock)).toThrow()
})

// Real Chromium, headless only: the background browser and a hand-off's relaunch, with the window step faked as
// another headless launch so nothing shows on screen.
const require = createRequire(import.meta.url)
const chromiumPath = (() => {
  try {
    const mcp = dirname(require.resolve('@playwright/mcp/package.json'))
    const { registry } = require(require.resolve('playwright-core/lib/coreBundle', { paths: [mcp] }))
    const path: string = registry.registry.findExecutable('chromium').executablePath()
    return existsSync(path) ? path : undefined
  } catch {
    return undefined
  }
})()

// host.spawn as the core's, for the test: the process is the test's own, killed by pid when the test ends.
const spawnHere: ExtensionHost['spawn'] = async (command, args) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-2000)))
  cleanups.push(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  const proc: ExtensionProcess = {
    onOutput: (listener) => void child.stdout.on('data', (chunk) => listener(String(chunk))),
    onExit: (listener) => void child.on('exit', (code) => listener(code, stderr)),
    stop: () => void child.kill('SIGTERM'),
  }
  return proc
}

it.skipIf(!chromiumPath)('runs a real headless Chromium, and a hand-off keeps its tabs and session cookies', async () => {
  const site = createServer((request, response) => {
    if (request.url === '/login') {
      return void response.writeHead(200, { 'set-cookie': 'session=abc; Path=/', 'content-type': 'text/html' }).end('<title>Login</title>in')
    }
    response.writeHead(200, { 'content-type': 'text/html' }).end(`<title>Page</title>${request.headers.cookie ?? 'none'}`)
  })
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => site.close(() => resolve())))
  const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`

  // The test may itself run in a sandbox, where Chromium's own sandbox and its separate network process can't start;
  // Kothar launches it unsandboxed, so it needs neither flag.
  const real = chromiumLauncher({ run, spawn: spawnHere }, async () => chromiumPath!, [
    '--enable-features=NetworkServiceInProcess2',
    '--no-sandbox',
  ])
  // The window step, headless: the test proves what carries over without a window on screen.
  const launches: Launch[] = []
  const launch: Launcher = (options) => {
    launches.push(options)
    return real({ ...options, headless: true })
  }
  const profile = join(tempDir('kothar-real-browser-'), 'profile')
  const space = new SpaceBrowser({ profile, launch, pollMs: 100 })
  cleanups.push(() => space.stop())
  const endpoints = await serveEndpoints(() => space.endpoint())
  cleanups.push(() => endpoints.close())

  // What Playwright does first: /json/version through Kothar's endpoint launches the browser.
  const version = await (await fetch(`${endpoints.url('space')}/json/version/`)).json()
  expect(version.webSocketDebuggerUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//)
  const endpoint = await space.endpoint()
  // Playwright attaches through Kothar's endpoint, as Playwright MCP's --cdp-endpoint does, and browses.
  const mcp = dirname(require.resolve('@playwright/mcp/package.json'))
  const { chromium } = require(require.resolve('playwright-core', { paths: [mcp] }))
  const attached = await chromium.connectOverCDP(endpoints.url('space'))
  const page = await attached.contexts()[0].newPage()
  await page.goto(`${origin}/login`)
  await until(async () => (await getCookies(endpoint)).some((c) => c.name === 'session'), 10_000)
  const disconnected = new Promise((resolve) => attached.once('disconnected', resolve))

  const done = space.handOff('Log in')
  await until(() => space.mode === 'window', 20_000)
  // Playwright sees its browser go, and reconnects on its next call.
  await disconnected
  expect(launches.map((l) => l.headless)).toEqual([true, false])
  const window = await space.endpoint().catch((error: Error) => error.message)
  expect(window).toContain('The user has this space’s browser open')
  await space.finish('done')
  const result = await done
  expect(result.how).toBe('done')
  expect(result.tabs.map((t) => t.url)).toEqual([`${origin}/login`])

  const after = await space.endpoint()
  expect(after).not.toBe(endpoint)
  // The session cookie (not saved to disk by Chromium) came across both relaunches, and the tab with it.
  expect((await getCookies(after)).find((c) => c.name === 'session')?.value).toBe('abc')
  await until(async () => (await listTabs(after)).some((t) => t.url === `${origin}/login`), 10_000)
  const again = await chromium.connectOverCDP(endpoints.url('space'))
  const tab = again.contexts()[0].pages().find((p: { url(): string }) => p.url() === `${origin}/login`)
  await tab.reload()
  expect(await tab.textContent('body')).toBe('in')
  const other = await again.contexts()[0].newPage()
  await other.goto(`${origin}/`)
  expect(await other.textContent('body')).toBe('session=abc')
  await again.close()
  await space.stop()
  expect(space.mode).toBe('off')
  expect(existsSync(join(profile, 'SingletonLock'))).toBe(false)
}, 60_000)

// A Mac with Chrome installed and one profile, as the files say.
function fakeChrome() {
  const home = tempDir('kothar-home-')
  const apps = join(home, 'Applications')
  const executable = join(apps, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')
  const data = join(home, 'Library', 'Application Support', 'Google', 'Chrome')
  for (const dir of [join(executable, '..'), join(data, 'Default')]) mkdirSync(dir, { recursive: true })
  writeFileSync(executable, '')
  writeFileSync(join(data, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Person 1', user_name: 'me@example.com' } } } }))
  writeFileSync(join(data, 'Default', 'Cookies'), 'v1')
  return { places: { home, apps: [apps] }, executable, source: join(data, 'Default') }
}

it('runs a copy of the picked profile on that browser’s own app, copied again on each cold start only', async () => {
  const chrome = fakeChrome()
  const fakes = fakeBrowsers()
  const { extension, browsers } = createBrowserExtension({ launch: () => fakes.launch, ops: fakes.ops, pollMs: 10, places: chrome.places, platform: 'darwin' })
  const profile = extension.settings!.find((s) => s.key === 'profile')!
  expect(profile.type === 'select' && profile.options).toEqual([
    { value: 'kothar', label: 'Kothar’s own' },
    { value: 'chrome:Default', label: 'Chrome: Person 1 (me@example.com)' },
    { value: 'folder', label: 'Other folder…' },
  ])
  const storage = tempDir('kothar-browser-extension-')
  const h = fakeHost(storage)
  const values = { ...defaults, profile: 'chrome:Default' }
  await extension.onStart!({ values, host: h.host })
  cleanups.push(() => extension.onStop!({ values, host: h.host }))
  // Nothing to install: it runs on the user's Chrome.
  expect(await extension.setup!.check(run, values)).toEqual({ ready: true, message: 'Uses Chrome: Person 1 (me@example.com), in the background' })
  const space = h.chat('space')
  const endpoint = valueAfter(extension.mcpServers!({ chat: space, workDir: '/w', sandboxed: true, values })[0]!.args, '--cdp-endpoint')!
  await fetch(`${endpoint}/json/version/`)
  const mirror = join(storage, 'mirrors', 'space')
  expect(fakes.launched[0]!.launch).toEqual({ profile: mirror, headless: true, cold: true, executable: chrome.executable, keychain: 'real' })
  expect(readFileSync(join(mirror, 'Default', 'Cookies'), 'utf8')).toBe('v1')

  // A hand-off relaunches on the same copy, without copying again, so the agent's logins carry over.
  writeFileSync(join(chrome.source, 'Cookies'), 'v2')
  fakes.launched[0]!.cookies = [{ name: 'made', value: 'by-agent', domain: 'example.com', path: '/' }]
  const show = extension.tools!.find((t) => t.name === SHOW_TOOL)!
  const call = show.run({ reason: 'Look at the chart' }, { caller: space, values, host: h.host })
  await until(() => h.waits.has('space'))
  expect(h.waits.get('space')!.text).toBe('Browser: Look at the chart')
  expect(h.notified).toEqual([{ chatId: 'space', title: 'An agent wants to show you something', body: 'Look at the chart' }])
  expect(fakes.launched[1]!.launch).toMatchObject({ profile: mirror, headless: false, cold: false, keychain: 'real' })
  expect(readFileSync(join(mirror, 'Default', 'Cookies'), 'utf8')).toBe('v1')
  await extension.onWaitAction!(space, { button: 'done' }, { values, host: h.host })
  expect(String(await call)).toContain('The user is done.')

  // Closing for idleness keeps its cookies in memory; the next start copies the profile again, then adds back the
  // cookies the copy doesn't have.
  await browsers.get('space')!.stop(true)
  await fetch(`${endpoint}/json/version/`)
  const next = fakes.launched.at(-1)!
  expect(next.launch).toMatchObject({ headless: true, cold: true })
  expect(readFileSync(join(mirror, 'Default', 'Cookies'), 'utf8')).toBe('v2')
  expect(next.cookies).toEqual([{ name: 'made', value: 'by-agent', domain: 'example.com', path: '/' }])

  // Refresh logins now closes the background browser, with nothing carried, so the next browse starts on a new copy.
  extension.settingsView!.onAction!({ name: 'refresh' }, { values, host: h.host })
  await until(() => !next.alive)
  await fetch(`${endpoint}/json/version/`)
  expect(fakes.launched.at(-1)!.cookies).toEqual([])

  // Picking Kothar's own profile again: the background browser closes, and the next starts on Kothar's profile.
  const own = { ...values, profile: 'kothar', engine: 'chromium' }
  await extension.onSettingsChanged!({ key: 'profile', value: 'kothar', previous: 'chrome:Default' }, { values: own, host: h.host })
  await until(() => !fakes.launched.at(-1)!.alive)
  await fetch(`${endpoint}/json/version/`)
  expect(fakes.launched.at(-1)!.launch).toEqual({ profile: join(storage, 'profiles', 'space'), headless: true, cold: true })

  // The settings page says where logins come from, and that a missing folder can't be used.
  const view = JSON.stringify(extension.settingsView!.render({ values, host: h.host }))
  expect(view).toContain('Logins from Chrome: Person 1 (me@example.com)')
  expect(view).toContain('Google (Gmail, YouTube and the like) signs you out in a copy')
  expect(view).toContain('Refresh logins now')
  const broken = { ...values, profile: 'folder', profileFolder: join(chrome.places.home, 'nope') }
  expect(JSON.stringify(extension.settingsView!.render({ values: broken, host: h.host }))).toContain('doesn\'t exist')
})

it('refuses to browse on a profile that can’t be used, and says where to fix it', async () => {
  const chrome = fakeChrome()
  const fakes = fakeBrowsers()
  const { extension } = createBrowserExtension({ launch: () => fakes.launch, ops: fakes.ops, places: chrome.places })
  const h = fakeHost(tempDir('kothar-browser-extension-'))
  const values = { ...defaults, profile: 'folder', profileFolder: '' }
  await extension.onStart!({ values, host: h.host })
  cleanups.push(() => extension.onStop!({ values, host: h.host }))
  const space = h.chat('space')
  const endpoint = valueAfter(extension.mcpServers!({ chat: space, workDir: '/w', sandboxed: true, values })[0]!.args, '--cdp-endpoint')!
  const answer = await fetch(`${endpoint}/json/version/`)
  expect(answer.status).toBe(503)
  expect(await answer.text()).toBe('No folder given: pick a profile in Settings → Extensions → Browser')
  expect(fakes.launched).toEqual([])
})

it('shows and hides the space’s browser from the General tab and Processes, with no agent waiting', async () => {
  const { extension, fakes, chat, host } = await startedExtension()
  const space = chat('space')
  const worker = chat('worker', { parentId: 'space', worker: true })
  const context = { values: defaults, host }
  const command = (id: string) => extension.commands!.find((c) => c.id === id)!
  expect(command('show-browser').shown!(space, context)).toBe(true)
  expect(command('hide-browser').shown!(space, context)).toBe(false)
  // From a worker's General tab too: it's the space's browser.
  await command('show-browser').run(worker, context)
  await until(() => fakes.launched.length === 1 && fakes.launched[0]!.fronted === 1)
  expect(fakes.launched[0]!.launch).toMatchObject({ headless: false, cold: true })
  // Its tab in front, and its app in front of the user's others.
  expect(fakes.launched[0]!.activated).toBe(1)
  expect(command('show-browser').shown!(space, context)).toBe(false)
  expect(command('hide-browser').shown!(space, context)).toBe(true)
  expect(extension.processes!('space', context)[0]!.actions.map((a) => a.label)).toEqual(['Open', 'Hide', 'Stop'])
  await command('hide-browser').run(space, context)
  expect(fakes.launched[1]!.launch.headless).toBe(true)
  expect(extension.processes!('space', context)[0]!.actions.map((a) => a.label)).toEqual(['Show', 'Sign in…', 'Stop'])
  expect(command('show-browser').shown!(space, context)).toBe(true)
})

it('offers show_browser beside ask_user_in_browser, and tells agents when to use each', () => {
  expect(browser.tools!.map((t) => t.name)).toEqual([HAND_OFF_TOOL, SHOW_TOOL])
  expect(BROWSER_INSTRUCTIONS).toContain(SHOW_TOOL)
})

it('runs a plain window and the headless browser with no automation tells, and only the plain one without DevTools', () => {
  const headless = chromiumArgs({ profile: '/p', headless: true })
  const plain = chromiumArgs({ profile: '/p', headless: true, plain: true, urls: ['https://a.example/', 'https://b.example/'] })
  const window = chromiumArgs({ profile: '/p', headless: false })
  for (const args of [headless, plain, window]) {
    expect(args).not.toContain('--enable-automation')
    expect(args.some((a) => a.startsWith('--enable-automation') || a.startsWith('--remote-debugging-pipe'))).toBe(false)
    // The keychain is the same in every mode, so the cookies one saves the others read.
    expect(args).toContain('--use-mock-keychain')
  }
  // Headless Chrome says navigator.webdriver unless told not to; a window doesn't, and the flag would only put Chrome's
  // "unsupported command-line flag" bar on it.
  expect(headless).toContain('--disable-blink-features=AutomationControlled')
  expect(window.some((a) => a.startsWith('--disable-blink-features'))).toBe(false)
  expect(headless.filter((a) => a.startsWith('--remote-debugging'))).toHaveLength(2)
  // Signing in: as close as can be to the Chrome the user opens. No DevTools, no flags Chrome warns about, and sync on,
  // which Chrome's own sign-in finishes through.
  expect(plain.filter((a) => a.startsWith('--remote-debugging'))).toEqual([])
  expect(plain.some((a) => a.startsWith('--disable-blink-features'))).toBe(false)
  expect(plain).not.toContain('--disable-sync')
  expect(plain.some((a) => a.startsWith('--disable-features'))).toBe(false)
  expect(plain).not.toContain('--headless')
  expect(plain.slice(-2)).toEqual(['https://a.example/', 'https://b.example/'])
  // After a plain window, the headless browser reopens the tabs it saved, instead of a blank one.
  const after = chromiumArgs({ profile: '/p', headless: true, restoreSession: true })
  expect(after).toContain('--restore-last-session')
  expect(after).not.toContain('about:blank')
})

it('finds the installed Google Chrome, stable before Beta and Canary, and on Linux in the usual places', () => {
  const home = tempDir('kothar-chrome-find-')
  const apps = join(home, 'Applications')
  const make = (path: string) => (mkdirSync(join(path, '..'), { recursive: true }), writeFileSync(path, ''), path)
  expect(findChrome({ home, apps: [apps] }, 'darwin')).toBeUndefined()
  const beta = make(join(apps, 'Google Chrome Beta.app', 'Contents', 'MacOS', 'Google Chrome Beta'))
  expect(findChrome({ home, apps: [apps] }, 'darwin')).toEqual({ name: 'Google Chrome Beta', executable: beta })
  const stable = make(join(apps, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'))
  expect(findChrome({ home, apps: [apps] }, 'darwin')).toEqual({ name: 'Google Chrome', executable: stable })
  const linux = make(join(home, 'opt', 'chrome'))
  expect(findChrome({ home, apps: [], bins: [join(home, 'none'), linux] }, 'linux')).toEqual({ name: 'Google Chrome', executable: linux })
  expect(findChrome({ home, apps: [], bins: [] }, 'linux')).toBeUndefined()
})

it('runs Kothar’s own profile on the installed Chrome, in a folder apart from Chromium’s, and falls back without it', async () => {
  const chrome = fakeChrome()
  const fakes = fakeBrowsers()
  const { extension } = createBrowserExtension({ launch: () => fakes.launch, ops: fakes.ops, places: chrome.places, platform: 'darwin' })
  const storage = tempDir('kothar-browser-extension-')
  const h = fakeHost(storage)
  await extension.onStart!({ values: defaults, host: h.host })
  cleanups.push(() => extension.onStop!({ values: defaults, host: h.host }))
  // Chrome is the default; nothing to install.
  expect(await extension.setup!.check(run, defaults)).toEqual({ ready: true, message: 'Uses Google Chrome, in the background' })
  expect(JSON.stringify(extension.settingsView!.render({ values: defaults, host: h.host }))).toContain('Google Chrome, on a profile of Kothar’s own per space')
  const space = h.chat('space')
  const endpoint = valueAfter(extension.mcpServers!({ chat: space, workDir: '/w', sandboxed: true, values: defaults })[0]!.args, '--cdp-endpoint')!
  await fetch(`${endpoint}/json/version/`)
  const chromeProfile = join(storage, 'chrome-profiles', 'space')
  expect(fakes.launched[0]!.launch).toEqual({ profile: chromeProfile, headless: true, cold: true, executable: chrome.executable })
  expect(extension.processes!('space', { values: defaults, host: h.host })[0]!.hint).toContain('Google Chrome')

  // Bundled Chromium: the background browser restarts on Chromium's own folder.
  const chromium = { ...defaults, engine: 'chromium' }
  await extension.onSettingsChanged!({ key: 'engine', value: 'chromium', previous: 'chrome' }, { values: chromium, host: h.host })
  await until(() => !fakes.launched[0]!.alive)
  await fetch(`${endpoint}/json/version/`)
  expect(fakes.launched[1]!.launch).toEqual({ profile: join(storage, 'profiles', 'space'), headless: true, cold: true })

  // Both folders go with the space.
  for (const dir of [chromeProfile, join(storage, 'profiles', 'space')]) mkdirSync(dir, { recursive: true })
  await extension.onChatRemoved!(space, { values: chromium, host: h.host })
  await until(() => !existsSync(chromeProfile) && !existsSync(join(storage, 'profiles', 'space')))

  // Chrome picked but not installed: Chromium runs, and Settings says so.
  const without = createBrowserExtension({ launch: () => fakes.launch, ops: fakes.ops, ...NO_CHROME }).extension
  const view = JSON.stringify(without.settingsView!.render({ values: defaults, host: h.host }))
  expect(view).toContain('Google Chrome isn’t installed')
  const fake: ExtensionRun = async () => ({ code: 0, stdout: JSON.stringify({ ready: true, name: 'Chrome for Testing 1', path: '/x' }), stderr: '' })
  expect(await without.setup!.check(fake, defaults)).toEqual({
    ready: true,
    message: 'Google Chrome isn’t installed; Chrome for Testing 1 installed, in the background',
  })
})

it('hands the browser over for signing in as a plain window, and the headless one reopens its tabs with both logins', async () => {
  const { extension, fakes, tool, waits, chat, host } = await startedExtension()
  const space = chat('space')
  const context = { values: defaults, host }
  const endpoint = valueAfter(extension.mcpServers!({ chat: space, workDir: '/w', sandboxed: true, values: defaults })[0]!.args, '--cdp-endpoint')!
  await fetch(`${endpoint}/json/version/`)
  const headless = fakes.launched[0]!
  headless.tabs = [{ id: 'a', url: 'https://accounts.google.com/', title: 'Sign in' }]
  headless.cookies = [{ name: 'agent', value: 'session', domain: 'example.com', path: '/' }]

  const call = tool.run({ reason: 'Sign in to Google' }, { caller: space, values: defaults, host })
  await until(() => waits.has('space'))
  expect(headless.alive).toBe(false)
  const window = fakes.launched[1]!
  // No DevTools: Kothar only brings its app forward, and never reads or drives it.
  expect(window.launch).toEqual({ profile: headless.launch.profile, headless: false, cold: false, plain: true, urls: ['https://accounts.google.com/'] })
  expect(window.fronted).toBe(0)
  expect(window.activated).toBe(1)
  expect(extension.processes!('space', context)[0]!.detail).toBe('Open for you, not under automation: Sign in to Google')
  const refused = await fetch(`${endpoint}/json/version/`)
  expect(refused.status).toBe(503)

  // The user signs in; Done asks the window to quit, and it saves its tabs and the new login to the profile.
  window.tabs = [{ id: 'x', url: 'https://myaccount.google.com/', title: 'Google Account' }]
  await extension.onWaitAction!(space, { button: 'done' }, context)
  const text = String(await call)
  expect(text).toContain('The user is done.')
  expect(text).toContain('* Google Account — https://myaccount.google.com/')
  expect(window.alive).toBe(false)
  const back = fakes.launched[2]!
  expect(back.launch).toEqual({ profile: headless.launch.profile, headless: true, cold: false, restoreSession: true })
  // The session cookie the plain window never had comes back.
  expect(back.cookies).toEqual(headless.cookies)

  // Quitting the plain window ends it too; Sign in… from the General tab opens one with no agent waiting.
  const again = tool.run({ reason: 'Sign in again' }, { caller: space, values: defaults, host })
  await until(() => fakes.launched.length === 4)
  fakes.launched[3]!.quit()
  expect(String(await again)).toContain('The user closed the browser window.')
  await until(() => fakes.launched.length === 5)
  expect(fakes.launched[4]!.launch.restoreSession).toBe(true)
  const signIn = extension.commands!.find((c) => c.id === 'sign-in-browser')!
  expect(signIn.shown!(space, context)).toBe(true)
  await signIn.run(space, context)
  await until(() => fakes.launched.length === 6)
  expect(fakes.launched[5]!.launch.plain).toBe(true)
  expect(signIn.shown!(space, context)).toBe(false)
  expect(waits.has('space')).toBe(false)
  await extension.onProcessAction!('space', 'browser', 'done', context)
  expect(fakes.launched[6]!.launch).toMatchObject({ headless: true, restoreSession: true })
})

// A host whose spawned "browser" locks its profile as the given pid. quits: whether a SIGTERM to that pid makes it quit
// (Chrome's clean quit); kill is never really run, so no real process is signalled.
function plainHost(profile: string, pid: number, quits: boolean) {
  const spawned: { command: string; args: string[] }[] = []
  const signalled: string[][] = []
  let exit!: (code: number | null, tail: string) => void
  let stopped = 0
  const host = {
    run: async (command: string, args: string[]) => {
      if (command === '/bin/kill') {
        signalled.push(args)
        if (quits && args.join(' ') === `-TERM ${pid}`) setTimeout(() => exit(0, ''), 20)
      }
      return { code: 0, stdout: '', stderr: '' }
    },
    spawn: async (command: string, args: string[]) => {
      spawned.push({ command, args })
      setTimeout(() => symlinkSync(`host-${pid}`, join(profile, 'SingletonLock')), 20)
      const proc: ExtensionProcess = {
        onOutput: () => {},
        onExit: (listener) => void (exit = listener),
        stop: () => {
          stopped++
          exit(0, '')
        },
      }
      return proc
    },
  } as unknown as ExtensionHost
  return { host, spawned, signalled, stopped: () => stopped }
}

it('stops a plain window by asking its browser process alone to quit, and waits for it, so a new login is saved', async () => {
  const profile = join(tempDir('kothar-plain-'), 'profile')
  const fake = plainHost(profile, 424242, true)
  const launcher = chromiumLauncher(fake.host, async () => '/bundled/chromium', [], 2000)
  const running = await launcher({ profile, headless: false, plain: true, executable: '/chrome', urls: ['https://accounts.google.com/'] })
  expect(running.endpoint).toBe('')
  const args = fake.spawned[0]!.args
  expect(args.some((a) => /^--(remote-debugging|enable-automation|disable-blink-features)/.test(a))).toBe(false)
  await running.stop()
  // SIGTERM to the browser only, not the process group: Chrome closes its helpers itself after saving.
  expect(fake.signalled).toEqual([['-TERM', '424242']])
  expect(fake.stopped()).toBe(0)
  await running.exited
})

it('kills a plain window that is still there after its grace period', async () => {
  const profile = join(tempDir('kothar-plain-'), 'profile')
  const fake = plainHost(profile, 424243, false)
  const launcher = chromiumLauncher(fake.host, async () => '/bundled/chromium', [], 50)
  const running = await launcher({ profile, headless: false, plain: true, executable: '/chrome' })
  await running.stop()
  expect(fake.signalled).toEqual([['-TERM', '424243']])
  expect(fake.stopped()).toBe(1)
})

it('starts a plain window with no DevTools, up once it locks its profile', async () => {
  const profile = join(tempDir('kothar-plain-'), 'profile')
  const spawned: { command: string; args: string[] }[] = []
  let exit!: (code: number | null, tail: string) => void
  let stopped = 0
  // Its pid is a process that's gone, so the stop goes straight to the process's own.
  const host = {
    run: async () => ({ code: 1, stdout: '', stderr: '' }),
    spawn: async (command: string, args: string[]) => {
      spawned.push({ command, args })
      // The browser locks its profile as it starts.
      setTimeout(() => symlinkSync(`host-${process.pid}`, join(profile, 'SingletonLock')), 20)
      const proc: ExtensionProcess = {
        onOutput: () => {},
        onExit: (listener) => void (exit = listener),
        stop: () => {
          stopped++
          exit(0, '')
        },
      }
      return proc
    },
  } as unknown as ExtensionHost
  const launcher = chromiumLauncher(host, async () => '/bundled/chromium', [], 50)
  const running = await launcher({ profile, headless: false, plain: true, executable: '/chrome', urls: ['https://accounts.google.com/'] })
  expect(running.endpoint).toBe('')
  expect(spawned[0]!.command).toBe('/chrome')
  expect(spawned[0]!.args.some((a) => a.startsWith('--remote-debugging'))).toBe(false)
  expect(spawned[0]!.args.at(-1)).toBe('https://accounts.google.com/')
  await running.stop()
  expect(stopped).toBe(1)
  await running.exited
})
