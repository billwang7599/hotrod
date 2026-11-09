// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ClientMessage, SearchHit } from '@kothar/core/shared'
import { ago, paletteResults, revealIn, SEARCH_DEBOUNCE_MS, SearchPalette, takeReveal } from './search.tsx'
import type { ChatView } from './state.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const chat = (change: Partial<ChatView>): ChatView => ({
  id: 'c1',
  name: 'demo',
  folders: [],
  files: [],
  engine: 'fake',
  archived: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  status: 'idle',
  items: [],
  draft: '',
  queue: [],
  ...change,
})

const HOME = chat({ id: 'main', name: 'Home', mod: 'home', doneAt: '2026-03-01T00:00:00Z' })
const WEB = chat({ id: 'web', name: 'Website', doneAt: '2026-03-03T00:00:00Z' })
const API = chat({ id: 'api', name: 'API server', readAt: '2026-03-02T00:00:00Z' })
const SUB = chat({ id: 'sub', name: 'Website subagent', parentId: 'web', subagent: true, doneAt: '2026-03-04T00:00:00Z' })
const CHATS = [HOME, WEB, API, SUB]
const hit = (chatId: string, nth = 0): SearchHit => ({
  chatId,
  at: '2026-03-02T12:00:00Z',
  kind: 'text',
  snippet: 'the web deploy is done',
  match: { start: 4, length: 3 },
  nth,
})

test('with no query it lists recent chats, the open one last, and never subagents', () => {
  expect(paletteResults(CHATS, 'web', '', undefined).map((r) => r.chat.id)).toEqual(['api', 'main', 'web'])
})

test('with a query, names come first (prefix matches first), then message hits', () => {
  const results = paletteResults(CHATS, '', 'web', [hit('api'), hit('gone')])
  expect(results.map((r) => [r.chat.id, !!r.hit])).toEqual([
    ['web', false],
    ['api', true],
  ])
  expect(paletteResults(CHATS, '', 'SERVER', undefined).map((r) => r.chat.id)).toEqual(['api'])
})

test('ago reads short', () => {
  const now = Date.parse('2026-03-10T12:00:00Z')
  expect(ago('2026-03-10T11:59:30Z', now)).toBe('just now')
  expect(ago('2026-03-10T11:55:00Z', now)).toBe('5m')
  expect(ago('2026-03-10T09:00:00Z', now)).toBe('3h')
  expect(ago('2026-03-08T12:00:00Z', now)).toBe('2d')
})

let root: Root
let container: HTMLElement
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

function render(props: Partial<Parameters<typeof SearchPalette>[0]>, sent: ClientMessage[], selected: string[], closed: number[]) {
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider>
            <SearchPalette
              open
              close={() => closed.push(1)}
              chats={CHATS}
              selectedId="web"
              connected
              send={(m) => sent.push(m)}
              select={(id) => selected.push(id)}
              {...props}
            />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
}

const input = () => document.querySelector('input[aria-label="Search"]') as HTMLInputElement
const options = () => [...document.querySelectorAll('[role="option"]')]
const selectedOption = () => options().findIndex((o) => o.getAttribute('aria-selected') === 'true')
const key = (k: string) =>
  act(() => void input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })))
const type = (value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('arrows move through results, wrapping, and Enter opens one', () => {
  const sent: ClientMessage[] = []
  const selected: string[] = []
  const closed: number[] = []
  render({}, sent, selected, closed)
  expect(options().map((o) => o.textContent)).toHaveLength(3)
  expect(selectedOption()).toBe(0)
  key('ArrowDown')
  expect(selectedOption()).toBe(1)
  key('ArrowUp')
  key('ArrowUp')
  expect(selectedOption()).toBe(2)
  key('ArrowDown')
  key('Enter')
  expect(selected).toEqual(['api'])
  expect(closed).toHaveLength(1)
})

test('typing searches the core once, after a pause, and shows its hits with the match marked', () => {
  const sent: ClientMessage[] = []
  const selected: string[] = []
  render({}, sent, selected, [])
  type('we')
  type('web')
  expect(sent).toEqual([])
  act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS))
  expect(sent).toEqual([{ type: 'search', id: 1, query: 'web' }])
  expect(document.body.textContent).toContain('Searching messages…')

  // An answer to an older request is ignored.
  render({ search: { id: 0, query: 'web', hits: [hit('main')] } }, sent, selected, [])
  expect(options()).toHaveLength(1)
  render({ search: { id: 1, query: 'web', hits: [hit('api', 2)] } }, sent, selected, [])
  expect(options().map((o) => o.textContent)).toHaveLength(2)
  expect(document.querySelector('mark')!.textContent).toBe('web')
  key('ArrowDown')
  key('Enter')
  expect(selected).toEqual(['api'])
  expect(takeReveal('api')).toEqual({ chatId: 'api', query: 'web', nth: 2 })
  expect(takeReveal('api')).toBeNull()
})

test('says when nothing matches', () => {
  const sent: ClientMessage[] = []
  render({}, sent, [], [])
  type('zzz')
  act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS))
  render({ search: { id: 1, query: 'zzz', hits: [] } }, sent, [], [])
  expect(document.body.textContent).toContain('Nothing matches')
})

test('revealIn picks the nth matching message, or the last one shown', () => {
  const list = document.createElement('div')
  list.innerHTML = `
    <div data-item-kind="user">deploy it</div>
    <div data-item-kind="steps">deploy step</div>
    <div data-item-kind="text">Deploy   done</div>`
  expect(revealIn(list, { chatId: 'x', query: 'deploy', nth: 1 })).toBe(true)
  expect(list.children[2]!.hasAttribute('data-revealed')).toBe(true)
  expect(revealIn(list, { chatId: 'x', query: 'deploy', nth: 9 })).toBe(true)
  expect(revealIn(list, { chatId: 'x', query: 'nope', nth: 0 })).toBe(false)
})
