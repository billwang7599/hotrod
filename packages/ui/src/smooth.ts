import { useEffect, useRef, useState } from 'react'

/** The slowest the reveal types, in characters per second, so text that trickles in still reads as typed. */
export const BASE_CPS = 90
/**
 * How far behind the reveal may fall, in seconds. The rate is BASE_CPS plus the backlog divided by this, so a steady
 * stream is never more than this far behind, and a burst of a few hundred characters drains in about a second.
 */
export const CATCH_UP_S = 0.4

/** Markdown markers: a run of them shows whole, so a code fence never flashes as stray backticks. */
const MARKUP = new Set(['*', '_', '`', '~'])

/** How many characters of a `length`-long text show after `dt` ms, from `shown` (fractional) now. */
export function advance(shown: number, length: number, dt: number): number {
  if (shown >= length) return length
  const k = BASE_CPS * CATCH_UP_S
  // The backlog b shrinks at BASE_CPS + b / CATCH_UP_S; this is that rate integrated over dt.
  const left = (length - shown + k) * Math.exp(-dt / 1000 / CATCH_UP_S) - k
  return left <= 0 ? length : length - left
}

/** Where to cut `text` to show about `shown` characters: never inside a surrogate pair or a run of markers. */
export function cut(text: string, shown: number): number {
  let at = Math.floor(shown)
  if (at >= text.length) return text.length
  if (at <= 0) return 0
  const code = text.charCodeAt(at)
  if (code >= 0xdc00 && code <= 0xdfff) at++
  while (at < text.length && MARKUP.has(text[at - 1]!) && MARKUP.has(text[at]!)) at++
  return at
}

/**
 * Where a text with no reveal yet starts: `start` types it from the beginning (it just arrived), `end` shows what's
 * there and types only what comes after (it was already streaming when the chat was opened), `none` shows it whole
 * (history).
 */
export type RevealFrom = 'start' | 'end' | 'none'

type Reveal = { text: string; shown: number; last: number; mounted: number }

/**
 * Reveals by key, kept outside React so a reveal outlives the element showing it: when a streamed draft becomes the
 * finished reply, the reply carries on from where the draft was. They're tiny and few, so they're kept for the session.
 */
const reveals = new Map<string, Reveal>()

/** Forget every reveal (tests). */
export function resetReveals() {
  reveals.clear()
}

/**
 * `text`, typed out as it grows at a steady rate that speeds up when it falls behind. `key` names the text across
 * elements (a chat's nth reply), so one reveal can move from the draft to the finished reply. A first look at a reveal
 * that's been off screen shows it caught up, as do reduced motion and `enabled` false.
 */
export function useReveal(key: string, text: string, from: RevealFrom, enabled = true): string {
  const [, setFrame] = useState(0)
  const firstRender = useRef(true)
  // oxlint-disable-next-line react/purity -- the reveal is a clock kept outside React on purpose (see reveals above)
  const now = performance.now()
  let reveal = reveals.get(key)
  if (enabled && reveal && !text.startsWith(reveal.text.slice(0, cut(reveal.text, reveal.shown)))) {
    reveals.delete(key)
    reveal = undefined
  }
  const known = !!reveal
  if (enabled && !reveal && from !== 'none') {
    reveal = { text, shown: from === 'start' ? 0 : text.length, last: now, mounted: 0 }
    reveals.set(key, reveal)
  }
  if (reveal) {
    // Coming back to a reveal nobody was showing: it's caught up, not replayed.
    // oxlint-disable-next-line react/refs -- only the first render of this element counts, and that's render-time state
    if (known && firstRender.current && reveal.mounted === 0) reveal.shown = text.length
    // A caught-up reveal's clock stands still, so text arriving after a pause types out rather than jumping.
    if (reveal.shown >= reveal.text.length) reveal.last = now
    reveal.text = text
  }
  // oxlint-disable-next-line react/refs -- see above
  firstRender.current = false
  const done = !reveal || reveal.shown >= text.length

  useEffect(() => {
    const reveal = reveals.get(key)
    if (!reveal) return
    reveal.mounted++
    return () => {
      reveal.mounted--
    }
  }, [key])

  useEffect(() => {
    if (!enabled || done) return
    let frame = 0
    const tick = (now: number) => {
      const reveal = reveals.get(key)
      if (!reveal) return
      reveal.shown = advance(reveal.shown, reveal.text.length, now - reveal.last)
      reveal.last = now
      setFrame((n) => n + 1)
      if (reveal.shown < reveal.text.length) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [key, text, enabled, done])

  if (!enabled || !reveal) return text
  return text.slice(0, cut(text, Math.min(reveal.shown, text.length)))
}
