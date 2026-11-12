// The browser profiles agents can browse with: Kothar's own (a profile per space that starts empty), or a copy of one
// of the user's Chromium-family browser profiles, so agents are logged in where the user is.
//
// A user's profile is never used in place. Chrome 136 and later refuse remote debugging on their default data folder,
// and a browser locks its profile while it runs, so the agent's browser runs on a mirror instead: a data folder of
// Kothar's own per space, holding a copy of the profile's login state (cookies, site storage, saved passwords), made
// again from the source each time the agent's browser starts. Everything here only reads the source.
//
// On macOS a Chromium browser encrypts cookies and passwords with a key in the login Keychain ("Chrome Safe Storage"
// and the like), which only that browser's own app may read without asking. So the mirror runs on the source browser's
// own binary, with the real Keychain: it decrypts the copy as the user's browser does, without a prompt.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

export type BrowserApp = {
  id: string
  name: string
  // The app bundle, and its binary inside.
  app: string
  binary: string
  // The browser's data folder, under ~/Library/Application Support.
  data: string
}

export const BROWSER_APPS: BrowserApp[] = [
  { id: 'chrome', name: 'Chrome', app: 'Google Chrome.app', binary: 'Google Chrome', data: 'Google/Chrome' },
  { id: 'chrome-beta', name: 'Chrome Beta', app: 'Google Chrome Beta.app', binary: 'Google Chrome Beta', data: 'Google/Chrome Beta' },
  { id: 'chrome-canary', name: 'Chrome Canary', app: 'Google Chrome Canary.app', binary: 'Google Chrome Canary', data: 'Google/Chrome Canary' },
  { id: 'brave', name: 'Brave', app: 'Brave Browser.app', binary: 'Brave Browser', data: 'BraveSoftware/Brave-Browser' },
  { id: 'edge', name: 'Edge', app: 'Microsoft Edge.app', binary: 'Microsoft Edge', data: 'Microsoft Edge' },
  { id: 'arc', name: 'Arc', app: 'Arc.app', binary: 'Arc', data: 'Arc/User Data' },
  { id: 'chromium', name: 'Chromium', app: 'Chromium.app', binary: 'Chromium', data: 'Chromium' },
]

// Where to look, for tests.
export type Places = { home: string; apps: string[]; bins?: string[] }
export const defaultPlaces = (): Places => ({ home: homedir(), apps: ['/Applications', join(homedir(), 'Applications')] })

// A profile of an installed browser. key is what the setting saves: "<browser id>:<profile folder name>".
export type BrowserProfile = { key: string; app: BrowserApp; executable: string; dir: string; name: string; email?: string }

export const KOTHAR_PROFILE = 'kothar'
export const FOLDER_PROFILE = 'folder'

export function executableOf(app: BrowserApp, places: Places) {
  for (const root of places.apps) {
    const path = join(root, app.app, 'Contents', 'MacOS', app.binary)
    if (existsSync(path)) return path
  }
}

