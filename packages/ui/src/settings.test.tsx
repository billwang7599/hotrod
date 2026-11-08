// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ClientMessage, WorkFolder } from '@hotrod/core/shared'
import { SettingsDialog, WorkFolderDialog } from './settings.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root
let container: HTMLElement

beforeEach(() => {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const workFolder: WorkFolder = { defaultPath: '/garage/work', canSandbox: true }

function render(props: Partial<Parameters<typeof WorkFolderDialog>[0]> = {}, sent: ClientMessage[] = []) {
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider>
            <WorkFolderDialog
              open
              workFolder={workFolder}
              connected
              send={(m) => sent.push(m)}
              toasts={[]}
              {...props}
            />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
  return sent
}

const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement
const button = (name: string) =>
  [...dialog().querySelectorAll('button')].find((b) => b.textContent === name) as HTMLButtonElement | undefined
const type = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('on first run it offers the default, shown, or a typed folder, and has no way out but choosing', () => {
  const sent = render()
  expect(dialog().textContent).toContain('Choose a work folder')
  expect(dialog().textContent).toContain(workFolder.defaultPath)
  expect(button('Cancel')).toBeUndefined()
  act(() => button('Use default')!.click())
  expect(sent).toEqual([{ type: 'workFolder.set', path: workFolder.defaultPath }])

  type(dialog().querySelector('input')!, ' /elsewhere/work ')
  act(() => button('Use this folder')!.click())
  expect(sent.at(-1)).toEqual({ type: 'workFolder.set', path: '/elsewhere/work' })
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(dialog()).not.toBeNull()
})

test('shows a refusal that arrives after choosing, and picks with the desktop picker when there is one', async () => {
  const toasts = [{ id: 1, message: 'an old error' }]
  const pickFolder = vi.fn(async () => '/picked')
  const sent = render({ toasts, pickFolder })
  act(() => button('Use default')!.click())
  expect(dialog().textContent).not.toContain('an old error')
  render({ toasts: [...toasts, { id: 2, message: "/ can't be the work folder" }], pickFolder }, sent)
  expect(dialog().textContent).toContain("/ can't be the work folder")

  await act(async () => button('Choose…')!.click())
  expect(pickFolder).toHaveBeenCalledWith('Choose a work folder')
  expect(sent.at(-1)).toEqual({ type: 'workFolder.set', path: '/picked' })
})

function renderSettings(workFolder: WorkFolder, sent: ClientMessage[] = []) {
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider>
            <SettingsDialog
              open
              page="work"
              openPage={() => {}}
              close={() => {}}
              engines={[]}
              accounts={[]}
              contextDefaults={{ agents: true, folders: true, files: true }}
              instructions={{ path: '/garage/AGENTS.md', text: '' }}
              mods={[]}
              modelLists={{}}
              workFolder={workFolder}
              chooseWorkFolder={() => {}}
              connected
              send={(m) => sent.push(m)}
            />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
  return sent
}

test('Settings → Work folder turns edits outside the work folder on for every chat', () => {
  const editSwitch = () =>
    dialog().querySelector('[aria-label="Allow edits outside the work folder"]') as HTMLButtonElement
  const sent = renderSettings({ ...workFolder, path: '/garage/work' })
  expect(editSwitch().getAttribute('aria-checked')).toBe('false')
  act(() => editSwitch().click())
  expect(sent).toEqual([{ type: 'workFolder.setEditAnywhere', enabled: true }])
  renderSettings({ ...workFolder, path: '/garage/work', editAnywhere: true }, sent)
  expect(editSwitch().getAttribute('aria-checked')).toBe('true')
  act(() => editSwitch().click())
  expect(sent.at(-1)).toEqual({ type: 'workFolder.setEditAnywhere', enabled: false })
})

test('from Settings it starts at the current folder and can be cancelled', () => {
  const close = vi.fn()
  render({ workFolder: { ...workFolder, path: '/current/work' }, close })
  expect(dialog().querySelector('input')!.value).toBe('/current/work')
  act(() => button('Cancel')!.click())
  expect(close).toHaveBeenCalled()
})
