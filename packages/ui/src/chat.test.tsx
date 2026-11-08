// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Chat, FOLLOW_PX, JUMP_BELOW_PX } from './chat.tsx'
import { PERMISSIONS } from './context-panel.tsx'
import { showPaths } from './paths.ts'
import { reloadSteps, showStepsByDefault } from './steps.ts'
import {
  GLOBAL_CONTEXT,
  PERMISSION_DEFAULTS,
  PERMISSION_SWITCHES,
  type ClientMessage,
  type ContextItem,
  type ToolKind,
  type WorkFolder,
} from '@hotrod/core/shared'
import type { ChatView, Item } from './state.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const USER: Item = { kind: 'user', text: 'Hi' }
type Tool = Extract<Item, { kind: 'tool' }>
const tool = (state: Tool['state'], output = '', change: Partial<Tool> = {}): Item => ({
  kind: 'tool',
  toolId: 't1',
  name: 'Bash',
  summary: 'ls',
  state,
  output,
  ...change,
})

const VIEW_PX = 500
const page = { scrollHeight: 2000 }
const tops = new WeakMap<Element, number>()
const sizes = {
  scrollHeight: { configurable: true, get: () => page.scrollHeight },
  clientHeight: { configurable: true, get: () => VIEW_PX },
  scrollTop: {
    configurable: true,
    get(this: Element) {
      return tops.get(this) ?? 0
    },
    set(this: Element, top: number) {
      tops.set(this, Math.max(0, Math.min(top, page.scrollHeight - VIEW_PX)))
    },
  },
}
let resizeCallbacks: (() => void)[]
let root: Root
let container: HTMLElement

beforeEach(() => {
  page.scrollHeight = 2000
  resizeCallbacks = []
  Object.defineProperties(HTMLElement.prototype, sizes)
  HTMLElement.prototype.scrollTo = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      targets: Element[] = []
      constructor(callback: (entries: ResizeObserverEntry[]) => void) {
        const entries = () => this.targets.map((target) => ({ target, contentRect: { width: 700 } }))
        resizeCallbacks.push(() => callback(entries() as unknown as ResizeObserverEntry[]))
      }
      observe(target: Element) {
        this.targets.push(target)
      }
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
  for (const key of [...Object.keys(sizes), 'scrollTo']) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key]
})

type RenderOptions = {
  workFolder?: Partial<WorkFolder>
  contextOpen?: boolean
  contextItems?: ContextItem[]
  folder?: string
}

