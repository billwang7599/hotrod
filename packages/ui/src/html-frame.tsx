/**
 * An extension's HTML, such as an artifact an agent made, drawn so its scripts can run but reach nothing of Kothar's.
 *
 * - sandbox="allow-scripts" without allow-same-origin: the page gets an opaque origin of its own, so Kothar's window,
 *   localStorage, sessionStorage (the core's token) and cookies are out of reach, and the core's WebSocket refuses it
 *   (it checks Origin). No allow-popups, allow-forms, allow-top-navigation or allow-modals either.
 * - A Content-Security-Policy written into the page ahead of everything in it, so it applies before the page's own
 *   first tag: nothing loads from the network and nothing connects (fetch, XHR, WebSocket, EventSource, beacons). A
 *   policy can only be tightened by later ones, so nothing the page writes loosens it. The frame's csp attribute asks
 *   the browser for the same policy where it supports that (Chromium, so the desktop app).
 * - srcdoc, not a URL: the HTML never passes through the core's server, so nothing is served from Kothar's origin.
 */
const BASE_POLICY = [
  "default-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
]

/** The frame's policy: inline only, or (web) loads from https: too, still with nothing that connects. */
export function frameCsp(web = false) {
  const from = web ? ' https:' : ''
  return [
    ...BASE_POLICY,
    `script-src 'unsafe-inline'${from}`,
    `style-src 'unsafe-inline'${from}`,
    `img-src data: blob:${from}`,
    `font-src data:${from}`,
    `media-src data: blob:${from}`,
  ].join('; ')
}

const escapeAttribute = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

// A doctype must stay first, or the page drops into quirks mode; comments may come before it.
const LEAD = /^﻿?\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>/i

/** The page with the policy as its first element: right after any doctype, before its own <html> or <head>. */
export function sandboxedDocument(html: string, web = false) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(frameCsp(web))}">`
  const lead = LEAD.exec(html)?.[0] ?? ''
  return `${lead}${meta}${html.slice(lead.length)}`
}

type HtmlFrameProps = { html: string; label: string; web?: boolean; height?: number }

export function HtmlFrame({ html, label, web, height }: HtmlFrameProps) {
  const csp = frameCsp(web)
  return (
    <iframe
      // A frame's csp attribute is read when it's made, so a new policy needs a new frame.
      key={csp}
      title={label}
      sandbox="allow-scripts"
      srcDoc={sandboxedDocument(html, web)}
      referrerPolicy="no-referrer"
      // Camera, microphone, location, clipboard and the like: none.
      allow=""
      // CSP Embedded Enforcement (Chromium); React passes unknown lowercase attributes through.
      {...{ csp }}
      className={`w-full rounded border bg-white ${height === undefined ? 'min-h-320 flex-1' : 'shrink-0'}`}
      style={height === undefined ? undefined : { height }}
    />
  )
}
