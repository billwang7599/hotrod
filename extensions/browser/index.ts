import { join } from 'node:path'
import { rmSync } from 'node:fs'
import type {
  ChatDetail,
  Extension,
  ExtensionHost,
  ExtensionProcessRow,
  ExtensionSetting,
  ExtensionTool,
  ExtensionValues,
  ExtensionView,
} from '@kothar/extension-api'
import { chromiumLauncher, type Launcher } from './chromium.ts'
import { serveEndpoints, type Endpoints } from './endpoint.ts'
import { EXTENSION_DIR, NOT_CONNECTED, type Relay, type RelayOptions, startRelay } from './relay.ts'
import { defaultPlaces, findBrowser, KOTHAR_PROFILE, type Places } from './profiles.ts'
import { type BrowserOps, type HandOffResult, SpaceBrowser } from './space-browser.ts'
import { createBrowserTools } from './tools.ts'

// Agents browse in the background: each space has one browser, headless, launched when an agent first browses and kept
// between messages, so its tabs and logins stay. By default it's the user's installed Google Chrome (else another
// installed Chromium-family browser: Edge, Brave, Arc, Chromium) on a profile of Kothar's own per space, never the
// user's own Chrome profile;
// or, through the Kothar Chrome extension (relay.ts), the user's own Chrome, in a tab group per space.
// Agents drive it with Kothar's own browser tools (tools.ts), over CDP through the extension's endpoint (endpoint.ts).
// When a page needs the user, ask_user_in_browser hands the
// browser over: the same profile opens in a window with the same tabs, the chat waits, and Done puts it back in the
// background where the user left it (see space-browser.ts).

export const HAND_OFF_TOOL = 'ask_user_in_browser'
export const SHOW_TOOL = 'show_browser'

// One of this extension's prompts as the user left it in Settings (host.prompt), else its default, as with a host
// that has no prompts (a test's).
const promptOf = (host: { prompt?: (id: string) => string } | undefined, id: string, fallback: string) =>
  typeof host?.prompt === 'function' ? host.prompt(id) : fallback

export const BROWSER_INSTRUCTIONS =
  'Browser (the browser_* tools): open a page with browser_open and read it from the snapshot it returns; act on it ' +
  'with browser_act and browser_type by the refs in the snapshot (e12), and each returns only what changed. A long ' +
  'page comes in parts: call browser_snapshot with the cursor it gives. Take a screenshot only when how it looks ' +
  "matters. browser_cdp sends a DevTools command to your tab for what the other tools can't do. You get a tab of your " +
  "own; other chats in this space have theirs, so leave tabs browser_tabs marks as another chat's alone. Close the " +
  'tabs you opened when you are done with them. The browser runs in the background and keeps ' +
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
  'are gone: take a browser_snapshot first. If another chat is waiting on the user in the browser, this waits its turn.'

export const SHOW_DESCRIPTION =
  "Shows this space's browser to the user so they can look at something: a page, a result, a problem you want them " +
  'to see. It opens in a window on their screen with your tabs, the current one in front, and this call waits until ' +
  'they click Done (or close the window, or send you a message); then it goes back to the background and this returns ' +
  'the open tabs. For something they must do (log in, pay, confirm), use ' +
  `${HAND_OFF_TOOL} instead: this window is under automation, so Google and other sites may refuse to sign the user in ` +
  'there. Afterwards your earlier page references are gone: take a browser_snapshot first.'

// Agents in the user's own Chrome, in a tab group per space, through the Kothar Chrome extension (relay.ts).
export const YOUR_CHROME = 'kothar-extension'

export const PROFILE_HINT =
  'Kothar’s own: a profile per space on your installed Chrome, apart from yours, that starts logged out; Sign in… ' +
  'opens it in a plain window to log in, Google included. Your Chrome: agents work in your own Chrome, with your ' +
  'logins, in a tab group per space, through the Kothar extension.'

export const PROFILE_SETTING: ExtensionSetting = {
  key: 'profile',
  label: 'Profile',
  description: 'Kothar’s own profile per space, or your own Chrome through the Kothar extension.',
  type: 'select',
  options: [
    { value: KOTHAR_PROFILE, label: 'Kothar’s own' },
    { value: YOUR_CHROME, label: 'Your Chrome (Kothar extension)' },
  ],
  default: KOTHAR_PROFILE,
}

