// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { ExtensionAction, ExtensionView } from '@kothar/extension-api'
import { ExtensionViewer } from './extension-view.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root
let container: HTMLElement
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const show = (view: ExtensionView, acted: ExtensionAction[] = [], shown: number[] = [], jumps = true) =>
  act(() =>
    root.render(
      <Tooltip.Provider delayDuration={0}>
        <ExtensionViewer view={view} act={(a) => acted.push(a)} showMessage={jumps ? (entry) => shown.push(entry) : undefined} />
      </Tooltip.Provider>,
    ),
  )

const quote = (text: string): ExtensionView => ({
  type: 'message',
  entry: 7,
  author: 'Agent',
  at: '2026-03-01T10:00:00.000Z',
  text,
  buttons: [{ type: 'button', label: 'Unpin', action: { name: 'unpin', value: 7 }, variant: 'ghost' }],
})

test('a quoted message shows its author, time and Markdown, and its buttons act without jumping', () => {
  const acted: ExtensionAction[] = []
  const shown: number[] = []
  show(quote('**Decided**: use Postgres'), acted, shown)
  expect(container.textContent).toContain('Agent')
  expect(container.querySelector('time')?.getAttribute('dateTime')).toBe('2026-03-01T10:00:00.000Z')
  expect(container.querySelector('strong')?.textContent).toBe('Decided')
  expect(container.textContent).not.toContain('Show more')
  const unpin = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Unpin')!
  act(() => unpin.click())
  expect(acted).toEqual([{ name: 'unpin', value: 7 }])
  expect(shown).toEqual([])
})

test('clicking a quoted message, or its author line by keyboard, shows it in the chat', () => {
  const shown: number[] = []
  show(quote('Some text'), [], shown)
  const head = container.querySelector<HTMLButtonElement>('button[aria-label^="Show Agent\'s message"]')!
  act(() => head.click())
  act(() => container.querySelector<HTMLElement>('p')!.click())
  expect(shown).toEqual([7, 7])
})

test('a long quoted message folds, with Show more', () => {
  show(quote(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n\n')))
  const more = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Show more')!
  expect(more.getAttribute('aria-expanded')).toBe('false')
  expect(container.querySelector('[class*="max-h-"]')).not.toBeNull()
  act(() => more.click())
  expect(more.textContent).toBe('Show less')
  expect(container.querySelector('[class*="max-h-"]')).toBeNull()
})

test("without a chat to show it in, a quoted message doesn't offer to", () => {
  show(quote('Some text'), [], [], false)
  expect(container.querySelector('button[aria-label^="Show"]')).toBeNull()
})
