import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Mod, ModRun, ModValues } from '@kothar/mod-api'
import type { LoginsProfile } from './logins.ts'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
// Copies a Chrome profile's logins, then runs Playwright MCP; see logins.ts.
const LOGINS = join(HERE, 'logins.ts')
// Picks Chrome or Kothar's Chromium for the default mode, on the session's machine; see background.ts.
const BACKGROUND = join(HERE, 'background.ts')
// Playwright passes Chrome a mock keychain on macOS (a plain password store on Linux), and then Chrome can't decrypt
// the copied cookies.
const LOGINS_CONFIG = join(HERE, 'chrome-logins.json')
const MCP_DIR = dirname(require.resolve('@playwright/mcp/package.json'))
const CLI = join(MCP_DIR, 'cli.js')
const CORE_BUNDLE = require.resolve('playwright-core/lib/coreBundle', { paths: [MCP_DIR] })
// The core may be Electron, which runs scripts as Node only with this set.
const NODE_ENV = { ELECTRON_RUN_AS_NODE: '1' }
const INSTALL_TIMEOUT_MS = 30 * 60_000

const CHECK_SCRIPT = `
const fs = require('node:fs')
const { registry } = require(${JSON.stringify(CORE_BUNDLE)})
const chromium = registry.registry.findExecutable('chromium')
const marker = registry.browserDirectoryToMarkerFilePath(chromium.directory)
const ready = fs.existsSync(marker) && fs.existsSync(chromium.executablePath())
console.log(JSON.stringify({ ready, name: chromium.title + ' ' + chromium.browserVersion }))
`

// The Playwright Extension: it connects Playwright MCP to tabs in the user's running Chrome.
const EXTENSION_ID = 'mmlmfjhmonkocbjadbfplnigmagldckm'
export const EXTENSION_URL = `https://chromewebstore.google.com/detail/playwright-extension/${EXTENSION_ID}`
const EXTENSION_WAIT_MS = 10 * 60_000
const EXTENSION_POLL_MS = 2_000

// Finds Chrome, and the profile Playwright MCP's --extension picks: the last used one with the extension, else the
// first. The same rules as Playwright's own, which it doesn't export.
const CHROME_CHECK_SCRIPT = `
const fs = require('node:fs')
const path = require('node:path')
const { registry, utils } = require(${JSON.stringify(CORE_BUNDLE)})
const id = ${JSON.stringify(EXTENSION_ID)}
let executable
try { executable = registry.registry.findExecutable('chrome').executablePath() } catch {}
const chrome = !!executable && fs.existsSync(executable)
const dataDir = utils.defaultUserDataDirForChannel('chrome')
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch {} }
const hasExtension = (profile) =>
  fs.existsSync(path.join(dataDir, profile, 'Extensions', id)) ||
  ['Preferences', 'Secure Preferences'].some((file) => {
    const record = read(path.join(dataDir, profile, file))?.extensions?.settings?.[id]
    return !!record && typeof record === 'object' && Object.keys(record).length > 0
  })
let profiles = []
try {
  profiles = fs.readdirSync(dataDir).filter((entry) => entry === 'Default' || /^Profile \\d+$/.test(entry))
} catch {}
const lastUsed = read(path.join(dataDir, 'Local State'))?.profile?.last_used
const ordered = profiles.includes(lastUsed) ? [lastUsed, ...profiles.filter((p) => p !== lastUsed)] : profiles
const profile = ordered.find(hasExtension) ?? null
console.log(JSON.stringify({ chrome, executable: chrome ? executable : null, profile }))
`

type ChromeCheck = { chrome: boolean; executable: string | null; profile: string | null }

