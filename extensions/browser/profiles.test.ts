import { spawn } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { FILTER_SCRIPT, HIDDEN_TOOLS } from './mcp-filter.ts'
import {
  chromiumMajor,
  detectProfiles,
  folderProfile,
  MIRROR_FILE,
  mirrorProfile,
  type Places,
  profileLabel,
  readMirror,
  windowUserAgent,
} from './profiles.ts'

const dirs: string[] = []
const tempDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const write = (path: string, text = 'x') => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

// A Mac with Chrome (two profiles) and Brave installed, Edge's data left behind without its app, as the files say.
function fakeMac(): Places & { support: string } {
  const home = tempDir('kothar-home-')
  const apps = join(home, 'Applications')
  const support = join(home, 'Library', 'Application Support')
  write(join(apps, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'))
  mkdirSync(join(apps, 'Google Chrome.app', 'Contents', 'Frameworks', 'Google Chrome Framework.framework', 'Versions', '157.0.8103.39'), { recursive: true })
  write(join(apps, 'Brave Browser.app', 'Contents', 'MacOS', 'Brave Browser'))
  const state = (cache: object, order?: string[]) => JSON.stringify({ profile: { info_cache: cache, ...(order && { profiles_order: order }) } })
  write(
    join(support, 'Google', 'Chrome', 'Local State'),
    state({ Default: { name: 'Person 1', user_name: 'me@example.com' }, 'Profile 2': { name: 'Work' }, Gone: { name: 'Gone' } }, ['Profile 2', 'Default']),
  )
  write(join(support, 'Google', 'Chrome', 'Default', 'Cookies'))
  write(join(support, 'Google', 'Chrome', 'Profile 2', 'Preferences'))
  write(join(support, 'BraveSoftware', 'Brave-Browser', 'Local State'), state({ Default: { name: 'Personal' } }))
  write(join(support, 'BraveSoftware', 'Brave-Browser', 'Default', 'Cookies'))
  write(join(support, 'Microsoft Edge', 'Local State'), state({ Default: { name: 'Edge' } }))
  write(join(support, 'Microsoft Edge', 'Default', 'Cookies'))
  return { home, apps: [join(home, 'Nowhere'), apps], support }
}

it('finds every profile of every installed Chromium browser, in the browser’s own order', () => {
  const mac = fakeMac()
  const found = detectProfiles(mac)
  expect(found.map((p) => [p.key, profileLabel(p)])).toEqual([
    ['chrome:Profile 2', 'Chrome: Work'],
    ['chrome:Default', 'Chrome: Person 1 (me@example.com)'],
    ['brave:Default', 'Brave: Personal'],
  ])
  expect(found[0]!.executable).toBe(join(mac.apps[1]!, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'))
  expect(found[0]!.dir).toBe(join(mac.support, 'Google', 'Chrome', 'Profile 2'))
  expect(chromiumMajor(found[0]!.executable)).toBe(157)
  expect(chromiumMajor(found[2]!.executable)).toBeUndefined()
  expect(windowUserAgent(157)).toContain('Chrome/157.0.0.0 Safari')
  expect(windowUserAgent(157)).not.toContain('Headless')
})

it('takes another folder only if it’s a profile of an installed browser', () => {
  const mac = fakeMac()
  const chrome = join(mac.support, 'Google', 'Chrome')
  expect(folderProfile(join(chrome, 'Profile 2'), mac)).toMatchObject({ dir: join(chrome, 'Profile 2'), app: { id: 'chrome' } })
  // A browser's data folder means its Default profile.
  expect(folderProfile(chrome, mac)).toMatchObject({ dir: join(chrome, 'Default') })
  expect(folderProfile('~/Library/Application Support/BraveSoftware/Brave-Browser/Default', mac)).toMatchObject({ app: { id: 'brave' } })
  expect(folderProfile('', mac)).toBe('No folder given')
  expect(folderProfile(join(mac.home, 'nope'), mac)).toMatch(/doesn't exist$/)
  expect(folderProfile(mac.home, mac)).toMatch(/isn't a browser profile/)
  // Edge's data is there but Edge isn't installed.
  expect(folderProfile(join(mac.support, 'Microsoft Edge', 'Default'), mac)).toMatch(/isn't in the data folder of an installed/)
})

// Every file under a folder with its size, time and content, to show a copy changed nothing.
const snapshotOf = (root: string) => {
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) out[relative(root, path)] = 'link'
      else if (stat.isDirectory()) walk(path)
      else out[relative(root, path)] = `${stat.size}:${stat.mtimeMs}:${readFileSync(path, 'utf8')}`
    }
  }
  walk(root)
  return out
}

it('copies a profile’s login state into a mirror of Kothar’s own, and leaves the source untouched', () => {
  const source = join(tempDir('kothar-source-'), 'Profile 1')
  for (const name of ['Cookies', 'Cookies-journal', 'Login Data', 'Login Data-wal', 'Web Data', 'Network/Cookies', 'Extension Cookies']) {
    write(join(source, name), `${name} v1`)
  }
  write(join(source, 'History'), 'history')
  write(join(source, 'Preferences'), '{"session":{"restore_on_startup":4}}')
  write(join(source, 'Local Storage', 'leveldb', '000003.log'), 'ls')
  write(join(source, 'Local Storage', 'leveldb', 'LOCK'), '')
  write(join(source, 'IndexedDB', 'https_small.example_0.indexeddb.leveldb', '000001.log'), 'small')
  write(join(source, 'IndexedDB', 'https_huge.example_0.indexeddb.leveldb', '000001.log'), 'x'.repeat(5000))
  symlinkSync('/etc', join(source, 'IndexedDB', 'link'))
  const before = snapshotOf(source)

  const mirror = join(tempDir('kothar-mirror-'), 'space')
  const info = mirrorProfile(source, mirror, { now: 1000, maxOriginBytes: 1000 })
  expect(snapshotOf(source)).toEqual(before)
  const copied = join(mirror, 'Default')
  for (const name of ['Cookies', 'Cookies-journal', 'Login Data', 'Login Data-wal', 'Web Data', 'Network/Cookies', 'Extension Cookies']) {
    expect(readFileSync(join(copied, name), 'utf8')).toBe(`${name} v1`)
  }
  expect(readFileSync(join(copied, 'Local Storage', 'leveldb', '000003.log'), 'utf8')).toBe('ls')
  const listed = Object.keys(snapshotOf(copied))
  for (const left of ['History', 'Preferences', 'Local Storage/leveldb/LOCK', 'IndexedDB/link']) expect(listed).not.toContain(left)
  expect(listed).toContain('IndexedDB/https_small.example_0.indexeddb.leveldb/000001.log')
  expect(listed.some((name) => name.includes('huge'))).toBe(false)
  expect(info).toEqual({ source, copiedAt: 1000, skipped: ['IndexedDB/https_huge.example_0.indexeddb.leveldb'] })
  expect(readMirror(mirror)).toEqual(info)

  // Copying again takes what changed, drops a journal that's gone, and keeps the mirror's own files.
  write(join(source, 'Cookies'), 'Cookies v2')
  rmSync(join(source, 'Cookies-journal'))
  rmSync(join(source, 'IndexedDB'), { recursive: true })
  write(join(mirror, 'Default', 'Cache', 'data'), 'cache')
  mirrorProfile(source, mirror, { now: 2000, maxOriginBytes: 1000 })
  expect(readFileSync(join(copied, 'Cookies'), 'utf8')).toBe('Cookies v2')
  expect(Object.keys(snapshotOf(copied))).not.toContain('Cookies-journal')
  expect(Object.keys(snapshotOf(copied)).some((name) => name.startsWith('IndexedDB'))).toBe(false)
  expect(readFileSync(join(copied, 'Cache', 'data'), 'utf8')).toBe('cache')
  expect(readMirror(mirror)?.copiedAt).toBe(2000)

  // A mirror of another profile starts over.
  const other = join(tempDir('kothar-source-'), 'Default')
  write(join(other, 'Cookies'), 'other')
  mirrorProfile(other, mirror)
  expect(Object.keys(snapshotOf(copied)).sort()).toEqual(['Cookies'])
  expect(readMirror(mirror)?.source).toBe(other)
  expect(readdirSync(mirror).sort()).toEqual(['Default', MIRROR_FILE])

  // Never into the source, or around it.
  expect(() => mirrorProfile(source, join(source, 'mirror'))).toThrow('outside its source')
  expect(() => mirrorProfile(source, join(source, '..'))).toThrow('outside its source')
})

// The filter in front of Playwright MCP, with a fake server: hidden tools are left out of tools/list and refused, the
// rest passes both ways untouched.
it('leaves the hidden Playwright tools out of the list and refuses calls to them', async () => {
  const server = `
    let partial = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      const lines = (partial + chunk).split('\\n')
      partial = lines.pop()
      for (const line of lines) {
        const m = JSON.parse(line)
        const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n')
        if (m.method === 'tools/list') reply({ tools: [{ name: 'browser_navigate' }, { name: 'browser_run_code_unsafe' }, { name: 'browser_resize' }] })
        else if (m.method === 'tools/call') reply({ called: m.params.name, text: 'a\\u2028b' })
        else reply({ echo: m.method })
      }
    })
  `
  const child = spawn(process.execPath, ['-e', FILTER_SCRIPT, HIDDEN_TOOLS.join(','), process.execPath, '-e', server], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const replies = new Map<number, Record<string, any>>()
  let partial = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    const lines = (partial + chunk).split('\n')
    partial = lines.pop()!
    for (const line of lines) {
      const message = JSON.parse(line)
      replies.set(message.id, message)
    }
  })
  const call = async (id: number, method: string, params: object = {}) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    for (let waited = 0; !replies.has(id) && waited < 5000; waited += 10) await new Promise((r) => setTimeout(r, 10))
    return replies.get(id)!
  }
  try {
    expect((await call(1, 'initialize')).result).toEqual({ echo: 'initialize' })
    expect((await call(2, 'tools/list')).result.tools).toEqual([{ name: 'browser_navigate' }])
    expect((await call(3, 'tools/call', { name: 'browser_navigate' })).result).toEqual({ called: 'browser_navigate', text: 'a b' })
    const refused = await call(4, 'tools/call', { name: 'browser_run_code_unsafe' })
    expect(refused.error.message).toBe('Tool browser_run_code_unsafe is not available in Kothar')
  } finally {
    child.kill()
  }
})
