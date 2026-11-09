// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ClientMessage } from '@hotrod/core/shared'
import { foldChat, reloadFolded } from './folded.ts'
import { ChatNav } from './sidebar.tsx'
import { initialState, reduce, type ChatView } from './state.ts'
import { useLooking, useMarkRead } from './unread.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const DONE = '2026-11-08T10:00:00.000Z'
const BEFORE = '2026-11-08T09:00:00.000Z'
const AFTER = '2026-11-08T11:00:00.000Z'

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
const finished = (id: string, change: Partial<ChatView> = {}) => chat(id, { doneAt: DONE, readAt: BEFORE, ...change })

let root: Root
let host: HTMLDivElement
let focused: boolean

beforeEach(() => {
  localStorage.clear()
  reloadFolded()
  focused = true
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

// Like the app: the sidebar and the open chat's read marker, with the window's focus.
function App({ chats, selectedId, send }: { chats: ChatView[]; selectedId: string; send: (m: ClientMessage) => void }) {
  const looking = useLooking()
  useMarkRead(
    chats.find((c) => c.id === selectedId),
    looking,
    send,
  )
  return (
    <ChatNav
      chats={chats}
      selectedId={selectedId}
      looking={looking}
      connected
      send={send}
      select={() => {}}
      askName={() => {}}
    />
  )
}

function render(chats: ChatView[], selectedId: string, send: (m: ClientMessage) => void = () => {}) {
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider delayDuration={0}>
            <App chats={chats} selectedId={selectedId} send={send} />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
}

const bold = () =>
  [...host.querySelectorAll('nav button[data-chat-id]')]
    .filter((b) => b.querySelector('[data-unread]'))
    .map((b) => b.getAttribute('data-chat-id'))

function setFocus(value: boolean) {
  focused = value
  act(() => dispatchEvent(new Event(value ? 'focus' : 'blur')))
}

test('a chat that finished in the background is bold, and only while idle', () => {
  render(
    [
      chat('open'),
      finished('done'),
      finished('running', { status: 'running' }),
      finished('waiting', { status: 'waiting' }),
      finished('seen', { readAt: AFTER }),
      chat('never'),
    ],
    'open',
  )
  expect(bold()).toEqual(['done'])
  const name = host.querySelector('[data-unread]')!
  expect(name.className).toContain('font-semibold')
  expect(name.closest('div')!.className).toContain('text-text')
})

test('opening a finished chat marks it read, and the read state clears the bold', () => {
  const sent: ClientMessage[] = []
  const send = (m: ClientMessage) => sent.push(m)
  const chats = [chat('open'), finished('done')]
  render(chats, 'open', send)
  expect(sent).toEqual([])

  render(chats, 'done', send)
  expect(sent).toEqual([{ type: 'chat.read', chatId: 'done' }])
  // It isn't bold while open, even before the core answers.
  expect(bold()).toEqual([])

  // The core's answer reaches every window, which then shows it read wherever it's open.
  let state = reduce({ ...initialState, chats }, { type: 'chat.updated', chat: { ...chats[1]!, readAt: AFTER } })
  render(state.chats, 'open', send)
  expect(bold()).toEqual([])
  expect(sent).toHaveLength(1)
  state = reduce(state, {
    type: 'chat.updated',
    chat: { ...state.chats[1]!, doneAt: '2026-11-08T12:00:00.000Z' },
  })
  render(state.chats, 'open', send)
  expect(bold()).toEqual(['done'])
})

test('a turn that ends in the open chat of a focused window is never bold', () => {
  const sent: ClientMessage[] = []
  render([chat('open', { status: 'running', readAt: BEFORE })], 'open', (m) => sent.push(m))
  render([finished('open')], 'open', (m) => sent.push(m))
  expect(bold()).toEqual([])
  expect(sent).toEqual([{ type: 'chat.read', chatId: 'open' }])
})

test('the open chat of a window the user is away from stays unread until they come back', () => {
  const sent: ClientMessage[] = []
  setFocus(false)
  render([finished('open')], 'open', (m) => sent.push(m))
  expect(bold()).toEqual(['open'])
  expect(sent).toEqual([])

  setFocus(true)
  expect(sent).toEqual([{ type: 'chat.read', chatId: 'open' }])
  expect(bold()).toEqual([])
})

test('a folded space is bold while a subagent it hides is unread', async () => {
  const chats = [chat('space'), finished('sub', { parentId: 'space', subagent: true }), chat('other')]
  render(chats, 'other')
  expect(bold()).toEqual(['sub'])

  // Rows leave through an exit animation, so wait for it to finish.
  const fold = async (folded: boolean) => {
    act(() => foldChat('space', folded))
    await act(() => new Promise((done) => setTimeout(done, 50)))
  }
  await fold(true)
  expect(bold()).toEqual(['space'])

  await fold(false)
  expect(bold()).toEqual(['sub'])
})
