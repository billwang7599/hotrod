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
  delete window.kothar
})

const sent: ExtensionAction[] = []
const show = (view: ExtensionView) => {
  sent.length = 0
  act(() =>
    root.render(
      <Tooltip.Provider>
        <ExtensionViewer view={view} act={(action) => sent.push(action)} />
      </Tooltip.Provider>,
    ),
  )
}
const desktop = (folder: string | null, files: string[]) => {
  const titles: (string | undefined)[] = []
  window.kothar = {
    pickFolder: async (title) => (titles.push(title), folder),
    pickFiles: async (title) => (titles.push(title), files),
  } as NonNullable<Window['kothar']>
  return titles
}
const click = async (label: string) => {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label)!
  await act(async () => button.click())
}

const pickers: ExtensionView = {
  type: 'row',
  children: [
    { type: 'button', label: 'Folder…', action: { name: 'folder' }, pick: { kind: 'folder', title: 'Pick a folder' } },
    { type: 'button', label: 'File…', action: { name: 'file', value: 'ignored' }, pick: { kind: 'file' } },
    { type: 'button', label: 'Plain', action: { name: 'plain' } },
  ],
}

test('a pick button sends the picked folder or first file as its value', async () => {
  const titles = desktop('/Users/me/skill', ['/Users/me/a.zip', '/Users/me/b.zip'])
  show(pickers)
  await click('Folder…')
  await click('File…')
  expect(titles).toEqual(['Pick a folder', undefined])
  expect(sent).toEqual([
    { name: 'folder', value: '/Users/me/skill' },
    { name: 'file', value: '/Users/me/a.zip' },
  ])
})

test('cancelling the picker sends nothing', async () => {
  desktop(null, [])
  show(pickers)
  await click('Folder…')
  await click('File…')
  expect(sent).toEqual([])
})

test('in a browser tab, with no picker, pick buttons are left out and others stay', () => {
  show(pickers)
  expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Plain'])
})