const ANSI = /\x1b\[[0-9;]*m/g

export const BROWSER_INSTRUCTIONS =
  'Browser (the browser_* tools): read a page from its snapshot, the one each action returns or browser_snapshot, ' +
  'and take a screenshot only when how it looks matters. Fill a form with one browser_fill_form call, not a call ' +
  'per field. Close the tabs you opened when you are done with them.'

const usesChrome = (values: ModValues) => values.browser === 'chrome'
const usesLogins = (values: ModValues) => values.browser === 'logins'
const usesBackground = (values: ModValues) => values.browser === 'background'
const usesAttach = (values: ModValues) => values.browser === 'attach'
// Kothar's Chromium in a visible window. A new value rather than the old 'chromium', which was headless by default:
// reusing it would open windows for everyone who had picked it.
export const WINDOW = 'window'

export const DEFAULT_PORT = 9222
const portOf = (values: ModValues) => {
  const port = Number(values.port)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT
}
export const endpointOf = (values: ModValues) => `http://localhost:${portOf(values)}`

// What answers on the debugging port: the browser's name, or nothing. Run through the Machine, where sessions run.
const ATTACH_CHECK_SCRIPT = `
fetch(process.argv[1] + '/json/version', { signal: AbortSignal.timeout(2000) })
  .then((response) => response.json())
  .then((version) => console.log(JSON.stringify({ browser: version.Browser ?? 'A browser' })))
  .catch(() => console.log(JSON.stringify({ browser: null })))
`

async function checkAttach(run: ModRun, values: ModValues) {
  const { code, stdout, stderr } = await run(process.execPath, ['-e', ATTACH_CHECK_SCRIPT, endpointOf(values)], {
    env: NODE_ENV,
  })
  if (code !== 0) throw new Error(stderr.trim() || `The debugging port check exited with code ${code}`)
  const { browser } = JSON.parse(stdout) as { browser: string | null }
  const port = portOf(values)
  if (!browser) return { ready: false, message: `No browser is listening on port ${port}` }
  return { ready: true, message: `${browser.replace('/', ' ')}, on port ${port}` }
}

async function checkChromium(run: ModRun) {
  const { code, stdout, stderr } = await run(process.execPath, ['-e', CHECK_SCRIPT], { env: NODE_ENV })
  if (code !== 0) throw new Error(stderr.trim() || `The browser check exited with code ${code}`)
  const { ready, name } = JSON.parse(stdout)
  return { ready: ready as boolean, message: ready ? `${name} installed` : 'Browser not installed' }
}

// The default mode is ready with Google Chrome as it is, and needs Kothar's Chromium only without it.
async function checkBackground(run: ModRun) {
  const { code, stdout, stderr } = await run(process.execPath, [BACKGROUND, 'check'], { env: NODE_ENV })
  if (code !== 0) throw new Error(stderr.trim() || `The Chrome check exited with code ${code}`)
  if ((JSON.parse(stdout) as { chrome: string | null }).chrome) {
    return { ready: true, message: 'Google Chrome, headless, on a profile of Kothar’s own' }
  }
  const chromium = await checkChromium(run)
  return chromium.ready ? { ...chromium, message: `${chromium.message}, headless` } : chromium
}

async function checkLogins(run: ModRun) {
  const chrome = await checkChrome(run)
  if (!chrome.chrome) return { ready: false, message: 'Google Chrome not found' }
  const { code, stdout, stderr } = await run(process.execPath, [LOGINS, 'check'], { env: NODE_ENV })
  if (code !== 0) throw new Error(stderr.trim() || `The Chrome profile check exited with code ${code}`)
  const { profile } = JSON.parse(stdout) as { profile: LoginsProfile | null }
  if (!profile) return { ready: false, message: 'No Chrome profile with logins found' }
  return { ready: true, message: `Logins from Chrome profile “${profile.label}”` }
}

async function checkChrome(run: ModRun): Promise<ChromeCheck> {
  const { code, stdout, stderr } = await run(process.execPath, ['-e', CHROME_CHECK_SCRIPT], { env: NODE_ENV })
  if (code !== 0) throw new Error(stderr.trim() || `The Chrome check exited with code ${code}`)
  return JSON.parse(stdout)
}

const chromeStatus = ({ chrome, profile }: ChromeCheck) => {
  if (!chrome) return { ready: false, message: 'Google Chrome not found' }
  if (!profile) return { ready: false, message: 'The Playwright Extension isn’t in Chrome' }
  return { ready: true, message: `Your Chrome, profile “${profile}”` }
}

const browser: Mod = {
  id: 'browser',
  name: 'Browser',
  description:
    'Agents browse the web with Playwright. By default in the background: no window opens or takes focus, on your ' +
    "Google Chrome if you have it, else a Chromium of Kothar's own, never your Chrome's profile or logins. Each space " +
    'keeps its own browser profile, so a login there stays. Pick a mode with a window only to watch the agent.',
  enabledByDefault: false,
  settings: [
    {
      key: 'browser',
      label: 'Browser',
      description:
        'In the background: headless, so nothing opens or takes focus, on Google Chrome if it is installed (nothing to ' +
        "install), else Kothar's Chromium, with a profile of the space's own. " +
        "With your Chrome's logins: Google Chrome runs headless on a copy of your Chrome profile's cookies and site " +
        "storage (not passwords or history), so agents are logged in where you are and can act as you there, " +
        'without opening a window. Logins you make in Chrome reach agents at their next message. ' +
        "Kothar's Chromium, in a window: Playwright's Chromium in a window you can watch, which may take focus while " +
        'the agent works. ' +
        'Your open browser: agents attach to a Chromium-based browser you started with --remote-debugging-port, as ' +
        "pi's browser extension does, and work in its tabs with its logins. Chrome 136 and later only allow this with " +
        'a --user-data-dir other than your usual one. ' +
        "Your Chrome, in front: agents work in tabs of the Chrome you're running, through the Playwright Extension. " +
        'Each message that browses opens a tab and brings Chrome to the front. Workers share it, each in a tab ' +
        'group of its own.',
      type: 'select',
      options: [
        // 'chromium' (Kothar's Chromium, headless unless a switch said otherwise) is gone: a saved one isn't an option,
        // so it reads as the default, 'background', which stays headless as it was. See WINDOW.
        { value: 'background', label: 'In the background (no window)' },
        { value: 'logins', label: "In the background, with your Chrome's logins" },
        { value: WINDOW, label: "Kothar's Chromium, in a window" },
        { value: 'attach', label: 'Your open browser (debugging port)' },
        { value: 'chrome', label: 'Your Chrome, in front (shows Chrome)' },
      ],
      default: 'background',
    },
    {
      key: 'port',
      label: 'Debugging port',
      description: 'Your open browser only: the port you started it with, as in --remote-debugging-port=9222.',
      type: 'number',
      default: DEFAULT_PORT,
      min: 1,
      max: 65535,
      integer: true,
    },
    {
      key: 'extensionToken',
      label: 'Extension token',
      description:
        "Your Chrome, in front, only. Without it, Chrome asks you to pick a tab each time an agent connects, which is every " +
        "message. Copy it from the Playwright Extension's page: click its icon in Chrome's toolbar.",
      type: 'text',
      default: '',
      rows: 1,
    },
    {
      key: 'askEachAction',
      label: 'Ask before each browser action',
      description:
        'Each browser tool call waits for your approval. Off, the agent browses without asking. pi never asks.',
      type: 'boolean',
      default: false,
    },
  ],

  setup: {
    description: (values) =>
      usesBackground(values)
        ? 'Uses Google Chrome if it is installed, with nothing to install. Without it, Install runs Playwright’s ' +
          'installer for its Chromium (Chrome for Testing), which other Playwright tools share.'
        : usesAttach(values)
        ? 'Start a Chromium-based browser with --remote-debugging-port=' + portOf(values) + ' (Chrome 136 and later ' +
          'also need a --user-data-dir other than your usual one), and this turns ready.'
        : usesLogins(values)
        ? 'Uses Google Chrome, with nothing to install. Each message that browses copies the logins of your last ' +
          "used Chrome profile into the space's work folder when Chrome's are newer, and Chrome reads them with " +
          'its key from your Keychain.'
        : usesChrome(values)
        ? `Install opens the Playwright Extension in the Chrome Web Store (${EXTENSION_URL}). Add it to Chrome, ` +
          'and this turns ready once Chrome has it.'
        : "Install runs Playwright's own installer for its Chromium (Chrome for Testing), into Playwright's " +
          'browser folder, which other Playwright tools share. Nothing in it is removed. Its window may take focus ' +
          'while the agent works.',
    async check(run, values) {
      if (usesBackground(values)) return checkBackground(run)
      if (usesAttach(values)) return checkAttach(run, values)
      if (usesLogins(values)) return checkLogins(run)
      if (usesChrome(values)) {
        // Kept for whoever picked it, but it's the one mode that brings Chrome to the front, so say so where it shows.
        const status = chromeStatus(await checkChrome(run))
        const front = 'Chrome comes to the front each message; pick In the background above for no pop-ups'
        return status.ready ? { ...status, message: `${status.message}. ${front}` } : status
      }
      const chromium = await checkChromium(run)
      return chromium.ready ? { ...chromium, message: `${chromium.message}, in a window` } : chromium
    },
    async install(run, report, values) {
      if (usesAttach(values)) {
        throw new Error(`Start your browser with --remote-debugging-port=${portOf(values)}; there's nothing to install`)
      }
      if (usesLogins(values)) {
        if (!(await checkChrome(run)).chrome) throw new Error('Install Google Chrome first')
        return
      }
      if (usesChrome(values)) return installExtension(run, report)
      let downloading = 'the browser'
      let partial = ''
      const onStdout = (chunk: string) => {
        const lines = (partial + chunk).split('\n')
        partial = lines.pop()!
        for (const line of lines.map((l) => l.replace(ANSI, ''))) {
          downloading = line.match(/^Downloading (.+?) \(playwright/)?.[1] ?? downloading
          const [, percent, size] = line.match(/(\d+)% of (.+)$/) ?? []
          if (percent) report({ text: `Downloading ${downloading}: ${percent}% of ${size}`, progress: +percent / 100 })
        }
      }
      // Without --no-remove the installer deletes browsers that other Playwright installs still use.
      const args = [CLI, 'install-browser', '--no-shell', '--no-remove', 'chromium']
      const options = { env: NODE_ENV, timeoutMs: INSTALL_TIMEOUT_MS, onStdout }
      const { code, stderr } = await run(process.execPath, args, options)
      if (code === 0) return
      const error = stderr.split('\n').findLast((line) => line.startsWith('Error: '))?.slice('Error: '.length)
      throw new Error(error ?? `Playwright's installer exited with code ${code}`)
    },
  },

  // Sessions that take MCP servers get the browser, so they get this too. Snapshots are text and cheaper than
  // screenshots; each action already returns one.
  instructions: ({ tools }) => (tools ? BROWSER_INSTRUCTIONS : undefined),

  mcpServers({ chat, workDir, sandboxed, values }) {
    const dir = join(workDir, '.browser')
    const args = [CLI, '--output-dir', join(dir, 'output'), '--file-paths', 'absolute']
    const env: Record<string, string> = {
      ...NODE_ENV,
      // Playwright puts sockets here, and the work folder's temp path can pass a socket path's 104 bytes.
      TMPDIR: tmpdir(),
      // Its list of running browsers is otherwise in ~/Library/Caches, which the sandbox keeps read-only.
      PWTEST_SERVER_REGISTRY: join(tmpdir(), 'kothar-browser-registry'),
    }
    if (usesBackground(values)) {
      args.unshift(BACKGROUND, 'run', dir)
      if (chat.worker) env.KOTHAR_BROWSER_WORKER = '1'
      // Chrome and Chromium can't start their own sandboxes inside Kothar's.
      if (sandboxed) args.push('--no-sandbox')
      if (process.env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH
    } else if (usesAttach(values)) {
      // The user's browser, as it is: Playwright attaches over CDP and leaves it running when the session ends.
      args.push('--cdp-endpoint', endpointOf(values))
    } else if (usesChrome(values)) {
      // The extension takes a connection per session, each in a tab group of its own, so workers share Chrome too.
      args.push('--extension', '--browser', 'chrome')
      const token = String(values.extensionToken ?? '').trim()
      if (token) env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = token
    } else if (usesLogins(values)) {
      // A worker gets a copy of its own, since Chrome locks a profile to one browser at a time.
      const copy = chat.worker ? join(dir, 'logins-workers', chat.id) : join(dir, 'logins')
      if (chat.worker) env.KOTHAR_LOGINS_TEMPORARY = '1'
      args.unshift(LOGINS, 'run', copy)
      args.push('--browser', 'chrome', '--headless', '--user-data-dir', copy, '--config', LOGINS_CONFIG)
      if (sandboxed) args.push('--no-sandbox')
    } else {
      // Kothar's Chromium, in a window: the one mode of Kothar's own browser that isn't headless.
      args.push('--browser', 'chromium')
      // A space's workers run beside it, and Chromium locks a profile to one browser at a time.
      args.push(...(chat.worker ? ['--isolated'] : ['--user-data-dir', join(dir, 'profile')]))
      // Chromium can't start its own sandbox inside Kothar's.
      if (sandboxed) args.push('--no-sandbox')
      if (process.env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH
    }
    return [{ name: 'browser', command: process.execPath, args, env, allowTools: !values.askEachAction }]
  },
}

// Opens the extension's store page in Chrome, then waits for Chrome to have it. Cancel stops it at its next check.
async function installExtension(run: ModRun, report: (update: { text?: string; progress?: number }) => void) {
  let checked = await checkChrome(run)
  if (!checked.chrome) throw new Error('Install Google Chrome first')
  if (checked.profile) return
  // Chrome's own binary hands a URL to the running Chrome; detached, so a Chrome it starts outlives the script.
  const open =
    "require('node:child_process').spawn(process.argv[1], [process.argv[2]], { detached: true, stdio: 'ignore' })" +
    '.unref()'
  const opened = await run(process.execPath, ['-e', open, checked.executable!, EXTENSION_URL], { env: NODE_ENV })
  if (opened.code !== 0) throw new Error(opened.stderr.trim() || `Opening Chrome exited with code ${opened.code}`)
  report({ text: 'Add the Playwright Extension in the Chrome window that opened…' })
  for (let waited = 0; waited < EXTENSION_WAIT_MS; waited += EXTENSION_POLL_MS) {
    await new Promise((resolve) => setTimeout(resolve, EXTENSION_POLL_MS))
    checked = await checkChrome(run)
    if (checked.profile) return
  }
  throw new Error(`Chrome didn't get the Playwright Extension. Add it from ${EXTENSION_URL}`)
}

export default browser
