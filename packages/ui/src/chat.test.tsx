// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Chat, FOLLOW_PX, JUMP_BELOW_PX } from './chat.tsx'
import { PERMISSIONS } from './context-panel.tsx'
import { DRAFT_SAVE_MS } from './drafts.ts'
import { currentDock, openDock } from './panel-tab.ts'
import { showPaths } from './paths.ts'
import { resetReveals } from './smooth.ts'
import { reloadSteps, showReportsByDefault, showStepsByDefault, showStepsIn } from './steps.ts'
import { ChatNav } from './sidebar.tsx'
import {
  GLOBAL_CONTEXT,
  PERMISSION_DEFAULTS,
  PERMISSION_SWITCHES,
  type ClientMessage,
  type ContextItem,
  type EngineInfo,
  type ModelLists,
  type ToolKind,
  type WorkFolder,
} from '@kothar/core/shared'
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
  resetReveals()
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
  delete (navigator as unknown as Record<string, unknown>).clipboard
  for (const key of [...Object.keys(sizes), 'scrollTo']) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key]
})

type RenderOptions = {
  workFolder?: Partial<WorkFolder>
  contextOpen?: boolean
  contextItems?: ContextItem[]
  folder?: string
  chats?: ChatView[]
  select?: (chatId: string) => void
  steering?: boolean
  engines?: EngineInfo[]
  modelLists?: ModelLists
  extensionUi?: ComponentProps<typeof Chat>['extensionUi']
}

const viewOf = (chat: Partial<ChatView>): ChatView => ({
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
})

function render(chat: Partial<ChatView>, send: (m: ClientMessage) => void = () => {}, options: RenderOptions = {}) {
  const view = viewOf(chat)
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider delayDuration={0}>
            <Chat
              chat={view}
              folder={options.folder}
              chats={[view, ...(options.chats ?? [])]}
              select={options.select}
              engines={
                options.engines ?? [
                  { id: 'fake', enabled: true, installed: true, signedIn: true, ...(options.steering && { steering: true }) },
                ]
              }
              modelLists={options.modelLists}
              extensionUi={options.extensionUi}
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

/** Takes over animation frames and the clock; returns a function that runs `times` frames of 16ms. */
function driveFrames() {
  let now = 0
  const frames = new Map<number, FrameRequestCallback>()
  let next = 1
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => (frames.set(next, callback), next++))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  return (times = 1) => {
    for (let i = 0; i < times; i++) {
      now += 16
      const due = [...frames.values()]
      frames.clear()
      act(() => due.forEach((callback) => callback(now)))
    }
  }
}
const replyText = () => [...container.querySelectorAll('.markdown')].at(-1)?.textContent ?? ''
const LONG_REPLY = 'Here is what I found after reading the code, in a few short sentences.'

test('a streamed reply types out, and carries on from there when it becomes the finished reply', () => {
  const frame = driveFrames()
  render({ status: 'running', items: [USER] })
  render({ status: 'running', items: [USER], draft: LONG_REPLY.slice(0, 40) })
  expect(replyText()).toBe('')
  frame(5)
  const typed = replyText().length
  expect(typed).toBeGreaterThan(0)
  expect(typed).toBeLessThan(40)
  render({ status: 'idle', items: [USER, { kind: 'text', text: LONG_REPLY }] })
  expect(replyText().length).toBe(typed)
  frame(200)
  expect(replyText()).toBe(LONG_REPLY)
  vi.restoreAllMocks()
})

test('a reply that arrives whole while the chat is open types out too, but history shows at once', () => {
  const frame = driveFrames()
  render({ status: 'idle', items: [USER, { kind: 'text', text: 'Earlier reply' }] })
  expect(replyText()).toBe('Earlier reply')
  const before: Item[] = [USER, { kind: 'text', text: 'Earlier reply' }, tool('done', 'a.txt')]
  render({ status: 'running', items: before })
  render({ status: 'running', items: [...before, { kind: 'text', text: LONG_REPLY }] })
  expect(replyText().length).toBeLessThan(LONG_REPLY.length)
  frame(200)
  expect(replyText()).toBe(LONG_REPLY)
  vi.restoreAllMocks()
})

test('a reply already streaming when the chat opens shows what has arrived at once', () => {
  driveFrames()
  render({ status: 'running', items: [USER], draft: LONG_REPLY })
  expect(replyText()).toBe(LONG_REPLY)
  vi.restoreAllMocks()
})

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

function type(text: string, keys: KeyboardEventInit = {}) {
  const area = container.querySelector('textarea')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, text)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => {
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...keys }))
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

