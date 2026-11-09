// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ClientMessage } from '@hotrod/core/shared'
import { ContextPanel, droppedPaths, type Pickers } from './context-panel.tsx'
import type { ChatView } from './state.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const space: ChatView = {
  id: 'space',
  name: 'Space',
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

let root: Root
let host: HTMLDivElement
let sent: ClientMessage[]

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('hotrod.panelTab', 'context')
  sent = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function pickers(over: Partial<Pickers> = {}): Pickers {
  return {
    pickFolder: vi.fn(async () => '/picked/folder'),
    pickFiles: vi.fn(async () => ['/picked/a.md', '/picked/b.png']),
    pathForFile: (file) => `/dropped/${file.name}`,
    ...over,
  }
}

function render(given?: Pickers, readOnly = false) {
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider delayDuration={0}>
            <ContextPanel
              chatId="space"
              items={[]}
              chats={[space]}
              workFolder={{ defaultPath: '/w', canSandbox: true }}
              readOnly={readOnly}
              connected
              send={(m) => sent.push(m)}
              pickers={given}
            />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
}

const button = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === name)
const input = (what: 'folder' | 'file') => host.querySelector<HTMLInputElement>(`[aria-label="Add a ${what} by path"]`)
const section = (label: string) => host.querySelector<HTMLElement>(`section[aria-label="${label}"]`)!

async function click(target: HTMLElement | undefined) {
  await act(async () => target!.click())
}

function type(field: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    set.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('in the desktop app, Add folder… opens the system folder picker and adds what was picked', async () => {
  const given = pickers()
  render(given)
  expect(input('folder')).toBeNull()
  await click(button('Add folder…'))
  expect(given.pickFolder).toHaveBeenCalledWith('Add a folder')
  expect(sent).toEqual([{ type: 'context.add', chatId: 'space', section: 'folders', path: '/picked/folder' }])
})

test('cancelling the folder picker adds nothing', async () => {
  render(pickers({ pickFolder: vi.fn(async () => null) }))
  await click(button('Add folder…'))
  expect(sent).toEqual([])
})

test('Add files… opens the system file picker and adds every file picked', async () => {
  const given = pickers()
  render(given)
  await click(button('Add files…'))
  expect(given.pickFiles).toHaveBeenCalledWith('Add files')
  expect(sent).toEqual([
    { type: 'context.add', chatId: 'space', section: 'files', path: '/picked/a.md' },
    { type: 'context.add', chatId: 'space', section: 'files', path: '/picked/b.png' },
  ])
})

test('Type a path opens a box for a copied path, which closes once added or on Escape', async () => {
  render(pickers())
  const folders = section('Folders')
  const toggle = [...folders.querySelectorAll('button')].find((b) => b.textContent === 'Type a path')!
  await click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  type(input('folder')!, ' /typed/folder ')
  await act(async () => input('folder')!.form!.requestSubmit())
  expect(sent).toEqual([{ type: 'context.add', chatId: 'space', section: 'folders', path: '/typed/folder' }])
  expect(input('folder')).toBeNull()

  await click(toggle)
  act(() => input('folder')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(input('folder')).toBeNull()
  expect(sent).toHaveLength(1)
})

test('in a browser tab there are no pickers, so the path box is the way to add', async () => {
  render(undefined)
  expect(button('Add folder…')).toBeUndefined()
  expect(button('Type a path')).toBeUndefined()
  type(input('file')!, '/typed/notes.md')
  await click(button('Add file'))
  expect(sent).toEqual([{ type: 'context.add', chatId: 'space', section: 'files', path: '/typed/notes.md' }])
})

test('a read-only chat disables the pickers', () => {
  render(pickers(), true)
  expect(button('Add folder…')!.disabled).toBe(true)
  expect(button('Add files…')!.disabled).toBe(true)
})

type FakeItem = { kind: string; name: string; directory?: boolean }
function transfer(items: FakeItem[]): DataTransfer {
  return {
    types: ['Files'],
    items: items.map((i) => ({
      kind: i.kind,
      getAsFile: () => (i.kind === 'file' ? new File([], i.name) : null),
      webkitGetAsEntry: () => ({ isDirectory: !!i.directory }),
    })),
  } as unknown as DataTransfer
}

test('dropped items are sorted into folders and files, skipping anything without a path', () => {
  const data = transfer([
    { kind: 'file', name: 'repo', directory: true },
    { kind: 'file', name: 'notes.md' },
    { kind: 'string', name: 'text' },
    { kind: 'file', name: 'nowhere' },
  ])
  expect(droppedPaths(data, (f) => (f.name === 'nowhere' ? '' : `/d/${f.name}`))).toEqual({
    folders: ['/d/repo'],
    files: ['/d/notes.md'],
  })
})

function drop(target: Element, data: DataTransfer, type = 'drop') {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: data })
  act(() => target.dispatchEvent(event))
  return event
}

test('dropping folders and files on the Context tab adds each to its own section', () => {
  render(pickers())
  const panel = host.querySelector('aside')!
  const data = transfer([
    { kind: 'file', name: 'repo', directory: true },
    { kind: 'file', name: 'notes.md' },
  ])
  drop(panel, data, 'dragenter')
  expect(host.textContent).toContain('Drop to add folders and files')
  const event = drop(panel, data)
  expect(event.defaultPrevented).toBe(true)
  expect(sent).toEqual([
    { type: 'context.add', chatId: 'space', section: 'folders', path: '/dropped/repo' },
    { type: 'context.add', chatId: 'space', section: 'files', path: '/dropped/notes.md' },
  ])
})

test('drops are ignored in a browser tab and in a read-only chat', () => {
  const data = transfer([{ kind: 'file', name: 'notes.md' }])
  render(undefined)
  expect(drop(host.querySelector('aside')!, data).defaultPrevented).toBe(false)
  render(pickers(), true)
  expect(drop(host.querySelector('aside')!, data).defaultPrevented).toBe(false)
  expect(sent).toEqual([])
})
