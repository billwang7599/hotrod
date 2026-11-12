// One space's browser: a Chromium on the space's profile (Kothar's own, or a copy of the user's), headless while agents
// work, relaunched with a window when the user takes over (a hand-off), and headless again once they're done. Every
// change runs one at a time, so only one browser is ever on the profile.
//
// A hand-off for signing in (signIn) opens a plain window: the same profile with no remote debugging, which sites
// can't tell from a browser the user opened, so Google and the like let them sign in. Kothar can't see into it, so it
// ends when the user clicks Done (Kothar asks it to quit) or quits it, and the headless browser that follows reopens
// its tabs from the profile's saved session.
import * as cdp from './cdp.ts'
import type { Launcher, Running } from './chromium.ts'

// The CDP calls a hand-off makes, as a parameter so tests can fake the browser with a window.
export type BrowserOps = Pick<
  typeof cdp,
  'listTabs' | 'activeTab' | 'getCookies' | 'restore' | 'bringToFront' | 'addMissingCookies'
>

export type SavedTab = { url: string; title: string; active: boolean }

// How a hand-off ended: the user clicked Done, sent a message, closed the window or quit the browser, the chat was
// stopped or the browser turned off, or nobody answered in time.
export type HandOffEnd = 'done' | 'message' | 'closed' | 'stopped' | 'timeout'
// error: why the window couldn't open, when it couldn't.
export type HandOffResult = { how: HandOffEnd; tabs: SavedTab[]; error?: string }

export type Mode = 'off' | 'headless' | 'window'

export type SpaceBrowserOptions = {
  profile: string
  launch: Launcher
  ops?: BrowserOps
  // Called after every change of mode, for the Processes row and the like.
  onChange?: () => void
  // How often a window's tabs are read, to notice the user closing it.
  pollMs?: number
  // The longest a hand-off waits for the user.
  handOffMs?: number
}

const KEEP = (url: string) =>
  !!url && url !== 'about:blank' && !url.startsWith('devtools://') && !url.startsWith('chrome://new-tab-page') && !url.startsWith('chrome://newtab')

export class SpaceBrowser {
  mode: Mode = 'off'
  // When the current browser started (epoch ms), and why the window is open.
  since?: number
  reason?: string
  // The chat whose agent waits on the window, if one does.
  waitingChat?: string
  // The window is plain (no DevTools), opened for signing in.
  plain = false
  private running?: Running
  // The cookies the browser had before a plain window, set again afterwards where the profile lacks them (session
  // cookies, which a plain window's start doesn't get).
  private beforePlain: cdp.Cookie[] = []
  // A plain window opened since the last finish: the next headless start reopens its saved tabs.
  private afterPlain = false
  private chain: Promise<unknown> = Promise.resolve()
  private tabs: SavedTab[] = []
  private poll?: ReturnType<typeof setInterval>
  private timeout?: ReturnType<typeof setTimeout>
  private waiters: ((result: HandOffResult) => void)[] = []
  // Cookies the browser had when it last closed for idleness, kept in memory only: the next start sets the ones its
  // profile doesn't have (session cookies, and logins made since a copied profile was last copied).
  private carried: cdp.Cookie[] = []
  private readonly ops: BrowserOps
  private readonly options: SpaceBrowserOptions

  constructor(options: SpaceBrowserOptions) {
    this.options = options
    this.ops = options.ops ?? cdp
  }

