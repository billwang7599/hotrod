// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { reloadFolded } from './folded.ts'
import { ChatNav } from './sidebar.tsx'
import type { ChatView } from './state.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const chat = (id: string, change: Partial<ChatView> = {}): ChatView => ({
  id,
  name: id,
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
const sub = (id: string, change: Partial<ChatView> = {}) => chat(id, { parentId: 'space', worker: true, ...change })

let root: Root
let host: HTMLDivElement
let selected: string[]

beforeEach(() => {
  localStorage.clear()
  reloadFolded()
  selected = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function render(chats: ChatView[], selectedId = 'space') {
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider delayDuration={0}>
            <ChatNav
              chats={chats}
              selectedId={selectedId}
              connected
              send={() => {}}
              select={(id) => selected.push(id)}
              askName={() => {}}
            />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
}

const names = () => [...host.querySelectorAll('nav button[title]')].map((b) => b.textContent!.replace('worker', ''))
const toggle = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
// Rows leave through an exit animation, so wait for it to finish.
const click = async (el: Element | null | undefined) => {
  act(() => (el as HTMLElement).click())
  await act(() => new Promise((done) => setTimeout(done, 50)))
}
const dotOf = (name: string) =>
  [...host.querySelectorAll('nav button[title]')].find((b) => b.textContent!.startsWith(name))!.querySelector('span')!

test('only a row with workers has a fold toggle', async () => {
  render([chat('space'), sub('a'), chat('alone', { createdAt: '2025-01-01T00:00:00.000Z' })])
  expect(host.querySelectorAll('button[aria-label="Hide workers"]')).toHaveLength(1)
  expect(toggle('Hide workers')!.getAttribute('aria-expanded')).toBe('true')
})

test("folding hides a space's workers and shows how many, without selecting it", async () => {
  render([chat('space'), sub('a'), sub('b'), chat('b-child', { parentId: 'b', worker: true })], 'other')
  expect(names()).toEqual(['space', 'a', 'b', 'b-child'])

  await click(toggle('Hide workers'))
  expect(names()).toEqual(['space'])
  const show = toggle('Show workers')!
  expect(show.getAttribute('aria-expanded')).toBe('false')
  expect(show.textContent).toBe('3')
  expect(selected).toEqual([])

  await click(show)
  expect(names()).toEqual(['space', 'a', 'b', 'b-child'])
})

test('nested workers fold under their own worker', async () => {
  render([chat('space'), sub('b'), chat('b-child', { parentId: 'b', worker: true })], 'other')
  await click(host.querySelectorAll('button[aria-label="Hide workers"]')[1])
  expect(names()).toEqual(['space', 'b'])
})

test('the folded state is kept after a reload', async () => {
  const chats = [chat('space'), sub('a')]
  render(chats, 'other')
  await click(toggle('Hide workers'))
  expect(JSON.parse(localStorage.getItem('kothar.foldedChats')!)).toEqual(['space'])

  act(() => root.unmount())
  root = createRoot(host)
  reloadFolded()
  render(chats, 'other')
  expect(names()).toEqual(['space'])
})

test('a folded row shows when a hidden worker is running or waiting', async () => {
  render([chat('space'), sub('a', { status: 'running' }), sub('b', { status: 'waiting' })], 'other')
  await click(toggle('Hide workers'))
  expect(dotOf('space').className).toContain('bg-amber')

  render([chat('space'), sub('a', { status: 'running' })], 'other')
  expect(dotOf('space').className).toContain('bg-green')

  render([chat('space'), sub('a')], 'other')
  expect(dotOf('space').className).toContain('bg-faint')
})

test('a stopping chat shows a grey dot, never the amber one that means it waits on you', () => {
  render([chat('space', { status: 'stopping' }), sub('a', { status: 'waiting' })], 'other')
  expect(dotOf('space').className).toContain('bg-muted')
  expect(dotOf('space').className).not.toContain('bg-amber')
  expect(dotOf('a').className).toContain('bg-amber')
})

test('the worker being viewed stays in the list when its space folds', async () => {
  render([chat('space'), sub('a'), sub('b')], 'a')
  await click(toggle('Hide workers'))
  expect(names()).toEqual(['space', 'a'])
})
