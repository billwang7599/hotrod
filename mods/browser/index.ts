import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { rmSync } from 'node:fs'
import type { ChatDetail, Mod, ModHost, ModProcessRow, ModRun } from '@kothar/mod-api'
import { chromiumLauncher, type Launcher } from './chromium.ts'
import { serveEndpoints, type Endpoints } from './endpoint.ts'
import { type BrowserOps, type HandOffResult, SpaceBrowser } from './space-browser.ts'

// Agents browse in the background: each space has one Chromium of Kothar's own (Playwright's, never the user's Chrome
// or profile), headless, launched when an agent first browses and kept between messages, so its tabs and logins stay.
// Playwright MCP attaches to it over CDP (see endpoint.ts). When a page needs the user, ask_user_in_browser hands the
// browser over: the same profile opens in a window with the same tabs, the chat waits, and Done puts it back in the
// background where the user left it (see space-browser.ts).

const require = createRequire(import.meta.url)
const MCP_DIR = dirname(require.resolve('@playwright/mcp/package.json'))
const CLI = join(MCP_DIR, 'cli.js')
const CORE_BUNDLE = require.resolve('playwright-core/lib/coreBundle', { paths: [MCP_DIR] })
// The core may be Electron, which runs scripts as Node only with this set.
const NODE_ENV = { ELECTRON_RUN_AS_NODE: '1' }
const INSTALL_TIMEOUT_MS = 30 * 60_000
// Playwright waits this long for the browser, which may be launching on that first call.
const CDP_TIMEOUT_MS = 60_000

const CHECK_SCRIPT = `
const fs = require('node:fs')
const { registry } = require(${JSON.stringify(CORE_BUNDLE)})
const chromium = registry.registry.findExecutable('chromium')
const marker = registry.browserDirectoryToMarkerFilePath(chromium.directory)
const path = chromium.executablePath()
const ready = fs.existsSync(marker) && fs.existsSync(path)
console.log(JSON.stringify({ ready, name: chromium.title + ' ' + chromium.browserVersion, path }))
`