export const YOUR_CHROME_INSTRUCTIONS =
  "The browser is the user's own Chrome: your tabs are in this space's blue Kothar tab group there, with the user's " +
  "logins, and you can't see or touch their other tabs. Close the tabs you opened when you're done."

export const NO_BROWSER =
  'No Chrome is installed. Install Google Chrome (google.com/chrome), or Edge, Brave, Arc or Chromium, and agents browse on it.'

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
  // How long the browser tools wait for a quiet network after an action.
  settleMs?: number
  // Where to look for the user's browsers, and the platform whose Chrome paths apply.
  places?: Places
  platform?: NodeJS.Platform
}


export function createBrowserExtension(options: BrowserExtensionOptions = {}) {
  let host: ExtensionHost | undefined
  let endpoints: Endpoints | undefined
  const browsers = new Map<string, SpaceBrowser>()
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let idleMs = 15 * 60_000
  // The extension's settings as last seen, for launches, which happen outside any hook.
  let current: ExtensionValues = {}
  const places = options.places ?? defaultPlaces()

  // The profile the settings pick: Kothar's own, or the user's Chrome through the extension. Anything else saved (a
  // copy of one of the user's profiles, which Kothar no longer makes) is Kothar's own.
  type Choice = { kind: 'kothar' } | { kind: 'extension' }
  const choiceOf = (values: ExtensionValues): Choice => (values.profile === YOUR_CHROME ? { kind: 'extension' } : { kind: 'kothar' })
  // Where copies of the user's profiles were kept, before; deleted when the extension starts.
  const mirrors = () => join(host!.storage.dir, 'mirrors')
  // Each browser gets a folder of its own per space: a browser refuses a profile that a newer one (or another
  // browser) last opened. Chrome's, Beta's and Canary's are one, as Chrome's always was.
  const profileFolders = (spaceId: string) => [
    join(host!.storage.dir, 'chrome-profiles', spaceId),
    ...['edge', 'brave', 'arc', 'chromium'].map((id) => join(host!.storage.dir, `${id}-profiles`, spaceId)),
    // Where the bundled Chromium, before, kept each space's.
    join(host!.storage.dir, 'profiles', spaceId),
  ]
  const profileOf = (spaceId: string, browserId: string) =>
    join(host!.storage.dir, browserId.startsWith('chrome') ? 'chrome-profiles' : `${browserId}-profiles`, spaceId)

  // What runs Kothar's own profile: the installed Chromium-family browser, Google Chrome first.
  const installed = () => findBrowser(places, options.platform)

  // Launches a space's browser on Kothar's own profile for it, on the installed browser.
  const launcherOf = (spaceId: string): Launcher => {
    const launch = options.launch ? options.launch(host!) : chromiumLauncher(host!, findExecutable)
    return async (given) => {
      const choice = choiceOf(current)
      activityOf(spaceId, `Launched the browser${given.cold ? '' : ' again'}`, `On ${installed()?.name ?? 'your browser'}, on Kothar’s profile for this space`)
      if (choice.kind === 'extension') throw new Error(NOT_CONNECTED)
      const browser = installed()
      if (!browser) throw new Error(NO_BROWSER)
      return launch({ ...given, profile: profileOf(spaceId, browser.id), executable: browser.executable })
    }
  }

  // Listed in the chat's Activity (the Inspector); a host without activity (a test's) skips it.
  const activityOf = (chatId: string, title: string, detail?: string) => {
    try {
      if (typeof host?.activity === 'function') host.activity({ kind: 'browser', chatId, title, ...(detail && { detail }) })
    } catch {
      // The chat is gone: nothing to list it under.
    }
  }

  // Every launch names its browser; this is only for one that doesn't.
  const findExecutable = async () => {
    const browser = installed()
    if (!browser) throw new Error(NO_BROWSER)
    return browser.executable
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
  // The space's DevTools endpoint for Kothar's own CDP client: the relay's in the user's Chrome, else Kothar's
  // endpoint, which launches the space's browser on the first call (and refuses while the user has its window).
  const cdpUrl = async (spaceId: string) => {
    if (usesExtension()) {
      if (!relay?.connected) throw new Error(NOT_CONNECTED)
      return relay.cdpUrl(spaceId)
    }
    if (!endpoints) throw new Error('The browser isn’t running yet')
    return endpoints.url(spaceId)
  }
  const browserTools = createBrowserTools({
    host: () => host,
    spaceIdOf,
    endpointOf: cdpUrl,
    activity: (chatId, title, detail) => activityOf(chatId, title, detail),
    ready: () => !!endpoints,
    ...(options.settleMs !== undefined && { settleMs: options.settleMs }),
  })

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
  // Each space's line of hand-offs (its last one's end), and the chats waiting in a line, by how to drop each.
  const handOffs = new Map<string, Promise<void>>()
  const queued = new Map<string, Set<() => void>>()
  const dropQueued = (chatId: string) => {
    for (const drop of queued.get(chatId) ?? []) drop()
  }
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
  const runsOn = () => `${installed()?.name ?? 'your browser'}, on a profile of Kothar's own`

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
      // One hand-off at a time per space: a chat that asks while another waits on the user waits its turn, and its
      // window opens when that one is done. Stopping the chat meanwhile drops it from the line.
      const before = handOffs.get(spaceId) ?? Promise.resolve()
      let release!: () => void
      let drop!: () => void
      const turn = new Promise<void>((resolve) => (release = resolve))
      const line = before.then(() => turn)
      handOffs.set(spaceId, line)
      try {
        if (browser.waitingChat && browser.waitingChat !== caller.id) {
          activityOf(caller.id, 'Waiting for the browser', 'Another chat in this space is waiting on the user in it')
        }
        const dropped = await Promise.race([
          before.then(() => false),
          new Promise<boolean>((resolve) => {
            drop = () => resolve(true)
            queued.set(caller.id, (queued.get(caller.id) ?? new Set()).add(drop))
          }),
        ])
        if (dropped) return 'The chat was stopped while waiting for its turn with the browser; nothing was shown to the user.'
        asked.set(caller.id, name)
        activityOf(caller.id, plain ? 'Handed the browser to you in a plain window' : 'Showed you the browser', `Why: ${reason}`)
        const result = await (plain ? browser.signIn(reason, caller.id) : browser.handOff(reason, caller.id))
        activityOf(caller.id, 'Took the browser back', resultText(result))
        asked.delete(caller.id)
        notified.delete(caller.id)
        try {
          host?.endWait(caller.id)
        } catch {}
        return resultText(result)
      } finally {
        queued.get(caller.id)?.delete(drop)
        if (!queued.get(caller.id)?.size) queued.delete(caller.id)
        release()
        if (handOffs.get(spaceId) === line) handOffs.delete(spaceId)
      }
    },
  })

  // Settings → Extensions → Browser, below the settings: which profile agents get.
  const settingsView = (values: ExtensionValues): ExtensionView => {
    const choice = choiceOf(values)
    const children: ExtensionView[] = [{ type: 'heading', text: 'Profile', hint: PROFILE_HINT }]
    if (choice.kind === 'extension') children.push(...extensionView())
    if (choice.kind === 'kothar') {
      const browser = installed()
      children.push(
        browser
          ? { type: 'text', text: `${browser.name}, on a profile of Kothar’s own per space`, tone: 'muted' }
          : { type: 'text', text: NO_BROWSER, tone: 'warning' },
      )
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
      'Agents browse the web in the background: no window opens or takes focus. They use your installed Google Chrome (or Edge, Brave, Arc or Chromium) ' +
      'on a profile of Kothar’s own per space (Sign in… opens it for you to log in), or your own Chrome through the Kothar extension (a blue tab group per space), with your logins. ' +
      'When a page needs you (a login, CAPTCHA, payment) or the agent wants to show you something, the browser opens ' +
      'in a window, and the agent carries on when you click Done.',
    enabledByDefault: false,
    prompts: [
      { id: 'browser', label: 'How to use the browser', text: BROWSER_INSTRUCTIONS, where: 'instructions' },
      {
        id: 'your-chrome',
        label: 'Your own Chrome (added when the browser is your Chrome, through the Kothar extension)',
        text: YOUR_CHROME_INSTRUCTIONS,
        where: 'instructions',
      },
    ],
    settingsVersion: 3,
    // Version 0 had a picker of where the browser ran (your Chrome, a debugging port, the Playwright Extension, a
    // window, a copy of your Chrome's logins). There is one way now, so those settings go. Version 1 had a Browser
    // picker (installed Chrome or a bundled Chromium); Kothar now runs whatever Chromium-family browser is installed.
    // Version 2 could run a copy of one of the user's profiles, or of a folder they named; Google signs out of a copy,
    // so that choice goes, and saved copies become Kothar's own.
    migrateSettings(saved, from) {
      if (from >= 3) return saved
      const { engine: _engine, profileFolder: _folder, ...kept } = saved
      const profile = kept.profile === YOUR_CHROME ? { profile: YOUR_CHROME } : kept.profile === undefined ? {} : { profile: KOTHAR_PROFILE }
      if (from >= 1) return { ...kept, ...profile }
      const { browser: _browser, port: _port, extensionToken: _token, background: _background, ...rest } = kept
      return { ...rest, ...profile }
    },
    get settings(): ExtensionSetting[] {
      return [PROFILE_SETTING, ...BASE_SETTINGS]
    },

    settingsView: {
      render: ({ values }) => settingsView(values),
      onAction(action) {
        if (action.name === 'repair') relay?.repair()
      },
    },

    onSettingsChanged({ key }, { values }) {
      current = values
      idleMs = Number(values.idleMinutes ?? 15) * 60_000
      if (key === 'profile') {
        restartBackground()
        for (const spaceId of browsers.keys()) host?.processesChanged(spaceId)
        void syncRelay()
      }
    },

    setup: {
      description: (values) =>
        choiceOf(values).kind === 'extension'
          ? 'Agents use your own Chrome through the Kothar extension: load it and pair it below.'
          : 'Agents use your installed Google Chrome (or Edge, Brave, Arc or Chromium), on a profile of Kothar’s own ' +
              'per space: nothing to install.',
      async check(_run, values) {
        const choice = choiceOf(values)
        if (choice.kind === 'extension') {
          return { ready: true, message: relay?.connected ? 'Your Chrome is connected' : 'Your Chrome isn’t connected yet' }
        }
        const browser = installed()
        return browser ? { ready: true, message: `Uses ${browser.name}, in the background` } : { ready: false, message: NO_BROWSER }
      },
      // Nothing Kothar installs: the browser is the user's own.
      async install() {
        if (!installed()) throw new Error(NO_BROWSER)
      },
    },

    // Sessions that take MCP servers get the browser, so they get this too.
    instructions: ({ tools }, { values, host: h }) => {
      if (!tools) return undefined
      const text = promptOf(h, 'browser', BROWSER_INSTRUCTIONS)
      return usesExtension(values) ? `${text} ${promptOf(h, 'your-chrome', YOUR_CHROME_INSTRUCTIONS)}` : text
    },

    async onStart({ host: given, values }) {
      host = given
      current = values
      idleMs = Number(values.idleMinutes ?? 15) * 60_000
      endpoints ??= await serveEndpoints((spaceId) => browserOf(spaceId).endpoint())
      // Copies of the user's profiles, cookies and all, that an older Kothar made: nothing uses them now.
      rmSync(mirrors(), { recursive: true, force: true })
      await syncRelay()
    },

    async onStop() {
      await browserTools.stop()
      const closing = endpoints
      endpoints = undefined
      for (const end of chromeWaits.values()) end('stopped')
      for (const chatId of [...queued.keys()]) dropQueued(chatId)
      const relayClosing = relayStarting
      relayStarting = undefined
      relay = undefined
      await (await relayClosing)?.close()
      await Promise.all([...browsers.keys()].map(stopSpace))
      await closing?.close()
    },

    tools: [
      ...browserTools.tools,
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
      if (status === 'stopping' || status === 'idle') {
        chromeWaits.get(chat.id)?.('stopped')
        dropQueued(chat.id)
      }
      const spaceId = spaceIdOf(chat.id)
      if (!spaceId) return
      const browser = browsers.get(spaceId)
      // Stopping the chat that waits on the window ends the hand-off, and the window closes.
      if (browser?.waitingChat === chat.id && (status === 'stopping' || status === 'idle')) void browser.finish('stopped')
      idleCheck(spaceId)
    },

    onChatArchived(chat, archived) {
      if (archived) {
        browserTools.forget(chat.id)
        dropQueued(chat.id)
      }
      if (archived && chat.parentId === undefined) void stopSpace(chat.id)
    },

    // The space's profiles, logins with them, go with the space, and a copy of the user's left from before.
    onChatRemoved(chat) {
      browserTools.forget(chat.id)
      dropQueued(chat.id)
      if (chat.parentId !== undefined || !host) return
      const folders = [...profileFolders(chat.id), join(mirrors(), chat.id)]
      void Promise.resolve(stopSpace(chat.id)).finally(() => {
        for (const folder of folders) rmSync(folder, { recursive: true, force: true })
      })
    },
  }

  return { extension, browsers, cdpUrl }
}

export default createBrowserExtension().extension
