// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { ClientMessage, ContextItem } from '@kothar/core/shared'
import { ContextPanel } from './context-panel.tsx'
import { initialState, reduce, terminalKey, type ChatView, type State } from './state.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const base: Omit<ChatView, 'id' | 'name'> = {
  folders: [],
  files: [],
  engine: 'fake',
  archived: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  status: 'idle',
  items: [],
  draft: '',
  queue: [],
}
const space: ChatView = {
  ...base,
  id: 'space',
  name: 'Space',
  folders: ['/code/app'],
  workDir: '/work/space',
  worktrees: { '/code/app': { path: '/work/space/app', branch: 'kothar/app' } },
}
const sub: ChatView = { ...base, id: 'sub', name: 'Sub', parentId: 'space', subagent: true }
const folder: ContextItem = { section: 'folders', path: '/code/app', from: 'space', enabled: true, text: '' }

let root: Root
let host: HTMLDivElement
let sent: ClientMessage[]

beforeEach(() => {
  localStorage.clear()
  sent = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function render(tab: 'context' | 'general', chatId = 'space', terminalErrors: State['terminalErrors'] = {}) {
  localStorage.setItem('kothar.panelTab', tab)
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider delayDuration={0}>
            <ContextPanel
              chatId={chatId}
              items={[folder]}
              chats={[space, sub]}
              workFolder={{ defaultPath: '/w', canSandbox: true }}
              readOnly={false}
              connected
              send={(m) => sent.push(m)}
              terminalErrors={terminalErrors}
            />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
}

const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

test('a folder card opens the terminal at the folder, and at its checkout', () => {
  render('context')
  act(() => button('Open /code/app in Terminal')!.click())
  act(() => button('Open the checkout /work/space/app in Terminal')!.click())
  expect(sent).toEqual([
    { type: 'terminal.open', chatId: 'space', path: '/code/app' },
    { type: 'terminal.open', chatId: 'space', path: '/work/space/app' },
  ])
})

test('the General tab opens the space’s work folder, from a subagent too', () => {
  render('general', 'sub')
  expect(host.querySelector('section[aria-label="Work folder"]')!.textContent).toContain('/work/space')
  act(() => button('Open the work folder in Terminal')!.click())
  expect(sent).toEqual([{ type: 'terminal.open', chatId: 'sub', path: '/work/space' }])
})

test('a failure shows inline under what failed, and a later success clears it', () => {
  let state = reduce(initialState, {
    type: 'terminal.result',
    chatId: 'space',
    path: '/code/app',
    error: "Couldn't open Ghostty. Is it installed?",
  })
  expect(state.terminalErrors).toEqual({ [terminalKey('space', '/code/app')]: "Couldn't open Ghostty. Is it installed?" })
  render('context', 'space', state.terminalErrors)
  expect(host.textContent).toContain("Couldn't open Ghostty. Is it installed?")
  // Not a toast.
  expect(state.toasts).toEqual([])
  state = reduce(state, { type: 'terminal.result', chatId: 'space', path: '/code/app' })
  expect(state.terminalErrors).toEqual({})
})
