// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ClientMessage, EngineInfo, ExtensionInfo, Setup } from '@kothar/core/shared'
import type { ChatView } from './state.ts'
import { SetupsPage, summaryOf } from './setups-page.tsx'
import { ContextPanel } from './context-panel.tsx'
import { choosePanelTab } from './panel-tab.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const engines: EngineInfo[] = [
  {
    id: 'cc',
    name: 'Claude Code',
    enabled: true,
    installed: true,
    signedIn: true,
    models: [
      { id: 'opus', label: 'Opus' },
      { id: 'haiku', label: 'Haiku' },
    ],
  },
]
const extension = (id: string, name: string, enabled = true): ExtensionInfo => ({
  id,
  name,
  description: '',
  enabled,
  settings: [],
  values: {},
})
const extensions = [extension('browser', 'Browser'), extension('notes', 'Notes'), extension('off', 'Off one', false)]
const reviewer: Setup = { id: 'aa11', name: 'Reviewer', engine: 'cc', model: 'opus', thinking: 'high', extensionsOff: ['browser'], instructions: 'Review only.' }

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const wrap = (children: React.ReactNode) => (
  <LazyMotion features={domAnimation} strict>
    <MotionConfig transition={{ duration: 0 }}>
      <Tooltip.Provider delayDuration={0}>{children}</Tooltip.Provider>
    </MotionConfig>
  </LazyMotion>
)

type Saved = { count: number; id?: string; error?: string }

function renderPage(setups: Setup[], saved?: Saved, sent: ClientMessage[] = [], shown = extensions) {
  act(() =>
    root.render(
      wrap(<SetupsPage setups={setups} engines={engines} extensions={shown} connected send={(m) => sent.push(m)} saved={saved} />),
    ),
  )
  return sent
}

const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === name) as HTMLButtonElement | undefined
const click = (name: string) => act(() => button(name)!.click())
const nameInput = () => host.querySelector<HTMLInputElement>('input[placeholder="e.g. Reviewer"]')!
const type = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const submit = (name: string) => act(() => button(name)!.closest('form')!.requestSubmit())

test('sums each setup up in one line, or says it follows Settings', () => {
  expect(summaryOf(reviewer, engines, extensions)).toBe('Opus · Claude Code · High thinking · Without Browser · Instructions')
  expect(summaryOf({ id: 'b', name: 'Plain' }, engines, extensions)).toBe('Follows Settings')
  expect(summaryOf({ id: 'c', name: 'Engine', engine: 'cc' }, engines, extensions)).toBe("Claude Code's default model")
})

test('makes a new setup with just a name, refusing a name another setup has', () => {
  const sent = renderPage([reviewer])
  expect(host.textContent).toContain('Reviewer')
  click('New setup')
  type(nameInput(), 'reviewer')
  expect(host.textContent).toContain('A setup named "reviewer" already exists')
  expect(button('Create')!.disabled).toBe(true)
  type(nameInput(), '  Quick fixes ')
  submit('Create')
  expect(sent).toEqual([{ type: 'setup.save', setup: { name: 'Quick fixes' } }])
})

test('edits a setup in place, keeping its id and what it sets', () => {
  const sent = renderPage([reviewer])
  click('Edit')
  expect(nameInput().value).toBe('Reviewer')
  // Only extensions that are on are listed; the setup's own left-out one shows off.
  const switches = [...host.querySelectorAll('[role="switch"]')].map((s) => [s.getAttribute('aria-label'), s.getAttribute('aria-checked')])
  expect(switches).toEqual([
    ['Agents start workers in this setup', 'true'],
    ['Browser in this setup', 'false'],
    ['Notes in this setup', 'true'],
  ])
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Notes in this setup"]')!.click())
  // Workers are the core's: a setup keeps its chats from starting them with workers: false.
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Agents start workers in this setup"]')!.click())
  submit('Save')
  expect(sent).toEqual([{ type: 'setup.save', setup: { ...reviewer, extensionsOff: ['browser', 'notes'], workers: false } }])
})

