// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ChatEntry, ChatState, ClientMessage, CoreMessage } from '@kothar/core/shared'
import { Chat, OLDER_PX } from './chat.tsx'
import { revealLater } from './search.tsx'
import { resetReveals } from './smooth.ts'
import { foldSteps, initialState, reduce, type ChatView, type State } from './state.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const at = '2026-01-01T00:00:00.000Z'
const user = (text: string): ChatEntry => ({ at, type: 'user.message', text })
const reply = (text: string): ChatEntry => ({
  at,
  type: 'text.completed',
  text,
})
const step = (id: string): ChatEntry[] => [
  {
    at,
    type: 'tool.started',
    toolId: id,
    name: 'Bash',
    kind: 'shell',
    summary: id,
    input: {},
  },
  { at, type: 'tool.completed', toolId: id, output: 'ok', isError: false },
]
const turn = (n: number): ChatEntry[] => [
  user(`question ${n}`),
  ...step(`a${n}`),
  ...step(`b${n}`),
  reply(`answer ${n}`),
]
const turns = (count: number) => Array.from({ length: count }, (_, n) => turn(n)).flat()

const chatState = (log: ChatEntry[], from: number): ChatState => ({
  id: 'c1',
  name: 'demo',
  folders: [],
  files: [],
  engine: 'fake',
  archived: false,
  createdAt: at,
  status: 'idle',
  entries: log.slice(from),
  ...(from > 0 && { from }),
  draft: '',
  queue: [],
})
const opened = (log: ChatEntry[], from: number): State =>
  reduce(initialState, {
    type: 'snapshot',
    chats: [chatState(log, from)],
  } as unknown as CoreMessage)
const older = (log: ChatEntry[], from: number, before: number): CoreMessage => ({
  type: 'chat.history',
  chatId: 'c1',
  before,
  from,
  entries: log.slice(from, before),
})
const chatOf = (state: State) => state.chats[0]!

describe('older pages in the state', () => {
  test('go in front, and a turn the page cut in two folds as one again', () => {
    const log = turns(3)
    // The loaded page starts mid-turn: after the first step of the second turn.
    const cut = log.indexOf(log.find((e) => e.type === 'tool.completed' && e.toolId === 'a1')!) + 1
    let state = opened(log, cut)
    const before = chatOf(state).items.length
    // The cut turn's one step left on this page doesn't fold; the whole turn after it does.
    expect(foldSteps(chatOf(state).items, false).filter((r) => 'steps' in r)).toHaveLength(1)

    state = reduce(state, older(log, 0, cut))
    const whole = reduce(initialState, {
      type: 'snapshot',
      chats: [chatState(log, 0)],
    } as unknown as CoreMessage)
    expect(chatOf(state).items).toEqual(chatOf(whole).items)
    expect(chatOf(state).from).toBe(0)
    expect(foldSteps(chatOf(state).items, false).filter((r) => 'steps' in r)).toHaveLength(3)
    expect(chatOf(state).shift).toBe(chatOf(state).items.length - before)
  })

  test('keep thinking that streamed in, and live entries after them', () => {
    const log = turns(4)
    let state = opened(log, 6)
    state = reduce(state, {
      type: 'chat.entry',
      chatId: 'c1',
      entry: user('more'),
    })
    state = reduce(state, {
      type: 'chat.thinking',
      chatId: 'c1',
      text: 'Hmm, ',
    })
    state = reduce(state, {
      type: 'chat.thinking',
      chatId: 'c1',
      text: 'let me look',
    })
    state = reduce(state, older(log, 0, 6))
    expect(chatOf(state).items.at(-1)).toEqual({
      kind: 'thinking',
      text: 'Hmm, let me look',
    })
    expect(chatOf(state).items.at(-2)).toEqual({ kind: 'user', text: 'more' })
    expect(chatOf(state).items[0]).toEqual({
      kind: 'user',
      text: 'question 0',
    })
  })

  test('that no longer fit where the loaded part starts are ignored', () => {
    const log = turns(4)
    const state = opened(log, 12)
    expect(reduce(state, older(log, 0, 6)).chats[0]).toBe(state.chats[0])
    expect(reduce(state, older(log, 6, 12)).chats[0]!.from).toBe(6)
  })
})

