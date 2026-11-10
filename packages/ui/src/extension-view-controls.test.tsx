// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { ExtensionView } from '@kothar/extension-api'
import { Tooltip } from 'radix-ui'
import { ExtensionViewer } from './extension-view.tsx'
import { ConfirmDialog } from './controls.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root
let host: HTMLElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const show = (view: ExtensionView, set?: (key: string, value: string | number | boolean) => void) =>
  act(() =>
    root.render(
      <Tooltip.Provider>
        <ExtensionViewer view={view} act={() => {}} set={set} />
      </Tooltip.Provider>,
    ),
  )

test("a switch shows its space setting's value and saves a flip", () => {
  const saved: unknown[][] = []
  show({ type: 'stack', children: [{ type: 'switch', setting: 'auto', label: 'Run on its own', value: true }] }, (k, v) =>
    saved.push([k, v]),
  )
  const toggle = host.querySelector('button[role="switch"]') as HTMLButtonElement
  expect(toggle.getAttribute('aria-label')).toBe('Run on its own')
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  act(() => toggle.click())
  expect(saved).toEqual([['auto', false]])
})

test('a picker shows the picked option, and without a way to save, its controls are off', () => {
  show({
    type: 'picker',
    setting: 'size',
    label: 'Size',
    value: 2,
    options: [
      { value: 1, label: 'Small' },
      { value: 2, label: 'Large' },
    ],
  })
  const trigger = host.querySelector('button[aria-label="Size"]') as HTMLButtonElement
  expect(trigger.textContent).toContain('Large')
  expect(trigger.disabled).toBe(true)
  show({ type: 'switch', setting: 'auto', label: 'Auto', value: false })
  expect((host.querySelector('button[role="switch"]') as HTMLButtonElement).disabled).toBe(true)
})

test('a button with confirm acts only once the user confirms', async () => {
  const acted: unknown[] = []
  const view: ExtensionView = {
    type: 'button',
    label: 'Delete summaries',
    action: { name: 'delete', value: 'tree' },
    confirm: { text: 'Delete them?', body: 'They are rebuilt with model calls.', ok: 'Delete summaries', danger: true },
  }
  act(() =>
    root.render(
      <Tooltip.Provider>
        <ExtensionViewer view={view} act={(action) => acted.push(action)} />
        <ConfirmDialog />
      </Tooltip.Provider>,
    ),
  )
  const answer = async (ok: boolean) => {
    const dialog = document.querySelector('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('They are rebuilt with model calls.')
    const button = [...dialog.querySelectorAll('button')].find((b) => b.textContent === (ok ? 'Delete summaries' : 'Cancel'))!
    await act(async () => button.click())
  }
  await act(async () => (host.querySelector('button') as HTMLButtonElement).click())
  expect(acted).toEqual([])
  await answer(false)
  expect(acted).toEqual([])
  await act(async () => (host.querySelector('button') as HTMLButtonElement).click())
  await answer(true)
  expect(acted).toEqual([{ name: 'delete', value: 'tree' }])
})

test('text with copy gets a copy button for its text', () => {
  show({ type: 'text', text: '/garage/chats', mono: true, copy: true })
  expect(host.querySelector('button[aria-label="Copy /garage/chats"]')).not.toBeNull()
})

test('text with reveal gets a Show in Finder button that asks for its path', () => {
  const revealed: string[] = []
  act(() =>
    root.render(
      <Tooltip.Provider>
        <ExtensionViewer
          view={{ type: 'text', text: '/garage/chats', mono: true, copy: true, reveal: true }}
          act={() => {}}
          reveal={(path) => revealed.push(path)}
        />
      </Tooltip.Provider>,
    ),
  )
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Show in Finder')!
  act(() => button.click())
  expect(revealed).toEqual(['/garage/chats'])
  expect(host.querySelector('button[aria-label="Copy /garage/chats"]')).not.toBeNull()
})
