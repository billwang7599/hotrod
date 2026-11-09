import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, expect, it } from 'vitest'
import type { ChatDetail, ModHost, ModProcess, ModRun, ModTool, ModWait } from '@kothar/mod-api'
import { sandboxingMachine } from '@kothar/core/test-machine'
import { getCookies, listTabs } from './cdp.ts'
import { chromiumArgs, chromiumLauncher, freeProfile, type Launch, type Launcher } from './chromium.ts'
import { serveEndpoints } from './endpoint.ts'
import browser, { BROWSER_INSTRUCTIONS, createBrowserMod, HAND_OFF_TOOL } from './index.ts'
import { type BrowserOps, SpaceBrowser } from './space-browser.ts'

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

const run: ModRun = (command, args, options = {}) => sandboxingMachine.run(command, args, { cwd: '/', ...options })
const defaults = Object.fromEntries(browser.settings!.map((setting) => [setting.key, setting.default]))
const valueAfter = (args: string[] = [], flag: string) =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined
const until = async (check: () => boolean | Promise<boolean>, ms = 4000) => {
  for (let waited = 0; waited < ms && !(await check()); waited += 10) await new Promise((r) => setTimeout(r, 10))
  expect(await check()).toBe(true)
}

// A fake browser: each launch is a "browser" with tabs the test can see and change, so the window step runs without
// a window. ops reads and writes the same tabs, as the CDP calls would.
function fakeBrowsers() {
  type Fake = { launch: Launch; endpoint: string; tabs: { id: string; url: string; title: string }[]; cookies: Record<string, unknown>[]; alive: boolean; quit: () => void; fronted: number }
  const launched: Fake[] = []
  const byEndpoint = (endpoint: string) => launched.find((b) => b.endpoint === endpoint)!
  let next = 0
  const launch: Launcher = async (options) => {
    let quit!: () => void
    const exited = new Promise<void>((resolve) => (quit = resolve))
    // A browser starts on one blank tab, as Chromium does on about:blank.
    const tabs = [{ id: 'blank', url: 'about:blank', title: '' }]
    const fake: Fake = { launch: options, endpoint: `http://fake:${++next}`, tabs, cookies: [], alive: true, quit: () => {}, fronted: 0 }
    fake.quit = () => {
      fake.alive = false
      quit()
    }
    launched.push(fake)
    return { endpoint: fake.endpoint, exited, stop: async () => fake.quit() }
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
  }
  return { launch, ops, launched }
}

// A host as the core gives one, for the calls the Browser mod makes, with chats the test sets.
function fakeHost(storage: string) {
  const chats: ChatDetail[] = []
  const waits = new Map<string, ModWait>()
  const changed: string[] = []
  const host = {
    chats: () => chats,
    space: (chatId: string) => {
      const chat = chats.find((c) => c.id === chatId)
      const id = chat?.parentId ?? chat?.id
      return id ? { id, name: id, folders: [], checkouts: [] } : undefined
    },
    wait: (chatId: string, wait: ModWait) => void waits.set(chatId, wait),
    endWait: (chatId: string) => void waits.delete(chatId),
    processesChanged: (spaceId: string) => void changed.push(spaceId),
    storage: { dir: storage },
    run,
  } as unknown as ModHost
  const chat = (id: string, more: Partial<ChatDetail> = {}): ChatDetail => {
    const detail = { id, name: id, engine: 'fake', status: 'running' as const, archived: false, folders: [], files: [], createdAt: '', ...more }
    chats.push(detail)
    return detail
  }
  return { host, chats, waits, changed, chat }
}

async function startedMod() {
  const fakes = fakeBrowsers()
  const { mod } = createBrowserMod({ launch: () => fakes.launch, ops: fakes.ops, pollMs: 10 })
  const storage = tempDir('kothar-browser-mod-')
  const fake = fakeHost(storage)
  await mod.onStart!({ values: defaults, host: fake.host })
  cleanups.push(() => mod.onStop!({ values: defaults, host: fake.host }))
  const tool = mod.tools!.find((t) => t.name === HAND_OFF_TOOL) as ModTool
  return { mod, fakes, storage, tool, ...fake }
}