test('duplicates a setup under a new name as a new one', () => {
  const sent = renderPage([reviewer, { id: 'bb22', name: 'Reviewer copy' }])
  act(() => [...host.querySelectorAll('button')].filter((b) => b.textContent === 'Duplicate')[0]!.click())
  expect(nameInput().value).toBe('Reviewer copy 2')
  submit('Create')
  const { id: _, ...copy } = reviewer
  expect(sent).toEqual([{ type: 'setup.save', setup: { ...copy, name: 'Reviewer copy 2' } }])
})

test('duplicating while the New setup form is open fills the form with the copy', () => {
  const sent = renderPage([reviewer])
  click('New setup')
  expect(nameInput().value).toBe('')
  click('Duplicate')
  expect(nameInput().value).toBe('Reviewer copy')
  submit('Create')
  const { id: _, ...copy } = reviewer
  expect(sent).toEqual([{ type: 'setup.save', setup: { ...copy, name: 'Reviewer copy' } }])
})

test('keeps the form open until the core saves it, and shows a refusal inline with everything typed kept', () => {
  const sent = renderPage([], { count: 3 })
  click('New setup')
  type(nameInput(), 'Quick fixes')
  submit('Create')
  expect(sent).toHaveLength(1)
  // Waiting for the core: still open, and can't be sent twice.
  expect(nameInput().value).toBe('Quick fixes')
  expect(button('Create')!.disabled).toBe(true)
  renderPage([], { count: 4, error: 'Engine "cc" offers no model "opus"' }, sent)
  expect(nameInput().value).toBe('Quick fixes')
  expect(host.textContent).toContain('Engine "cc" offers no model "opus"')
  expect(button('Create')!.disabled).toBe(false)
  submit('Create')
  expect(host.textContent).not.toContain('offers no model')
  const quick = { id: 'cc33', name: 'Quick fixes' }
  renderPage([quick], { count: 5, id: quick.id }, sent)
  expect(host.querySelector('form')).toBeNull()
  expect(sent).toHaveLength(2)
})

test("doesn't list an extension with a chat of its own (Home) to leave out", () => {
  renderPage([reviewer], undefined, [], [...extensions, { ...extension('home', 'Home'), ownsChat: true }])
  click('Edit')
  const labels = [...host.querySelectorAll('[role="switch"]')].map((s) => s.getAttribute('aria-label'))
  expect(labels).toEqual(['Agents start workers in this setup', 'Browser in this setup', 'Notes in this setup'])
})

const space: ChatView = {
  id: 'space',
  name: 'Space',
  folders: [],
  files: [],
  engine: 'cc',
  archived: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  status: 'idle',
  items: [],
  draft: '',
  queue: [],
}

function renderPanel(chat: ChatView, setups: Setup[], openSetups = () => {}) {
  choosePanelTab('general')
  act(() =>
    root.render(
      wrap(
        <ContextPanel
          chatId={chat.id}
          items={[]}
          chats={[chat]}
          workFolder={{ defaultPath: '/w', canSandbox: true }}
          readOnly={false}
          connected
          send={() => {}}
          setups={setups}
          openSetups={openSetups}
        />,
      ),
    ),
  )
}

test("shows the chat's setup in its General tab, with a way to Settings → Setups", () => {
  const openSetups = vi.fn()
  renderPanel({ ...space, setup: 'aa11' }, [reviewer], openSetups)
  expect(host.querySelector('button[aria-label="Setup"]')!.textContent).toBe('Reviewer')
  click('Edit setups…')
  expect(openSetups).toHaveBeenCalled()
  renderPanel(space, [])
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="Setup"]')!.disabled).toBe(true)
  expect(button('Make a setup…')).toBeDefined()
})

test('shows no setup picker for a worker, which uses its space’s setup', () => {
  renderPanel({ ...space, id: 'w1', name: 'Worker', parentId: 'space', worker: true }, [reviewer])
  expect(host.querySelector('button[aria-label="Setup"]')).toBeNull()
})
