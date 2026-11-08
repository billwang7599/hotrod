import { useEffect, useRef, useState } from 'react'

/** How fast the shown text catches up to what has arrived: the backlog shrinks by about 63% every this many ms. */
export const CATCH_UP_MS = 60

/**
 * How many characters of `target` to show after `dt` ms, given `shown` are showing now. Engines send text in bursts;
 * this spreads each burst over the next few frames. The rate grows with the backlog, so the shown text never falls
 * more than a moment behind, and it never splits a surrogate pair.
 */
export function nextLength(shown: number, target: string, dt: number): number {
  if (shown >= target.length) return target.length
  const backlog = target.length - shown
  let next = shown + Math.max(1, Math.ceil(backlog * (1 - Math.exp(-dt / CATCH_UP_MS))))
  if (next >= target.length) return target.length
  const code = target.charCodeAt(next)
  if (code >= 0xdc00 && code <= 0xdfff) next++
  return next
}

/** `text`, revealed smoothly as it grows. A text that doesn't extend the last one starts over. */
export function useSmoothText(text: string, enabled = true): string {
  const [shown, setShown] = useState(0)
  const shownRef = useRef(0)
  const lastRef = useRef(text)

  if (!text.startsWith(lastRef.current.slice(0, shownRef.current))) shownRef.current = 0
  lastRef.current = text

  useEffect(() => {
    if (!enabled) return
    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      const next = nextLength(shownRef.current, lastRef.current, now - last)
      last = now
      if (next !== shownRef.current) {
        shownRef.current = next
        setShown(next)
      }
      if (next < lastRef.current.length) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [text, enabled])

  if (!enabled) return text
  return text.slice(0, Math.min(shown, shownRef.current, text.length))
}
