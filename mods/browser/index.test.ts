import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { crc32 } from 'node:zlib'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { ModRun, ModSession } from '@hotrod/mod-api'
import { startCore } from '@hotrod/core/main'
import type { Adapter, SessionOptions } from '@hotrod/core/shared'
import { sandboxingMachine } from '@hotrod/core/test-machine'
import browser, { EXTENSION_URL } from './index.ts'

const dirs: string[] = []
const tempDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}
let browsers = ''
beforeEach(() => {
  browsers = tempDir('hotrod-browsers-')
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsers
})
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  delete process.env.PLAYWRIGHT_BROWSERS_PATH
  delete process.env.PLAYWRIGHT_DOWNLOAD_HOST
})

const run: ModRun = (command, args, options = {}) => sandboxingMachine.run(command, args, { cwd: '/', ...options })
const defaults = Object.fromEntries(browser.settings!.map((setting) => [setting.key, setting.default]))
const space = { id: 'abc', name: 'Space', engine: 'claude-code' }
const serverFor = (session: Partial<ModSession> = {}) =>
  browser.mcpServers!({ chat: space, workDir: '/work/abc', sandboxed: true, values: defaults, ...session })[0]!
const valueAfter = (args: string[] = [], flag: string) =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined

it("runs Playwright MCP headless on Playwright's Chromium, with the space's own profile in its work folder", () => {
  const { name, command, args, env, allowTools } = serverFor()
  expect({ name, command, allowTools }).toEqual({ name: 'browser', command: process.execPath, allowTools: true })
  expect(existsSync(args![0]!)).toBe(true)
  expect(args).toContain('--headless')
  expect(valueAfter(args, '--browser')).toBe('chromium')
  expect(valueAfter(args, '--user-data-dir')).toBe('/work/abc/.browser/profile')
  expect(valueAfter(args, '--output-dir')).toBe('/work/abc/.browser/output')
  expect(args).toContain('--no-sandbox')
  expect(env).toEqual({
    ELECTRON_RUN_AS_NODE: '1',
    TMPDIR: tmpdir(),
    PWTEST_SERVER_REGISTRY: join(tmpdir(), 'hotrod-browser-registry'),
    PLAYWRIGHT_BROWSERS_PATH: browsers,
  })
})

it("shows a window, asks before each action, keeps a subagent's profile in memory, as set", () => {
  expect(serverFor({ values: { ...defaults, background: false } }).args).not.toContain('--headless')
  expect(serverFor({ values: { ...defaults, askEachAction: true } }).allowTools).toBe(false)
  const subagent = serverFor({ chat: { ...space, id: 'def', parentId: 'abc', subagent: true } }).args
  expect(subagent).toContain('--isolated')
  expect(subagent).not.toContain('--user-data-dir')
  expect(serverFor({ sandboxed: false }).args).not.toContain('--no-sandbox')
})

const chrome = { ...defaults, browser: 'chrome' }

it("connects to your running Chrome through the Playwright Extension, with its token, and nothing of Hotrod's Chromium", () => {
  const { args, env, allowTools } = serverFor({ values: { ...chrome, extensionToken: ' abc123 ' } })
  expect(allowTools).toBe(true)
  expect(args).toContain('--extension')
  expect(valueAfter(args, '--browser')).toBe('chrome')
  expect(valueAfter(args, '--output-dir')).toBe('/work/abc/.browser/output')
  for (const flag of ['--headless', '--user-data-dir', '--isolated', '--no-sandbox']) expect(args).not.toContain(flag)
  expect(env).toEqual({
    ELECTRON_RUN_AS_NODE: '1',
    TMPDIR: tmpdir(),
    PWTEST_SERVER_REGISTRY: join(tmpdir(), 'hotrod-browser-registry'),
    PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'abc123',
  })
  expect(serverFor({ values: chrome }).env).not.toHaveProperty('PLAYWRIGHT_MCP_EXTENSION_TOKEN')
})

it("gives a subagent the same Chrome as its space, since the extension takes a connection per session", () => {
  const subagent = { ...space, id: 'def', parentId: 'abc', subagent: true }
  expect(serverFor({ chat: subagent, values: chrome }).args).toEqual(serverFor({ values: chrome }).args)
})

const fakeRun = (...results: object[]) => {
  const calls: string[][] = []
  const run: ModRun = async (_command, args) => {
    calls.push(args)
    // Opening Chrome prints nothing; every other run is the check.
    if (args[1]!.includes('child_process')) return { code: 0, stdout: '', stderr: '' }
    return { code: 0, stdout: JSON.stringify(results.length > 1 ? results.shift() : results[0]), stderr: '' }
  }
  return { run, calls }
}
const found = { chrome: true, executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }

