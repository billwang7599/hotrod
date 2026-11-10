// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ChatNav, NameDialog, SidebarFooter, type NameRequest } from './sidebar.tsx'
import type { ChatView } from './state.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root
let container: HTMLElement

beforeEach(() => {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

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

const HOME = chat({ id: 'main', name: 'Home', extension: 'home', createdAt: '2025-01-01T00:00:00.000Z' })
const SPACE = chat({ id: 's1', name: 'Kothar' })
const WORKER = chat({ id: 'w1', name: 'Worker', parentId: 's1', worker: true })

function render(chats: ChatView[], selected: string[] = []) {
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider delayDuration={0}>
            <ChatNav
              chats={chats}
              selectedId=""
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

const spaces = () => container.querySelector('[role="group"][aria-labelledby="spaces-label"]')!
const names = (el: Element) => [...el.querySelectorAll('button[title]')].map((b) => b.textContent)
const rowOf = (name: string) =>
  [...container.querySelectorAll('button[title]')].find((b) => b.textContent === name) as HTMLButtonElement

test('Home sits above the spaces, outside their section, and still selects; Home and workers get no row menu', () => {
  const selected: string[] = []
  render([SPACE, WORKER, HOME], selected)
  expect(container.querySelector('#spaces-label')?.textContent).toBe('spaces')
  expect(names(spaces())).toEqual(['Kothar', 'Workerworker'])
  const home = rowOf('Home')
  expect(spaces().contains(home)).toBe(false)
  expect(home.compareDocumentPosition(spaces()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(home.querySelector('svg')).not.toBeNull()
  expect(container.querySelector('[aria-label="More for Home"]')).toBeNull()
  expect(container.querySelector('[aria-label="More for Kothar"]')).not.toBeNull()
  expect(container.querySelector('[aria-label="More for Worker"]')).toBeNull()
  act(() => home.click())
  expect(selected).toEqual(['main'])
})

test('with Home off, only the spaces show', () => {
  render([SPACE, WORKER])
  expect(rowOf('Home')).toBeUndefined()
  expect(names(spaces())).toEqual(['Kothar', 'Workerworker'])
  expect(names(container)).toEqual(names(spaces()))
})

function Sidebar({ connected }: { connected: boolean }) {
  const [request, setRequest] = useState<NameRequest | null>(null)
  return (
    <>
      <ChatNav
        chats={[SPACE]}
        selectedId=""
        connected={connected}
        send={() => {}}
        select={() => {}}
        askName={setRequest}
        newSpaceKeys="Mod+N"
      />
      <SidebarFooter settingsKeys="Mod+," openSettings={() => {}} />
      <NameDialog request={request} connected={connected} send={() => {}} close={() => setRequest(null)} />
    </>
  )
}

function renderSidebar(connected = true) {
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider delayDuration={0}>
            <Sidebar connected={connected} />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
}

const buttonsEnding = (label: string) =>
  [...container.querySelectorAll('button')].filter((b) => b.textContent?.endsWith(label)) as HTMLButtonElement[]

test('the sidebar has one New space button, under the spaces; it opens the name dialog and is off while disconnected', () => {
  renderSidebar()
  const [newSpace, ...more] = buttonsEnding('New space')
  expect(more).toEqual([])
  expect(newSpace!.closest('nav')).not.toBeNull()
  expect(newSpace!.hasAttribute('data-hint')).toBe(true)
  // Full width like the space rows, label on the left: the tooltip adds no wrapper around it.
  expect(newSpace!.parentElement!.tagName).toBe('NAV')
  expect(newSpace!.className).toContain('w-full')
  expect(newSpace!.className).not.toContain('self-end')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  act(() => newSpace!.click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  renderSidebar(false)
  expect(buttonsEnding('New space')[0]!.disabled).toBe(true)
  expect(buttonsEnding('Settings')[0]!.disabled).toBe(false)
})
