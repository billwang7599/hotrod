// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { ExtensionView } from '@kothar/extension-api'
import { Tooltip } from 'radix-ui'
import { ExtensionViewer, SettingsLinkContext } from './extension-view.tsx'
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

test('a form keeps what is typed and sends every field on submit; cancel sends its own action', () => {
  const acted: unknown[] = []
  const view: ExtensionView = {
    type: 'form',
    key: 'new',
    fields: [
      { name: 'name', label: 'Name', value: 'Tests' },
      { name: 'body', label: 'Note', rows: 6 },
    ],
    submit: { label: 'Save', action: 'save' },
    cancel: { label: 'Cancel', action: { name: 'cancel' } },
  }
  act(() =>
    root.render(
      <Tooltip.Provider>
        <ExtensionViewer view={view} act={(action) => acted.push(action)} />
      </Tooltip.Provider>,
    ),
  )
  const box = host.querySelector('textarea[aria-label="Note"]') as HTMLTextAreaElement
  expect((host.querySelector('input[aria-label="Name"]') as HTMLInputElement).value).toBe('Tests')
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(box, 'npm test')
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const buttons = [...host.querySelectorAll('button')]
  act(() => buttons.find((b) => b.textContent === 'Save')!.click())
  act(() => buttons.find((b) => b.textContent === 'Cancel')!.click())
  expect(acted).toEqual([{ name: 'save', value: { name: 'Tests', body: 'npm test' } }, { name: 'cancel' }])
})

test('a kothar:settings link opens that Settings page at its anchor, and is plain text where nothing opens Settings', () => {
  const opened: unknown[][] = []
  const view: ExtensionView = { type: 'link', text: 'Edit it', url: 'kothar:settings/extension:notes#prompt-notes-tone' }
  act(() =>
    root.render(
      <SettingsLinkContext.Provider value={(page, anchor) => opened.push([page, anchor])}>
        <Tooltip.Provider>
          <ExtensionViewer view={view} act={() => {}} />
        </Tooltip.Provider>
      </SettingsLinkContext.Provider>,
    ),
  )
  expect(host.querySelector('a')).toBeNull()
  act(() => (host.querySelector('button') as HTMLButtonElement).click())
  expect(opened).toEqual([['extension:notes', 'prompt-notes-tone']])
  show(view)
  expect(host.querySelector('button')).toBeNull()
  expect(host.textContent).toBe('Edit it')
  show({ type: 'link', text: 'Site', url: 'https://example.com' })
  expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
})

test("a card's long title wraps instead of being cut short, and its badges wrap under it in a narrow panel", () => {
  const title = 'Permission answered for a command that reaches the network: curl https://example.com/a/long/path'
  show({ type: 'card', title, open: false, badges: [{ text: 'Kothar' }, { text: 'Allowed' }, { text: '12:00:00' }], children: [] })
  const shown = [...host.querySelectorAll('span')].find((s) => s.textContent === title)!
  expect(shown.className).not.toContain('truncate')
  expect(shown.parentElement!.parentElement!.className).toContain('flex-wrap')
})