// The installed Google Chrome agents' browsers run on, when the setting picks it: on macOS the first of Chrome, Chrome
// Beta and Chrome Canary found in the app folders; elsewhere the usual install paths. `places.bins` overrides those
// paths, for tests.
export type InstalledChrome = { name: string; executable: string }
const CHROME_IDS = ['chrome', 'chrome-beta', 'chrome-canary']
const CHROME_PATHS: Partial<Record<NodeJS.Platform, string[]>> = {
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/google-chrome-beta'],
  win32: [
    `${process.env.PROGRAMFILES ?? 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
}
export function findChrome(places: Places = defaultPlaces(), platform: NodeJS.Platform = process.platform): InstalledChrome | undefined {
  if (platform === 'darwin') {
    for (const app of BROWSER_APPS.filter((a) => CHROME_IDS.includes(a.id))) {
      const executable = executableOf(app, places)
      if (executable) return { name: `Google ${app.name}`, executable }
    }
    return undefined
  }
  const executable = (places.bins ?? CHROME_PATHS[platform] ?? []).find((path) => existsSync(path))
  return executable ? { name: 'Google Chrome', executable } : undefined
}

// Every profile of every installed Chromium-family browser, from its Local State (profile.info_cache), in the
// browser's own order.
export function detectProfiles(places: Places = defaultPlaces()): BrowserProfile[] {
  const found: BrowserProfile[] = []
  for (const app of BROWSER_APPS) {
    const executable = executableOf(app, places)
    if (!executable) continue
    const data = join(places.home, 'Library', 'Application Support', app.data)
    let cache: Record<string, { name?: string; user_name?: string; gaia_name?: string }>
    let order: string[] = []
    try {
      const state = JSON.parse(readFileSync(join(data, 'Local State'), 'utf8'))
      cache = state?.profile?.info_cache ?? {}
      order = Array.isArray(state?.profile?.profiles_order) ? state.profile.profiles_order : []
    } catch {
      continue
    }
    const names = [...new Set([...order, ...Object.keys(cache)])].filter((name) => cache[name])
    for (const name of names) {
      const info = cache[name]!
      const dir = join(data, name)
      if (!existsSync(dir)) continue
      found.push({
        key: `${app.id}:${name}`,
        app,
        executable,
        dir,
        name: info.name || name,
        ...(info.user_name && { email: info.user_name }),
      })
    }
  }
  return found
}

export const profileLabel = (profile: BrowserProfile) =>
  `${profile.app.name}: ${profile.name}${profile.email ? ` (${profile.email})` : ''}`

// What a folder the user named holds: a profile folder (with Cookies or Preferences), or a browser's whole data folder
// (with Local State), whose Default profile is used. Its browser is the installed one whose data folder it's in, if
// any.
export function folderProfile(folder: string, places: Places = defaultPlaces()): Omit<BrowserProfile, 'key'> | string {
  const path = resolve(folder.replace(/^~(?=$|\/)/, places.home))
  if (!folder.trim()) return 'No folder given'
  if (!existsSync(path)) return `${path} doesn't exist`
  const dir = existsSync(join(path, 'Local State')) && existsSync(join(path, 'Default')) ? join(path, 'Default') : path
  if (!['Cookies', 'Network/Cookies', 'Preferences'].some((name) => existsSync(join(dir, name)))) {
    return `${dir} isn't a browser profile (no Cookies or Preferences in it)`
  }
  for (const app of BROWSER_APPS) {
    const data = join(places.home, 'Library', 'Application Support', app.data)
    const executable = executableOf(app, places)
    if (executable && inside(dir, data)) return { app, executable, dir, name: dir.split(sep).at(-1)! }
  }
  return `${dir} isn't in the data folder of an installed Chrome, Brave, Edge, Arc or Chromium`
}

const inside = (path: string, folder: string) => {
  const rel = relative(folder, path)
  return !!rel && !rel.startsWith('..') && !rel.startsWith(sep)
}

// The login state a mirror copies, relative to the profile folder. SQLite files go with their journals, so the copy
// is consistent. Not copied: Preferences and Secure Preferences (startup pages, extensions and the browser's own
// sign-in, which an agent's browser shouldn't take on; Secure Preferences is signed for its own folder, so Chrome would
// reset it anyway), history, bookmarks, extensions and caches.
export const LOGIN_FILES = [
  'Cookies',
  'Network/Cookies',
  'Extension Cookies',
  'Login Data',
  'Login Data For Account',
  'Web Data',
  'Account Web Data',
]
export const LOGIN_FOLDERS = ['Local Storage', 'IndexedDB', 'Session Storage', 'WebStorage']
const SQLITE_SIDES = ['-journal', '-wal', '-shm']
// A browser holds these while it runs; a copy mustn't.
const SKIP = new Set(['LOCK', 'SingletonLock', 'SingletonSocket', 'SingletonCookie'])
// One site's IndexedDB can be huge (offline mail, chat apps); bigger ones are left out of the copy.
export const MAX_ORIGIN_BYTES = 200 * 1024 * 1024

export const MIRROR_FILE = 'kothar-mirror.json'
export type MirrorInfo = { source: string; copiedAt: number; skipped: string[] }

export const readMirror = (mirror: string): MirrorInfo | undefined => {
  try {
    return JSON.parse(readFileSync(join(mirror, MIRROR_FILE), 'utf8'))
  } catch {
    return undefined
  }
}

const sizeOf = (path: string): number => {
  const stat = lstatSync(path)
  if (!stat.isDirectory()) return stat.size
  let total = 0
  for (const name of readdirSync(path)) total += sizeOf(join(path, name))
  return total
}

const stamp = (path: string) => {
  try {
    const stat = statSync(path)
    return `${stat.size}:${stat.mtimeMs}`
  } catch {
    return '-'
  }
}

// Copies a SQLite file with its journals, again if the browser wrote to it meanwhile (up to a few tries).
function copySqlite(from: string, to: string) {
  const parts = ['', ...SQLITE_SIDES]
  for (let attempt = 0; attempt < 4; attempt++) {
    const before = parts.map((side) => stamp(from + side)).join('|')
    for (const side of parts) {
      rmSync(to + side, { force: true })
      if (existsSync(from + side)) copyFileSync(from + side, to + side)
    }
    if (parts.map((side) => stamp(from + side)).join('|') === before) return
  }
}

// Copies a folder (a LevelDB, or IndexedDB's folders of them), leaving out lock files and, in IndexedDB, any one
// site's data past MAX_ORIGIN_BYTES. Returns what it left out.
function copyFolder(from: string, to: string, limitEach: number | undefined): string[] {
  const skipped: string[] = []
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) {
    if (SKIP.has(name)) continue
    const source = join(from, name)
    const stat = lstatSync(source)
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      if (limitEach !== undefined && sizeOf(source) > limitEach) {
        skipped.push(name)
        continue
      }
      skipped.push(...copyFolder(source, join(to, name), undefined))
    } else if (stat.isFile()) {
      copyFileSync(source, join(to, name))
    }
  }
  return skipped
}

