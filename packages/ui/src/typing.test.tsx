// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ClientMessage } from '@kothar/core/shared'
import { Chat } from './chat.tsx'
import type { ChatView, Item } from './state.ts'

// Counts Markdown parses: the costly part of rendering a transcript.
const parses = vi.hoisted(() => ({ count: 0 }))
vi.mock('react-markdown', async (load) => {
  const real = (await load()) as { default: (props: object) => unknown }
  return { ...real, default: (props: object) => (parses.count++, real.default(props)) }
})

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root
let container: HTMLElement

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** A long chat: 70 rounds of a question, a tool call and a Markdown reply. */
function longChat(): Item[] {
  const items: Item[] = []
  for (let i = 0; i < 70; i++) {
    items.push({ kind: 'user', text: `Question ${i}` })
    items.push({ kind: 'tool', toolId: `t${i}`, name: 'Bash', summary: 'ls', state: 'done', output: 'a\nb' })
    items.push({ kind: 'text', text: `## Answer ${i}\n\nSome **bold** text and a list:\n\n- one\n- two\n\n\`\`\`ts\nconst x = ${i}\n\`\`\`` })
  }
  return items
}

function render(items: Item[], send: (m: ClientMessage) => void = () => {}) {
  const view: ChatView = {
    id: 'c1',
    name: 'demo',
    folders: [],
    files: [],
    engine: 'fake',
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'idle',
    items,
    draft: '',
    queue: [],
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
              send={send}
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
              workFolder={{ defaultPath: '/work', canSandbox: true }}
            />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
}

function typeEach(text: string) {
  const box = container.querySelector('textarea')!
  for (let n = 1; n <= text.length; n++)
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text.slice(0, n))
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
}

test('typing in a long chat re-renders none of the transcript', () => {
  const sent: ClientMessage[] = []
  render(longChat(), (m) => sent.push(m))
  expect(parses.count).toBe(70)
  parses.count = 0
  typeEach('hello there')
  expect(parses.count).toBe(0)
  expect(localStorage.getItem('kothar.drafts')).toBeNull()
  const box = container.querySelector('textarea')!
  expect(box.value).toBe('hello there')
  act(() => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(sent.filter((m) => m.type === 'chat.send')).toEqual([{ type: 'chat.send', chatId: 'c1', text: 'hello there' }])
  expect(box.value).toBe('')
})

test('a new item in a long chat parses only its own Markdown', () => {
  const items = longChat()
  render(items)
  parses.count = 0
  render([...items, { kind: 'text', text: 'One more **reply**' }])
  expect(parses.count).toBe(1)
})

test("a sent message's lists render as lists, without a Markdown parse", () => {
  parses.count = 0
  render([{ kind: 'user', text: 'Two things:\n- a\n- b' }])
  const ul = container.querySelector('ul.list-disc')!
  expect([...ul.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['a', 'b'])
  expect(parses.count).toBe(0)
})

test('the message box continues and nests lists, and leaves other keys alone', () => {
  render([])
  const box = container.querySelector('textarea')!
  typeEach('- a')
  const key = (init: KeyboardEventInit) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    act(() => box.dispatchEvent(event))
    return event.defaultPrevented
  }
  box.setSelectionRange(3, 3)
  expect(key({ key: 'Enter', shiftKey: true })).toBe(true)
  expect(box.value).toBe('- a\n- ')
  expect(key({ key: 'Tab' })).toBe(true)
  expect(box.value).toBe('- a\n  - ')
  expect(key({ key: 'Enter', shiftKey: true })).toBe(true)
  expect(box.value).toBe('- a\n')
  // Mid-composition (IME), nothing happens.
  typeEach('- a\n- b')
  box.setSelectionRange(7, 7)
  expect(key({ key: 'Enter', shiftKey: true, isComposing: true })).toBe(false)
  expect(box.value).toBe('- a\n- b')
  // Off a list line, Tab and Shift+Enter keep their usual behaviour.
  typeEach('plain')
  box.setSelectionRange(5, 5)
  expect(key({ key: 'Tab' })).toBe(false)
  expect(key({ key: 'Enter', shiftKey: true })).toBe(false)
  expect(box.value).toBe('plain')
})
