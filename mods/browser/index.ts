import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Mod } from '@hotrod/mod-api'

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

const ANSI = /\x1b\[[0-9;]*m/g

const browser: Mod = {
  id: 'browser',
  name: 'Browser',
  description:
    "Agents browse the web with Playwright, in a Chromium of Hotrod's own, never your Chrome or its logins. Each " +
    'space keeps its own browser profile, so a login there stays. Claude Code only: pi takes no MCP servers.',
  enabledByDefault: false,
  settings: [
    {
      key: 'background',
      label: 'Keep the browser in the background',
      description:
        'The browser runs headless, so no window ever shows or takes focus. Off, it opens a visible window, which ' +
        'may take focus while the agent works.',
      type: 'boolean',
      default: true,
    },
    {
      key: 'askEachAction',
      label: 'Ask before each browser action',
      description: 'Each browser tool call waits for your approval. Off, the agent browses without asking.',
      type: 'boolean',
      default: false,
    },
  ],

  setup: {
    description:
      "Install runs Playwright's own installer for its Chromium (Chrome for Testing), into Playwright's browser " +
      'folder, which other Playwright tools share. Nothing in it is removed.',
    async check(run) {
      const { code, stdout, stderr } = await run(process.execPath, ['-e', CHECK_SCRIPT], { env: NODE_ENV })
      if (code !== 0) throw new Error(stderr.trim() || `The browser check exited with code ${code}`)
      const { ready, name } = JSON.parse(stdout)
      return { ready, message: ready ? `${name} installed` : 'Browser not installed' }
    },
    async install(run, report) {
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
    const args = [CLI, '--browser', 'chromium', '--output-dir', join(dir, 'output'), '--file-paths', 'absolute']
    if (values.background) args.push('--headless')
    // A space's subagents run beside it, and Chromium locks a profile to one browser at a time.
    args.push(...(chat.subagent ? ['--isolated'] : ['--user-data-dir', join(dir, 'profile')]))
    // Chromium can't start its own sandbox inside Hotrod's.
    if (sandboxed) args.push('--no-sandbox')
    const env: Record<string, string> = {
      ...NODE_ENV,
      // Playwright puts sockets here, and the work folder's temp path can pass a socket path's 104 bytes.
      TMPDIR: tmpdir(),
      // Its list of running browsers is otherwise in ~/Library/Caches, which the sandbox keeps read-only.
      PWTEST_SERVER_REGISTRY: join(tmpdir(), 'hotrod-browser-registry'),
    }
    if (process.env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH
    return [{ name: 'browser', command: process.execPath, args, env, allowTools: !values.askEachAction }]
  },
}

export default browser
