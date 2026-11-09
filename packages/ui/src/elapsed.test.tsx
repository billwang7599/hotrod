// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ModView } from '@kotharhq/mod-api'
import { ModViewer } from './mod-view.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const START = Date.parse('2026-11-09T12:00:00.000Z')
let root: Root
let host: HTMLElement
let renders = 0

beforeEach(() => {
  vi.useFakeTimers({ now: START })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  renders = 0
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const show = (view: ModView) =>
  act(() =>
    root.render(
      <ModViewer
        view={view}
        act={() => {
          renders++
        }}
      />,
    ),
  )
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms))
const text = () => host.textContent

test('a row’s since ticks live, without the panel being sent again', () => {
  show({
    type: 'list',
    items: [
      { key: 'web', label: 'web', since: START - 58_000 },
      { key: 'old', label: 'old', detail: 'static' },
    ],
  })
  expect(text()).toBe('web58soldstatic')
  advance(1000)
  expect(text()).toBe('web59soldstatic')
  advance(1000)
  expect(text()).toBe('web1m 0soldstatic')
  advance(3_600_000)
  expect(text()).toBe('web1h 1moldstatic')
})

test('the elapsed node ticks too, and the clock stops once nothing shows one', () => {
  show({ type: 'stack', children: [{ type: 'text', text: 'up ' }, { type: 'elapsed', since: START }] })
  expect(text()).toBe('up 0s')
  advance(5000)
  expect(text()).toBe('up 5s')
  expect(vi.getTimerCount()).toBe(1)
  show({ type: 'text', text: 'ended' })
  expect(vi.getTimerCount()).toBe(0)
  expect(renders).toBe(0)
})

test('it pauses while the window is hidden and catches up when shown', () => {
  show({ type: 'elapsed', since: START })
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(vi.getTimerCount()).toBe(0)
  advance(10_000)
  expect(text()).toBe('0s')
  visibility.mockReturnValue('visible')
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(text()).toBe('10s')
  expect(vi.getTimerCount()).toBe(1)
  visibility.mockRestore()
})
