import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { crc32 } from 'node:zlib'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import type { ModRun, ModSession } from '@hotrod/mod-api'
import { startCore } from '@hotrod/core/main'
import type { Adapter, SessionOptions } from '@hotrod/core/shared'
import { sandboxingMachine } from '@hotrod/core/test-machine'
import browser from './index.ts'

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
  expect(await browser.setup!.check(run)).toEqual({ ready: false, message: 'Browser not installed' })
  const reports: { text?: string; progress?: number }[] = []
  await browser.setup!.install(run, (update) => reports.push(update))
  expect(reports).toContainEqual({ text: expect.stringMatching(/^Downloading Chrome for Testing .*100%/), progress: 1 })
  expect(await browser.setup!.check(run)).toEqual({ ready: true, message: expect.stringMatching(/ installed$/) })
  expect(existsSync(other)).toBe(true)
}, 60_000)

it("fails with the installer's error", async () => {
  downloads.failing = true
  try {
    await expect(browser.setup!.install(run, () => {})).rejects.toThrow(/404/)
    expect((await browser.setup!.check(run)).ready).toBe(false)
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
