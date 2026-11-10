// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { ExtensionView } from '@kothar/extension-api'
import { Tooltip } from 'radix-ui'
import { ExtensionViewer } from './extension-view.tsx'

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
