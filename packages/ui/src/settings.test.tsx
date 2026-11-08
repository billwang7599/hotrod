// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  PERMISSION_DEFAULTS,
  PERMISSION_SWITCHES,
  type ClientMessage,
  type ModInfo,
  type SetupState,
  type WorkFolder,
} from '@hotrod/core/shared'
import type { ModSetting } from '@hotrod/mod-api'
import { PERMISSIONS } from './context-panel.tsx'
import { SettingsDialog, WorkFolderDialog, type SettingsPage } from './settings.tsx'

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

test('Settings → Work folder sets the default of each permission every chat follows', () => {
  for (const name of PERMISSION_SWITCHES) {
    const toggle = () =>
      dialog().querySelector(`[aria-label="${PERMISSIONS[name].label}"]`) as HTMLButtonElement
    const sent = renderSettings({ ...workFolder, path: '/garage/work' })
    expect(toggle().getAttribute('aria-checked')).toBe(String(PERMISSION_DEFAULTS[name]))
    act(() => toggle().click())
    expect(sent).toEqual([{ type: 'permission.setDefault', name, enabled: !PERMISSION_DEFAULTS[name] }])
    renderSettings({ ...workFolder, path: '/garage/work', [name]: !PERMISSION_DEFAULTS[name] }, sent)
    expect(toggle().getAttribute('aria-checked')).toBe(String(!PERMISSION_DEFAULTS[name]))
  }
})

test('Settings has no Instructions page: the global AGENTS.md is edited in the Context panel', () => {
  renderSettings(workFolder)
  const tabs = [...dialog().querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)
  expect(tabs).toContain('Work folder')
  expect(tabs).not.toContain('Instructions')
})

test('from Settings it starts at the current folder and can be cancelled', () => {
  const close = vi.fn()
  render({ workFolder: { ...workFolder, path: '/current/work' }, close })
  expect(dialog().querySelector('input')!.value).toBe('/current/work')
  act(() => button('Cancel')!.click())
  expect(close).toHaveBeenCalled()
})

const setupMod = (enabled: boolean, setup: Omit<SetupState, 'description'>, settings: ModSetting[] = []): ModInfo => ({
  id: 'browser',
  name: 'Browser',
  description: 'Browse the web.',
  enabled,
  settings,
  values: {},
  setup: { description: 'Downloads a browser.', ...setup },
})

function renderMods(mods: ModInfo[], page: SettingsPage, sent: ClientMessage[] = []) {
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider>
            <SettingsDialog
              open
              page={page}
              openPage={() => {}}
              close={() => {}}
              engines={[]}
              accounts={[]}
              contextDefaults={{ agents: true, folders: true, files: true }}
              mods={mods}
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

const setupDialog = () => document.querySelector('[role="alertdialog"]') as HTMLElement | null
const setupButton = (name: string) =>
  [...setupDialog()!.querySelectorAll('button')].find((b) => b.textContent === name) as HTMLButtonElement

test('turning on a mod that is not set up asks to install it, shows the progress and can cancel', () => {
  const sent = renderMods([setupMod(false, { status: 'checking' })], 'mods')
  act(() => (dialog().querySelector('[aria-label="Browser"]') as HTMLButtonElement).click())
  expect(sent).toEqual([{ type: 'mod.setEnabled', modId: 'browser', enabled: true }])
  renderMods([setupMod(true, { status: 'checking' })], 'mods', sent)
  expect(setupDialog()).toBeNull()

  const missing = { status: 'missing', message: 'Browser not installed' } as const
  renderMods([setupMod(true, missing)], 'mods', sent)
  expect(setupDialog()!.textContent).toContain('Browser not installed')
  act(() => setupButton('Install').click())
  expect(sent.at(-1)).toEqual({ type: 'mod.install', modId: 'browser' })

  const installing = { ...missing, status: 'installing', progressText: 'Downloading Chromium', progress: 0.4 } as const
  renderMods([setupMod(true, installing)], 'mods', sent)
  expect(setupDialog()!.textContent).toContain('Downloading Chromium')
  expect(setupDialog()!.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('40')
  renderMods([setupMod(true, { status: 'checking', message: missing.message })], 'mods', sent)
  expect(setupDialog()!.textContent).toContain('Browser not installed')
  renderMods([setupMod(true, { ...missing, error: 'Download failed' })], 'mods', sent)
  expect(setupDialog()!.textContent).toContain('Download failed')
  act(() => setupButton('Install').click())
  renderMods([setupMod(true, { status: 'installing' })], 'mods', sent)
  act(() => setupButton('Cancel').click())
  expect(sent.slice(-2)).toEqual([
    { type: 'mod.install', modId: 'browser' },
    { type: 'mod.cancelInstall', modId: 'browser' },
  ])
  expect(setupDialog()).toBeNull()

  renderMods([setupMod(false, { status: 'missing', message: 'Browser not installed' })], 'mods', sent)
  act(() => (dialog().querySelector('[aria-label="Browser"]') as HTMLButtonElement).click())
  renderMods([setupMod(true, { status: 'checking', message: 'Browser not installed' })], 'mods', sent)
  renderMods([setupMod(true, { status: 'ready', message: 'Browser installed' })], 'mods', sent)
  expect(setupDialog()).toBeNull()
})

test("a mod's page shows its setup, with Install while it is missing, even when it has no settings", () => {
  const sent = renderMods([setupMod(true, { status: 'missing', message: 'Browser not installed' })], 'mod:browser')
  const tabs = [...dialog().querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)
  expect(tabs).toContain('Browser')
  expect(dialog().textContent).toContain('Browser not installed')
  act(() => ([...dialog().querySelectorAll('button')].find((b) => b.textContent === 'Install') as HTMLElement).click())
  expect(sent).toEqual([{ type: 'mod.install', modId: 'browser' }])
  renderMods([setupMod(true, { status: 'ready', message: 'Browser installed' })], 'mod:browser', sent)
  expect(dialog().textContent).toContain('Browser installed')
  expect([...dialog().querySelectorAll('button')].some((b) => b.textContent === 'Install')).toBe(false)
})
