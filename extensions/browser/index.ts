import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { rmSync } from 'node:fs'
import type {
  ChatDetail,
  Extension,
  ExtensionHost,
  ExtensionProcessRow,
  ExtensionRun,
  ExtensionSetting,
  ExtensionTool,
  ExtensionValues,
  ExtensionView,
} from '@kothar/extension-api'
import { chromiumLauncher, type Launcher } from './chromium.ts'
import { serveEndpoints, type Endpoints } from './endpoint.ts'
import { FILTER_SCRIPT, HIDDEN_TOOLS } from './mcp-filter.ts'
import { EXTENSION_DIR, NOT_CONNECTED, type Relay, type RelayOptions, startRelay } from './relay.ts'
import {
  type BrowserProfile,
  defaultPlaces,
  detectProfiles,
  findChrome,
  FOLDER_PROFILE,
  folderProfile,
  KOTHAR_PROFILE,
  mirrorProfile,
  type Places,
  profileLabel,
  readMirror,
} from './profiles.ts'
import { type BrowserOps, type HandOffResult, SpaceBrowser } from './space-browser.ts'

// Agents browse in the background: each space has one browser, headless, launched when an agent first browses and kept
// between messages, so its tabs and logins stay. By default it's the user's installed Google Chrome (else Playwright's
// Chromium) on a profile of Kothar's own per space, never the user's own Chrome profile;
// the user can pick one of their own browser profiles instead, which the agents' browser runs a copy of (profiles.ts),
// never the profile itself or the user's running browser.
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

