// The installed browsers Kothar's own profile can run on, and what it tells about them.
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export type BrowserApp = {
  id: string
  name: string
  // The app bundle, and its binary inside.
  app: string
  binary: string
}

export const BROWSER_APPS: BrowserApp[] = [
  { id: 'chrome', name: 'Chrome', app: 'Google Chrome.app', binary: 'Google Chrome' },
  { id: 'chrome-beta', name: 'Chrome Beta', app: 'Google Chrome Beta.app', binary: 'Google Chrome Beta' },
  { id: 'chrome-canary', name: 'Chrome Canary', app: 'Google Chrome Canary.app', binary: 'Google Chrome Canary' },
  { id: 'brave', name: 'Brave', app: 'Brave Browser.app', binary: 'Brave Browser' },
  { id: 'edge', name: 'Edge', app: 'Microsoft Edge.app', binary: 'Microsoft Edge' },
  { id: 'arc', name: 'Arc', app: 'Arc.app', binary: 'Arc' },
  { id: 'chromium', name: 'Chromium', app: 'Chromium.app', binary: 'Chromium' },
]

// Where to look, for tests.
export type Places = { home: string; apps: string[]; bins?: string[] }
export const defaultPlaces = (): Places => ({ home: homedir(), apps: ['/Applications', join(homedir(), 'Applications')] })

export const KOTHAR_PROFILE = 'kothar'

export function executableOf(app: BrowserApp, places: Places) {
  for (const root of places.apps) {
    const path = join(root, app.app, 'Contents', 'MacOS', app.binary)
    if (existsSync(path)) return path
  }
}

// The installed browser agents' browsers run on, for Kothar's own profile: Google Chrome first (then its Beta and
// Canary), else Edge, Brave, Arc or Chromium, whichever is found first. On macOS from the app folders; elsewhere the
// usual install paths, Chrome's first. `places.bins` overrides those paths, for tests. id: the BROWSER_APPS id, which
// names its profile folders, since a profile one browser last opened may not open in another.
export type InstalledBrowser = { id: string; name: string; executable: string }
export const BROWSER_ORDER = ['chrome', 'chrome-beta', 'chrome-canary', 'edge', 'brave', 'arc', 'chromium']
const NAMES: Record<string, string> = { chrome: 'Google Chrome', 'chrome-beta': 'Google Chrome Beta', 'chrome-canary': 'Google Chrome Canary' }
const PROGRAMS = process.env.PROGRAMFILES ?? 'C:\\Program Files'
const PROGRAMS_X86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'
const LOCAL = process.env.LOCALAPPDATA ?? ''
const BROWSER_PATHS: Partial<Record<NodeJS.Platform, [string, string][]>> = {
  linux: [
    ['chrome', '/usr/bin/google-chrome'],
    ['chrome', '/usr/bin/google-chrome-stable'],
    ['chrome', '/opt/google/chrome/chrome'],
    ['chrome-beta', '/usr/bin/google-chrome-beta'],
    ['edge', '/usr/bin/microsoft-edge'],
    ['brave', '/usr/bin/brave-browser'],
    ['chromium', '/usr/bin/chromium'],
    ['chromium', '/usr/bin/chromium-browser'],
  ],
  win32: [
    ['chrome', `${PROGRAMS}\\Google\\Chrome\\Application\\chrome.exe`],
    ['chrome', `${PROGRAMS_X86}\\Google\\Chrome\\Application\\chrome.exe`],
    ['chrome', `${LOCAL}\\Google\\Chrome\\Application\\chrome.exe`],
    ['edge', `${PROGRAMS_X86}\\Microsoft\\Edge\\Application\\msedge.exe`],
    ['edge', `${PROGRAMS}\\Microsoft\\Edge\\Application\\msedge.exe`],
    ['brave', `${PROGRAMS}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`],
  ],
}
export function findBrowser(places: Places = defaultPlaces(), platform: NodeJS.Platform = process.platform): InstalledBrowser | undefined {
  const named = (id: string, executable: string) => ({ id, name: NAMES[id] ?? BROWSER_APPS.find((a) => a.id === id)!.name, executable })
  if (platform === 'darwin') {
    for (const id of BROWSER_ORDER) {
      const executable = executableOf(BROWSER_APPS.find((a) => a.id === id)!, places)
      if (executable) return named(id, executable)
    }
    return undefined
  }
  if (places.bins) {
    const executable = places.bins.find((path) => existsSync(path))
    return executable ? named('chrome', executable) : undefined
  }
  const found = (BROWSER_PATHS[platform] ?? []).find(([, path]) => existsSync(path))
  return found ? named(found[0], found[1]) : undefined
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