it('attaches Playwright MCP to the space’s browser through Kothar’s endpoint, never launching one itself', async () => {
  const { mod, chat } = await startedMod()
  chat('space')
  chat('worker', { parentId: 'space', worker: true })
  const serverOf = (id: string, values = defaults) =>
    mod.mcpServers!({ chat: { id, name: id, engine: 'fake' }, workDir: '/work/space', sandboxed: true, values })[0]!
  const { name, command, args, env, allowTools } = serverOf('space')
  expect({ name, command, allowTools }).toEqual({ name: 'browser', command: process.execPath, allowTools: true })
  expect(args![0]).toMatch(/@playwright[/\\]mcp[/\\]cli\.js$/)
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
  const { mod } = createBrowserMod()
  expect(mod.mcpServers!({ chat: { id: 'a', name: 'a', engine: 'fake' }, workDir: '/w', sandboxed: true, values: defaults })).toEqual([])
  expect(mod.settings!.map((s) => s.key)).toEqual(['askEachAction', 'idleMinutes'])
  expect(mod.settingsVersion).toBe(1)
  const old = { browser: 'chrome', port: 9333, extensionToken: 'x', background: true, askEachAction: true }
  expect(mod.migrateSettings!(old, 0, {})).toEqual({ askEachAction: true })
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
  const { mod, fakes, storage, chat } = await startedMod()
  chat('space')
  const endpoint = valueAfter(
    mod.mcpServers!({ chat: { id: 'space', name: 's', engine: 'fake' }, workDir: '/w', sandboxed: true, values: defaults })[0]!.args,
    '--cdp-endpoint',
  )!
  expect(fakes.launched).toHaveLength(0)
  // Playwright's first call: the fake has no real /json/version, so the endpoint answers 503, but it launched.
  await fetch(`${endpoint}/json/version/`)
  await fetch(`${endpoint}/json/version/`)
  expect(fakes.launched).toHaveLength(1)
  expect(fakes.launched[0]!.launch).toEqual({ profile: join(storage, 'profiles', 'space'), headless: true })
  // Only Kothar's endpoint, with its token, answers.
  expect((await fetch(endpoint.replace(/\/[\w-]+\/space$/, '/wrong/space/json/version'))).status).toBe(404)
})

it('hands the browser to the user in a window with the same tabs and logins, and goes back headless on Done', async () => {
  const { mod, fakes, tool, waits, changed, chat, host } = await startedMod()
  const space = chat('space')
  // The agent browsed: a headless browser with two tabs and a cookie.
  const servers = mod.mcpServers!({ chat: space, workDir: '/w', sandboxed: true, values: defaults })
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
  expect(mod.processes!('space', { values: defaults, host })).toEqual([
    expect.objectContaining({ label: 'Browser', dot: 'warning', detail: 'Open for you: Log in to Example' }),
  ])
  expect(changed).toContain('space')

  // Open brings it forward again; the user logs in and lands somewhere new.
  await mod.onWaitAction!(space, { button: 'open' }, { values: defaults, host })
  expect(window.fronted).toBe(2)
  window.tabs = [{ id: 'x', url: 'https://example.com/home', title: 'Home' }]
  window.cookies = [{ name: 'session', value: 'logged-in', domain: 'example.com' }]
  await mod.onWaitAction!(space, { button: 'done' }, { values: defaults, host })

  const text = String(await call)
  expect(text).toContain('The user is done.')
  expect(text).toContain('* Home — https://example.com/home')
  expect(window.alive).toBe(false)
  const back = fakes.launched[2]!
  expect(back.launch.headless).toBe(true)
  expect(back.tabs.map((t) => t.url)).toEqual(['https://example.com/home'])
  expect(back.cookies).toEqual(window.cookies)
  expect(waits.has('space')).toBe(false)
  expect(mod.processes!('space', { values: defaults, host })).toEqual([
    expect.objectContaining({ dot: 'success', detail: 'In the background' }),
  ])
})

it('ends a hand-off when the user closes the window, sends a message, or the chat is stopped', async () => {
  const { mod, fakes, tool, waits, chat, host } = await startedMod()
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
  await mod.onWaitAction!(space, { message: 'done, carry on' }, context)
  expect(String(await call)).toContain('The user sent you a message')

  // Quitting the browser.
  ;({ call, window } = await handOff())
  window.quit()
  expect(String(await call)).toContain('The user closed the browser window.')

  // Stop on the chat: the window closes and the browser stays off.
  ;({ call, window } = await handOff())
  const launches = fakes.launched.length
  mod.onStatusChanged!({ ...space, status: 'stopping' }, 'stopping', context)
  expect(String(await call)).toContain('The hand-off was stopped.')
  expect(window.alive).toBe(false)
  expect(fakes.launched).toHaveLength(launches)
  expect(mod.processes!('space', context)).toEqual([])
})

