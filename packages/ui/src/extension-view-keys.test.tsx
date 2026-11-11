// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { ExtensionAction, ExtensionView } from '@kothar/extension-api'
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

const view: ExtensionView = {
  type: 'split',
  side: {
    type: 'stack',
    children: [
      { type: 'search', placeholder: 'Search', action: 'search', submit: 'go' },
      {
        type: 'list',
        label: 'Notes',
        items: [
          { key: 'a', label: 'Alpha', action: { name: 'open', value: 'a' } },
          { key: 'b', label: 'Beta', action: { name: 'open', value: 'b' } },
        ],
      },
    ],
  },
  main: { type: 'empty', text: 'Nothing open' },
}

function show() {
  const acts: ExtensionAction[] = []
  act(() =>
    root.render(
      <Tooltip.Provider>
        <ExtensionViewer view={view} act={(a) => acts.push(a)} />
      </Tooltip.Provider>,
    ),
  )
  return acts
}

const key = (el: Element, k: string) => act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })))

test('Enter in a search box with submit sends what is typed, then the submit action, at once', () => {
  const acts = show()
  const box = host.querySelector('input[type=search]') as HTMLInputElement
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(box, 'alp')
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
  key(box, 'Enter')
  expect(acts).toEqual([
    { name: 'search', value: 'alp' },
    { name: 'go', value: 'alp' },
  ])
})

test('the arrows go from the search box down a list and back up', () => {
  show()
  const box = host.querySelector('input[type=search]') as HTMLInputElement
  const [alpha, beta] = [...host.querySelectorAll('ul button')] as HTMLButtonElement[]
  box.focus()
  key(box, 'ArrowDown')
  expect(document.activeElement).toBe(alpha)
  key(alpha!, 'ArrowDown')
  expect(document.activeElement).toBe(beta)
  key(beta!, 'ArrowUp')
  key(alpha!, 'ArrowUp')
  expect(document.activeElement).toBe(box)
})
