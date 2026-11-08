// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Chat } from './chat.tsx'
import type { ChatView, Item } from './state.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const USER: Item = { kind: 'user', text: 'Hi' }
const tool = (state: 'running' | 'done', output = ''): Item => ({
  kind: 'tool',
  toolId: 't1',
  name: 'Bash',
  summary: 'ls',
  state,
  output,
})

let root: Root
let container: HTMLElement

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function render(chat: Partial<ChatView>) {
  const view: ChatView = {
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
    ...chat,
  }
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider>
            <Chat
              chat={view}
              chats={[view]}
              engines={[{ id: 'fake', enabled: true, installed: true, signedIn: true }]}
              connected
              send={() => {}}
              openSettings={() => {}}
              sidebarOpen
              toggleSidebar={() => {}}
              contextOpen={false}
              contextOverlay={false}
              toggleContext={() => {}}
              contextDefaults={{ agents: true, folders: true, files: true }}
              columnPx={720}
              setColumnPx={() => {}}
              notify={() => {}}
            />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
}

const working = () => container.querySelector('[aria-label="Working"]')

test('shows typing dots where the reply will appear while a turn runs and nothing streams yet', () => {
  render({ status: 'running', items: [USER] })
  const dots = working()
  expect(dots).not.toBeNull()
  const bubble = [...container.querySelectorAll('div')].find((d) => d.textContent === 'Hi' && !d.children.length)!
  expect(bubble.compareDocumentPosition(dots!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test('hides the dots once the reply streams, and when the turn ends', () => {
  render({ status: 'running', items: [USER], draft: 'Hel' })
  expect(working()).toBeNull()
  render({ status: 'idle', items: [USER, { kind: 'text', text: 'Hello' }] })
  expect(working()).toBeNull()
})

test('shows the dots between tool calls while the turn still runs', () => {
  render({ status: 'running', items: [USER, tool('done', 'a.txt')] })
  expect(working()).not.toBeNull()
})

test('a running tool shows the dots in its row instead of the transcript', () => {
  render({ status: 'running', items: [USER, tool('running')] })
  expect(working()).toBeNull()
  const row = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Bash'))!
  expect(row.querySelector('[aria-label="running"]')).not.toBeNull()
  act(() => row.click())
  expect(container.textContent).not.toContain('Running…')
  expect(container.querySelectorAll('[aria-label="running"]')).toHaveLength(2)
})