it('times out a hand-off nobody answers, and lets only one chat in a space wait at a time', async () => {
  const fakes = fakeBrowsers()
  const { mod } = createBrowserMod({ launch: () => fakes.launch, ops: fakes.ops, pollMs: 10, handOffMs: 50 })
  const h = fakeHost(tempDir('kothar-browser-mod-'))
  await mod.onStart!({ values: defaults, host: h.host })
  cleanups.push(() => mod.onStop!({ values: defaults, host: h.host }))
  const space = h.chat('space')
  const worker = h.chat('worker', { parentId: 'space', worker: true })
  const tool = mod.tools![0]!
  const call = tool.run({ reason: 'Pay' }, { caller: space, values: defaults, host: h.host })
  await until(() => h.waits.has('space'))
  await expect(
    Promise.resolve(tool.run({ reason: 'Me too' }, { caller: worker, values: defaults, host: h.host })),
  ).rejects.toThrow('Another chat in this space is waiting')
  expect(String(await call)).toContain('did not finish in time')
})

it('opens on demand from Processes, refuses agents while the user has it, and stops', async () => {
  const { mod, fakes, chat, host } = await startedMod()
  const space = chat('space')
  const context = { values: defaults, host }
  const endpoint = valueAfter(mod.mcpServers!({ chat: space, workDir: '/w', sandboxed: true, values: defaults })[0]!.args, '--cdp-endpoint')!
  await fetch(`${endpoint}/json/version/`)
  expect(mod.processes!('space', context)[0]!.actions.map((a) => a.name)).toEqual(['open', 'stop'])
  await mod.onProcessAction!('space', 'browser', 'open', context)
  await until(() => fakes.launched.length === 2 && fakes.launched[1]!.fronted === 1)
  expect(fakes.launched[1]!.launch.headless).toBe(false)
  expect(mod.processes!('space', context)[0]!.actions.map((a) => a.name)).toEqual(['open', 'done', 'stop'])
  const refused = await fetch(`${endpoint}/json/version/`)
  expect(refused.status).toBe(503)
  expect(await refused.text()).toContain('The user has this space’s browser open')
  await mod.onProcessAction!('space', 'browser', 'done', context)
  expect(fakes.launched[2]!.launch.headless).toBe(true)
  await mod.onProcessAction!('space', 'browser', 'stop', context)
  expect(fakes.launched.every((b) => !b.alive)).toBe(true)
  expect(mod.processes!('space', context)).toEqual([])
})

it('closes a space’s browser once the space has been idle a while, and its profile goes with the space', async () => {
  const fakes = fakeBrowsers()
  const { mod } = createBrowserMod({ launch: () => fakes.launch, ops: fakes.ops })
  const storage = tempDir('kothar-browser-mod-')
  const h = fakeHost(storage)
  const values = { ...defaults, idleMinutes: 0.001 }
  await mod.onStart!({ values, host: h.host })
  cleanups.push(() => mod.onStop!({ values, host: h.host }))
  const space = h.chat('space')
  const endpoint = valueAfter(mod.mcpServers!({ chat: space, workDir: '/w', sandboxed: true, values })[0]!.args, '--cdp-endpoint')!
  await fetch(`${endpoint}/json/version/`)
  space.status = 'idle'
  mod.onStatusChanged!(space, 'idle', { values, host: h.host })
  await until(() => !fakes.launched[0]!.alive)
  const profile = join(storage, 'profiles', 'space')
  mkdirSync(profile, { recursive: true })
  await mod.onChatRemoved!(space, { values, host: h.host })
  await until(() => !existsSync(profile))
})

it('is ready once Playwright’s Chromium is installed', async () => {
  const fake = (result: object): ModRun => async () => ({ code: 0, stdout: JSON.stringify(result), stderr: '' })
  expect(await browser.setup!.check(fake({ ready: false, name: 'Chrome for Testing 1', path: '/x' }), defaults)).toEqual({
    ready: false,
    message: 'Browser not installed',
  })
  expect(await browser.setup!.check(fake({ ready: true, name: 'Chrome for Testing 1', path: '/x' }), defaults)).toEqual({
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
  const fakeRun: ModRun = async (command, args) => {
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
const spawnHere: ModHost['spawn'] = async (command, args) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-2000)))
  cleanups.push(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  const proc: ModProcess = {
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
