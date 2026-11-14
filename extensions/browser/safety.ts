// What browser_cdp may send. Agents get the raw protocol for what the other browser tools don't cover, but only on
// their own tab, and the browser may be the user's own Chrome (the Kothar extension), with every login they have.
// Kothar checks each call here before sending it, whichever browser it is; the relay keeps refusing the browser-wide
// ones itself as well (relay.ts REFUSED), in case anything else reaches it.
//
// - Refused, whatever the user says: what reads or changes the whole browser rather than the page. Every cookie of
//   every site (and the page's own, which hold logins the page itself can't read), setting or clearing them, site
//   permissions, closing or crashing the browser, other tabs and browser contexts (the whole Target domain: tabs go
//   through browser_tabs, which keeps to the space), the machine (SystemInfo), and downloads to a folder of the agent's
//   choosing.
// - Allowed without asking: reading the page and acting on it, as a user at the keyboard could: DOM, CSS,
//   accessibility, running script in the page, input, navigating, screenshots, and reading the tab's own traffic.
// - Everything else asks the user, with a card showing the method and its parameters: intercepting or rewriting
//   requests (Fetch), turning off certificate checks, service workers, site storage that isn't a plain read, and any
//   method Kothar doesn't know.

export type CdpVerdict = { verdict: 'allow' } | { verdict: 'ask' } | { verdict: 'refuse'; why: string }

const REFUSED_METHODS: Record<string, string> = {
  'Network.getAllCookies': 'it reads every cookie of every site',
  'Network.getCookies': 'cookies hold logins, including ones the page itself is not allowed to read',
  'Network.setCookie': 'it changes cookies, which hold logins',
  'Network.setCookies': 'it changes cookies, which hold logins',
  'Network.deleteCookies': 'it changes cookies, which hold logins',
  'Network.clearBrowserCookies': "it clears every site's cookies",
  'Network.clearBrowserCache': "it clears the whole browser's cache",
  'Storage.getCookies': 'it reads every cookie of every site',
  'Storage.setCookies': 'it changes cookies, which hold logins',
  'Storage.clearCookies': "it clears every site's cookies",
  'Storage.clearDataForOrigin': "it deletes a site's stored data and logins",
  'Storage.clearDataForStorageKey': "it deletes a site's stored data and logins",
  'Page.setDownloadBehavior': 'it saves downloads to a folder of its choosing',
}

const REFUSED_DOMAINS: Record<string, string> = {
  Browser: 'it acts on the whole browser (closing it, its permissions, its windows and downloads)',
  Target: "it reaches tabs and browser contexts beyond this chat's tab; use browser_tabs",
  SystemInfo: 'it reads about the computer, not the page',
  Tethering: 'it opens ports on the computer',
  Extensions: "it reaches the browser's extensions",
  PWA: 'it installs or removes apps',
}

// Browser.getVersion only says which browser it is.
const ALLOWED_IN_REFUSED = new Set(['Browser.getVersion'])

// Domains whose every method reads the page or acts on it as a user could.
const PAGE_DOMAINS = new Set([
  'DOM', 'DOMSnapshot', 'CSS', 'Accessibility', 'Runtime', 'Input', 'Overlay', 'Log', 'Console', 'Performance',
  'PerformanceTimeline', 'Animation', 'LayerTree', 'DOMDebugger', 'Emulation', 'Audits', 'Media', 'WebAudio', 'Inspector',
  'HeadlessExperimental', 'IO',
])

const PAGE_METHODS = new Set([
  'Page.enable', 'Page.disable', 'Page.navigate', 'Page.reload', 'Page.stopLoading', 'Page.getFrameTree',
  'Page.getResourceTree', 'Page.getResourceContent', 'Page.getLayoutMetrics', 'Page.getNavigationHistory',
  'Page.navigateToHistoryEntry', 'Page.captureScreenshot', 'Page.printToPDF', 'Page.bringToFront',
  'Page.handleJavaScriptDialog', 'Page.setLifecycleEventsEnabled', 'Page.getAppManifest', 'Page.searchInResource',
  'Page.startScreencast', 'Page.stopScreencast', 'Page.screencastFrameAck', 'Page.createIsolatedWorld',
  'Page.addScriptToEvaluateOnNewDocument', 'Page.removeScriptToEvaluateOnNewDocument', 'Page.setBypassCSP',
  'Page.getFrameOwner', 'Network.enable', 'Network.disable', 'Network.getResponseBody', 'Network.getRequestPostData',
  'Network.emulateNetworkConditions', 'Network.setCacheDisabled', 'Network.setBypassServiceWorker',
  'Storage.getStorageKeyForFrame', 'Storage.getUsageAndQuota',
])

// Reads of site storage the page itself could make.
const STORAGE_READS = /^(DOMStorage|IndexedDB|CacheStorage)\.(enable|disable|get\w*|request\w*)$/

export function checkCdp(method: string): CdpVerdict {
  if (!/^[A-Z][A-Za-z]*\.[a-zA-Z]+$/.test(method)) return { verdict: 'refuse', why: 'it is not a DevTools method name (Domain.method)' }
  const refused = REFUSED_METHODS[method]
  if (refused) return { verdict: 'refuse', why: refused }
  const domain = method.split('.')[0]!
  const whole = REFUSED_DOMAINS[domain]
  if (whole && !ALLOWED_IN_REFUSED.has(method)) return { verdict: 'refuse', why: whole }
  if (ALLOWED_IN_REFUSED.has(method) || PAGE_DOMAINS.has(domain) || PAGE_METHODS.has(method) || STORAGE_READS.test(method)) {
    return { verdict: 'allow' }
  }
  return { verdict: 'ask' }
}
