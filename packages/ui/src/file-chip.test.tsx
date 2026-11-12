// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Attachment, ClientMessage, ContextItem } from '@kothar/core/shared'
import { SentAttachment } from './chat/attachments.tsx'
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
const video: Attachment = {
  name: '20261110_screen_recording_final.mp4',
  size: 5_000,
  mimeType: 'video/mp4',
  path: 'attachments/20261110_screen_recording_final.mp4',
}
const image: Attachment = { name: 'shot.png', size: 50_000, mimeType: 'image/png', path: 'attachments/shot.png' }

let root: Root
let host: HTMLDivElement
let sent: ClientMessage[]

beforeEach(() => {
  sent = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function render(attachment: Attachment, contextItems: ContextItem[] = []) {
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider delayDuration={0}>
            <SentAttachment
              chat={space}
              attachment={attachment}
              contextItems={contextItems}
              connected
              send={(m) => sent.push(m)}
            />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
}

const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!

test('Open on a file chip opens its preview', () => {
  render(video)
  act(() => button(`Open ${video.name}`).click())
  expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe(video.name)
})

test('Pin on a file chip adds it to the chat context, and Unpin takes it out', () => {
  render(video)
  act(() => button(`Pin ${video.name}`).click())
  expect(sent).toEqual([{ type: 'context.add', chatId: 'space', section: 'files', path: video.path }])
  sent = []
  render(video, [{ section: 'files', path: video.path, from: 'space', enabled: true, text: '' }])
  act(() => button(`Unpin ${video.name}`).click())
  expect(sent).toEqual([{ type: 'context.remove', chatId: 'space', section: 'files', path: video.path }])
})

// The size and the buttons share one grid cell, each fading in as the other fades out. Anything below opacity 1
// paints above its in-flow siblings, so on hover the faded-out size sat on top of the buttons and took their clicks.
// jsdom doesn't paint, so this checks that every faded-out layer is click-through instead.
test('on a file chip, the size under the buttons never takes their clicks, and hidden buttons take none', () => {
  render(video)
  const actions = button(`Open ${video.name}`).parentElement!
  const size = actions.previousElementSibling!
  expect(size.textContent).toBe('5 KB')
  expect(size.classList).toContain('pointer-events-none')
  expect(actions.classList).toContain('pointer-events-none')
  expect(actions.classList).toContain('group-hover/file:pointer-events-auto')
  expect(actions.classList).toContain('group-focus-within/file:pointer-events-auto')
})

test('on an image, the hidden overlay takes no clicks until shown, and its buttons work', () => {
  render(image)
  const overlay = button(`Open ${image.name}`).parentElement!
  expect(overlay.classList).toContain('pointer-events-none')
  expect(overlay.classList).toContain('group-hover/file:pointer-events-auto')
  act(() => button(`Pin ${image.name}`).click())
  expect(sent).toEqual([{ type: 'context.add', chatId: 'space', section: 'files', path: image.path }])
  act(() => button(`Open ${image.name}`).click())
  expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe(image.name)
})
