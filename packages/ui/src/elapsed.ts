import { useSyncExternalStore } from 'react'

/**
 * Live elapsed times for mod panels (`since` on a list row, the `elapsed` node). One clock ticks for all of them, only
 * while something shows one and the window is visible. Each subscriber re-renders only when its own text changes, so
 * past an hour a row redraws once a minute and the rest of the panel never does.
 */

const TICK_MS = 1000

// The same format as the Processes mod's duration(); a test pins the two together.
export function elapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

let now = Date.now()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

function tick() {
  now = Date.now()
  for (const listener of listeners) listener()
}

function sync() {
  const run = listeners.size > 0 && !hidden()
  if (run && timer === undefined) {
    tick()
    timer = setInterval(tick, TICK_MS)
  } else if (!run && timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', sync)

function subscribe(listener: () => void) {
  listeners.add(listener)
  sync()
  return () => {
    listeners.delete(listener)
    sync()
  }
}

export function useElapsed(since: number) {
  return useSyncExternalStore(subscribe, () => elapsed(now - since))
}
