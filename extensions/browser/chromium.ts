// Launches Playwright's Chromium (Chrome for Testing) on a profile of Kothar's own, headless or with a window, through
// the Machine (host.spawn), and finds its DevTools endpoint. Playwright MCP never launches a browser in this extension:
// it attaches to this one over CDP.
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionHost, ExtensionProcess } from '@kothar/extension-api'
import { closeBrowser } from './cdp.ts'

export type Launch = { profile: string; headless: boolean }

// A browser that's running: its DevTools endpoint (http://127.0.0.1:<port>), a promise that settles when it exits,
// and stop, which asks it to quit and kills it if it won't.
export type Running = { endpoint: string; exited: Promise<void>; stop(): Promise<void> }

export type Launcher = (launch: Launch) => Promise<Running>

const STARTUP_MS = 20_000
const QUIT_MS = 5_000
const POLL_MS = 50

// The flags Kothar's browser runs with. The mock keychain and basic password store keep macOS from asking for the
// Keychain, and are the same in both modes, so cookies one mode saves the other can read.
export function chromiumArgs({ profile, headless }: Launch): string[] {
  return [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--use-mock-keychain',
    '--password-store=basic',
    '--hide-crash-restore-bubble',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter',
    ...(headless ? ['--headless', '--hide-scrollbars', '--mute-audio'] : []),
    'about:blank',
  ]
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

// The launcher for a Chromium at `executable`. extraArgs: for tests that run inside a sandbox.
export function chromiumLauncher(
  host: Pick<ExtensionHost, 'run' | 'spawn'>,
  executable: () => Promise<string>,
  extraArgs: string[] = [],
): Launcher {
  return async (launch) => {
    const path = await executable()
    mkdirSync(launch.profile, { recursive: true })
    await freeProfile(host, launch.profile)
    const portFile = join(launch.profile, 'DevToolsActivePort')
    rmSync(portFile, { force: true })
    const proc: ExtensionProcess = await host.spawn(path, [...extraArgs, ...chromiumArgs(launch)])
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
    return {
      endpoint,
      exited,
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