// Makes `mirror` (a browser data folder of Kothar's own) hold a fresh copy of the source profile's login state, as
// its Default profile. The rest of the mirror (caches, Kothar's own settings for it) stays, unless the mirror was of
// another profile before, in which case it starts over. Only reads the source. Not while a browser runs on the mirror.
export function mirrorProfile(
  source: string,
  mirror: string,
  { now = Date.now(), maxOriginBytes = MAX_ORIGIN_BYTES }: { now?: number; maxOriginBytes?: number } = {},
): MirrorInfo {
  const from = resolve(source)
  const to = resolve(mirror)
  if (from === to || inside(to, from) || inside(from, to)) throw new Error('A mirror must be outside its source')
  if (readMirror(to)?.source !== from) rmSync(to, { recursive: true, force: true })
  const profile = join(to, 'Default')
  mkdirSync(join(profile, 'Network'), { recursive: true })
  for (const name of LOGIN_FILES) {
    for (const side of ['', ...SQLITE_SIDES]) rmSync(join(profile, name + side), { force: true })
    if (existsSync(join(from, name))) copySqlite(join(from, name), join(profile, name))
  }
  const skipped: string[] = []
  for (const name of LOGIN_FOLDERS) {
    // Into a new folder, then swapped in, so a copy that fails partway leaves the last good one.
    const target = join(profile, name)
    const next = `${target}.kothar-new`
    rmSync(next, { recursive: true, force: true })
    if (!existsSync(join(from, name))) {
      rmSync(target, { recursive: true, force: true })
      continue
    }
    const limit = name === 'IndexedDB' ? maxOriginBytes : undefined
    skipped.push(...copyFolder(join(from, name), next, limit).map((s) => `${name}/${s}`))
    rmSync(target, { recursive: true, force: true })
    renameSync(next, target)
  }
  const info: MirrorInfo = { source: from, copiedAt: now, skipped }
  writeFileSync(join(to, MIRROR_FILE), JSON.stringify(info, null, 2))
  return info
}

// The Chromium major version of a browser binary, from its framework's version folder
// (<App>.app/Contents/Frameworks/<Name> Framework.framework/Versions/<version>), for a user agent that doesn't say
// HeadlessChrome. Undefined if it can't tell.
export function chromiumMajor(executable: string): number | undefined {
  const contents = resolve(executable, '..', '..')
  try {
    const frameworks = join(contents, 'Frameworks')
    const framework = readdirSync(frameworks).find((name) => name.endsWith(' Framework.framework'))
    if (!framework) return undefined
    const versions = readdirSync(join(frameworks, framework, 'Versions')).filter((name) => /^\d+\./.test(name))
    const majors = versions.map((name) => Number(name.split('.')[0])).filter((n) => n > 0)
    return majors.length ? Math.max(...majors) : undefined
  } catch {
    return undefined
  }
}

// The user agent Chrome shows in a window on macOS, for a headless browser to send instead of HeadlessChrome's, which
// some sites turn away.
export const windowUserAgent = (major: number) =>
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