// oxlint-disable-next-line no-control-regex -- strips terminal escape codes on purpose
const ANSI = /\x1b\[[0-9;]*m/g

export const HAND_OFF_TOOL = 'ask_user_in_browser'
export const SHOW_TOOL = 'show_browser'

export const BROWSER_INSTRUCTIONS =
  'Browser (the browser_* tools): read a page from its snapshot, the one each action returns or browser_snapshot, ' +
  'and take a screenshot only when how it looks matters. Fill a form with one browser_fill_form call, not a call ' +
  'per field. Close the tabs you opened when you are done with them. The browser runs in the background and keeps ' +
  `its tabs and logins between messages. When a page needs the user (a login, CAPTCHA, 2FA, payment, or anything ` +
  `you shouldn't do for them), call ${HAND_OFF_TOOL} instead of asking them for passwords or codes. To show them ` +
  `something on a page, call ${SHOW_TOOL}.`

export const HAND_OFF_DESCRIPTION =
  "Hands this space's browser to the user, for what only they can or should do: log in, solve a CAPTCHA, enter a " +
  '2FA code, pay, confirm. The browser opens on their screen as a plain window with your tabs, not under ' +
  'automation, so sites such as Google let them sign in, and this call waits until they say they are done (or quit ' +
  'the browser, or send you a message). Then the browser goes back to the background with their tabs and logins, and ' +
  'this returns the open tabs. Cookies, logins and site storage carry over both ways, but anything typed into a form ' +
  "and not submitted is lost, so ask before filling a form you can't finish. Afterwards your earlier page references " +
  'are gone: take a browser_snapshot first.'

export const SHOW_DESCRIPTION =
  "Shows this space's browser to the user so they can look at something: a page, a result, a problem you want them " +
  'to see. It opens in a window on their screen with your tabs, the current one in front, and this call waits until ' +
  'they click Done (or close the window, or send you a message); then it goes back to the background and this returns ' +
  'the open tabs. For something they must do (log in, pay, confirm), use ' +
  `${HAND_OFF_TOOL} instead: this window is under automation, so Google and other sites may refuse to sign the user in ` +
  'there. Afterwards your earlier page references are gone: take a browser_snapshot first.'

// Google ties a login to the profile it was made in, so a copied one comes up signed out.
export const GOOGLE_COPY_NOTE =
  'Google (Gmail, YouTube and the like) signs you out in a copy. For Google, pick Kothar’s own profile and use its ' +
  'Sign in… button.'

export const PROFILE_HINT =
  'A copy of one of your profiles: its cookies, site storage and saved passwords, copied into a folder of Kothar’s ' +
  'own each time a space’s browser starts, and run on that browser’s own app, which reads them with your Keychain. ' +
  'Your browser and its profile are only ever read. Logins made in the agents’ browser last until the next copy; to ' +
  'keep one, log in in your own browser. ' +
  GOOGLE_COPY_NOTE

export function profileSetting(found: BrowserProfile[]): ExtensionSetting {
  return {
    key: 'profile',
    label: 'Profile',
    description:
      'Kothar’s own profile per space, your own Chrome through the Kothar extension, or a copy of one of your ' +
      'profiles, so agents are logged in where you are.',
    type: 'select',
    options: [
      { value: KOTHAR_PROFILE, label: 'Kothar’s own' },
      { value: YOUR_CHROME, label: 'Your Chrome (Kothar extension)' },
      ...found.map((profile) => ({ value: profile.key, label: profileLabel(profile) })),
      { value: FOLDER_PROFILE, label: 'Other folder…' },
    ],
    default: KOTHAR_PROFILE,
  }
}

// Agents in the user's own Chrome, in a tab group per space, through the Kothar Chrome extension (relay.ts).
export const YOUR_CHROME = 'kothar-extension'

export const YOUR_CHROME_INSTRUCTIONS =
  "The browser is the user's own Chrome: your tabs are in this space's blue Kothar tab group there, with the user's " +
  "logins, and you can't see or touch their other tabs. Close the tabs you opened when you're done."

export const PROFILE_FOLDER_SETTING: ExtensionSetting = {
  key: 'profileFolder',
  label: 'Other profile folder',
  description: 'Used when Profile is Other folder…, e.g. ~/Library/Application Support/Google/Chrome/Profile 2',
  type: 'text',
  default: '',
  rows: 1,
}

export const CHROME_ENGINE = 'chrome'
export const CHROMIUM_ENGINE = 'chromium'

export const ENGINE_SETTING: ExtensionSetting = {
  key: 'engine',
  label: 'Browser',
  description:
    'What runs Kothar’s own profile. Google Chrome is the one installed on this computer, on a profile per space ' +
    'apart from yours; Google lets you sign in on it. Without Chrome installed, the bundled Chromium runs instead.',
  type: 'select',
  options: [
    { value: CHROME_ENGINE, label: 'Google Chrome (installed)' },
    { value: CHROMIUM_ENGINE, label: 'Bundled Chromium' },
  ],
  default: CHROME_ENGINE,
}

export const SIGN_IN_HINT =
  'Opens this space’s browser as a plain window, not under automation, so you can sign in to Google and other ' +
  'sites. Click Done, or quit the browser, when you’re finished; agents then browse signed in.'

export const BASE_SETTINGS: ExtensionSetting[] = [
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
]

export type BrowserExtensionOptions = {
  // Tests pass a fake launcher and fake CDP calls, so nothing opens a window.
  launch?: (host: ExtensionHost) => Launcher
  ops?: BrowserOps
  pollMs?: number
  handOffMs?: number
  finishMs?: number
  // Tests start the relay on a spare port, with the fake extension's Origin.
  relay?: Partial<RelayOptions>
  // Where to look for the user's browsers, and the platform whose Chrome paths apply.
  places?: Places
  platform?: NodeJS.Platform
}

// Detected profiles are read again at most this often, when Settings asks for the picker's options.
const DETECT_MS = 5000

export function createBrowserExtension(options: BrowserExtensionOptions = {}) {
  let host: ExtensionHost | undefined
  let endpoints: Endpoints | undefined
  let executable: string | undefined
  const browsers = new Map<string, SpaceBrowser>()
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let idleMs = 15 * 60_000
  // The extension's settings as last seen, for launches, which happen outside any hook.
  let current: ExtensionValues = {}
  const places = options.places ?? defaultPlaces()

  let detected: { at: number; profiles: BrowserProfile[] } | undefined
  const profiles = () => {
    if (!detected || Date.now() - detected.at > DETECT_MS) detected = { at: Date.now(), profiles: detectProfiles(places) }
    return detected.profiles
  }

  // The profile the settings pick: Kothar's own, a copy of one of the user's, or why it can't be used.
  type Choice =
    | { kind: 'kothar' }
    | { kind: 'extension' }
    | { kind: 'copy'; label: string; dir: string; executable: string }
    | { kind: 'error'; message: string }
  const choiceOf = (values: ExtensionValues): Choice => {
    const key = String(values.profile ?? KOTHAR_PROFILE)
    if (key === KOTHAR_PROFILE) return { kind: 'kothar' }
    if (key === YOUR_CHROME) return { kind: 'extension' }
    if (key === FOLDER_PROFILE) {
      const found = folderProfile(String(values.profileFolder ?? ''), places)
      if (typeof found === 'string') return { kind: 'error', message: found }
      return { kind: 'copy', label: `${found.app.name}: ${found.dir}`, dir: found.dir, executable: found.executable }
    }
    const found = profiles().find((p) => p.key === key)
    if (!found) return { kind: 'error', message: 'That browser profile is gone' }
    return { kind: 'copy', label: profileLabel(found), dir: found.dir, executable: found.executable }
  }
  const mirrorOf = (spaceId: string) => join(host!.storage.dir, 'mirrors', spaceId)
  // Chrome gets a folder of its own per space, apart from the bundled Chromium's: the two are different versions, and
  // Chrome refuses a profile a newer version last opened.
  const chromeProfileOf = (spaceId: string) => join(host!.storage.dir, 'chrome-profiles', spaceId)

  // What runs Kothar's own profile: the installed Chrome when the setting picks it and it's there, else Chromium.
  type Engine = { kind: 'chrome'; name: string; executable: string } | { kind: 'chromium'; missingChrome: boolean }
  const engineOf = (values: ExtensionValues): Engine => {
    const wanted = String(values.engine ?? CHROME_ENGINE)
    if (wanted === CHROMIUM_ENGINE) return { kind: 'chromium', missingChrome: false }
    const chrome = findChrome(places, options.platform)
    return chrome ? { kind: 'chrome', ...chrome } : { kind: 'chromium', missingChrome: true }
  }

  // Launches a space's browser on the profile the settings pick now: Kothar's own, or a copy of the user's, made
  // again from the source on each cold start, run on the source's own browser with the real Keychain.
  const launcherOf = (spaceId: string): Launcher => {
    const launch = options.launch ? options.launch(host!) : chromiumLauncher(host!, findExecutable)
    return async (given) => {
      const choice = choiceOf(current)
      if (choice.kind === 'error') throw new Error(`${choice.message}: pick a profile in Settings → Extensions → Browser`)
      if (choice.kind === 'extension') throw new Error(NOT_CONNECTED)
      if (choice.kind === 'kothar') {
        const engine = engineOf(current)
        if (engine.kind === 'chromium') return launch(given)
        return launch({ ...given, profile: chromeProfileOf(spaceId), executable: engine.executable })
      }
      const mirror = mirrorOf(spaceId)
      const copied = readMirror(mirror)
      if (given.cold || !copied || copied.source !== choice.dir) mirrorProfile(choice.dir, mirror)
      return launch({ ...given, profile: mirror, executable: choice.executable, keychain: 'real' })
    }
  }

  const findExecutable = async () => {
    if (executable) return executable
    const { ready, path } = await checkChromium(host!.run)
    if (!ready) throw new Error('Kothar’s browser isn’t installed: Settings → Extensions → Browser → Install')
    return (executable = path)
  }

  const spaceIdOf = (chatId: string) => host?.space(chatId)?.id

  // The relay to the Kothar Chrome extension, running only while the profile picks it.
  let relay: Relay | undefined
  let relayStarting: Promise<Relay | undefined> | undefined
  const usesExtension = (values: ExtensionValues = current) => choiceOf(values).kind === 'extension'
  const syncRelay = async () => {
    if (!host) return
    if (usesExtension()) {
      relayStarting ??= startRelay({
        stateFile: join(host.storage.dir, 'chrome-extension.json'),
        nameOf: (spaceId) => host?.space(spaceId)?.name,
        onChange: () => host?.refresh?.(),
        ...options.relay,
      })
        .then((started) => {
          relay = started
          host?.refresh?.()
          return started
        })
        .catch(() => (relayStarting = undefined))
      await relayStarting
    } else if (relayStarting) {
      const closing = await relayStarting
      relayStarting = undefined
      relay = undefined
      await closing?.close()
    }
  }
  // Chats waiting on the user to finish in their own Chrome, and how each ended.
  const chromeWaits = new Map<string, (how: HandOffResult['how']) => void>()

  const browserOf = (spaceId: string) => {
    let browser = browsers.get(spaceId)
    if (browser) return browser
    browser = new SpaceBrowser({
      profile: join(host!.storage.dir, 'profiles', spaceId),
      launch: launcherOf(spaceId),
      ...(options.ops && { ops: options.ops }),
      ...(options.pollMs !== undefined && { pollMs: options.pollMs }),
      ...(options.handOffMs !== undefined && { handOffMs: options.handOffMs }),
      ...(options.finishMs !== undefined && { finishMs: options.finishMs }),
      onChange: () => changed(spaceId),
    })
    browsers.set(spaceId, browser)
    return browser
  }

  // What each waiting chat's agent asked for (ask_user_in_browser or show_browser), and the window it was last notified
  // about, so each window that opens for an agent notifies once.
  const asked = new Map<string, string>()
  const notified = new Map<string, string>()

  const changed = (spaceId: string) => {
    if (!host) return
    host.processesChanged(spaceId)
    // The General tab's Show browser / Hide browser follow the window.
    host.refresh?.()
    const browser = browsers.get(spaceId)
    // The chat that waits on the window shows it; any other's wait goes.
    const waiting = browser?.waitingChat
    for (const chat of host.chats()) {
      if (chat.id !== spaceId && chat.parentId !== spaceId) continue
      // Once the user is done (ending), the bar goes at once, while the window closes in the background.
      if (chat.id === waiting && browser?.mode === 'window' && !browser.ending) {
        if (!['running', 'waiting'].includes(chat.status)) continue
        const shown = `${browser.since}:${browser.reason}`
        if (notified.get(chat.id) !== shown) {
          notified.set(chat.id, shown)
          const title = asked.get(chat.id) === SHOW_TOOL ? 'An agent wants to show you something' : 'The browser needs you'
          // Kothar shows it only while you're away from the chat (#236's rules).
          try {
            host.notify?.({ chatId: chat.id, title, ...(browser.reason && { body: browser.reason }) })
          } catch {}
        }
        host.wait(chat.id, {
          text: `Browser: ${browser.reason}`,
          buttons: [
            { id: 'open', label: 'Open browser', hint: 'Bring the browser window to the front' },
            {
              id: 'done',
              label: 'Done',
              primary: true,
              closes: true,
              hint: 'Close the window; the agent carries on in the background',
            },
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
        if (browser.mode === 'headless') void browser.stop(true)
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

  const resultText = ({ how, tabs, error, late }: HandOffResult) => {
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
    const where =
      how === 'stopped'
        ? 'The browser is closed.'
        : late
          ? 'The browser is still going back to the background; your next browser call waits for it.'
          : error
            ? 'The browser could not go back to the background; it starts again when you next browse.'
            : 'The browser is back in the background.'
    return `${said}${error && !late ? ` (${error})` : ''} ${where} Open tabs (* is the one in front):\n${list}`
  }

  // Which browser and profile a space's browser runs, in words, for hints.
  const runsOn = () => {
    const choice = choiceOf(current)
    if (choice.kind === 'copy') return `a copy of ${choice.label}`
    const engine = engineOf(current)
    return engine.kind === 'chrome' ? `${engine.name}, on a profile of Kothar's own` : "Kothar's own Chromium"
  }

  const rowOf = (spaceId: string): ExtensionProcessRow[] => {
    const browser = browsers.get(spaceId)
    if (!browser?.busy) return []
    const window = browser.mode === 'window'
    const actions: ExtensionProcessRow['actions'] = browser.ending
      ? [{ name: 'stop', label: 'Stop', hint: 'Close the browser' }]
      : !window
      ? [
          { name: 'open', label: 'Show', hint: 'Show the agents’ tabs in a window, to look or take over. To sign in, use Sign in…' },
          { name: 'signin', label: 'Sign in…', hint: SIGN_IN_HINT },
          { name: 'stop', label: 'Stop', hint: 'Close the browser; it starts again when an agent browses' },
        ]
      : browser.waitingChat
        ? [
            { name: 'open', label: 'Open', hint: 'Bring its window to the front' },
            { name: 'done', label: 'Done', primary: true, hint: 'Close the window; the agent carries on in the background' },
            { name: 'stop', label: 'Stop', hint: 'Close the browser' },
          ]
        : [
            { name: 'open', label: 'Open', hint: 'Bring its window to the front' },
            { name: 'done', label: 'Hide', primary: true, hint: 'Close the window; the browser goes on in the background' },
            { name: 'stop', label: 'Stop', hint: 'Close the browser' },
          ]
    return [
      {
        key: 'browser',
        label: 'Browser',
        detail: browser.ending
          ? 'Going back to the background'
          : window
          ? `Open for you${browser.plain ? ', not under automation' : ''}${browser.reason ? `: ${browser.reason}` : ''}`
          : 'In the background',
        ...(browser.since !== undefined && { since: browser.since }),
        dot: window ? 'warning' : 'success',
        hint: `This space's browser, on ${runsOn()}. Agents' tabs and logins stay while it runs.`,
        actions,
      },
    ]
  }

  // Shows the space's browser in a window, for the user to look at or take over; no agent waits on it.
  const peek = (spaceId: string) => {
    const browser = browserOf(spaceId)
    if (browser.mode === 'window') return browser.show()
    void browser.handOff('opened by you')
  }

  // Opens the space's browser as a plain window for the user to sign in; no agent waits on it.
  const signIn = (spaceId: string) => {
    const browser = browserOf(spaceId)
    if (browser.mode === 'window') return browser.show()
    void browser.signIn('signing in')
  }

  // In the user's own Chrome nothing moves: the space's group comes to the front, and the agent waits for Done.
  const inYourChrome = async (spaceId: string, chatId: string, reason: string, tool: string) => {
    if (!relay?.connected) throw new Error(NOT_CONNECTED)
    if (chromeWaits.has(chatId)) throw new Error('This chat is already waiting on the user in Chrome')
    if (!(await relay.focus(spaceId))) {
      throw new Error("This space has no tabs in the user's Chrome yet; open the page first, then call this again")
    }
    const ended = new Promise<HandOffResult['how']>((resolve) => chromeWaits.set(chatId, resolve))
    const title = tool === SHOW_TOOL ? 'An agent wants to show you something' : 'Chrome needs you'
    try {
      host?.notify?.({ chatId, title, body: reason })
    } catch {}
    host?.wait(chatId, {
      text: `Chrome: ${reason}`,
      buttons: [
        { id: 'open', label: 'Show tabs', hint: 'Bring this space’s Kothar tab group to the front in Chrome' },
        { id: 'done', label: 'Done', primary: true, closes: true, hint: 'The agent carries on' },
      ],
    })
    const how = await ended
    chromeWaits.delete(chatId)
    try {
      host?.endWait(chatId)
    } catch {}
    const tabs = await relay?.tabs(spaceId).catch(() => [])
    return resultText({ how, tabs: tabs ?? [] }).replace(
      / The browser (is back in the background|is closed)\./,
      " Your tabs are still in this space's Kothar tab group in the user's Chrome.",
    )
  }

  // A tool that hands the browser to the user and waits for them: in a plain window (signIn) for what they must do,
  // in one Kothar still reads (handOff) for what they should look at.
  const handOffTool = (name: string, description: string, example: string, plain: boolean): ExtensionTool => ({
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', minLength: 1, description: `What the user should do or look at, shown to them, e.g. ${example}` },
      },
      required: ['reason'],
    },
    offered: (caller) => !!endpoints && !!spaceIdOf(caller.id),
    async run(input, { caller }) {
      const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : 'Your turn'
      const spaceId = spaceIdOf(caller.id)
      if (!spaceId || !endpoints) throw new Error('This chat has no browser')
      if (usesExtension()) return await inYourChrome(spaceId, caller.id, reason, name)
      const browser = browserOf(spaceId)
      if (browser.waitingChat && browser.waitingChat !== caller.id) {
        throw new Error('Another chat in this space is waiting on the user in the browser; try again after')
      }
      asked.set(caller.id, name)
      const result = await (plain ? browser.signIn(reason, caller.id) : browser.handOff(reason, caller.id))
      asked.delete(caller.id)
      notified.delete(caller.id)
      try {
        host?.endWait(caller.id)
      } catch {}
      return resultText(result)
    },
  })

  // Settings → Extensions → Browser, below the settings: which profile agents get, and refreshing its copy.
  const settingsView = (values: ExtensionValues): ExtensionView => {
    const choice = choiceOf(values)
    const children: ExtensionView[] = [{ type: 'heading', text: 'Profile', hint: PROFILE_HINT }]
    if (choice.kind === 'error') children.push({ type: 'text', text: choice.message, tone: 'error' })
    if (choice.kind === 'extension') children.push(...extensionView())
    if (choice.kind === 'kothar') {
      const engine = engineOf(values)
      const text =
        engine.kind === 'chrome'
          ? `${engine.name}, on a profile of Kothar’s own per space`
          : "Kothar's own Chromium, a profile per space"
      children.push({ type: 'text', text, tone: 'muted' })
      if (engine.kind === 'chromium' && engine.missingChrome) {
        children.push({
          type: 'text',
          text: 'Google Chrome isn’t installed, so the bundled Chromium runs instead. Google may not let you sign in on it.',
          small: true,
          tone: 'warning',
        })
      }
    }
    if (choice.kind === 'copy') {
      const copies = host ? join(host.storage.dir, 'mirrors') : undefined
      const times = [...browsers.keys()].map((id) => readMirror(mirrorOf(id))?.copiedAt ?? 0).filter(Boolean)
      const skipped = [...new Set([...browsers.keys()].flatMap((id) => readMirror(mirrorOf(id))?.skipped ?? []))]
      children.push(
        { type: 'text', text: `Logins from ${choice.label}` },
        { type: 'text', text: GOOGLE_COPY_NOTE, small: true, tone: 'warning' },
        { type: 'text', text: 'Read from', small: true, tone: 'faint' },
        { type: 'text', text: choice.dir, mono: true, small: true, tone: 'muted', copy: true },
      )
      if (times.length) {
        children.push({ type: 'text', text: `Last copied ${new Date(Math.max(...times)).toLocaleString()}`, small: true, tone: 'muted' })
      }
      if (skipped.length) {
        children.push({
          type: 'text',
          text: `Left out of the copy (over 200 MB): ${skipped.join(', ')}`,
          small: true,
          tone: 'warning',
        })
      }
      if (copies) {
        children.push({ type: 'text', text: 'Copied into', small: true, tone: 'faint' })
        children.push({
          type: 'text',
          text: copies,
          mono: true,
          small: true,
          tone: 'faint',
          copy: true,
          hint: "Where each space's copy lives. It goes when the space is deleted.",
        })
      }
      children.push({
        type: 'row',
        children: [
          {
            type: 'button',
            label: 'Refresh logins now',
            action: { name: 'refresh' },
            hint:
              'Closes the agents’ browsers that run in the background, so each copies your profile again when an ' +
              'agent next browses. A window open for you is left until you’re done with it.',
          },
        ],
      })
    }
    const others = profiles()
    if (!others.length) {
      children.push({ type: 'text', text: 'No Chrome, Brave, Edge, Arc or Chromium profiles found', small: true, tone: 'faint' })
    }
    return { type: 'stack', gap: 'tight', children }
  }

  // Setting up the Kothar extension in the user's Chrome, and whether it's connected.
  const extensionView = (): ExtensionView[] => {
    if (!relay) return [{ type: 'text', text: 'Starting…', tone: 'muted' }]
    const connected = relay.connected
    const view: ExtensionView[] = [
      {
        type: 'row',
        children: [
          { type: 'text', text: 'Your Chrome' },
          { type: 'badge', text: connected ? 'Connected' : 'Not connected', tone: connected ? 'success' : 'warning' },
        ],
      },
      {
        type: 'text',
        text:
          'Agents work in a blue “Kothar · space” tab group per space, in a window of its own, with your logins. ' +
          'They can’t see or touch your other tabs; drag a tab out of the group to take it back. While they work, ' +
          'Chrome shows “Kothar started debugging this browser”.',
        small: true,
        tone: 'muted',
      },
    ]
    if (!connected) {
      view.push(
        { type: 'text', text: '1. In Chrome, open chrome://extensions and turn on Developer mode.', small: true },
        { type: 'text', text: '2. Click Load unpacked and pick this folder:', small: true },
        { type: 'text', text: EXTENSION_DIR, mono: true, small: true, tone: 'muted', copy: true },
        { type: 'text', text: '3. Click the Kothar extension’s icon and paste this code:', small: true },
      )
    } else {
      view.push({ type: 'text', text: 'Pairing code', small: true, tone: 'faint' })
    }
    view.push(
      { type: 'text', text: relay.code, mono: true, small: true, tone: 'muted', copy: true },
      {
        type: 'row',
        children: [
          {
            type: 'button',
            label: 'New code',
            action: { name: 'repair' },
            hint: 'Makes a new pairing code. The extension disconnects until you paste the new one into it.',
            confirm: { text: 'Make a new pairing code?', body: 'Your Chrome disconnects until you paste the new code.', ok: 'New code' },
          },
        ],
      },
    )
    return view
  }

  // Closes the browsers running in the background, so the next browse starts on the profile the settings pick now.
  // Windows the user has stay until they're done.
  const restartBackground = () => {
    for (const [spaceId, browser] of browsers) {
      if (browser.mode === 'window') continue
      clearTimeout(idleTimers.get(spaceId))
      idleTimers.delete(spaceId)
      void browser.stop()
    }
  }

  const extension: Extension = {
    id: 'browser',
    name: 'Browser',
    description:
      'Agents browse the web in the background: no window opens or takes focus. They use your installed Google Chrome ' +
      'on a profile of Kothar’s own per space (Sign in… opens it for you to log in), your own Chrome through the Kothar extension (a blue tab group per space), or a copy of one of your Chrome, Brave, Edge or Arc profiles, so they’re logged in where you are. ' +
      'When a page needs you (a login, CAPTCHA, payment) or the agent wants to show you something, the browser opens ' +
      'in a window, and the agent carries on when you click Done.',
    enabledByDefault: false,
    settingsVersion: 1,
    // Version 0 had a picker of where the browser ran (your Chrome, a debugging port, the Playwright Extension, a
    // window, a copy of your Chrome's logins). There is one way now, so those settings go.
    migrateSettings(saved, from) {
      if (from >= 1) return saved
      const { browser: _browser, port: _port, extensionToken: _token, background: _background, ...rest } = saved
      return rest
    },
    get settings(): ExtensionSetting[] {
      return [ENGINE_SETTING, profileSetting(profiles()), PROFILE_FOLDER_SETTING, ...BASE_SETTINGS]
    },

    settingsView: {
      render: ({ values }) => settingsView(values),
      onAction(action) {
        if (action.name === 'refresh') restartBackground()
        if (action.name === 'repair') relay?.repair()
      },
    },

    onSettingsChanged({ key }, { values }) {
      current = values
      idleMs = Number(values.idleMinutes ?? 15) * 60_000
      if (key === 'engine' || key === 'profile' || key === 'profileFolder') {
        restartBackground()
        for (const spaceId of browsers.keys()) host?.processesChanged(spaceId)
        void syncRelay()
      }
    },

    setup: {
      description: (values) =>
        choiceOf(values).kind === 'extension'
          ? 'Agents use your own Chrome through the Kothar extension: load it and pair it below.'
          : choiceOf(values).kind === 'copy'
          ? 'Agents use your own browser’s app, on a copy of the profile you picked: nothing to install.'
          : engineOf(values).kind === 'chrome'
            ? 'Agents use your installed Google Chrome, on a profile of Kothar’s own per space: nothing to install.'
            : "Install runs Playwright's own installer for its Chromium (Chrome for Testing), into Playwright's browser " +
            'folder, which other Playwright tools share. Nothing in it is removed.',
      async check(run, values) {
        // A copy of the user's profile runs on their own browser: nothing to install.
        const choice = choiceOf(values)
        if (choice.kind === 'extension') {
          return { ready: true, message: relay?.connected ? 'Your Chrome is connected' : 'Your Chrome isn’t connected yet' }
        }
        if (choice.kind === 'copy') return { ready: true, message: `Uses ${choice.label}, in the background` }
        const engine = engineOf(values)
        if (engine.kind === 'chrome') return { ready: true, message: `Uses ${engine.name}, in the background` }
        const { ready, name } = await checkChromium(run)
        const instead = engine.missingChrome ? 'Google Chrome isn’t installed; ' : ''
        const message = ready ? `${instead}${name} installed, in the background` : `${instead}Browser not installed`
        return { ready, message }
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
    instructions: ({ tools }, { values }) =>
      tools ? (usesExtension(values) ? `${BROWSER_INSTRUCTIONS} ${YOUR_CHROME_INSTRUCTIONS}` : BROWSER_INSTRUCTIONS) : undefined,

    async onStart({ host: given, values }) {
      host = given
      current = values
      idleMs = Number(values.idleMinutes ?? 15) * 60_000
      endpoints ??= await serveEndpoints((spaceId) => browserOf(spaceId).endpoint())
      await syncRelay()
    },

    async onStop() {
      const closing = endpoints
      endpoints = undefined
      for (const end of chromeWaits.values()) end('stopped')
      const relayClosing = relayStarting
      relayStarting = undefined
      relay = undefined
      await (await relayClosing)?.close()
      await Promise.all([...browsers.keys()].map(stopSpace))
      await closing?.close()
    },

    mcpServers({ chat, workDir, values }) {
      const spaceId = spaceIdOf(chat.id)
      // Not started yet (it starts once Kothar is ready), or a chat outside any space: no browser this time.
      if (!endpoints || !spaceId) return []
      current = values
      idleMs = Number(values.idleMinutes ?? 15) * 60_000
      // Through the filter (mcp-filter.ts), which leaves out tools agents don't need.
      const args = [
        '-e',
        FILTER_SCRIPT,
        HIDDEN_TOOLS.join(','),
        process.execPath,
        CLI,
        '--cdp-endpoint',
        usesExtension(values) && relay ? relay.cdpUrl(spaceId) : endpoints.url(spaceId),
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
      handOffTool(HAND_OFF_TOOL, HAND_OFF_DESCRIPTION, '"Log in to GitHub"', true),
      handOffTool(SHOW_TOOL, SHOW_DESCRIPTION, '"The chart on this page is empty"', false),
    ],

    // Show or hide the space's browser from the chat's General tab, at any time.
    commands: [
      {
        id: 'show-browser',
        label: 'Show browser',
        hint: 'Show the agents’ tabs in a window, to look or take over. Hide puts it back in the background.',
        shown: (chat) =>
          usesExtension() ? !!relay?.connected && !!spaceIdOf(chat.id) : !!endpoints && browsers.get(spaceIdOf(chat.id) ?? '')?.mode !== 'window',
        run: (chat) => {
          const spaceId = spaceIdOf(chat.id)
          if (spaceId && usesExtension()) return void relay?.focus(spaceId).catch(() => {})
          if (spaceId) return peek(spaceId)
        },
      },
      {
        id: 'sign-in-browser',
        label: 'Sign in…',
        hint: SIGN_IN_HINT,
        shown: (chat) =>
          !usesExtension() && !!endpoints && !!spaceIdOf(chat.id) && browsers.get(spaceIdOf(chat.id) ?? '')?.mode !== 'window',
        run: (chat) => {
          const spaceId = spaceIdOf(chat.id)
          if (spaceId) return signIn(spaceId)
        },
      },
      {
        id: 'hide-browser',
        label: 'Hide browser',
        hint: 'Close the window; the browser goes on in the background with its tabs and logins',
        shown: (chat) => browsers.get(spaceIdOf(chat.id) ?? '')?.mode === 'window',
        run: (chat) => browsers.get(spaceIdOf(chat.id) ?? '')?.finish('done'),
      },
    ],

    onWaitAction(chat, answer) {
      const waiting = chromeWaits.get(chat.id)
      if (waiting) {
        if ('message' in answer) return waiting('message')
        if (answer.button === 'open') return void relay?.focus(spaceIdOf(chat.id) ?? '').catch(() => {})
        if (answer.button === 'done') return waiting('done')
        return
      }
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
      // On demand: no agent waits; Hide (or closing the window) puts it back.
      if (action === 'open') return peek(spaceId)
      if (action === 'signin') return signIn(spaceId)
    },

    onStatusChanged(chat: ChatDetail, status) {
      if (status === 'stopping' || status === 'idle') chromeWaits.get(chat.id)?.('stopped')
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

    // The space's profiles and its copy of the user's, logins with them, go with the space.
    onChatRemoved(chat) {
      if (chat.parentId !== undefined || !host) return
      const folders = [join(host.storage.dir, 'profiles', chat.id), chromeProfileOf(chat.id), mirrorOf(chat.id)]
      void Promise.resolve(stopSpace(chat.id)).finally(() => {
        for (const folder of folders) rmSync(folder, { recursive: true, force: true })
      })
    },
  }

  return { extension, browsers }
}

async function checkChromium(run: ExtensionRun) {
  const { code, stdout, stderr } = await run(process.execPath, ['-e', CHECK_SCRIPT], { env: NODE_ENV })
  if (code !== 0) throw new Error(stderr.trim() || `The browser check exited with code ${code}`)
  return JSON.parse(stdout) as { ready: boolean; name: string; path: string }
}

export default createBrowserExtension().extension