function render(chat: Partial<ChatView>, send: (m: ClientMessage) => void = () => {}, options: RenderOptions = {}) {
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
          <Tooltip.Provider delayDuration={0}>
            <Chat
              chat={view}
              folder={options.folder}
              chats={[view]}
              engines={[{ id: 'fake', enabled: true, installed: true, signedIn: true }]}
              connected
              send={send}
              openSettings={() => {}}
              sidebarOpen
              toggleSidebar={() => {}}
              contextOpen={options.contextOpen ?? false}
              contextItems={options.contextItems}
              contextOverlay={false}
              toggleContext={() => {}}
              contextDefaults={{ agents: true, folders: true, files: true }}
              columnPx={720}
              setColumnPx={() => {}}
              notify={() => {}}
              workFolder={{ defaultPath: '/work', canSandbox: true, ...options.workFolder }}
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

const list = () => container.querySelector<HTMLElement>('main .overflow-y-auto')!
const bottom = () => page.scrollHeight - VIEW_PX
const jumpButton = () => container.querySelector<HTMLButtonElement>('[aria-label="Scroll to bottom"]')
const grow = (px: number) => {
  page.scrollHeight += px
  act(() => resizeCallbacks.forEach((callback) => callback()))
}
const scrollTo = (top: number) =>
  act(() => {
    list().scrollTop = top
    list().dispatchEvent(new Event('scroll'))
  })

function type(text: string) {
  const area = container.querySelector('textarea')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, text)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => {
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

const REPLY: Item = { kind: 'text', text: 'Hello' }

test('a chat opens scrolled to the bottom', () => {
  render({ items: [USER, REPLY] })
  expect(list().scrollTop).toBe(bottom())
})

test('streamed output keeps the view at the bottom while the user is there', () => {
  render({ status: 'running', items: [USER, REPLY], draft: 'More' })
  page.scrollHeight += 800
  render({ status: 'running', items: [USER, REPLY], draft: 'More and more' })
  expect(list().scrollTop).toBe(bottom())
  grow(300)
  expect(list().scrollTop).toBe(bottom())
  scrollTo(bottom() - FOLLOW_PX)
  grow(300)
  expect(list().scrollTop).toBe(bottom())
})

test('streamed output never drags the view once the user scrolls up', () => {
  render({ status: 'running', items: [USER, REPLY], draft: 'More' })
  scrollTo(bottom() - FOLLOW_PX - 1)
  const top = list().scrollTop
  page.scrollHeight += 800
  render({ status: 'running', items: [USER, REPLY], draft: 'More and more' })
  render({ status: 'running', items: [USER, REPLY, { kind: 'text', text: 'More and more' }, tool('running')] })
  grow(300)
  expect(list().scrollTop).toBe(top)
  expect(jumpButton()).not.toBeNull()
  scrollTo(bottom())
  grow(300)
  expect(list().scrollTop).toBe(bottom())
})

test('a down button shows once more than the threshold of output is below the view', async () => {
  render({ status: 'running', items: [USER, REPLY], draft: 'More' })
  scrollTo(bottom() - FOLLOW_PX - 1)
  grow(JUMP_BELOW_PX - FOLLOW_PX - 1)
  expect(jumpButton()).toBeNull()
  grow(1)
  expect(jumpButton()).not.toBeNull()
  scrollTo(bottom() - JUMP_BELOW_PX)
  await vi.waitFor(() => expect(jumpButton()).toBeNull())
})

test('the down button turns amber while a permission request waits below', () => {
  render({ status: 'running', items: [USER, REPLY], draft: 'More' })
  scrollTo(0)
  grow(JUMP_BELOW_PX * 3)
  expect(jumpButton()!.className).not.toContain('text-amber')
  render({ status: 'waiting', items: [USER, REPLY] })
  const asking = container.querySelector<HTMLButtonElement>('[aria-label="Scroll to the permission request"]')!
  expect(asking.className).toContain('text-amber')
})

test('the down button smooth-scrolls to the bottom, hides there and follows output again', async () => {
  render({ status: 'running', items: [USER, REPLY], draft: 'More' })
  scrollTo(0)
  grow(JUMP_BELOW_PX * 3)
  act(() => jumpButton()!.click())
  expect(list().scrollTo).toHaveBeenCalledWith({ top: page.scrollHeight, behavior: 'smooth' })
  scrollTo(400)
  scrollTo(bottom())
  await vi.waitFor(() => expect(jumpButton()).toBeNull())
  page.scrollHeight += 800
  render({ status: 'running', items: [USER, REPLY], draft: 'More and more' })
  expect(list().scrollTop).toBe(bottom())
})

test('sending scrolls to the bottom and follows the reply until the user scrolls up', () => {
  const send = vi.fn()
  render({ items: [USER, REPLY] }, send)
  scrollTo(0)
  type('Next')
  expect(send).toHaveBeenCalledWith({ type: 'chat.send', chatId: 'c1', text: 'Next' })
  const asked: Item[] = [USER, REPLY, { kind: 'user', text: 'Next' }]
  page.scrollHeight += 100
  render({ items: asked })
  expect(list().scrollTop).toBe(bottom())
  page.scrollHeight += 30
  render({ status: 'running', items: asked })
  expect(list().scrollTop).toBe(bottom())
  page.scrollHeight += 40
  render({ status: 'running', items: [...asked, { kind: 'thinking', text: 'Hmm' }] })
  expect(list().scrollTop).toBe(bottom())
  page.scrollHeight += 600
  render({ status: 'running', items: [...asked, { kind: 'thinking', text: 'Hmm' }], draft: 'A long reply' })
  expect(list().scrollTop).toBe(bottom())
  scrollTo(0)
  page.scrollHeight += 600
  render({ status: 'running', items: [...asked, { kind: 'thinking', text: 'Hmm' }], draft: 'A longer reply' })
  expect(list().scrollTop).toBe(0)
})

test('queueing a message during a turn scrolls to the bottom and follows from there', () => {
  render({ status: 'running', items: [USER, REPLY], draft: 'More' })
  scrollTo(0)
  type('Later')
  expect(list().scrollTop).toBe(bottom())
  page.scrollHeight += 300
  render({ status: 'running', items: [USER, REPLY, tool('running')] })
  expect(list().scrollTop).toBe(bottom())
})

test('the header warns while a chat may edit anywhere, and where nothing is sandboxed', () => {
  const header = () => container.querySelector('header')!.textContent
  render({})
  expect(header()).not.toMatch(/Edits anywhere|Not sandboxed/)
  render({ editAnywhere: true })
  expect(header()).toContain('Edits anywhere')
  render({}, () => {}, { workFolder: { editAnywhere: true } })
  expect(header()).toContain('Edits anywhere')
  render({}, () => {}, { workFolder: { canSandbox: false } })
  expect(header()).toContain('Not sandboxed')
  expect(header()).not.toContain('Edits anywhere')
})

const hintOf = async (element: Element) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return document.querySelector('[role="tooltip"]')?.textContent
}

const rowButtons = () => [...list().querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
const foldButton = () => rowButtons().find((b) => /^\d+ steps$/.test(b.textContent ?? ''))
const before = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

test('a finished turn folds its steps into one row above the reply, which opens and closes in place', async () => {
  const steps: Item[] = [tool('done', 'a.txt'), { kind: 'text', text: 'Installing them.' }, tool('done', '', { toolId: 't2' })]
  const items: Item[] = [USER, ...steps, { kind: 'text', text: 'All set' }]
  render({ status: 'running', items })
  expect(foldButton()).toBeUndefined()
  expect(container.textContent).toContain('Installing them.')

  render({ status: 'idle', items })
  const fold = foldButton()!
  expect(fold.textContent).toBe('3 steps')
  expect(container.textContent).not.toContain('Installing them.')
  expect(rowButtons()).toEqual([fold])
  const reply = [...container.querySelectorAll('p')].find((p) => p.textContent === 'All set')!
  expect(before(fold, reply)).toBe(true)

  act(() => fold.click())
  expect(fold.getAttribute('aria-expanded')).toBe('true')
  expect(container.textContent).toContain('Installing them.')
  const chevronTurned = (b: Element) => !!b.firstElementChild!.closest('.group[data-open]')
  expect(rowButtons().map(chevronTurned)).toEqual([true, false, false])
  act(() => fold.click())
  await vi.waitFor(() => expect(container.textContent).not.toContain('Installing them.'))
})

test('a turn that ended without a reply keeps its last line below the fold, and one step never folds', () => {
  const looked: Item[] = [tool('done'), { kind: 'text', text: 'Looking.' }, tool('stopped', '', { toolId: 't2' })]
  render({ items: [USER, ...looked, { kind: 'error', text: 'Interrupted' }] })
  expect(foldButton()?.textContent).toBe('3 steps')
  expect(container.textContent).toContain('Interrupted')
  render({ items: [USER, tool('done'), { kind: 'text', text: 'Done' }] })
  expect(foldButton()).toBeUndefined()
  expect(rowButtons().map((b) => b.textContent)).toEqual([expect.stringContaining('Bash')])
})

test('thinking and tool calls show unfolded by default from Settings, and each chat overrides that in its panel', () => {
  Element.prototype.scrollIntoView = vi.fn()
  localStorage.clear()
  reloadSteps()
  const steps: Item[] = [{ kind: 'thinking', text: 'Pondering' }, tool('done', 'a.txt'), { kind: 'text', text: 'Hm.' }]
  const items: Item[] = [USER, ...steps, { kind: 'text', text: 'All set' }]
  const open = () => rowButtons().map((b) => b.getAttribute('aria-expanded'))
  render({ items }, () => {}, { contextOpen: true })
  expect(foldButton()?.textContent).toBe('3 steps')

  act(() => showStepsByDefault(true))
  expect(foldButton()).toBeUndefined()
  expect(open()).toEqual(['true', 'true'])
  expect(container.textContent).toContain('Pondering')
  act(() => rowButtons()[1]!.click())
  expect(open()).toEqual(['true', 'false'])

  expect(container.querySelector('aside button[aria-label="Thinking and tool calls"]')).toBeNull()
  const general = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((t) => t.textContent === 'General')!
  act(() => general.click())
  const select = () => container.querySelector<HTMLButtonElement>('aside button[aria-label="Thinking and tool calls"]')!
  expect(select().textContent).toBe('Default (Unfolded)')
  act(() => select().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  const folded = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === 'Folded')!
  act(() => folded.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(select().textContent).toBe('Folded')
  expect(foldButton()?.textContent).toBe('3 steps')
  render({ id: 'c2', items }, () => {}, { contextOpen: true })
  expect(foldButton()).toBeUndefined()

  act(() => showStepsByDefault(false))
  localStorage.clear()
  reloadSteps()
})

test("a permission shows on its tool's row: the prompt under it while pending, then a verdict badge", async () => {
  const asked = { requestId: 'r1', name: 'Bash', summary: 'ls', input: { command: 'ls' } }
  type Outcome = 'pending' | 'allowed' | 'denied'
  const withVerdict = (toolId: string, outcome: Outcome, auto?: true, toolKind: ToolKind = 'shell'): Item =>
    tool(outcome === 'pending' ? 'waiting' : 'done', '', {
      toolId,
      permission: { ...asked, toolKind, requestId: `r-${toolId}`, outcome, ...(auto && { auto }) },
    })
  const sent: ClientMessage[] = []
  render({ status: 'waiting', items: [USER, withVerdict('t1', 'pending')] }, (m) => sent.push(m))
  const [row] = rowButtons()
  expect(rowButtons()).toHaveLength(1)
  expect(row!.textContent).toContain('waiting for approval')
  const approve = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Approve')!
  expect(before(row!, approve)).toBe(true)
  act(() => approve.click())
  expect(sent.at(-1)).toEqual({ type: 'permission.respond', chatId: 'c1', requestId: 'r-t1', allow: true })

  const verdicts = [
    withVerdict('t1', 'allowed'),
    withVerdict('t2', 'allowed', true),
    withVerdict('t3', 'denied', true, 'edit'),
  ]
  render({ status: 'running', items: [USER, ...verdicts, withVerdict('t4', 'denied')] })
  const rows = rowButtons()
  expect(rows).toHaveLength(4)
  const badges = rows.map((b) => b.querySelector('[data-verdict]')?.textContent)
  expect(badges).toEqual(['Allowed', 'Allowed automatically', 'Denied', 'Denied'])
  expect(container.textContent).not.toContain('Approve')
  expect(await hintOf(rows[2]!.querySelector('[data-verdict]')!)).toContain('outside the work folder')
})

test('says why Hotrod allowed a command or an edit without asking', async () => {
  const allowed = (toolKind: 'shell' | 'edit'): Item =>
    tool('done', '', {
      permission: { requestId: 'r1', name: 'X', toolKind, summary: 'x', input: {}, outcome: 'allowed', auto: true },
    })
  const badge = () => container.querySelector('[data-verdict]')!
  render({ items: [USER, allowed('shell')] })
  expect(await hintOf(badge())).toMatch(/command.*sandbox/)
  act(() => root.render(<></>))
  render({ items: [USER, allowed('edit')] })
  expect(await hintOf(badge())).toContain('edit inside the work folder')
})

test('a permission without a tool row keeps a row of its own, with the same badge', () => {
  const permission: Item = {
    kind: 'permission',
    requestId: 'r1',
    name: 'Write',
    toolKind: 'edit',
    summary: '/x.ts',
    input: {},
    outcome: 'denied',
  }
  render({ status: 'running', items: [USER, permission] })
  const [row] = rowButtons()
  expect(row!.textContent).toContain('Write')
  expect(row!.querySelector('[data-verdict]')?.textContent).toBe('Denied')
})

test('the global AGENTS.md is editable in every chat, Home too, and saves as the global instructions', async () => {
  const global: ContextItem = { section: 'agents', path: '/g/AGENTS.md', from: GLOBAL_CONTEXT, enabled: true, text: 'OLD' }
  const box = () => container.querySelector('textarea[aria-label="AGENTS.md of Global"]') as HTMLTextAreaElement
  for (const chat of [{}, { id: 'main', name: 'Home', mod: 'home' }]) {
    const sent: ClientMessage[] = []
    render(chat, (m) => sent.push(m), { contextOpen: true, contextItems: [global] })
    expect(box().readOnly).toBe(false)
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box(), 'NEW')
      box().dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => box().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(sent.at(-1)).toEqual({ type: 'instructions.write', text: 'NEW' })
  }
  const pill = [...container.querySelectorAll('aside[aria-label="Context"] span')].find((s) => s.textContent === 'Every chat')!
  expect(await hintOf(pill)).toContain('changes it everywhere')
})

test("each panel tab folds its explanations under How this works, not in tooltips", () => {
  localStorage.clear()
  render({}, () => {}, { contextOpen: true })
  const about = () => container.querySelector<HTMLDetailsElement>('aside details')!
  expect(about().open).toBe(false)
  expect(about().querySelector('summary')!.textContent).toBe('How this works')
  expect(about().textContent).toContain('Folders:')
  const tab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((t) => t.textContent === 'Permissions')!
  act(() => tab.click())
  expect(about().textContent).toContain(`${PERMISSIONS.editAnywhere.label}:`)
  expect(container.querySelectorAll('aside [data-hint]').length).toBe(0)
  localStorage.clear()
})

test('a subagent is view only: no composer, just a Stop button while it runs', () => {
  const sent: ClientMessage[] = []
  render({ subagent: true, parentId: 'p1', status: 'running' }, (m) => sent.push(m))
  expect(container.querySelector('textarea')).toBeNull()
  const bar = container.querySelector('[aria-label="Subagent"]')!
  expect(bar.textContent).toContain('view only')
  const stop = [...bar.querySelectorAll('button')].find((b) => b.textContent === 'Stop')!
  act(() => stop.click())
  expect(sent.at(-1)).toEqual({ type: 'chat.interrupt', chatId: 'c1' })
  render({ subagent: true, parentId: 'p1', status: 'idle' })
  expect(container.querySelector('[aria-label="Subagent"] button')).toBeNull()
})

test('while busy, the empty composer shows its status as a sweeping highlight instead of a plain placeholder', () => {
  const box = () => container.querySelector('textarea')!
  const shimmer = () => container.querySelector('.shimmer')
  render({ status: 'idle' })
  expect(shimmer()).toBeNull()
  expect(box().placeholder).toBe('Message')
  render({ status: 'running' })
  expect(shimmer()!.textContent).toBe('Working… Enter queues a message')
  expect(box().getAttribute('placeholder')).toBeNull()
  expect(box().getAttribute('aria-placeholder')).toBe('Working… Enter queues a message')
  render({ status: 'waiting' })
  expect(shimmer()!.getAttribute('data-status')).toBe('waiting')
})

test('the right panel shows context and permissions as two tabs, remembering the last one', () => {
  localStorage.clear()
  const tab = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('aside [role="tab"]')].find((t) => t.textContent === name)!
  const permission = () => container.querySelector(`aside button[aria-label="${PERMISSIONS.editAnywhere.label}"]`)
  render({}, () => {}, { contextOpen: true })
  expect(tab('Context').getAttribute('aria-selected')).toBe('true')
  expect(permission()).toBeNull()
  expect(container.querySelector('aside section[aria-label="AGENTS.md"]')).not.toBeNull()
  act(() => tab('Permissions').click())
  expect(permission()).not.toBeNull()
  expect(container.querySelector('aside section[aria-label="AGENTS.md"]')).toBeNull()
  act(() => root.render(<></>))
  render({}, () => {}, { contextOpen: true })
  expect(tab('Permissions').getAttribute('aria-selected')).toBe('true')
  localStorage.clear()
})

test('file paths stay hidden at the top of a space and in the Context panel until Settings shows them', () => {
  const item: ContextItem = { section: 'folders', path: '/repo/app', from: 'c1', enabled: true, text: '' }
  const shows = (path: string) => [...container.querySelectorAll('span')].some((s) => s.textContent === path)
  render({}, () => {}, { contextOpen: true, contextItems: [item], folder: '/repo/app' })
  expect(shows('/repo/app')).toBe(false)
  act(() => showPaths('header', true))
  expect(container.querySelector('header')!.textContent).toContain('/repo/app')
  expect(container.querySelector('aside')!.textContent).not.toContain('/repo/app')
  act(() => showPaths('context', true))
  expect(container.querySelector('aside')!.textContent).toContain('/repo/app')
  act(() => {
    showPaths('header', false)
    showPaths('context', false)
  })
})

test('every chat, Home too, overrides each permission default in its Context panel', () => {
  Element.prototype.scrollIntoView = vi.fn()
  localStorage.setItem('hotrod.panelTab', 'permissions')
  const choose = (select: HTMLButtonElement, option: (text: string) => boolean) => {
    act(() => select.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    const item = [...document.querySelectorAll('[role="option"]')].find((o) => option(o.textContent ?? ''))!
    act(() => item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  }
  for (const name of PERMISSION_SWITCHES) {
    const select = () =>
      container.querySelector<HTMLButtonElement>(`aside button[aria-label="${PERMISSIONS[name].label}"]`)!
    const [fallback, flipped] = PERMISSION_DEFAULTS[name] ? ['On', 'Off'] : ['Off', 'On']
    for (const chat of [{}, { id: 'main', name: 'Home', mod: 'home' }]) {
      const sent: ClientMessage[] = []
      render(chat, (m) => sent.push(m), { contextOpen: true })
      expect(select().textContent).toBe(`Default (${fallback})`)
      choose(select(), (text) => text.endsWith(flipped))
      const chatId = 'id' in chat ? chat.id : 'c1'
      expect(sent.at(-1)).toEqual({ type: 'chat.setPermission', chatId, name, enabled: !PERMISSION_DEFAULTS[name] })
    }

    render({}, () => {}, { contextOpen: true, workFolder: { [name]: !PERMISSION_DEFAULTS[name] } })
    expect(select().textContent).toBe(`Default (${flipped})`)
    const sent: ClientMessage[] = []
    render({ [name]: true }, (m) => sent.push(m), { contextOpen: true })
    expect(select().textContent).toBe('On')
    choose(select(), (text) => text.includes('Default'))
    expect(sent.at(-1)).toEqual({ type: 'chat.setPermission', chatId: 'c1', name })
  }
  localStorage.clear()
})

test('a chat turns edits anywhere off while Settings turns it on by default, its label amber only while on', () => {
  const { label } = PERMISSIONS.editAnywhere
  const select = () => container.querySelector<HTMLButtonElement>(`aside button[aria-label="${label}"]`)!
  const amber = () => [...container.querySelectorAll('aside span')].find((s) => s.textContent === label)!.className
  localStorage.setItem('hotrod.panelTab', 'permissions')
  render({}, () => {}, { contextOpen: true, workFolder: { editAnywhere: true } })
  expect(select().textContent).toBe('Default (On)')
  expect(amber()).toContain('text-amber')
  render({ editAnywhere: false }, () => {}, { contextOpen: true, workFolder: { editAnywhere: true } })
  expect(select().textContent).toBe('Off')
  expect(select().disabled).toBe(false)
  expect(amber()).not.toContain('text-amber')
  localStorage.clear()
})

test('each context card collapses to its header, its switch still working, and stays so after a remount', async () => {
  localStorage.clear()
  const global: ContextItem = { section: 'agents', path: '/g/AGENTS.md', from: GLOBAL_CONTEXT, enabled: true, text: '' }
  const folder: ContextItem = { section: 'folders', path: '/repo/app', from: 'c1', enabled: true, text: 'F' }
  const sent: ClientMessage[] = []
  const show = () => render({}, (m) => sent.push(m), { contextOpen: true, contextItems: [global, folder] })
  const toggle = (name: string) =>
    container.querySelector<HTMLButtonElement>(`aside button[aria-expanded][aria-label$=" ${name}"]`)!
  const globalBox = () => container.querySelector('textarea[aria-label="AGENTS.md of Global"]')
  const folderPath = () => [...container.querySelectorAll('aside span')].find((s) => s.textContent === folder.path)
  showPaths('context', true)
  show()
  expect(toggle('Global').getAttribute('aria-expanded')).toBe('true')
  act(() => toggle('Global').click())
  await vi.waitFor(() => expect(globalBox()).toBeNull())
  expect(toggle('Global').getAttribute('aria-expanded')).toBe('false')
  expect(folderPath()).toBeDefined()
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Use the AGENTS.md of Global"]')!.click())
  expect(sent.at(-1)).toEqual({ type: 'context.set', chatId: 'c1', path: global.path, enabled: false })

  const names = [...container.querySelectorAll<HTMLElement>('aside button span')]
  act(() => names.find((s) => s.textContent === 'app')!.click())
  await vi.waitFor(() => expect(folderPath()).toBeUndefined())

  act(() => root.render(<></>))
  show()
  expect(globalBox()).toBeNull()
  expect(folderPath()).toBeUndefined()
  act(() => toggle('Global').click())
  await vi.waitFor(() => expect(globalBox()).not.toBeNull())
  showPaths('context', false)
  localStorage.clear()
})
