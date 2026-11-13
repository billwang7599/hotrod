// Launches a Chromium (the user's installed Google Chrome, Playwright's Chrome for Testing, or the user's own browser on
// a copy of their profile) on a profile of Kothar's own, headless or with a window, through the Machine (host.spawn),
// and finds its DevTools endpoint. Playwright MCP never launches a browser in this extension: it attaches to this one
// over CDP. A plain launch has no DevTools at all: a window for the user to sign in, which sites can't tell from an
// ordinary browser.
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionHost, ExtensionProcess } from '@kothar/extension-api'
import { closeBrowser } from './cdp.ts'
import { chromiumMajor, windowUserAgent } from './profiles.ts'

// executable: the browser to run, if not the launcher's own (a copy of a user's profile runs on its browser's binary).
// keychain 'real': cookies and passwords are encrypted with the browser's key in the macOS Keychain, as the user's own
// browser does, so a copy of a user's profile reads; otherwise a mock keychain keeps macOS from asking. userAgent: sent
// instead of headless Chrome's own. cold: a start from nothing, not a relaunch for a hand-off (a copied profile is
// copied again then). plain: a window with no remote debugging, for signing in (headless is ignored); urls: the tabs
// it opens on. restoreSession: opens the tabs the profile's last browser had, as a plain window leaves them.
export type Launch = {
  profile: string
  headless: boolean
  executable?: string
  keychain?: 'mock' | 'real'
  userAgent?: string
  cold?: boolean
  plain?: boolean
  urls?: string[]
  restoreSession?: boolean
}

// A browser that's running: its DevTools endpoint (http://127.0.0.1:<port>; empty for a plain one), a promise that
// settles when it exits,
// and stop, which asks it to quit and kills it if it won't.
// activate: makes its window the one in front of the user's other apps, as far as macOS lets it.
export type Running = { endpoint: string; exited: Promise<void>; stop(): Promise<void>; activate?(): Promise<void> }

export type Launcher = (launch: Launch) => Promise<Running>

const STARTUP_MS = 20_000
const QUIT_MS = 5_000
// The longest a plain window gets to quit by itself: after a sign-in Chrome writes its cookies, session and account
// before it goes, and a kill partway loses the login.
export const PLAIN_QUIT_MS = 20_000
const POLL_MS = 50

