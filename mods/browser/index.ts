import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Mod, ModRun, ModValues } from '@kotharhq/mod-api'

const require = createRequire(import.meta.url)
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

const usesChrome = (values: ModValues) => values.browser === 'chrome'

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
    "Agents browse the web with Playwright. By default it's a Chromium of Kothar's own, never your Chrome or its " +
    'logins, and each space keeps its own browser profile, so a login there stays.',
  enabledByDefault: false,
  settings: [
    {
      key: 'browser',
      label: 'Browser',
      description:
        "Your Chrome: agents work in tabs of the Chrome you're running, through the Playwright Extension, so they " +
        'are logged in wherever you are and can act as you on every one of those sites. Subagents share it, each ' +
        'in a tab group of its own.',
      type: 'select',
      options: [
        { value: 'chromium', label: "Kothar's Chromium" },
        { value: 'chrome', label: 'Your Chrome' },
      ],
      default: 'chromium',
    },
    {
      key: 'extensionToken',
      label: 'Extension token',
      description:
        "Your Chrome only. Without it, Chrome asks you to pick a tab each time an agent connects, which is every " +
        "message. Copy it from the Playwright Extension's page: click its icon in Chrome's toolbar.",
      type: 'text',
      default: '',
      rows: 1,
    },
    {
      key: 'background',
      label: 'Keep the browser in the background',
      description:
        "Kothar's Chromium only. It runs headless, so no window ever shows or takes focus. Off, it opens a " +
        'visible window, which may take focus while the agent works.',
      type: 'boolean',
      default: true,
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
      usesChrome(values)
        ? `Install opens the Playwright Extension in the Chrome Web Store (${EXTENSION_URL}). Add it to Chrome, ` +
          'and this turns ready once Chrome has it.'
        : "Install runs Playwright's own installer for its Chromium (Chrome for Testing), into Playwright's " +
          'browser folder, which other Playwright tools share. Nothing in it is removed.',
    async check(run, values) {
      if (usesChrome(values)) return chromeStatus(await checkChrome(run))
      const { code, stdout, stderr } = await run(process.execPath, ['-e', CHECK_SCRIPT], { env: NODE_ENV })
      if (code !== 0) throw new Error(stderr.trim() || `The browser check exited with code ${code}`)
      const { ready, name } = JSON.parse(stdout)
      return { ready, message: ready ? `${name} installed` : 'Browser not installed' }
    },
    async install(run, report, values) {
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
    if (usesChrome(values)) {
      // The extension takes a connection per session, each in a tab group of its own, so subagents share Chrome too.
      args.push('--extension', '--browser', 'chrome')
      const token = String(values.extensionToken ?? '').trim()
      if (token) env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = token
    } else {
      args.push('--browser', 'chromium')
      if (values.background) args.push('--headless')
      // A space's subagents run beside it, and Chromium locks a profile to one browser at a time.
      args.push(...(chat.subagent ? ['--isolated'] : ['--user-data-dir', join(dir, 'profile')]))
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
