// @vitest-environment jsdom
// The mode picker on each attached folder that isn't a git repo, in the Context panel.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ClientMessage, ContextItem } from '@kothar/core/shared'
import { ContextPanel } from './context-panel.tsx'
import { receiveCopyChanges } from './folder-copies.tsx'
import type { ChatView } from './state.ts'

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
const sub: ChatView = { ...base, id: 'sub', name: 'Sub', parentId: 'space', worker: true }
const repo: ContextItem = { section: 'folders', path: '/code/app', from: 'space', enabled: true, text: '', git: true }
const docs: ContextItem = { section: 'folders', path: '/docs', from: 'space', enabled: true, text: '', mode: 'edit' }

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

function render(items: ContextItem[], readOnly = false) {
  const tab = 'context'
  const chatId = 'space'
  localStorage.setItem('kothar.panelTab', tab)
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider delayDuration={0}>
            <ContextPanel
              chatId={chatId}
              items={items}
              chats={[space, sub]}
              workFolder={{ defaultPath: '/w', canSandbox: true }}
              readOnly={readOnly}
              connected
              send={(m) => sent.push(m)}
            />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
}

const modeSelect = (path: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="Mode of ${path}"]`)
const choose = (select: HTMLButtonElement, label: string) => {
  Element.prototype.scrollIntoView = vi.fn()
  act(() => select.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  const option = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.startsWith(label))!
  act(() => option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
}

test('a folder that is not git shows its mode and sends the one picked; a git folder shows its checkout instead', () => {
  render([repo, docs])
  expect(modeSelect('/code/app')).toBeNull()
  expect(host.textContent).toContain('Checked out at')
  expect(modeSelect('/docs')!.textContent).toBe('Edit in place')
  choose(modeSelect('/docs')!, 'Read only')
  expect(sent).toEqual([{ type: 'context.folderMode', chatId: 'space', path: '/docs', mode: 'readOnly' }])
})

test("a folder holding Kothar's data says why it stays read only, with no picker", () => {
  render([{ ...docs, blocked: "it holds Kothar's own data, which agents never write" }])
  expect(modeSelect('/docs')).toBeNull()
  expect(host.textContent).toContain("Read only, since it holds Kothar's own data")
  // The long reason takes the room left beside "Mode" and wraps there, so the label never gets squeezed under it.
  const reason = [...host.querySelectorAll('span')].find((s) => s.textContent?.startsWith('Read only, since'))!
  const label = [...reason.parentElement!.children].find((s) => s.textContent === 'Mode')!
  expect(label.className).toContain('shrink-0')
  expect(reason.className).toContain('min-w-0')
  expect(reason.className).toContain('flex-1')
})

test('an archived chat shows the mode but cannot change it', () => {
  render([{ ...docs, mode: 'readOnly' }], true)
  expect(modeSelect('/docs')!.textContent).toBe('Read only')
  expect(modeSelect('/docs')!.disabled).toBe(true)
})

test('a folder set to Work on a copy shows its copy, and Copy changes back copies the picked files', () => {
  render([{ ...docs, mode: 'copy', copy: '/work/space/docs' }])
  expect(host.textContent).toContain('Copy at /work/space/docs')
  act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Copy changes back…')!.click())
  expect(sent).toEqual([{ type: 'context.copyChanges', chatId: 'space', path: '/docs' }])
  act(() =>
    receiveCopyChanges({
      type: 'context.copyChanges',
      chatId: 'space',
      path: '/docs',
      changes: [
        { path: 'a.md', kind: 'changed' },
        { path: 'b.md', kind: 'changed', conflict: true },
      ],
    }),
  )
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  const apply = () => [...dialog.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Copy back'))!
  expect(dialog.textContent).toContain('Original changed')
  // A file whose original changed since starts unpicked.
  expect(apply().textContent).toBe('Copy back 1 file')
  const boxes = () => [...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
  act(() => boxes()[1]!.click())
  expect(apply().disabled).toBe(true)
  act(() => boxes()[2]!.click())
  expect(apply().disabled).toBe(false)
  act(() => apply().click())
  expect(sent.at(-1)).toEqual({ type: 'context.copyBack', chatId: 'space', path: '/docs', files: ['a.md', 'b.md'], overwrite: true })
  act(() => receiveCopyChanges({ type: 'context.copyChanges', chatId: 'space', path: '/docs', changes: [], copied: 2 }))
  expect(dialog.textContent).toContain('Copied back 2 files.')
})

test('a copy not made yet says when it will be, with nothing to copy back', () => {
  render([{ ...docs, mode: 'copy' }])
  expect(host.textContent).toContain('Copied into the work folder at the chat’s next message')
  expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Copy changes back…')).toBe(false)
})