test('a turn folds its steps, while running too, into one row above the reply, which opens and closes in place', async () => {
  const steps: Item[] = [tool('done', 'a.txt'), { kind: 'text', text: 'Installing them.' }, tool('done', '', { toolId: 't2' })]
  const items: Item[] = [USER, ...steps, { kind: 'text', text: 'All set' }]
  render({ status: 'running', items })
  expect(foldButton()?.textContent).toBe('3 steps')

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
  expect(select().textContent).toBe('Unfolded')
  act(() => select().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  const options = [...document.querySelectorAll('[role="option"]')]
  expect(options.map((o) => o.textContent?.replace('✓', ''))).toEqual(['Unfolded', 'Folded'])
  const folded = options.find((o) => o.textContent === 'Folded')!
  act(() => folded.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(select().textContent).toBe('Folded')
  expect(foldButton()?.textContent).toBe('3 steps')
  act(() => showStepsByDefault(true))
  expect(select().textContent).toBe('Folded')
  render({ id: 'c2', items }, () => {}, { contextOpen: true })
  expect(foldButton()).toBeUndefined()
  expect(select().textContent).toBe('Unfolded')

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
  act(() => showStepsByDefault(true))
  render({ status: 'running', items: [USER, ...verdicts, withVerdict('t4', 'denied')] })
  const rows = rowButtons()
  expect(rows).toHaveLength(4)
  const badges = rows.map((b) => b.querySelector('[data-verdict]')?.textContent)
  expect(badges).toEqual(['Allowed', 'Allowed automatically', 'Denied', 'Denied'])
  expect(container.textContent).not.toContain('Approve')
  expect(await hintOf(rows[2]!.querySelector('[data-verdict]')!)).toContain('outside the folders this chat may write')
  act(() => showStepsByDefault(false))
  localStorage.clear()
  reloadSteps()
})

test('says why Kothar allowed a command or an edit without asking', async () => {
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

test('messages, replies, their code, tool output and permission input each copy their own text', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  const reply = 'Ran **it**:\n\n```sh\nls -a\n```'
  const input = { path: '/x.ts' }
  const items: Item[] = [
    { kind: 'user', text: 'Copy *me*' },
    tool('done', 'a.txt'),
    { kind: 'permission', requestId: 'r1', name: 'Write', toolKind: 'edit', summary: '/x.ts', input, outcome: 'denied' },
    { kind: 'text', text: reply },
    tool('running', '', { toolId: 't2' }),
  ]
  render({ status: 'running', items, draft: 'Streaming' })
  act(() => foldButton()!.click())
  act(() => rowButtons().filter((b) => b !== foldButton()).forEach((b) => b.click()))
  const copies: [string | null, string][] = []
  for (const button of list().querySelectorAll<HTMLButtonElement>('button[aria-label^="Copy"]')) {
    const label = button.getAttribute('aria-label')
    await act(async () => button.click())
    copies.push([label, writeText.mock.lastCall![0]])
  }
  expect(copies).toEqual([
    ['Copy message', 'Copy *me*'],
    ['Copy output', 'a.txt'],
    ['Copy input', JSON.stringify(input, null, 2)],
    ['Copy code', 'ls -a'],
    ['Copy reply', reply],
  ])
})

const FORMAT = 'How should I format the output?'
const SECTIONS = 'Which sections should I include?'
const QUESTIONS = [
  {
    header: 'Format',
    question: FORMAT,
    options: [
      { label: 'Summary', description: 'Brief overview' },
      { label: 'Detailed', description: 'Full explanation' },
    ],
    multiSelect: false,
  },
  {
    header: 'Sections',
    question: SECTIONS,
    options: [
      { label: 'Introduction', description: 'Opening context' },
      { label: 'Body', description: 'The main part' },
      { label: 'Conclusion', description: 'Final summary' },
    ],
    multiSelect: true,
  },
]
type QuestionItem = Extract<Item, { kind: 'question' }>
const question = (change: Partial<QuestionItem> = {}): Item => ({
  kind: 'question',
  requestId: 'q1',
  questions: QUESTIONS,
  outcome: 'pending',
  ...change,
})
const card = () => container.querySelector<HTMLElement>('[aria-label="Question"]')
const press = (key: string, target: Element = document.body) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
const choices = () => [...card()!.querySelectorAll<HTMLButtonElement>('[role="radio"], [role="checkbox"]')]
const checked = () => choices().flatMap((c) => (c.getAttribute('aria-checked') === 'true' ? [c.dataset.label] : []))
const buttonNamed = (name: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === name)!

test('a pending question is a card: a tab per question, option rows, number keys, an Other field, Enter submits', () => {
  const sent: ClientMessage[] = []
  render({ status: 'waiting', items: [USER, question()] }, (m) => sent.push(m))
  const tabs = [...card()!.querySelectorAll('[role="tab"]')]
  expect(tabs.map((t) => t.textContent)).toEqual(['Format', 'Sections'])
  expect(card()!.textContent).toContain(FORMAT)
  expect(choices().map((c) => c.getAttribute('role'))).toEqual(['radio', 'radio', 'radio'])
  const [summary] = choices()
  expect(summary!.querySelector('strong')?.textContent).toBe('Summary')
  expect(summary!.textContent).toContain('Brief overview')
  expect(choices().at(-1)!.textContent).toContain('Other…')

  press('2')
  expect(card()!.textContent).toContain(SECTIONS)
  expect(tabs[1]!.getAttribute('aria-selected')).toBe('true')
  expect(choices().map((c) => c.getAttribute('role'))).toEqual(Array(4).fill('checkbox'))
  press('1')
  press('3')
  press('2')
  press('2')
  expect(checked()).toEqual(['Introduction', 'Conclusion'])
  press('4')
  const other = card()!.querySelector<HTMLInputElement>('input[aria-label="Other answer"]')!
  expect(document.activeElement).toBe(other)
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(other, 'Appendix')
    other.dispatchEvent(new Event('input', { bubbles: true }))
  })
  press('1', other)
  expect(checked()).toEqual(['Introduction', 'Conclusion', 'Other'])
  press('Enter', other)
  expect(sent.filter((m) => m.type === 'question.respond')).toEqual([
    {
      type: 'question.respond',
      chatId: 'c1',
      requestId: 'q1',
      answers: { [FORMAT]: ['Detailed'], [SECTIONS]: ['Introduction', 'Conclusion', 'Appendix'] },
    },
  ])
})

test('Submit waits for an answer to every question, Enter shows the first one left, and Skip declines', () => {
  const sent: ClientMessage[] = []
  render({ status: 'waiting', items: [USER, question()] }, (m) => sent.push(m))
  const tabs = () => [...card()!.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  const tab = (name: string) => tabs().find((t) => t.textContent?.includes(name))!
  act(() => tab('Sections').click())
  act(() => choices()[1]!.click())
  expect(buttonNamed('Submit').disabled).toBe(true)
  press('Enter')
  expect(sent.filter((m) => m.type === 'question.respond')).toEqual([])
  expect(tab('Format').getAttribute('aria-selected')).toBe('true')
  act(() => choices()[0]!.click())
  expect(buttonNamed('Submit').disabled).toBe(false)
  act(() => buttonNamed('Submit').click())
  press('Enter')
  expect(sent.filter((m) => m.type === 'question.respond')).toEqual([
    { type: 'question.respond', chatId: 'c1', requestId: 'q1', answers: { [FORMAT]: ['Summary'], [SECTIONS]: ['Body'] } },
  ])
  expect(buttonNamed('Skip').disabled).toBe(true)

  render({ status: 'waiting', items: [USER, question({ requestId: 'q2' })] }, (m) => sent.push(m))
  act(() => buttonNamed('Skip').click())
  expect(sent.at(-1)).toEqual({ type: 'question.respond', chatId: 'c1', requestId: 'q2' })
})

test('one question shows no tabs, and keys typed elsewhere never pick an option', () => {
  render({ status: 'waiting', items: [USER, question({ questions: QUESTIONS.slice(0, 1) })] })
  expect(card()!.querySelector('[role="tab"]')).toBeNull()
  const composer = container.querySelector('textarea')!
  composer.focus()
  press('1', composer)
  expect(checked()).toEqual([])
  const placeholder = composer.placeholder || composer.getAttribute('aria-placeholder')
  expect(placeholder).toBe('Waiting for your answer… Enter queues a message')
  render({ status: 'stopping', items: [USER, question({ questions: QUESTIONS.slice(0, 1) })] })
  expect(card()!.textContent).toContain('Stopping…')
  expect(choices().every((c) => c.disabled)).toBe(true)
})

test('an answered question shrinks to a row of its answers that folds with the steps', () => {
  const answers = { [FORMAT]: ['Detailed'], [SECTIONS]: ['Introduction', 'Body'] }
  const items: Item[] = [USER, tool('done'), question({ outcome: 'answered', answers }), REPLY]
  render({ status: 'running', items })
  expect(card()).toBeNull()
  act(() => foldButton()!.click())
  const row = rowButtons().find((b) => b.textContent?.includes('Format'))!
  expect(row.textContent).toContain('Format → Detailed')
  expect(row.textContent).toContain('Sections → Introduction, Body')
  act(() => row.click())
  expect(container.textContent).toContain(SECTIONS)
  render({ status: 'idle', items })
  expect(foldButton()?.textContent).toBe('2 steps')
  render({ status: 'running', items: [USER, question({ outcome: 'skipped' })] })
  expect(rowButtons()[0]!.querySelector('[data-verdict]')?.textContent).toBe('Skipped')
})

test('with steps folded, a question waiting for an answer shows below the fold, not inside it', () => {
  const steps: Item[] = [tool('done'), { kind: 'thinking', text: 'Which format?' }, tool('done', '', { toolId: 't2' })]
  render({ status: 'waiting', items: [USER, ...steps, question()] })
  const fold = foldButton()!
  expect(fold.textContent).toBe('3 steps')
  expect(fold.getAttribute('aria-expanded')).toBe('false')
  expect(container.textContent).not.toContain('Which format?')
  expect(card()).not.toBeNull()
  expect(before(fold, card()!)).toBe(true)
  const composer = container.querySelector('textarea')!
  expect(composer.placeholder || composer.getAttribute('aria-placeholder')).toBe(
    'Waiting for your answer… Enter queues a message',
  )
})

test('the down button points at a question waiting below', () => {
  render({ status: 'running', items: [USER, REPLY], draft: 'More' })
  scrollTo(0)
  grow(JUMP_BELOW_PX * 3)
  render({ status: 'waiting', items: [USER, REPLY, question()] })
  const asking = container.querySelector<HTMLButtonElement>('[aria-label="Scroll to the question"]')!
  expect(asking.className).toContain('text-amber')
})

test('the global AGENTS.md is editable in every chat, Home too, and saves as the global instructions', async () => {
  const global: ContextItem = { section: 'agents', path: '/g/AGENTS.md', from: GLOBAL_CONTEXT, enabled: true, text: 'OLD' }
  const box = () => container.querySelector('textarea[aria-label="AGENTS.md of Global"]') as HTMLTextAreaElement
  for (const chat of [{}, { id: 'main', name: 'Home', extension: 'home' }]) {
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
  const tab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((t) => t.textContent === 'General')!
  act(() => tab.click())
  const permissions = container.querySelector('aside section[aria-label="Permissions"] details')!
  expect(permissions.textContent).toContain(`${PERMISSIONS.editAnywhere.label}:`)
  expect(container.querySelectorAll('aside [data-hint]').length).toBe(0)
  localStorage.clear()
})

test('a worker is view only: no composer, just a Stop button while it runs', () => {
  const sent: ClientMessage[] = []
  render({ worker: true, parentId: 'p1', status: 'running' }, (m) => sent.push(m))
  expect(container.querySelector('textarea')).toBeNull()
  const bar = container.querySelector('[aria-label="Worker"]')!
  expect(bar.textContent).toContain('view only')
  const stop = [...bar.querySelectorAll('button')].find((b) => b.textContent === 'Stop')!
  act(() => stop.click())
  expect(sent.at(-1)).toEqual({ type: 'chat.interrupt', chatId: 'c1' })
  render({ worker: true, parentId: 'p1', status: 'idle' })
  expect(container.querySelector('[aria-label="Worker"] button')).toBeNull()
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

test('the right panel has two tabs, General with the permissions and Context, remembering the last one', () => {
  localStorage.clear()
  const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('aside [role="tab"]')]
  const tab = (name: string) => tabs().find((t) => t.textContent === name)!
  const permission = () => container.querySelector(`aside button[aria-label="${PERMISSIONS.editAnywhere.label}"]`)
  render({}, () => {}, { contextOpen: true })
  expect(tabs().map((t) => t.textContent)).toEqual(['General', 'Context'])
  expect(tab('Context').getAttribute('aria-selected')).toBe('true')
  expect(permission()).toBeNull()
  expect(container.querySelector('aside section[aria-label="AGENTS.md"]')).not.toBeNull()
  act(() => tab('General').click())
  expect(container.querySelector('aside section[aria-label="Permissions"] h3')!.textContent).toBe('Permissions')
  expect(container.querySelector('aside section[aria-label="View"]')).not.toBeNull()
  expect(permission()).not.toBeNull()
  expect(container.querySelector('aside section[aria-label="AGENTS.md"]')).toBeNull()
  act(() => root.render(<></>))
  render({}, () => {}, { contextOpen: true })
  expect(tab('General').getAttribute('aria-selected')).toBe('true')
  localStorage.clear()
})

test('a panel saved on the old Permissions tab opens General, where the switches now are', () => {
  localStorage.setItem('kothar.panelTab', 'permissions')
  render({}, () => {}, { contextOpen: true })
  const selected = container.querySelector('aside [role="tab"][aria-selected="true"]')!
  expect(selected.textContent).toBe('General')
  expect(container.querySelector(`aside button[aria-label="${PERMISSIONS.editAnywhere.label}"]`)).not.toBeNull()
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
  localStorage.setItem('kothar.panelTab', 'general')
  const choose = (select: HTMLButtonElement, option: (text: string) => boolean) => {
    act(() => select.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    const item = [...document.querySelectorAll('[role="option"]')].find((o) => option(o.textContent ?? ''))!
    act(() => item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  }
  for (const name of PERMISSION_SWITCHES) {
    const select = () =>
      container.querySelector<HTMLButtonElement>(`aside button[aria-label="${PERMISSIONS[name].label}"]`)!
    const [fallback, flipped] = PERMISSION_DEFAULTS[name] ? ['On', 'Off'] : ['Off', 'On']
    for (const chat of [{}, { id: 'main', name: 'Home', extension: 'home' }]) {
      const sent: ClientMessage[] = []
      render(chat, (m) => sent.push(m), { contextOpen: true })
      expect(select().textContent).toBe(fallback)
      choose(select(), (text) => text.startsWith(flipped))
      const chatId = 'id' in chat ? chat.id : 'c1'
      expect(sent.at(-1)).toEqual({ type: 'chat.setPermission', chatId, name, enabled: !PERMISSION_DEFAULTS[name] })
    }

    render({}, () => {}, { contextOpen: true, workFolder: { [name]: !PERMISSION_DEFAULTS[name] } })
    expect(select().textContent).toBe(flipped)
    render({ [name]: true }, () => {}, { contextOpen: true, workFolder: { [name]: false } })
    expect(select().textContent).toBe('On')
    act(() => select().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent?.replace('✓', ''))).toEqual([
      'On',
      'Off',
    ])
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  }
  localStorage.clear()
})

test('a chat turns edits anywhere off while Settings turns it on by default, its label amber only while on', () => {
  const { label } = PERMISSIONS.editAnywhere
  const select = () => container.querySelector<HTMLButtonElement>(`aside button[aria-label="${label}"]`)!
  const amber = () => [...container.querySelectorAll('aside span')].find((s) => s.textContent === label)!.className
  localStorage.setItem('kothar.panelTab', 'general')
  render({}, () => {}, { contextOpen: true, workFolder: { editAnywhere: true } })
  expect(select().textContent).toBe('On')
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

const SPACE = viewOf({ id: 'p1', name: 'Space' })
const pendingTool = (outcome: 'pending' | 'allowed') =>
  tool(outcome === 'pending' ? 'waiting' : 'running', '', {
    summary: 'rm -rf build',
    permission: { requestId: 'r1', name: 'Bash', toolKind: 'shell', summary: 'rm -rf build', input: {}, outcome },
  })
const worker = (change: Partial<ChatView> = {}) =>
  viewOf({ id: 's1', name: 'Fix tests', parentId: 'p1', worker: true, status: 'waiting', items: [USER, pendingTool('pending')], ...change })

test("a worker's permission request waits in its space, which answers it and turns the down button amber", () => {
  const sent: ClientMessage[] = []
  const space = { ...SPACE, status: 'running' as const, items: [USER, REPLY], draft: 'More' }
  render(space, (m) => sent.push(m), { chats: [worker()] })
  const card = () => container.querySelector('[aria-label="Request from worker Fix tests"]')
  expect(card()!.textContent).toContain('Worker Fix tests wants to run Bash')
  expect(card()!.textContent).toContain('rm -rf build')
  scrollTo(0)
  grow(JUMP_BELOW_PX * 3)
  expect(container.querySelector('[aria-label="Scroll to the permission request"]')!.className).toContain('text-amber')

  const approve = [...card()!.querySelectorAll('button')].find((b) => b.textContent === 'Approve')!
  act(() => approve.click())
  expect(sent.at(-1)).toEqual({ type: 'permission.respond', chatId: 's1', requestId: 'r1', allow: true })

  render(space, () => {}, { chats: [worker({ status: 'running', items: [USER, pendingTool('allowed')] })] })
  expect(card()).toBeNull()
  render(space, () => {}, { chats: [worker({ status: 'stopping' })] })
  expect(card()).toBeNull()
})

test("an extension's wait shows above the composer with its buttons, in the chat and in its worker's space", () => {
  const sent: ClientMessage[] = []
  const wait = {
    extension: 'browser',
    text: 'Browser: Log in to GitHub',
    buttons: [
      { id: 'open', label: 'Open browser' },
      { id: 'done', label: 'Done', primary: true },
    ],
  }
  const bar = () => container.querySelector('[aria-label="Waiting for you"]')
  const space = { ...SPACE, status: 'waiting' as const, items: [USER], waits: [wait] }
  render(space, (m) => sent.push(m))
  expect(bar()!.textContent).toContain('Browser: Log in to GitHub')
  act(() => [...bar()!.querySelectorAll('button')].find((b) => b.textContent === 'Done')!.click())
  expect(sent.at(-1)).toEqual({ type: 'extension.wait.answer', chatId: 'p1', extension: 'browser', button: 'done' })

  render({ ...SPACE, status: 'running' as const, items: [USER] }, (m) => sent.push(m), {
    chats: [worker({ status: 'waiting', items: [USER], waits: [wait] })],
  })
  expect(bar()!.textContent).toContain('Worker Fix tests: Browser: Log in to GitHub')
  act(() => [...bar()!.querySelectorAll('button')].find((b) => b.textContent === 'Open browser')!.click())
  expect(sent.at(-1)).toEqual({ type: 'extension.wait.answer', chatId: 's1', extension: 'browser', button: 'open' })

  render({ ...SPACE, items: [USER] }, () => {})
  expect(bar()).toBeNull()
})

test("a worker's own view shows where its request waits, with a way to the space instead of Approve", () => {
  const select = vi.fn()
  render(worker(), () => {}, { chats: [SPACE], select })
  expect(container.textContent).toContain('Waiting for approval in Space')
  const buttons = [...container.querySelectorAll('button')]
  expect(buttons.some((b) => b.textContent === 'Approve')).toBe(false)
  act(() => buttons.find((b) => b.textContent === 'Go to Space')!.click())
  expect(select).toHaveBeenCalledWith('p1')
})

test("a worker without its own choice shows thinking and tool calls the way its space does", () => {
  const steps: Item[] = [tool('done', 'a.txt'), { kind: 'text', text: 'Installing them.' }, tool('done', '', { toolId: 't2' })]
  const sub = worker({ status: 'idle', items: [USER, ...steps, { kind: 'text', text: 'All set' }] })
  render(sub, () => {}, { chats: [SPACE] })
  expect(foldButton()?.textContent).toBe('3 steps')
  act(() => showStepsIn('p1', true))
  expect(foldButton()).toBeUndefined()
  act(() => showStepsIn('s1', false))
  expect(foldButton()?.textContent).toBe('3 steps')
  localStorage.clear()
  act(() => reloadSteps())
})

test("the sidebar shows a space as waiting while a worker below it waits for approval", () => {
  const dot = (name: string) =>
    [...container.querySelectorAll('nav button, button')]
      .find((b) => b.textContent?.startsWith(name))
      ?.querySelector('[data-status]')
      ?.getAttribute('data-status')
  const nav = (chats: ChatView[]) =>
    act(() =>
      root.render(
        <LazyMotion features={domAnimation} strict>
          <Tooltip.Provider delayDuration={0}>
            <ChatNav chats={chats} selectedId="p1" connected send={() => {}} select={() => {}} askName={() => {}} />
          </Tooltip.Provider>
        </LazyMotion>,
      ),
    )
  nav([SPACE, worker()])
  expect(dot('Space')).toBe('waiting')
  expect(dot('Fix tests')).toBe('waiting')
  nav([SPACE, worker({ status: 'running', items: [USER, pendingTool('allowed')] })])
  expect(dot('Space')).toBe('idle')
})

test("shows a worker's report as a report card, not as the user's message", () => {
  const selected: string[] = []
  const report = (chatId: string, name: string, text: string, error?: string) =>
    ({ kind: 'report', chatId, name, text, ...(error && { error }) }) as const
  render(
    { items: [USER, report('s1', 'Docs', 'Found **it**'), report('s2', 'Lint', '', 'Interrupted')] },
    () => {},
    { chats: [viewOf({ id: 's1', name: 'Docs', worker: true, parentId: 'c1' })], select: (id) => selected.push(id) },
  )
  const docs = container.querySelector('[aria-label="Report from worker Docs"]')!
  expect(docs.textContent).toContain('Worker Docs reported')
  expect(docs.querySelector('strong')?.textContent).toBe('it')
  expect(docs.closest('.self-end')).toBeNull()
  const named = (card: Element, name: string) => [...card.querySelectorAll('button')].find((b) => b.textContent === name)
  act(() => named(docs, 'Docs')!.click())
  expect(selected).toEqual(['s1'])

  // A removed worker's name is plain text; a report with no reply says so.
  const lint = container.querySelector('[aria-label="Report from worker Lint"]')!
  expect(named(lint, 'Lint')).toBeUndefined()
  expect(lint.textContent).toContain('Worker Lint reported · ended early: Interrupted')
  expect(lint.textContent).toContain('No reply')
})

// jsdom has no layout, so these check the classes that keep the transcript from scrolling sideways at a narrow width.
test('the transcript never scrolls sideways, and a long report heading wraps instead of widening it', () => {
  const long = 'ended early: Claude Code exited with code 143 while running a very long command'
  render({ items: [USER, { kind: 'report', chatId: 's1', name: 'Make Kothar workers hands-off for the…', text: '', error: long }] })
  const list = container.querySelector('[class*="overflow-anchor"]')!
  expect(list.className).toContain('overflow-x-hidden')
  // Gutters on both edges keep the column centred under a visible scrollbar, in line with the composer.
  expect(list.className).toContain('[scrollbar-gutter:stable_both-edges]')
  const heading = [...container.querySelectorAll('[aria-label^="Report from worker"] span')].find((s) =>
    s.textContent?.startsWith('Worker'),
  )!
  expect(heading.className).not.toContain('shrink-0')
  expect(heading.className).toContain('min-w-0')
})

test('a report card folds and unfolds on click, and remembers it', () => {
  localStorage.clear()
  reloadSteps()
  const items: Item[] = [USER, { kind: 'report', chatId: 's1', name: 'Docs', text: '## Found **it**\n\nMore detail' }]
  render({ items })
  const card = () => container.querySelector('[aria-label="Report from worker Docs"]')!
  const chevron = () => card().querySelector<HTMLButtonElement>('button[aria-expanded]')!
  expect(chevron().getAttribute('aria-expanded')).toBe('true')
  expect(card().textContent).toContain('More detail')

  act(() => chevron().click())
  expect(chevron().getAttribute('aria-expanded')).toBe('false')
  expect(chevron().getAttribute('aria-label')).toBe('Unfold report')
  const preview = [...card().querySelectorAll('button')].at(-1)!
  expect(preview.textContent).toBe('Found it')

  // The choice survives a reload, for this card only.
  act(() => reloadSteps())
  render({ items })
  expect(chevron().getAttribute('aria-expanded')).toBe('false')
  render({ id: 'c2', items })
  expect(chevron().getAttribute('aria-expanded')).toBe('true')

  render({ items })
  act(() => [...card().querySelectorAll('button')].at(-1)!.click())
  expect(chevron().getAttribute('aria-expanded')).toBe('true')
  expect(card().textContent).toContain('More detail')
  localStorage.clear()
  reloadSteps()
})

test('worker reports fold by default from Settings, and each chat overrides that in its General tab', () => {
  Element.prototype.scrollIntoView = vi.fn()
  localStorage.clear()
  reloadSteps()
  const items: Item[] = [USER, { kind: 'report', chatId: 's1', name: 'Docs', text: 'Found it\n\nMore detail' }]
  const expanded = () =>
    container
      .querySelector('[aria-label="Report from worker Docs"] button[aria-expanded]')!
      .getAttribute('aria-expanded')
  render({ items }, () => {}, { contextOpen: true })
  expect(expanded()).toBe('true')

  act(() => showReportsByDefault(false))
  expect(expanded()).toBe('false')

  const general = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((t) => t.textContent === 'General')!
  act(() => general.click())
  const select = () => container.querySelector<HTMLButtonElement>('aside button[aria-label="Worker reports"]')!
  expect(select().textContent).toBe('Folded')
  act(() => select().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  const options = [...document.querySelectorAll('[role="option"]')]
  expect(options.map((o) => o.textContent?.replace('✓', ''))).toEqual(['Unfolded', 'Folded'])
  const unfolded = options.find((o) => o.textContent?.replace('✓', '') === 'Unfolded')!
  act(() => unfolded.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(select().textContent).toBe('Unfolded')
  expect(expanded()).toBe('true')

  // Another chat still follows Settings.
  render({ id: 'c2', items }, () => {}, { contextOpen: true })
  expect(expanded()).toBe('false')
  expect(select().textContent).toBe('Folded')

  act(() => showReportsByDefault(true))
  localStorage.clear()
  reloadSteps()
})

test("labels a queued worker report as the worker's", () => {
  const queue = [{ id: 'q1', text: 'Found it', report: { chatId: 's1', name: 'Docs' } }]
  render({ status: 'running', items: [USER], queue })
  const queued = container.querySelector('[aria-label="Queued messages"]')!
  expect(queued.textContent).toContain('Worker Docs reported:Found it')
})

test('the empty composer starts one line high', () => {
  render({})
  const box = container.querySelector('textarea')!
  expect(box.rows).toBe(1)
  expect(box.className).toContain('min-h-[calc(1lh+16px)]')
  expect(box.className).not.toContain('min-h-[calc(2lh')
})

test('an unsent message stays in its chat across a switch and a reload, and is cleared once sent', () => {
  localStorage.clear()
  const box = () => container.querySelector('textarea')!
  const write = (text: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box(), text)
      box().dispatchEvent(new Event('input', { bubbles: true }))
    })
  const reopen = (id: string, send?: (m: ClientMessage) => void) => {
    act(() => root.render(<></>))
    render({ id }, send)
  }
  render({ id: 'c1' })
  write('half a thought')
  reopen('c2')
  expect(box().value).toBe('')
  write('other chat')
  reopen('c1')
  expect(box().value).toBe('half a thought')
  expect(JSON.parse(localStorage.getItem('kothar.drafts')!)).toEqual({ c1: 'half a thought', c2: 'other chat' })
  const sent: ClientMessage[] = []
  reopen('c1', (m) => sent.push(m))
  act(() => box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(sent.filter((m) => m.type === 'chat.send')).toEqual([{ type: 'chat.send', chatId: 'c1', text: 'half a thought' }])
  expect(box().value).toBe('')
  reopen('c1')
  expect(box().value).toBe('')
  reopen('c2')
  expect(box().value).toBe('other chat')
  localStorage.clear()
})

test('a draft is saved once typing pauses, and a message queued during a turn clears it', () => {
  localStorage.clear()
  vi.useFakeTimers()
  const box = () => container.querySelector('textarea')!
  render({ status: 'running' })
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box(), 'later')
    box().dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(localStorage.getItem('kothar.drafts')).toBeNull()
  act(() => vi.advanceTimersByTime(DRAFT_SAVE_MS))
  expect(localStorage.getItem('kothar.drafts')).toContain('later')
  act(() => box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(localStorage.getItem('kothar.drafts')).toBeNull()
  vi.useRealTimers()
})

test('while a turn runs, Enter steers when the engine can and ⌥Enter queues; otherwise Enter queues', () => {
  const sent: ClientMessage[] = []
  const shimmer = () => container.querySelector('.shimmer')?.textContent
  render({ status: 'running', items: [USER] }, (m) => sent.push(m), { steering: true })
  expect(shimmer()).toBe('Working… Enter steers · ⌥Enter queues')
  type('use y')
  type('then z', { altKey: true })
  render({ status: 'running', items: [USER] }, (m) => sent.push(m))
  expect(shimmer()).toBe('Working… Enter queues a message')
  type('plain')
  render({ status: 'idle', items: [USER] }, (m) => sent.push(m), { steering: true })
  type('fresh')
  expect(sent.filter((m) => m.type === 'chat.send')).toEqual([
    { type: 'chat.send', chatId: 'c1', text: 'use y', steer: true },
    { type: 'chat.send', chatId: 'c1', text: 'then z' },
    { type: 'chat.send', chatId: 'c1', text: 'plain' },
    { type: 'chat.send', chatId: 'c1', text: 'fresh' },
  ])
})

test('a steering message waits in the queue with no way to take it back, then shows in place marked as sent mid-turn', () => {
  const queue = [
    { id: 'q1', text: 'use y', steering: true as const },
    { id: 'q2', text: 'later' },
  ]
  render({ status: 'running', items: [USER], queue }, () => {}, { steering: true })
  const queued = container.querySelector('[aria-label="Queued messages"]')!
  expect(queued.textContent).toContain('At the next step:use y')
  expect(queued.querySelectorAll('[aria-label="Remove from queue"]')).toHaveLength(1)
  expect(queued.textContent).toContain('Sends when this turn ends')
  const items: Item[] = [USER, tool('done', 'a'), { kind: 'user', text: 'use y', midTurn: true }]
  render({ status: 'running', items, queue: [] }, () => {}, { steering: true })
  expect(container.textContent).toContain('Sent mid-turn')
})

test("the composer offers every engine's models, grouped, and picking one on another engine pins the chat to it", () => {
  Element.prototype.scrollIntoView = vi.fn()
  const engines: EngineInfo[] = [
    { id: 'cc', name: 'Claude Code', enabled: true, installed: true, signedIn: true, thinking: ['low', 'high'], models: [{ id: 'opus', label: 'Opus' }] },
    { id: 'pi', enabled: true, installed: true, signedIn: true, thinking: ['off', 'high'], models: [{ id: 'p/one', label: 'One' }] },
  ]
  const sent: ClientMessage[] = []
  // The core sends what the chat runs; the composer only shows it.
  const run = { engine: 'cc', model: 'opus', thinking: 'high' as const }
  render({ engine: 'cc', thinking: 'high', run }, (m) => sent.push(m), { engines })
  const select = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
  expect(select('Model').textContent).toBe('Opus · Claude Code')
  expect(select('Thinking').textContent).toBe('High')
  expect(container.querySelector('button[aria-label="Engine"]')).toBeNull()
  act(() => select('Model').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect([...document.querySelectorAll('[role="group"]')].map((g) => g.firstElementChild?.textContent)).toEqual([
    'Claude Code',
    'pi',
  ])
  const item = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.endsWith('One · pi'))!
  act(() => item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  // The chat's own level carries over, since pi's model takes it too.
  expect(sent.at(-1)).toEqual({ type: 'chat.setModel', chatId: 'c1', engine: 'pi', model: 'p/one', thinking: 'high' })
})

test("a chat whose own model can't run says so and offers to go back to Settings' models", () => {
  const engines: EngineInfo[] = [
    { id: 'cc', enabled: true, installed: true, signedIn: true, models: [{ id: 'opus', label: 'Opus' }] },
  ]
  const modelLists: ModelLists = { chat: [{ engine: 'cc', model: 'opus' }], planning: [], searching: [], workers: [] }
  const sent: ClientMessage[] = []
  render({ engine: 'cc', model: 'gone' }, (m) => sent.push(m), { engines, modelLists })
  expect(container.textContent).toContain("gone on cc can't run")
  const back = [...container.querySelectorAll('button')].find((b) => b.textContent === "Use Settings' models")!
  act(() => back.click())
  expect(sent.at(-1)).toEqual({ type: 'chat.setModel', chatId: 'c1' })
})

test("an extension's card stays in view when the turn folds, and opens its panel on what it's about", () => {
  const sent: ClientMessage[] = []
  const tool = (toolId: string): Item => ({ kind: 'tool', toolId, name: 'create_artifact', summary: '', state: 'done', output: '' })
  const card: Item = {
    kind: 'note',
    text: 'Made the artifact',
    extension: 'artifacts',
    panel: 'artifacts',
    action: { name: 'open', value: 'chart' },
    card: { title: 'Sales chart', badge: 'Chart', detail: 'v2' },
  }
  const panels = [{ extension: 'artifacts', id: 'artifacts', title: 'Artifacts', placement: 'dock' as const }]
  render({ items: [USER, tool('t1'), card, tool('t2'), { kind: 'text', text: 'Done' }] }, (m) => sent.push(m), {
    extensionUi: { chatId: 'c1', panels, commands: [] },
  })
  const shown = container.querySelector('[data-note-card]') as HTMLButtonElement
  expect(shown.textContent).toContain('Sales chart')
  expect(shown.textContent).toContain('Chart')
  expect(shown.textContent).toContain('v2')
  expect(container.textContent).toContain('2 steps')
  act(() => shown.click())
  expect(sent).toContainEqual({
    type: 'extension.panel.action',
    chatId: 'c1',
    extension: 'artifacts',
    panel: 'artifacts',
    action: { name: 'open', value: 'chart' },
  })
  expect(currentDock().open).toBe('extension:artifacts/artifacts')
  act(() => openDock(null))
})
