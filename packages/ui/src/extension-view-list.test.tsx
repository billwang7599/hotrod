// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { ExtensionAction, ExtensionView } from '@kothar/extension-api'
import { Tooltip } from 'radix-ui'
import { ExtensionViewer, Marked } from './extension-view.tsx'

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

test('marked text highlights its ranges, and odd ranges never lose or reorder text', () => {
  expect(renderToStaticMarkup(<Marked text="Groceries" marks={[[0, 3]]} />)).toBe('<mark class="rounded-sm bg-accent/25 text-inherit">Gro</mark>ceries')
  // Unsorted, overlapping, out of range and not numbers.
  const odd = [[5, 99], [1, 3], [2, 6], [-4, 0], ['x', 2]] as unknown as [number, number][]
  const html = renderToStaticMarkup(<Marked text="abcdefgh" marks={odd} />)
  expect(html.replace(/<[^>]+>/g, '')).toBe('abcdefgh')
  expect([...html.matchAll(/<mark[^>]*>([^<]*)<\/mark>/g)].map((m) => m[1])).toEqual(['bc', 'def', 'gh'])
})

test('a list row shows its excerpt with marks and its extra button, which the arrows skip', () => {
  const acted: ExtensionAction[] = []
  const view: ExtensionView = {
    type: 'stack',
    children: [
      { type: 'search', action: 'search', placeholder: 'Search' },
      {
        type: 'list',
        label: 'Notes',
        items: [
          {
            key: 'a',
            label: 'Groceries',
            marks: [[0, 3]],
            excerpt: { text: '…buy milk today', marks: [[5, 9]] },
            action: { name: 'open', value: 'a' },
            button: { label: 'Link', action: { name: 'link', value: 'a' } },
          },
          { key: 'b', label: 'Plans', action: { name: 'open', value: 'b' } },
        ],
      },
    ],
  }
  act(() => root.render(<Tooltip.Provider><ExtensionViewer view={view} act={(a) => acted.push(a)} /></Tooltip.Provider>))
  expect(host.querySelector('[data-excerpt]')!.innerHTML).toContain('<mark class="rounded-sm bg-accent/25 text-inherit">milk</mark>')
  expect([...host.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['Gro', 'milk'])
  const link = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Link')!
  act(() => link.click())
  expect(acted).toEqual([{ name: 'link', value: 'a' }])
  // ArrowDown from the search box goes to the first row, then the next row, never the Link button.
  const press = (el: Element, key: string) => act(() => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))
  press(host.querySelector('input[type=search]')!, 'ArrowDown')
  expect(document.activeElement!.textContent).toContain('Groceries')
  press(document.activeElement!, 'ArrowDown')
  expect(document.activeElement!.textContent).toBe('Plans')
})
