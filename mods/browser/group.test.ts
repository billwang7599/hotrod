import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterAll, expect, it } from 'vitest'
import { EXTENSION_DIR, GROUP_NAME, renameClient, windowArgs, windowConfig } from './group.ts'
import browser, { WINDOW } from './index.ts'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
const GROUP = join(import.meta.dirname, 'group.ts')
const defaults = Object.fromEntries(browser.settings!.map((setting) => [setting.key, setting.default]))
const space = { id: 'abc', name: 'Space', engine: 'claude-code' }
const argsFor = (mode: string, chat: object = space) =>
  browser.mcpServers!({ chat: chat as never, workDir: '/work/abc', sandboxed: true, values: { ...defaults, browser: mode } })[0]!
    .args!

it('names the MCP client Kothar in the initialize request only, so the Playwright Extension groups as Kothar', () => {
  const init = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { clientInfo: { name: 'claude-code', version: '2' } } }
  expect(JSON.parse(renameClient(JSON.stringify(init)))).toEqual({
    ...init,
    params: { clientInfo: { name: GROUP_NAME, version: '2' } },
  })
  const call = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'initialize' } })
  expect(renameClient(call)).toBe(call)
  expect(renameClient('{"method":"initialize"')).toBe('{"method":"initialize"')
})

it('runs Your Chrome through group.ts, and Kothar’s Chromium in a window with the grouping extension', () => {
  const chrome = argsFor('chrome')
  expect(chrome.slice(0, 2)).toEqual([GROUP, 'name'])
  expect(chrome).toContain('--extension')
  const window = argsFor(WINDOW)
  expect(window.slice(0, 3)).toEqual([GROUP, 'window', '/work/abc/.browser'])
  expect(argsFor(WINDOW, { ...space, id: 'def', worker: true })).toContain('--isolated')
  // Headless, logins and the debugging port have no group.
  for (const mode of ['background', 'logins', 'attach']) expect(argsFor(mode)).not.toContain(GROUP)
  expect(windowConfig('/x').browser.launchOptions).toEqual({
    args: ['--disable-extensions-except=/x', '--load-extension=/x'],
    ignoreDefaultArgs: ['--disable-extensions'],
  })
})

it("gives a worker in a window a profile of its own on disk, since Chromium loads no extension into --isolated", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-group-')))
  dirs.push(dir)
  expect(windowArgs(dir, ['--browser', 'chromium', '--user-data-dir', '/p'])).toEqual({
    args: ['--browser', 'chromium', '--user-data-dir', '/p'],
  })
  const { args, temporary } = windowArgs(dir, ['--browser', 'chromium', '--isolated'])
  expect(temporary).toMatch(new RegExp(`^${dir}/worker-`))
  expect(args).toEqual(['--browser', 'chromium', '--user-data-dir', temporary])
})

it('group.ts name passes every message through to Playwright MCP, and its replies back, with the client renamed', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-group-')))
  dirs.push(dir)
  // Stands in for Playwright MCP: echoes each line it reads.
  const cli = join(dir, 'cli.js')
  writeFileSync(cli, "process.stdin.pipe(process.stdout)")
  const child = spawn(process.execPath, [GROUP, 'name', cli], { stdio: ['pipe', 'pipe', 'inherit'] })
  let out = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk))
  const init = JSON.stringify({ id: 0, method: 'initialize', params: { clientInfo: { name: 'pi' } } })
  // Split mid-line, and a later initialize-looking line stays as it is.
  child.stdin.write(init.slice(0, 10))
  child.stdin.write(init.slice(10) + '\n{"id":1,"method":"initialize","params":{"clientInfo":{"name":"x"}}}\n')
  child.stdin.end('{"id":2}\n')
  const code = await new Promise((resolve) => child.on('exit', resolve))
  expect(code).toBe(0)
  expect(out.split('\n').filter(Boolean).map((line) => JSON.parse(line))).toEqual([
    { id: 0, method: 'initialize', params: { clientInfo: { name: 'Kothar' } } },
    { id: 1, method: 'initialize', params: { clientInfo: { name: 'x' } } },
    { id: 2 },
  ])
})

// A small stand-in for Chrome's tabs, windows and tabGroups APIs.
function fakeChrome() {
  const NONE = -1
  const tabs = new Map<number, { id: number; windowId: number; groupId: number; pinned: boolean }>()
  const groups = new Map<number, { id: number; windowId: number; title?: string; color?: string }>()
  const windows: Record<number, string> = { 1: 'normal', 2: 'normal', 3: 'popup' }
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {}
  const on = (name: string) => ({ addListener: (fn: (...args: unknown[]) => void) => (listeners[name] ??= []).push(fn) })
  let nextGroup = 100
  const chrome = {
    tabGroups: {
      TAB_GROUP_ID_NONE: NONE,
      query: async ({ windowId, title }: { windowId: number; title: string }) =>
        [...groups.values()].filter((g) => g.windowId === windowId && g.title === title),
      update: async (id: number, props: object) => Object.assign(groups.get(id)!, props),
    },
    windows: { get: async (id: number) => ({ id, type: windows[id] }) },
    tabs: {
      onCreated: on('created'),
      onAttached: on('attached'),
      onUpdated: on('updated'),
      get: async (id: number) => ({ ...tabs.get(id)! }),
      query: async () => [...tabs.values()].map((t) => ({ ...t })),
      group: async ({ groupId, tabIds, createProperties }: { groupId?: number; tabIds: number; createProperties?: { windowId: number } }) => {
        if (windows[tabs.get(tabIds)!.windowId] !== 'normal') throw new Error('Tabs can only be grouped in normal windows')
        const id = groupId ?? nextGroup++
        if (!groups.has(id)) groups.set(id, { id, windowId: createProperties!.windowId })
        tabs.get(tabIds)!.groupId = id
        return id
      },
    },
  }
  const open = (id: number, windowId: number, pinned = false) => {
    tabs.set(id, { id, windowId, groupId: NONE, pinned })
    for (const fn of listeners.created ?? []) fn({ ...tabs.get(id)! })
  }
  return { chrome, tabs, groups, open }
}

it('the extension puts every tab of a normal window in one blue Kothar group per window, and leaves popups and pins', async () => {
  const fake = fakeChrome()
  fake.tabs.set(1, { id: 1, windowId: 1, groupId: -1, pinned: false })
  const manifest = JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8'))
  expect(manifest).toMatchObject({ manifest_version: 3, permissions: ['tabGroups'] })
  runInNewContext(readFileSync(join(EXTENSION_DIR, manifest.background.service_worker), 'utf8'), { chrome: fake.chrome })
  fake.open(2, 1)
  fake.open(3, 1)
  fake.open(4, 2)
  fake.open(5, 3)
  fake.open(6, 1, true)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const groups = [...fake.groups.values()]
  expect(groups).toEqual([
    { id: 100, windowId: 1, title: 'Kothar', color: 'blue', collapsed: false },
    { id: 101, windowId: 2, title: 'Kothar', color: 'blue', collapsed: false },
  ])
  expect([1, 2, 3, 4, 5, 6].map((id) => fake.tabs.get(id)!.groupId)).toEqual([100, 100, 100, 101, -1, -1])
})
