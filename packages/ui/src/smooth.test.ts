// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { advance, BASE_CPS, CATCH_UP_S, cut, resetReveals, useReveal, type RevealFrom } from './smooth.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const FRAME_MS = 16

/** Frames of `ms` each until `length` characters show, starting from `shown`. */
function msToShow(length: number, shown = 0) {
  let ms = 0
  while (shown < length) {
    shown = advance(shown, length, FRAME_MS)
    ms += FRAME_MS
  }
  return ms
}

test('a short reply types out at about the base rate, not all at once', () => {
  const ms = msToShow(20)
  expect(ms).toBeGreaterThan(100)
  expect(advance(0, 20, FRAME_MS)).toBeLessThan(5)
})

test('a steady trickle shows at least the base rate', () => {
  expect(advance(0, 1000, 1000 / 60) * 60).toBeGreaterThanOrEqual(BASE_CPS)
})

test('a big burst speeds up and drains in about a second or two, never crawling', () => {
  expect(msToShow(500)).toBeLessThan(1500)
  expect(msToShow(2000)).toBeLessThan(2000)
  expect(msToShow(20000)).toBeLessThan(3000)
})

test('a steady stream faster than the base rate is never more than the catch-up time behind', () => {
  const cps = 400
  let arrived = 0
  let shown = 0
  for (let t = 0; t < 10_000; t += FRAME_MS) {
    arrived += (cps * FRAME_MS) / 1000
    shown = advance(shown, arrived, FRAME_MS)
  }
  expect((arrived - shown) / cps).toBeLessThanOrEqual(CATCH_UP_S)
})

test('a long time away catches up at once and never overshoots', () => {
  expect(advance(0, 5000, 10_000)).toBe(5000)
  expect(advance(10, 10, FRAME_MS)).toBe(10)
})

test('never cuts inside a surrogate pair or a run of markdown markers', () => {
  expect(cut('a😀b', 2)).toBe(3)
  expect(cut('Run:\n```ts\nx', 6)).toBe(8)
  expect(cut('**bold**', 1)).toBe(2)
  expect(cut('abc', 1.7)).toBe(1)
  expect(cut('abc', 9)).toBe(3)
})

let now = 0
let frames = new Map<number, FrameRequestCallback>()
let nextFrame = 1
let root: Root
let container: HTMLElement

beforeEach(() => {
  now = 0
  frames = new Map()
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(nextFrame, callback)
    return nextFrame++
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  resetReveals()
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function step(ms: number, times = 1) {
  for (let i = 0; i < times; i++) {
    now += ms
    const due = [...frames.values()]
    frames.clear()
    act(() => due.forEach((callback) => callback(now)))
  }
}

type Shown = { name: string; text: string; from: RevealFrom; enabled?: boolean; as?: string }
function Show({ name, text, from, enabled = true }: Shown) {
  return useReveal(name, text, from, enabled)
}
const show = (props: Shown) => act(() => root.render(createElement(Show, { key: props.as ?? 'draft', ...props })))
const shown = () => container.textContent ?? ''

const REPLY = 'Hello there, this is a reply that streams in.'

test('a new text types out frame by frame until it has all shown', () => {
  show({ name: 'c:text:0', text: REPLY, from: 'start' })
  expect(shown()).toBe('')
  step(FRAME_MS, 5)
  expect(shown().length).toBeGreaterThan(0)
  expect(shown().length).toBeLessThan(REPLY.length)
  expect(REPLY.startsWith(shown())).toBe(true)
  step(FRAME_MS, 200)
  expect(shown()).toBe(REPLY)
  expect(frames.size).toBe(0)
})

test('the finished reply carries on from where the draft was instead of popping in', () => {
  show({ name: 'c:text:0', text: REPLY.slice(0, 30), from: 'start' })
  step(FRAME_MS, 5)
  const before = shown().length
  expect(before).toBeGreaterThan(0)
  // The draft becomes the finished item: a different element, the same name.
  show({ name: 'c:text:0', text: REPLY, from: 'none', as: 'item' })
  expect(shown().length).toBe(before)
  step(FRAME_MS)
  expect(shown().length).toBeGreaterThan(before)
  expect(shown().length).toBeLessThan(REPLY.length)
  step(FRAME_MS, 200)
  expect(shown()).toBe(REPLY)
})

test('history shows whole at once', () => {
  show({ name: 'c:text:0', text: REPLY, from: 'none' })
  expect(shown()).toBe(REPLY)
  expect(frames.size).toBe(0)
})

test('text already streaming when the chat opens shows whole, and only what comes after types out', () => {
  show({ name: 'c:text:0', text: REPLY, from: 'end' })
  expect(shown()).toBe(REPLY)
  show({ name: 'c:text:0', text: REPLY + ' More words arrive.', from: 'end' })
  expect(shown()).toBe(REPLY)
  step(FRAME_MS, 3)
  expect(shown().length).toBeGreaterThan(REPLY.length)
})

test('coming back to a reveal nobody was showing shows it caught up', () => {
  show({ name: 'c:text:0', text: REPLY, from: 'start' })
  step(FRAME_MS, 2)
  act(() => root.render(null))
  show({ name: 'c:text:0', text: REPLY, from: 'start' })
  expect(shown()).toBe(REPLY)
})

test('text arriving after a pause types out rather than jumping in', () => {
  show({ name: 'c:text:0', text: 'Hi.', from: 'start' })
  step(FRAME_MS, 100)
  expect(shown()).toBe('Hi.')
  now += 5000
  show({ name: 'c:text:0', text: 'Hi. ' + REPLY, from: 'start' })
  step(FRAME_MS)
  expect(shown().length).toBeLessThan(10)
})

test('reduced motion shows everything at once', () => {
  show({ name: 'c:text:0', text: REPLY, from: 'start', enabled: false })
  expect(shown()).toBe(REPLY)
})