it('is ready with your Chrome once Chrome has the Playwright Extension', async () => {
  const check = (result: object) => browser.setup!.check(fakeRun(result).run, chrome)
  expect(await check({ chrome: false, executable: null, profile: null })).toEqual({
    ready: false,
    message: 'Google Chrome not found',
  })
  expect(await check({ ...found, profile: null })).toEqual({
    ready: false,
    message: 'The Playwright Extension isn’t in Chrome',
  })
  expect(await check({ ...found, profile: 'Profile 1' })).toEqual({
    ready: true,
    message: 'Your Chrome, profile “Profile 1”',
  })
  const failing: ModRun = async () => ({ code: 1, stdout: '', stderr: 'boom' })
  await expect(browser.setup!.check(failing, chrome)).rejects.toThrow('boom')
  const about = browser.setup!.description
  expect(typeof about === 'function' && about(chrome)).toContain(EXTENSION_URL)
  expect(typeof about === 'function' && about(defaults)).toContain('Chromium')
})

it("finds the extension in Chrome's last used profile that has it, as Playwright does", async () => {
  if (process.platform === 'win32') return
  const home = tempDir('hotrod-chrome-home-')
  const dataDir =
    process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'Google', 'Chrome')
      : join(home, '.config', 'google-chrome')
  const id = EXTENSION_URL.split('/').at(-1)!
  mkdirSync(join(dataDir, 'Profile 1', 'Extensions', id), { recursive: true })
  mkdirSync(join(dataDir, 'Profile 2'), { recursive: true })
  mkdirSync(join(dataDir, 'Default'), { recursive: true })
  const prefs = { extensions: { settings: { [id]: { state: 1 } } } }
  writeFileSync(join(dataDir, 'Profile 2', 'Secure Preferences'), JSON.stringify(prefs))
  const atHome: ModRun = (command, args, options = {}) =>
    run(command, args, { ...options, env: { ...options.env, HOME: home } })
  const { message } = await browser.setup!.check(atHome, chrome)
  // Chrome itself may or may not be installed where the tests run.
  if (message !== 'Google Chrome not found') expect(message).toBe('Your Chrome, profile “Profile 1”')
  writeFileSync(join(dataDir, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 2' } }))
  const again = await browser.setup!.check(atHome, chrome)
  if (again.message !== 'Google Chrome not found') expect(again.message).toBe('Your Chrome, profile “Profile 2”')
  rmSync(join(dataDir, 'Profile 1', 'Extensions'), { recursive: true })
  rmSync(join(dataDir, 'Profile 2', 'Secure Preferences'))
  const none = await browser.setup!.check(atHome, chrome)
  expect(none.ready).toBe(false)
})

it("opens the extension's store page in Chrome and waits until Chrome has it", async () => {
  vi.useFakeTimers()
  try {
    const missing = { ...found, profile: null }
    const { run, calls } = fakeRun(missing, missing, { ...found, profile: 'Default' })
    const reports: { text?: string }[] = []
    const installing = browser.setup!.install(run, (update) => reports.push(update), chrome)
    await vi.advanceTimersByTimeAsync(5_000)
    await installing
    expect(calls).toHaveLength(4)
    expect(calls[1]!.slice(2)).toEqual([found.executable, EXTENSION_URL])
    expect(reports).toEqual([{ text: 'Add the Playwright Extension in the Chrome window that opened…' }])
  } finally {
    vi.useRealTimers()
  }
  const missing = fakeRun({ chrome: false, executable: null, profile: null })
  await expect(browser.setup!.install(missing.run, () => {}, chrome)).rejects.toThrow('Install Google Chrome first')
  expect(missing.calls).toHaveLength(1)
  const already = fakeRun({ ...found, profile: 'Default' })
  await browser.setup!.install(already.run, () => {}, chrome)
  expect(already.calls).toHaveLength(1)
})

const require = createRequire(import.meta.url)
const executableIn = (name: string) => {
  const { registry } = require('playwright-core/lib/coreBundle')
  const executable = registry.registry.findExecutable(name)
  return relative(executable.directory, executable.executablePath())
}

function zipOf(name: string) {
  const data = Buffer.from('#!/bin/sh\n')
  const path = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt32LE(crc32(data), 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(path.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  local.copy(central, 16, 14, 26)
  central.writeUInt16LE(path.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + path.length, 12)
  end.writeUInt32LE(local.length + path.length + data.length, 16)
  return Buffer.concat([local, path, data, central, path, end])
}

const downloads = { failing: false }
const mirror = createServer((request, response) => {
  if (downloads.failing) return response.writeHead(404).end('No such build')
  const body = zipOf(executableIn(request.url!.includes('ffmpeg') ? 'ffmpeg' : 'chromium'))
  response.writeHead(200, { 'content-length': body.length }).end(body)
})
beforeAll(async () => {
  await new Promise<void>((resolve) => mirror.listen(0, '127.0.0.1', resolve))
  const address = mirror.address()
  if (typeof address === 'object' && address) process.env.PLAYWRIGHT_DOWNLOAD_HOST = `http://127.0.0.1:${address.port}`
})
afterAll(() => new Promise<void>((resolve) => mirror.close(() => resolve())))

it("installs Chromium with Playwright's installer, reporting progress, and never removes other browsers", async () => {
  const other = join(browsers, 'chromium-1000', 'INSTALLATION_COMPLETE')
  mkdirSync(dirname(other))
  writeFileSync(other, '')
  expect(await browser.setup!.check(run, defaults)).toEqual({ ready: false, message: 'Browser not installed' })
  const reports: { text?: string; progress?: number }[] = []
  await browser.setup!.install(run, (update) => reports.push(update), defaults)
  expect(reports).toContainEqual({ text: expect.stringMatching(/^Downloading Chrome for Testing .*100%/), progress: 1 })
  expect(await browser.setup!.check(run, defaults)).toEqual({ ready: true, message: expect.stringMatching(/ installed$/) })
  expect(existsSync(other)).toBe(true)
}, 60_000)

it("fails with the installer's error", async () => {
  downloads.failing = true
  try {
    await expect(browser.setup!.install(run, () => {}, defaults)).rejects.toThrow(/404/)
    expect((await browser.setup!.check(run, defaults)).ready).toBe(false)
  } finally {
    downloads.failing = false
  }
}, 60_000)

function fakeInstall() {
  const { registry } = require('playwright-core/lib/coreBundle')
  const executable = registry.registry.findExecutable('chromium')
  const directory = join(browsers, relative(registry.registryDirectory, executable.directory))
  mkdirSync(dirname(join(directory, executableIn('chromium'))), { recursive: true })
  writeFileSync(join(directory, executableIn('chromium')), '')
  writeFileSync(join(directory, 'INSTALLATION_COMPLETE'), '')
}

it('offers the browser once it is installed, and only to engines that take MCP servers', async () => {
  const garage = tempDir('hotrod-browser-garage-')
  const sessions: SessionOptions[] = []
  const engine = (id: string, hotrodMcp: boolean): Adapter => ({
    id,
    hotrodMcp,
    detect: async () => ({ installed: true, signedIn: true }),
    start(_machine, options, emit) {
      sessions.push(options)
      return {
        prompt() {
          emit({ type: 'turn.started' })
          emit({ type: 'turn.completed' })
        },
        interrupt() {},
        respond() {},
        close() {},
      }
    },
  })
  const env = { HOTROD_ENGINE: 'mcp', HOTROD_GARAGE: garage, HOTROD_WORK: join(garage, 'work'), HOTROD_PORT: '0' }
  const adapters = [engine('mcp', true), engine('plain', false)]
  const hotrod = await startCore({ env, adapters, mods: [browser], machine: sandboxingMachine })
  cleanups.push(() => hotrod.close(true))
  const handle = (message: Parameters<typeof hotrod.core.handle>[0]) => hotrod.core.handle(message, () => {})
  const statusOf = () => hotrod.core.mods().find((mod) => mod.id === 'browser')!.setup!.status
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(check()).toBe(true)
  }
  const turn = (engine: string) => {
    handle({ type: 'chat.create', name: engine, engine })
    const { id } = hotrod.core.chats().at(-1)!
    handle({ type: 'chat.send', chatId: id, text: 'Open the page' })
    return { chat: hotrod.core.chats().find((chat) => chat.id === id)!, options: sessions.at(-1)! }
  }

  expect(hotrod.core.mods().find((mod) => mod.id === 'browser')?.enabled).toBe(false)
  handle({ type: 'mod.setEnabled', modId: 'browser', enabled: true })
  await until(() => statusOf() === 'missing')
  expect(turn('mcp').options.mcpServers).toBeUndefined()

  fakeInstall()
  handle({ type: 'mod.setEnabled', modId: 'browser', enabled: true })
  await until(() => statusOf() === 'ready')
  const { chat, options } = turn('mcp')
  expect(options.mcpServers?.map((server) => server.name)).toEqual(['browser'])
  expect(valueAfter(options.mcpServers![0]!.args, '--user-data-dir')).toBe(join(chat.workDir!, '.browser', 'profile'))
  handle({ type: 'engine.setEnabled', engine: 'plain', enabled: true })
  expect(turn('plain').options.mcpServers).toBeUndefined()
}, 30_000)