// The flags Kothar's browser runs with. The keychain flags are the same in both modes, so cookies one mode saves the
// other can read: on Kothar's own profile the mock keychain and basic password store keep macOS from asking for the
// Keychain; a copy of a user's profile needs the real one. The disk cache stays in the profile (macOS Chromium
// otherwise puts it in ~/Library/Caches), so it goes with the profile. Never --enable-automation. Headless, also
// AutomationControlled off, so pages don't see navigator.webdriver (headless Chrome sets it otherwise): sites such as
// Google's sign-in refuse a browser that says it's automated. A window doesn't set navigator.webdriver without
// --enable-automation, and that flag would only put Chrome's "unsupported command-line flag" bar on it, so a window
// goes without it. A plain window, for signing in, has no remote debugging at all and is as close as it can be to the
// Chrome the user opens themselves: only the profile, its keychain (so the cookies it saves read in the other modes) and
// no first-run pages. It keeps sync on, as Chrome's own sign-in (Sign in to Chrome) finishes through sync.
export function chromiumArgs(launch: Launch): string[] {
  const { profile, keychain, userAgent, plain } = launch
  const headless = launch.headless && !plain
  return [
    `--user-data-dir=${profile}`,
    `--disk-cache-dir=${profile}/Cache`,
    ...(plain ? [] : ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1']),
    ...(headless ? ['--disable-blink-features=AutomationControlled'] : []),
    '--no-first-run',
    '--no-default-browser-check',
    ...(keychain === 'real' ? [] : ['--use-mock-keychain', '--password-store=basic']),
    '--hide-crash-restore-bubble',
    ...(plain ? [] : ['--disable-sync', '--disable-features=Translate,MediaRouter']),
    ...(headless ? ['--headless', '--hide-scrollbars', '--mute-audio'] : []),
    ...(headless && userAgent ? [`--user-agent=${userAgent}`] : []),
    ...(launch.restoreSession ? ['--restore-last-session'] : []),
    ...(launch.urls?.length ? launch.urls : launch.restoreSession ? [] : ['about:blank']),
  ]
}

// Activates the app with this pid, through AppKit (no Automation permission needed): a browser started from a process
// in the background doesn't always come forward on its own.
export const ACTIVATE_SCRIPT = `function run(argv) {
  ObjC.import('AppKit')
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]))
  if (!app || app.isNil()) return 'gone'
  app.unhide
  return app.activateWithOptions(3) ? 'activated' : 'refused'
}`

// The pid of the browser on a profile, from its SingletonLock ("<host>-<pid>").
export function profilePid(profile: string) {
  try {
    const pid = Number(readlinkSync(join(profile, 'SingletonLock')).split('-').at(-1))
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Chromium locks a profile to one browser (SingletonLock, a link to "<host>-<pid>"). A browser of Kothar's own still
// on it, left by a Kothar that crashed, is asked to go; a lock whose process is gone is removed. Only a process
// running on this very profile is ever signalled.
export async function freeProfile(host: Pick<ExtensionHost, 'run'>, profile: string) {
  const lock = join(profile, 'SingletonLock')
  let target: string
  try {
    target = readlinkSync(lock)
  } catch {
    return
  }
  const pid = Number(target.split('-').at(-1))
  if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
    const { stdout } = await host.run('/bin/ps', ['-o', 'command=', '-p', String(pid)])
    if (stdout.includes(`--user-data-dir=${profile}`)) {
      await host.run('/bin/kill', ['-TERM', String(pid)])
      for (let waited = 0; waited < QUIT_MS && alive(pid); waited += POLL_MS) await sleep(POLL_MS)
      if (alive(pid)) await host.run('/bin/kill', ['-KILL', String(pid)])
      for (let waited = 0; waited < QUIT_MS && alive(pid); waited += POLL_MS) await sleep(POLL_MS)
    }
  }
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) rmSync(join(profile, name), { force: true })
}

// The launcher for a Chromium at `executable`. extraArgs: for tests that run inside a sandbox. plainQuitMs: how long a
// plain window gets to quit by itself (PLAIN_QUIT_MS), shorter in tests.
export function chromiumLauncher(
  host: Pick<ExtensionHost, 'run' | 'spawn'>,
  executable: () => Promise<string>,
  extraArgs: string[] = [],
  plainQuitMs = PLAIN_QUIT_MS,
): Launcher {
  return async (launch) => {
    const path = launch.executable ?? (await executable())
    mkdirSync(launch.profile, { recursive: true })
    await freeProfile(host, launch.profile)
    const portFile = join(launch.profile, 'DevToolsActivePort')
    rmSync(portFile, { force: true })
    // Headless, it says the user agent Chrome says in a window: some sites turn HeadlessChrome away.
    const major = launch.headless && !launch.plain && !launch.userAgent ? chromiumMajor(path) : undefined
    const args = chromiumArgs({ ...launch, ...(major && { userAgent: windowUserAgent(major) }) })
    const proc: ExtensionProcess = await host.spawn(path, [...extraArgs, ...args])
    if (launch.plain) return plainRunning(host, proc, launch, plainQuitMs)
    let gone = false
    let stderr = ''
    const exited = new Promise<void>((resolve) =>
      proc.onExit((_code, tail) => {
        gone = true
        stderr = tail
        resolve()
      }),
    )
    let port: number | undefined
    for (let waited = 0; !port && waited < STARTUP_MS; waited += POLL_MS) {
      if (gone) break
      await sleep(POLL_MS)
      if (existsSync(portFile)) port = Number(readFileSync(portFile, 'utf8').split('\n')[0]) || undefined
    }
    if (!port) {
      proc.stop()
      const why = stderr.trim().split('\n').at(-1)
      throw new Error(`The browser didn't start${why ? `: ${why}` : ''}`)
    }
    const endpoint = `http://127.0.0.1:${port}`
    const pid = profilePid(launch.profile)
    return {
      endpoint,
      exited,
      async activate() {
        if (gone || !pid || launch.headless || process.platform !== 'darwin') return
        await host.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', ACTIVATE_SCRIPT, String(pid)], { timeoutMs: 5000 })
      },
      async stop() {
        if (gone) return
        await closeBrowser(endpoint).catch(() => {})
        await Promise.race([exited, sleep(QUIT_MS)])
        if (!gone) proc.stop()
        await exited
      },
    }
  }
}

// A plain window: no DevTools to ask, so it's up once it has locked its profile. It stops on a SIGTERM to the browser
// process alone, which Chrome takes as a request to quit cleanly: it closes its windows and its helpers itself, with the
// network service, which holds the cookies, flushing them first. Signalling the whole process group at once (what the
// process's own stop does) would take the helpers down under it and can lose the cookies of a login just made; that's
// only the fallback, for a browser that's still there after PLAIN_QUIT_MS or whose pid isn't known.
async function plainRunning(
  host: Pick<ExtensionHost, 'run'>,
  proc: ExtensionProcess,
  launch: Launch,
  quitMs: number,
): Promise<Running> {
  let gone = false
  let stderr = ''
  const exited = new Promise<void>((resolve) =>
    proc.onExit((_code, tail) => {
      gone = true
      stderr = tail
      resolve()
    }),
  )
  for (let waited = 0; !gone && !profilePid(launch.profile) && waited < STARTUP_MS; waited += POLL_MS) await sleep(POLL_MS)
  if (gone || !profilePid(launch.profile)) {
    proc.stop()
    const why = stderr.trim().split('\n').at(-1)
    throw new Error(`The browser didn't start${why ? `: ${why}` : ''}`)
  }
  const pid = profilePid(launch.profile)
  return {
    endpoint: '',
    exited,
    async activate() {
      if (gone || !pid || process.platform !== 'darwin') return
      await host.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', ACTIVATE_SCRIPT, String(pid)], { timeoutMs: 5000 })
    },
    async stop() {
      if (gone) return
      if (pid) {
        await host.run('/bin/kill', ['-TERM', String(pid)], { timeoutMs: 5000 }).catch(() => {})
        await Promise.race([exited, sleep(quitMs)])
      }
      if (!gone) proc.stop()
      await exited
    },
  }
}
