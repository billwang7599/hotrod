import { useEffect, useLayoutEffect, useRef } from 'react'
import { useAppearance } from './themes.tsx'
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

// A frame's runtime error, as the frame's reporter sends it to Kothar's window: at most this long, at most this many per
// page load (a page that throws on every frame of an animation stops there).
export const FRAME_ERROR_CHARS = 2000
export const FRAME_ERRORS_PER_LOAD = 20
const ERROR_KEY = 'kotharFrameError'

// Runs first in the page, before its own scripts: tells the window about uncaught errors and unhandled rejections.
// postMessage is the one way out of the sandbox, and it carries only a string the window cuts to size.
const ERROR_REPORTER = `<script>(()=>{const send=(text)=>{try{parent.postMessage({${ERROR_KEY}:String(text)},'*')}catch(e){}};addEventListener('error',(e)=>send((e.error&&e.error.stack)||(e.message+(e.lineno?' (line '+e.lineno+')':''))));addEventListener('unhandledrejection',(e)=>{const r=e.reason;send('Unhandled promise rejection: '+((r&&(r.stack||r.message))||r))})})()</script>`

type FrameOptions = { web?: boolean; errors?: boolean; theme?: boolean }

/**
 * The page with the policy as its first element: right after any doctype, before its own <html> or <head>. errors: the
 * error reporter runs next, before the page's own scripts. theme: the page says it draws in light and dark, so its
 * default colours follow Kothar's.
 */
export function sandboxedDocument(html: string, options: boolean | FrameOptions = {}) {
  const { web = false, errors = false, theme = false } = typeof options === 'boolean' ? { web: options } : options
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(frameCsp(web))}">`
  const scheme = theme ? '<meta name="color-scheme" content="light dark">' : ''
  const lead = LEAD.exec(html)?.[0] ?? ''
  return `${lead}${meta}${scheme}${errors ? ERROR_REPORTER : ''}${html.slice(lead.length)}`
}

/** The error a message from a frame carries, cut to size, or undefined if it isn't one from the reporter. */
export function frameErrorOf(data: unknown): string | undefined {
  const text = (data as Record<string, unknown> | null)?.[ERROR_KEY]
  return typeof text === 'string' && text.trim() ? text.trim().slice(0, FRAME_ERROR_CHARS) : undefined
}

type HtmlFrameProps = {
  html: string
  label: string
  web?: boolean
  height?: number
  // Called with each runtime error the page reports (an uncaught error or rejection), cut to size.
  onError?: (error: string) => void
  // The page follows Kothar's light or dark scheme: no white sheet behind it, and prefers-color-scheme inside matches.
  theme?: boolean
}

export function HtmlFrame({ html, label, web, height, onError, theme }: HtmlFrameProps) {
  const csp = frameCsp(web)
  const frame = useRef<HTMLIFrameElement>(null)
  const dark = useAppearance().dark
  const report = useRef(onError)
  useLayoutEffect(() => {
    report.current = onError
  })
  const errors = !!onError
  const doc = sandboxedDocument(html, { web, errors, theme })
  useEffect(() => {
    if (!errors) return
    // Counted per page: a new document (a new version, the same one reloaded) starts again.
    let count = 0
    const onMessage = (e: MessageEvent) => {
      // Only this frame's own page; any other window's message is ignored.
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const error = frameErrorOf(e.data)
      if (error === undefined || ++count > FRAME_ERRORS_PER_LOAD) return
      report.current?.(error)
    }
    addEventListener('message', onMessage)
    return () => removeEventListener('message', onMessage)
  }, [errors, doc])
  return (
    <iframe
      ref={frame}
      // A frame's csp attribute is read when it's made, so a new policy needs a new frame.
      key={csp}
      title={label}
      sandbox="allow-scripts"
      srcDoc={doc}
      referrerPolicy="no-referrer"
      // Camera, microphone, location, clipboard and the like: none.
      allow=""
      // CSP Embedded Enforcement (Chromium); React passes unknown lowercase attributes through.
      {...{ csp }}
      className={`w-full rounded border ${height === undefined ? 'min-h-320 flex-1' : 'shrink-0'}`}
      // A plain page draws on white, as in a browser; a themed one on the panel, in Kothar's scheme.
      style={{
        ...(height !== undefined && { height }),
        ...(theme ? { colorScheme: dark ? 'dark' : 'light', backgroundColor: 'transparent' } : { colorScheme: 'light', backgroundColor: '#fff' }),
      }}
    />
  )
}