// The transcript in a fake layout: every element in the list is ROW_PX tall, in document order.
const VIEW_PX = 500
const ROW_PX = 100
const scrollTops = new WeakMap<Element, number>()
let root: Root
let container: HTMLElement
const list = () => container.querySelector<HTMLElement>('main .overflow-y-auto')!
const rows = () => [...list().querySelectorAll<HTMLElement>('[data-item-kind], [data-loading-older]')]
const layout = {
  scrollHeight: {
    configurable: true,
    get(this: HTMLElement) {
      return this === list() ? rows().length * ROW_PX : 0
    },
  },
  clientHeight: { configurable: true, get: () => VIEW_PX },
  offsetTop: {
    configurable: true,
    get(this: HTMLElement) {
      return Math.max(0, rows().indexOf(this)) * ROW_PX
    },
  },
  scrollTop: {
    configurable: true,
    get(this: Element) {
      return scrollTops.get(this) ?? 0
    },
    set(this: HTMLElement, top: number) {
      scrollTops.set(this, Math.max(0, Math.min(top, this.scrollHeight - VIEW_PX)))
    },
  },
}

beforeEach(() => {
  resetReveals()
  Object.defineProperties(HTMLElement.prototype, layout)
  HTMLElement.prototype.scrollTo = vi.fn()
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
  for (const key of [...Object.keys(layout), 'scrollTo'])
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key]
})

function render(chat: ChatView, send: (m: ClientMessage) => void) {
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider delayDuration={0}>
            <Chat
              chat={chat}
              chats={[chat]}
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

const scrollTo = (top: number) =>
  act(() => {
    list().scrollTop = top
    list().dispatchEvent(new Event('scroll'))
  })
const texts = () => rows().map((r) => r.textContent ?? '')

describe('the chat view', () => {
  test('asks for the older page near the top, shows it is loading, and keeps the view on the same row', () => {
    const log = turns(20)
    const from = 60
    let state = opened(log, from)
    const sent: ClientMessage[] = []
    render(chatOf(state), (m) => sent.push(m))
    expect(list().scrollTop).toBe(list().scrollHeight - VIEW_PX)
    expect(sent.filter((m) => m.type === 'chat.history')).toEqual([])

    scrollTo(OLDER_PX - 1)
    expect(sent.filter((m) => m.type === 'chat.history')).toEqual([
      { type: 'chat.history', chatId: 'c1', before: from },
    ])
    expect(container.querySelector('[aria-label="Loading earlier messages"]')).not.toBeNull()
    // Asked once per page, however much the user scrolls.
    scrollTo(OLDER_PX - 50)
    expect(sent.filter((m) => m.type === 'chat.history')).toHaveLength(1)

    const top = list().scrollTop
    const onScreen = texts()[Math.floor(top / ROW_PX)]
    state = reduce(state, older(log, 30, from))
    render(chatOf(state), (m) => sent.push(m))
    expect(container.querySelector('[aria-label="Loading earlier messages"]')).toBeNull()
    expect(texts()[Math.floor(list().scrollTop / ROW_PX)]).toBe(onScreen)
    expect(texts()[0]).toContain('question 5')
  })

  test('asks for nothing once the whole log is loaded', () => {
    const log = turns(20)
    const sent: ClientMessage[] = []
    render(chatOf(opened(log, 0)), (m) => sent.push(m))
    scrollTo(0)
    expect(sent.filter((m) => m.type === 'chat.history')).toEqual([])
    expect(container.querySelector('[aria-label="Loading earlier messages"]')).toBeNull()
  })

  test('opened from a search match older than what is loaded, loads back to it and shows it', () => {
    const log = turns(20)
    const from = 60
    let state = opened(log, from)
    const entry = log.findIndex((e) => e.type === 'user.message' && e.text === 'question 2')
    revealLater({ chatId: 'c1', query: 'question 2', nth: 0, entry })
    const sent: ClientMessage[] = []
    render(chatOf(state), (m) => sent.push(m))
    expect(sent.filter((m) => m.type === 'chat.history')).toEqual([
      { type: 'chat.history', chatId: 'c1', before: from, to: entry },
    ])

    state = reduce(state, older(log, entry, from))
    render(chatOf(state), (m) => sent.push(m))
    const revealed = container.querySelector<HTMLElement>('[data-revealed]')
    expect(revealed?.textContent).toContain('question 2')
  })
})