  // One change at a time, in order; a failed one doesn't block the next.
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run)
    this.chain = next.catch(() => {})
    return next
  }

  private changed() {
    this.options.onChange?.()
  }

  // The endpoint agents attach to: the headless browser, launched now if it isn't running. Refused while the user
  // has the window, so an agent never acts in front of them.
  endpoint(): Promise<string> {
    return this.serial(async () => {
      if (this.mode === 'window') {
        throw new Error('The user has this space’s browser open in a window; it is back in the background once they’re done')
      }
      if (this.mode === 'headless' && this.running) return this.running.endpoint
      await this.start(true, { tabs: [], cookies: [] }, true)
      return this.running!.endpoint
    })
  }

  get busy() {
    return this.mode !== 'off'
  }

  // The tabs as the browser has them now (or as last seen, if it's gone), with the active one marked.
  private async snapshot(): Promise<{ tabs: SavedTab[]; cookies: cdp.Cookie[] }> {
    const running = this.running
    if (!running?.endpoint) return { tabs: this.tabs, cookies: [] }
    try {
      const open = (await this.ops.listTabs(running.endpoint)).filter((t) => KEEP(t.url))
      const active = await this.ops.activeTab(running.endpoint, open).catch(() => open[0])
      const tabs = open.map((t) => ({ url: t.url, title: t.title, active: t.id === active?.id }))
      const cookies = await this.ops.getCookies(running.endpoint).catch(() => [])
      // Every tab closed: the ones seen last are what the agent was on.
      if (!tabs.length) return { tabs: this.tabs, cookies }
      this.tabs = tabs
      return { tabs, cookies }
    } catch {
      // It died or stopped answering: what the window showed last is the best there is.
      return { tabs: this.tabs, cookies: [] }
    }
  }

  // cold: from nothing, not a relaunch that carries a browser's tabs and cookies over.
  // plain: a window with no DevTools, on the given tabs. afterPlain: headless again after one, on the tabs it saved.
  private async start(
    headless: boolean,
    from: { tabs: SavedTab[]; cookies: cdp.Cookie[] },
    cold = false,
    how: { plain?: boolean; afterPlain?: boolean } = {},
  ) {
    const urls = from.tabs.map((t) => t.url)
    const running = await this.options.launch({
      profile: this.options.profile,
      headless: headless && !how.plain,
      cold,
      ...(how.plain && { plain: true, ...(urls.length && { urls }) }),
      ...(how.afterPlain && { restoreSession: true }),
    })
    this.running = running
    this.plain = !!how.plain
    this.mode = headless && !how.plain ? 'headless' : 'window'
    this.since = Date.now()
    void running.exited.then(() => this.exited(running))
    if (cold && this.carried.length) {
      const carried = this.carried.splice(0)
      await this.ops.addMissingCookies(running.endpoint, carried).catch(() => {})
    }
    if (how.plain) return this.changed()
    if (how.afterPlain) {
      const before = this.beforePlain
      this.beforePlain = []
      if (before.length) await this.ops.addMissingCookies(running.endpoint, before).catch(() => {})
      return this.changed()
    }
    const active = from.tabs.findIndex((t) => t.active)
    if (from.tabs.length || from.cookies.length) {
      await this.ops.restore(
        running.endpoint,
        from.cookies,
        from.tabs.map((t) => t.url),
        active < 0 ? undefined : active,
      )
    }
    this.changed()
  }

  private async halt() {
    this.stopWatching()
    const running = this.running
    this.running = undefined
    this.mode = 'off'
    this.plain = false
    this.since = undefined
    await running?.stop()
  }

  // A browser that went on its own: a window the user quit ends the hand-off; a headless one that crashed is
  // launched again by the next agent that browses.
  private exited(running: Running) {
    if (this.running !== running) return
    const wasWindow = this.mode === 'window'
    this.running = undefined
    this.mode = 'off'
    this.plain = false
    this.since = undefined
    this.stopWatching()
    this.changed()
    if (wasWindow) void this.finish('closed')
  }

  // Watches the window: its tabs as they change, and the user closing its last tab (on macOS the app stays running
  // without windows, so that's the closing that counts).
  private watch(running: Running) {
    const every = this.options.pollMs ?? 1000
    let reading = false
    this.poll = setInterval(async () => {
      if (reading || this.running !== running) return
      reading = true
      try {
        const open = await this.ops.listTabs(running.endpoint)
        if (this.running !== running) return
        if (!open.length) return void this.finish('closed')
        const kept = open.filter((t) => KEEP(t.url))
        if (kept.length) this.tabs = kept.map((t, i) => ({ url: t.url, title: t.title, active: i === 0 }))
      } catch {
        // Gone or busy; exited() handles a browser that's gone.
      } finally {
        reading = false
      }
    }, every)
  }

  private stopWatching() {
    clearInterval(this.poll)
    clearTimeout(this.timeout)
    this.poll = undefined
    this.timeout = undefined
  }

  // Shows the browser to the user: the headless one closes and the same profile opens with a window, the same tabs and
  // logins, the active tab in front. With chatId, that chat's agent waits on the result. Resolves when the user is
  // done and the browser is headless again.
  handOff(reason: string, chatId?: string): Promise<HandOffResult> {
    const result = new Promise<HandOffResult>((resolve) => this.waiters.push(resolve))
    void this.serial(async () => {
      this.reason = reason
      if (chatId) this.waitingChat = chatId
      if (this.mode === 'window' && this.running) {
        await this.front(this.running)
        this.changed()
        return
      }
      const cold = this.mode === 'off'
      const from = await this.snapshot()
      await this.halt()
      await this.start(false, from, cold)
      const running = this.running!
      await this.front(running)
      this.watch(running)
      this.limit()
    }).catch((error: unknown) => this.failed(error))
    return result
  }

  // Hands the browser to the user for signing in: the same profile, tabs and logins in a plain window, with no
  // DevTools (see the top of this file). A window already open, plain or not, is brought forward; one with DevTools
  // stays as it is, so it needs Hide first to become plain. With chatId, that chat's agent waits on the result.
  signIn(reason: string, chatId?: string): Promise<HandOffResult> {
    const result = new Promise<HandOffResult>((resolve) => this.waiters.push(resolve))
    void this.serial(async () => {
      this.reason = reason
      if (chatId) this.waitingChat = chatId
      if (this.mode === 'window' && this.running) {
        await this.front(this.running)
        this.changed()
        return
      }
      const cold = this.mode === 'off'
      const from = await this.snapshot()
      this.beforePlain = from.cookies
      await this.halt()
      await this.start(false, from, cold, { plain: true })
      this.afterPlain = true
      await this.front(this.running!)
      this.limit()
    }).catch((error: unknown) => this.failed(error))
    return result
  }

  private limit() {
    const limit = this.options.handOffMs ?? 60 * 60_000
    this.timeout = setTimeout(() => void this.finish('timeout'), limit)
  }

  private failed(error: unknown) {
    this.reason = undefined
    this.waitingChat = undefined
    this.afterPlain = false
    this.beforePlain = []
    this.changed()
    const message = error instanceof Error ? error.message : String(error)
    for (const resolve of this.waiters.splice(0)) resolve({ how: 'stopped', tabs: this.tabs, error: message })
  }

  // Its current tab in front, and its window in front of the user's other apps.
  private async front(running: Running) {
    if (running.endpoint) await this.ops.bringToFront(running.endpoint).catch(() => {})
    await running.activate?.().catch(() => {})
  }

  // Brings the window forward again, if there is one.
  async show() {
    const running = this.running
    if (this.mode === 'window' && running) await this.front(running)
  }

  // Ends a hand-off: the window closes and the browser goes on headless, on the same tabs and logins.
  finish(how: HandOffEnd): Promise<void> {
    return this.serial(async () => {
      if (this.mode !== 'window' && !this.waiters.length) return
      let from: { tabs: SavedTab[]; cookies: cdp.Cookie[] } = { tabs: this.tabs, cookies: [] }
      // A plain window can't be read; it saves its tabs to the profile as it quits, for the next start to reopen.
      // One the user quit themselves did the same.
      const plain = this.afterPlain
      this.afterPlain = false
      if (this.mode === 'window') {
        from = await this.snapshot()
        await this.halt()
      }
      // Back in the background where the window left off. Stopped means stopped: the next agent that browses starts
      // it again, on the same profile.
      let error: string | undefined
      if (how !== 'stopped' && this.mode === 'off') {
        const started = plain ? this.start(true, { tabs: [], cookies: [] }, false, { afterPlain: true }) : this.start(true, from)
        await started.catch((e: unknown) => (error = e instanceof Error ? e.message : String(e)))
        if (plain && !error) from = await this.snapshot()
      }
      this.beforePlain = []
      this.reason = undefined
      this.waitingChat = undefined
      this.changed()
      for (const resolve of this.waiters.splice(0)) resolve({ how, tabs: from.tabs, ...(error && { error }) })
    })
  }

  // Closes the browser, whatever mode it's in; a waiting agent hears it was stopped. keepCookies: it closes for
  // idleness, so its next start gets back the cookies it would otherwise lose (in memory only, never written).
  stop(keepCookies = false): Promise<void> {
    return this.serial(async () => {
      if (this.mode === 'window' || keepCookies) {
        const now = await this.snapshot()
        this.tabs = now.tabs
        if (keepCookies) this.carried = now.cookies
      }
      if (!keepCookies) this.carried = []
      this.afterPlain = false
      this.beforePlain = []
      await this.halt()
      this.reason = undefined
      this.waitingChat = undefined
      this.changed()
      for (const resolve of this.waiters.splice(0)) resolve({ how: 'stopped', tabs: this.tabs })
    })
  }
}