const ANSI = /\x1b\[[0-9;]*m/g

export const HAND_OFF_TOOL = 'ask_user_in_browser'

export const BROWSER_INSTRUCTIONS =
  'Browser (the browser_* tools): read a page from its snapshot, the one each action returns or browser_snapshot, ' +
  'and take a screenshot only when how it looks matters. Fill a form with one browser_fill_form call, not a call ' +
  'per field. Close the tabs you opened when you are done with them. The browser runs in the background and keeps ' +
  `its tabs and logins between messages. When a page needs the user (a login, CAPTCHA, 2FA, payment, or anything ` +
  `you shouldn't do for them), call ${HAND_OFF_TOOL} instead of asking them for passwords or codes.`

export const HAND_OFF_DESCRIPTION =
  "Hands this space's browser to the user, for what only they can or should do: log in, solve a CAPTCHA, enter a " +
  '2FA code, pay, confirm. The browser opens in a window on their screen with your tabs, the current one in front, ' +
  'and this call waits until they say they are done (or close the window, or send you a message). Then the browser ' +
  'goes back to the background with their tabs and logins, and this returns the open tabs. Cookies, logins and site ' +
  'storage carry over both ways, but anything typed into a form and not submitted is lost, so ask before filling a ' +
  "form you can't finish. Afterwards your earlier page references are gone: take a browser_snapshot first."

export type BrowserModOptions = {
  // Tests pass a fake launcher and fake CDP calls, so nothing opens a window.
  launch?: (host: ModHost) => Launcher
  ops?: BrowserOps
  pollMs?: number
  handOffMs?: number
}

export function createBrowserMod(options: BrowserModOptions = {}) {
  let host: ModHost | undefined
  let endpoints: Endpoints | undefined
  let executable: string | undefined
  const browsers = new Map<string, SpaceBrowser>()
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let idleMs = 15 * 60_000

  const findExecutable = async () => {
    if (executable) return executable
    const { ready, path } = await checkChromium(host!.run)
    if (!ready) throw new Error('Kothar’s browser isn’t installed: Settings → Extensions → Browser → Install')
    return (executable = path)
  }

  const spaceIdOf = (chatId: string) => host?.space(chatId)?.id

  const browserOf = (spaceId: string) => {
    let browser = browsers.get(spaceId)
    if (browser) return browser
    const launch = options.launch ? options.launch(host!) : chromiumLauncher(host!, findExecutable)
    browser = new SpaceBrowser({
      profile: join(host!.storage.dir, 'profiles', spaceId),
      launch,
      ...(options.ops && { ops: options.ops }),
      ...(options.pollMs !== undefined && { pollMs: options.pollMs }),
      ...(options.handOffMs !== undefined && { handOffMs: options.handOffMs }),
      onChange: () => changed(spaceId),
    })
    browsers.set(spaceId, browser)
    return browser
  }

  const changed = (spaceId: string) => {
    if (!host) return
    host.processesChanged(spaceId)
    const browser = browsers.get(spaceId)
    // The chat that waits on the window shows it; any other's wait goes.
    const waiting = browser?.waitingChat
    for (const chat of host.chats()) {
      if (chat.id !== spaceId && chat.parentId !== spaceId) continue
      if (chat.id === waiting && browser?.mode === 'window') {
        if (!['running', 'waiting'].includes(chat.status)) continue
        host.wait(chat.id, {
          text: `Browser: ${browser.reason}`,
          buttons: [
            { id: 'open', label: 'Open browser', hint: 'Bring the browser window to the front' },
            { id: 'done', label: 'Done', primary: true, hint: 'Close the window; the agent carries on in the background' },
          ],
        })
      } else if (['running', 'waiting'].includes(chat.status)) {
        try {
          host.endWait(chat.id)
        } catch {}
      }
    }
  }

  // Stops a space's browser once nothing in the space has run for a while. A window the user has is left alone.
  const idleCheck = (spaceId: string) => {
    clearTimeout(idleTimers.get(spaceId))
    idleTimers.delete(spaceId)
    const browser = browsers.get(spaceId)
    if (!host || !browser?.busy || browser.mode === 'window' || idleMs <= 0) return
    const active = host.chats().some((c) => (c.id === spaceId || c.parentId === spaceId) && c.status !== 'idle')
    if (active) return
    idleTimers.set(
      spaceId,
      setTimeout(() => {
        idleTimers.delete(spaceId)
        if (browser.mode === 'headless') void browser.stop()
      }, idleMs),
    )
  }

  const stopSpace = (spaceId: string) => {
    clearTimeout(idleTimers.get(spaceId))
    idleTimers.delete(spaceId)
    const browser = browsers.get(spaceId)
    browsers.delete(spaceId)
    return browser?.stop()
  }

  const resultText = ({ how, tabs, error }: HandOffResult) => {
    const said = {
      done: 'The user is done.',
      message: 'The user sent you a message instead of clicking Done; it follows this result.',
      closed: 'The user closed the browser window.',
      stopped: 'The hand-off was stopped.',
      timeout: 'The user did not finish in time; ask them in the chat before trying again.',
    }[how]
    const list = tabs.length
      ? tabs.map((t) => `${t.active ? '* ' : '- '}${t.title ? `${t.title} — ` : ''}${t.url}`).join('\n')
      : '(no tabs)'
    const where = how === 'stopped' ? 'The browser is closed.' : 'The browser is back in the background.'
    return `${said}${error ? ` (${error})` : ''} ${where} Open tabs (* is the one in front):\n${list}`
  }

  const rowOf = (spaceId: string): ModProcessRow[] => {
    const browser = browsers.get(spaceId)
    if (!browser?.busy) return []
    const window = browser.mode === 'window'
    return [
      {
        key: 'browser',
        label: 'Browser',
        detail: window ? `Open for you${browser.reason ? `: ${browser.reason}` : ''}` : 'In the background',
        ...(browser.since !== undefined && { since: browser.since }),
        dot: window ? 'warning' : 'success',
        hint: "This space's browser, Kothar's own Chromium. Agents' tabs and logins stay while it runs.",
        actions: window
          ? [
              { name: 'open', label: 'Open', hint: 'Bring its window to the front' },
              { name: 'done', label: 'Done', primary: true, hint: 'Close the window; it goes on in the background' },
              { name: 'stop', label: 'Stop', hint: 'Close the browser' },
            ]
          : [
              { name: 'open', label: 'Open', hint: 'Show the agents’ tabs in a window, to look or take over' },
              { name: 'stop', label: 'Stop', hint: 'Close the browser; it starts again when an agent browses' },
            ],
      },
    ]
  }

  const mod: Mod = {
    id: 'browser',
    name: 'Browser',
    description:
      "Agents browse the web in the background, in a Chromium of Kothar's own: no window opens or takes focus. Each " +
      'space keeps its own browser profile, so its tabs and logins stay. When a page needs you (a login, CAPTCHA, ' +
      'payment), the agent hands you the browser in a window and carries on when you click Done.',
    enabledByDefault: false,
    settingsVersion: 1,
    // Version 0 had a picker of where the browser ran (your Chrome, a debugging port, the Playwright Extension, a
    // window, a copy of your Chrome's logins). There is one way now, so those settings go.
    migrateSettings(saved, from) {
      if (from >= 1) return saved
      const { browser: _browser, port: _port, extensionToken: _token, background: _background, ...rest } = saved
      return rest
    },
    settings: [
      {
        key: 'askEachAction',
        label: 'Ask before each browser action',
        description:
          'Each browser tool call waits for your approval. Off, the agent browses without asking. pi never asks.',
        type: 'boolean',
        default: false,
      },
      {
        key: 'idleMinutes',
        label: 'Close after idle (minutes)',
        description:
          "A space's browser closes once nothing in the space has run for this long, and opens again when an agent " +
          'browses. Logins stay; tabs don’t. 0 keeps it open until Kothar quits.',
        type: 'number',
        default: 15,
        min: 0,
        max: 1440,
        integer: true,
      },
    ],

    setup: {
      description:
        "Install runs Playwright's own installer for its Chromium (Chrome for Testing), into Playwright's browser " +
        'folder, which other Playwright tools share. Nothing in it is removed.',
      async check(run) {
        const { ready, name } = await checkChromium(run)
        return { ready, message: ready ? `${name} installed, in the background` : 'Browser not installed' }
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
        const { code, stderr } = await run(process.execPath, args, {
          env: NODE_ENV,
          timeoutMs: INSTALL_TIMEOUT_MS,
          onStdout,
        })
        executable = undefined
        if (code === 0) return
        const error = stderr.split('\n').findLast((line) => line.startsWith('Error: '))?.slice('Error: '.length)
        throw new Error(error ?? `Playwright's installer exited with code ${code}`)
      },
    },

    // Sessions that take MCP servers get the browser, so they get this too.
    instructions: ({ tools }) => (tools ? BROWSER_INSTRUCTIONS : undefined),

    async onStart({ host: given, values }) {
      host = given
      idleMs = Number(values.idleMinutes ?? 15) * 60_000
      endpoints ??= await serveEndpoints((spaceId) => browserOf(spaceId).endpoint())
    },

    async onStop() {
      const closing = endpoints
      endpoints = undefined
      await Promise.all([...browsers.keys()].map(stopSpace))
      await closing?.close()
    },

    mcpServers({ chat, workDir, values }) {
      const spaceId = spaceIdOf(chat.id)
      // Not started yet (it starts once Kothar is ready), or a chat outside any space: no browser this time.
      if (!endpoints || !spaceId) return []
      idleMs = Number(values.idleMinutes ?? 15) * 60_000
      const args = [
        CLI,
        '--cdp-endpoint',
        endpoints.url(spaceId),
        '--cdp-timeout',
        String(CDP_TIMEOUT_MS),
        '--output-dir',
        join(workDir, '.browser', 'output'),
        '--file-paths',
        'absolute',
      ]
      const env: Record<string, string> = {
        ...NODE_ENV,
        // Playwright puts sockets here, and the work folder's temp path can pass a socket path's 104 bytes.
        TMPDIR: tmpdir(),
        // Its list of running browsers is otherwise in ~/Library/Caches, which the sandbox keeps read-only.
        PWTEST_SERVER_REGISTRY: join(tmpdir(), 'kothar-browser-registry'),
      }
      return [{ name: 'browser', command: process.execPath, args, env, allowTools: !values.askEachAction }]
    },

    tools: [
      {
        name: HAND_OFF_TOOL,
        description: HAND_OFF_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              minLength: 1,
              description: 'What the user should do, shown to them, e.g. "Log in to GitHub"',
            },
          },
          required: ['reason'],
        },
        offered: (caller) => !!endpoints && !!spaceIdOf(caller.id),
        async run(input, { caller }) {
          const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : 'Your turn'
          const spaceId = spaceIdOf(caller.id)
          if (!spaceId || !endpoints) throw new Error('This chat has no browser')
          const browser = browserOf(spaceId)
          if (browser.waitingChat && browser.waitingChat !== caller.id) {
            throw new Error('Another chat in this space is waiting on the user in the browser; try again after')
          }
          const result = await browser.handOff(reason, caller.id)
          try {
            host?.endWait(caller.id)
          } catch {}
          return resultText(result)
        },
      },
    ],

    onWaitAction(chat, answer) {
      const browser = browsers.get(spaceIdOf(chat.id) ?? '')
      if (!browser || browser.waitingChat !== chat.id) return
      if ('message' in answer) return browser.finish('message')
      if (answer.button === 'open') return browser.show()
      if (answer.button === 'done') return browser.finish('done')
    },

    processes: (spaceId) => rowOf(spaceId),

    async onProcessAction(spaceId, _key, action) {
      const browser = browsers.get(spaceId)
      if (!browser) return
      if (action === 'stop') return stopSpace(spaceId)
      if (action === 'done') return browser.finish('done')
      if (action === 'open') {
        if (browser.mode === 'window') return browser.show()
        // On demand: no agent waits; Done (or closing the window) puts it back.
        void browser.handOff('opened from Processes')
      }
    },

    onStatusChanged(chat: ChatDetail, status) {
      const spaceId = spaceIdOf(chat.id)
      if (!spaceId) return
      const browser = browsers.get(spaceId)
      // Stopping the chat that waits on the window ends the hand-off, and the window closes.
      if (browser?.waitingChat === chat.id && (status === 'stopping' || status === 'idle')) void browser.finish('stopped')
      idleCheck(spaceId)
    },

    onChatArchived(chat, archived) {
      if (archived && chat.parentId === undefined) void stopSpace(chat.id)
    },

    // The space's profile, its logins with it, goes with the space.
    onChatRemoved(chat) {
      if (chat.parentId !== undefined || !host) return
      const profile = join(host.storage.dir, 'profiles', chat.id)
      void Promise.resolve(stopSpace(chat.id)).finally(() => rmSync(profile, { recursive: true, force: true }))
    },
  }

  return { mod, browsers }
}

async function checkChromium(run: ModRun) {
  const { code, stdout, stderr } = await run(process.execPath, ['-e', CHECK_SCRIPT], { env: NODE_ENV })
  if (code !== 0) throw new Error(stderr.trim() || `The browser check exited with code ${code}`)
  return JSON.parse(stdout) as { ready: boolean; name: string; path: string }
}

export default createBrowserMod().mod
