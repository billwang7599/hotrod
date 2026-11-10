// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ClientMessage, InstalledItem, MarketEntry, ExtensionInfo, RestartState } from '@kothar/core/shared'
import { ConfirmDialog } from './controls.tsx'
import { MarketplaceDialog, type Market } from './marketplace.tsx'
import { SettingsDialog } from './settings.tsx'
import { reduce, initialState } from './state.ts'
import { startAppearance } from './themes.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root
let container: HTMLElement

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => {} }))
  localStorage.clear()
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  startAppearance()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

const counter = (change: Partial<ExtensionInfo> = {}, community: Partial<NonNullable<ExtensionInfo['community']>> = {}): ExtensionInfo => ({
  id: 'counter',
  name: 'Counter',
  description: 'Counts words.',
  enabled: false,
  settings: [],
  values: {},
  community: { version: '1.0.0', author: 'Someone', uses: ['run', 'panels'], source: 'marketplace', repo: 'someone/counter', ...community },
  ...change,
})
const builtIn: ExtensionInfo = { id: 'home', name: 'Home', description: 'Your assistant.', enabled: true, settings: [], values: {} }

const entry: MarketEntry = {
  id: 'counter',
  kind: 'extension',
  name: 'Counter',
  author: 'Someone',
  description: 'Counts words.',
  repo: 'someone/counter',
  latest: { tag: 'v1.0.0', version: '1.0.0', uses: ['run', 'panels'] },
}
const installed: InstalledItem = { kind: 'extension', id: 'counter', name: 'Counter', version: '1.0.0', source: 'marketplace', repo: 'someone/counter', tag: 'v1.0.0' }

function render(node: ReactNode) {
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider>
            {node}
            <ConfirmDialog />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
}

type Extra = { communityExtensions?: boolean; restart?: RestartState; running?: number }

function settings(extensions: ExtensionInfo[], sent: ClientMessage[] = [], extra: Extra = { communityExtensions: true }) {
  render(
    <SettingsDialog
      open
      page="community-extensions"
      openPage={() => {}}
      close={() => {}}
      engines={[]}
      accounts={[]}
      contextDefaults={{ agents: true, folders: true, files: true }}
      extensions={extensions}
      modelLists={{ chat: [], planning: [], searching: [], workers: [] }}
      workFolder={{ defaultPath: '/garage/work', canSandbox: true }}
      chooseWorkFolder={() => {}}
      connected
      send={(m) => sent.push(m)}
      {...extra}
    />,
  )
  return sent
}

const buttons = (label: string) => [...document.querySelectorAll('button')].filter((b) => b.textContent === label)
const confirmText = () => document.querySelector('[role="alertdialog"]')?.textContent ?? ''
// The confirm's own button (OK, Turn on, Restart…) or Cancel.
const answer = async (ok: boolean) => {
  const dialog = document.querySelector('[role="alertdialog"]')!
  const [cancel, confirming] = [...dialog.querySelectorAll('button')]
  await act(async () => (ok ? confirming : cancel)!.click())
}
const extensionSwitch = (name = 'Counter') => document.querySelector(`[role="switch"][aria-label="${name}"]`) as HTMLButtonElement

test('Community hub lists only community extensions, with the warning, what each uses and where it came from', () => {
  settings([builtIn, counter()])
  const dialog = document.querySelector('[role="dialog"]')!
  const tabs = [...dialog.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)
  expect(tabs.indexOf('Community hub')).toBe(tabs.indexOf('Built-in extensions') + 1)
  const text = dialog.textContent!
  expect(text).toContain('runs code on your computer with your permissions')
  expect(text).toContain('Counter')
  expect(text).toContain('1.0.0 by Someone')
  expect(text).toContain('Runs programs on your computer')
  expect(text).toContain('Adds panels')
  expect(text).toContain('Off. Turn it on in Community hub.')
  expect(text).not.toContain('Your assistant.')
  expect(dialog.querySelector('a[href="https://github.com/someone/counter"]')).toBeTruthy()
})

test('says when no community extensions are installed', () => {
  settings([builtIn])
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('No community extensions installed.')
})

test('turning an extension on asks first, naming its repo and what it uses, and says it starts on a restart', async () => {
  const sent = settings([counter()])
  await act(async () => extensionSwitch().click())
  expect(confirmText()).toContain('Turn on Counter?')
  expect(confirmText()).toContain('From github.com/someone/counter.')
  expect(confirmText()).toContain('• Runs programs on your computer')
  expect(buttons('Turn on')).toHaveLength(1)
  await answer(false)
  expect(sent).toEqual([])

  await act(async () => extensionSwitch().click())
  await answer(true)
  expect(sent).toEqual([{ type: 'extension.setEnabled', extensionId: 'counter', enabled: true }])

  settings([counter({ enabled: true })], sent)
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Starts when Kothar restarts.')
})

test('the master switch is off by default: extensions are greyed out and can only be turned off', () => {
  settings([counter(), counter({ id: 'notes', name: 'Notes', enabled: true })], [], {})
  const text = document.querySelector('[role="dialog"]')!.textContent!
  expect(text).toContain('Off. No community extension runs, whatever its own switch says.')
  expect(extensionSwitch('Community extensions').getAttribute('aria-checked')).toBe('false')
  expect(document.querySelector('[aria-disabled="true"]')?.className).toContain('opacity-60')
  expect(extensionSwitch().disabled).toBe(true)
  // One that's on can still be turned off.
  expect(extensionSwitch('Notes').disabled).toBe(false)
  expect(text).toContain('Off while community extensions are off.')
})

test('turning community extensions on warns about the risks first; turning them off asks nothing', async () => {
  const sent = settings([counter()], [], { communityExtensions: false })
  await act(async () => extensionSwitch('Community extensions').click())
  expect(confirmText()).toContain('Turn on community extensions?')
  expect(confirmText()).toContain('They can read your files and settings, and reach the network.')
  expect(confirmText()).toContain("Kothar doesn't review them.")
  expect(confirmText()).toContain('An update can change what an extension does.')
  expect(buttons('Turn on community extensions')).toHaveLength(1)
  await answer(false)
  expect(sent).toEqual([])
  await act(async () => extensionSwitch('Community extensions').click())
  await answer(true)
  expect(sent).toEqual([{ type: 'communityExtensions.setEnabled', enabled: true }])

  settings([counter()], sent, { communityExtensions: true })
  await act(async () => extensionSwitch('Community extensions').click())
  expect(confirmText()).toBe('')
  expect(sent.at(-1)).toEqual({ type: 'communityExtensions.setEnabled', enabled: false })
})

test('a change waiting for a restart shows with a Restart button that warns about running chats', async () => {
  const restart: RestartState = {
    changes: [
      { id: 'counter', name: 'Counter', change: 'start' },
      { id: 'notes', name: 'Notes', change: 'stop' },
    ],
    canRestart: true,
  }
  const sent = settings([counter({ enabled: true })], [], { communityExtensions: true, restart, running: 2 })
  const notice = document.querySelector('[role="dialog"] [role="status"]')!
  expect(notice.textContent).toContain('Restart Kothar to apply: Counter starts, Notes stops')
  await act(async () => buttons('Restart')[0]!.click())
  expect(confirmText()).toContain('Restart Kothar?')
  expect(confirmText()).toContain('2 chats are running and will stop.')
  await answer(false)
  expect(sent).toEqual([])
  await act(async () => buttons('Restart')[0]!.click())
  await answer(true)
  expect(sent).toEqual([{ type: 'app.restart' }])

  // Nothing running: no question.
  settings([counter({ enabled: true })], sent, { communityExtensions: true, restart, running: 0 })
  await act(async () => buttons('Restart')[0]!.click())
  expect(confirmText()).toBe('')
  expect(sent.at(-1)).toEqual({ type: 'app.restart' })

  // A Kothar that can't restart itself says what to do instead.
  settings([counter({ enabled: true })], sent, { communityExtensions: true, restart: { ...restart, canRestart: false } })
  expect(buttons('Restart')).toHaveLength(0)
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Restart the dev server')

  settings([counter({ enabled: true })], sent, { communityExtensions: true, restart: { changes: [], canRestart: true } })
  expect(document.querySelector('[role="dialog"] [role="status"]')).toBeNull()
})

test('the state follows the master switch and what waits for a restart', () => {
  expect(initialState.communityExtensions).toBe(false)
  let state = reduce(initialState, { type: 'communityExtensions.updated', enabled: true })
  expect(state.communityExtensions).toBe(true)
  const restart: RestartState = { changes: [{ id: 'counter', name: 'Counter', change: 'update' }], canRestart: true }
  state = reduce(state, { type: 'restart.updated', restart })
  expect(state.restart).toEqual(restart)
})

test('turning an extension off, uninstalling it, and an extension that failed to load', async () => {
  const sent = settings([counter({ enabled: true, loadError: 'boom' }, { running: undefined })])
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Couldn't load: boom")
  await act(async () => extensionSwitch().click())
  expect(sent).toEqual([{ type: 'extension.setEnabled', extensionId: 'counter', enabled: false }])
  act(() => buttons('Uninstall')[0]!.click())
  expect(sent.at(-1)).toEqual({ type: 'market.uninstall', kind: 'extension', id: 'counter' })
})

test('says when a running extension has an update waiting for a restart', () => {
  settings([counter({ enabled: true }, { version: '1.1.0', running: '1.0.0' })])
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Running 1.0.0. Restart Kothar to run 1.1.0.')
})

test("an extension's own settings page lists what it uses", () => {
  const withSettings = counter({ enabled: true, settings: [{ key: 'n', label: 'N', type: 'number', default: 1 }], values: { n: 1 } }, { running: '1.0.0' })
  render(
    <SettingsDialog
      open
      page="extension:counter"
      openPage={() => {}}
      close={() => {}}
      engines={[]}
      accounts={[]}
      contextDefaults={{ agents: true, folders: true, files: true }}
      extensions={[withSettings]}
      modelLists={{ chat: [], planning: [], searching: [], workers: [] }}
      workFolder={{ defaultPath: '/garage/work', canSandbox: true }}
      chooseWorkFolder={() => {}}
      connected
      send={() => {}}
      communityExtensions
    />,
  )
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('UsesRuns programs on your computer')
})

function market(m: Partial<Market>, sent: ClientMessage[] = []) {
  render(<MarketplaceDialog open close={() => {}} market={{ marketFailures: {}, themes: [], installed: [], ...m }} connected send={(x) => sent.push(x)} />)
  return sent
}
// Picks the entry in the Marketplace's list and returns its detail pane.
const detail = (name: string) => {
  act(() => (document.querySelector(`[role="option"][aria-label="${name}"]`) as HTMLElement).click())
  return document.querySelector(`article[aria-label="${name}"]`)!
}

test('the Marketplace lists extensions with what they use and the warning, and asks before installing', async () => {
  const sent = market({ catalog: { entries: [entry] } })
  const row = detail('Counter')
  expect(row.textContent).toContain('Runs programs on your computer')
  expect(row.textContent).toContain('1.0.0')
  expect(row.textContent).toContain('A community extension runs code on your computer')
  await act(async () => buttons('Install')[0]!.click())
  expect(confirmText()).toContain('Install Counter?')
  expect(confirmText()).toContain('It stays off until you turn it on in Community hub.')
  expect(confirmText()).toContain('• Adds panels')
  await answer(true)
  expect(sent.at(-1)).toEqual({ type: 'market.install', kind: 'extension', id: 'counter' })
})

test('the Marketplace says an installed extension is off, and offers its update', () => {
  market({ catalog: { entries: [entry] }, installed: [installed], extensions: [counter()] })
  const row = detail('Counter')
  expect(row.textContent).toContain('Off. Turn it on in Community hub.')
  market({
    catalog: { entries: [{ ...entry, latest: { ...entry.latest!, version: '2.0.0' } }] },
    installed: [installed],
    extensions: [counter()],
  })
  expect(buttons('Update to 2.0.0')).toHaveLength(1)
})

test('the state adds a newly installed extension and drops an uninstalled one', () => {
  let state = reduce({ ...initialState, extensions: [builtIn] }, { type: 'extension.updated', extension: counter() })
  expect(state.extensions.map((m) => m.id)).toEqual(['home', 'counter'])
  state = reduce(state, { type: 'extension.updated', extension: counter({ enabled: true }) })
  expect(state.extensions.find((m) => m.id === 'counter')!.enabled).toBe(true)
  state = reduce(state, { type: 'extension.removed', extensionId: 'counter' })
  expect(state.extensions.map((m) => m.id)).toEqual(['home'])
})

test('Install from folder: a browser tab types a path; the answer shows inline', () => {
  const sent = market({ catalog: { entries: [] } })
  const input = document.querySelector('input[aria-label="Install from a folder by path"]') as HTMLInputElement
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '/Users/me/my-extension')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => buttons('Install from folder')[0]!.click())
  expect(sent.at(-1)).toEqual({ type: 'market.installLocal', path: '/Users/me/my-extension' })
  expect(document.body.textContent).toContain('Installing…')

  const local: InstalledItem = { kind: 'extension', id: 'mine', name: 'Mine', version: '0.1.0', source: 'local', path: '/Users/me/my-extension' }
  const answered = { path: '/Users/me/my-extension', kind: 'extension' as const, ids: ['mine'], count: 1 }
  market({ catalog: { entries: [] }, installed: [local], localInstall: answered }, sent)
  expect(document.body.textContent).toContain('Installed Mine from /Users/me/my-extension. Turn it on in Community hub.')
})

test('Install from folder: the desktop picker comes first, and a failure shows why', async () => {
  const sent: ClientMessage[] = []
  const pickFolder = vi.fn(async () => '/Users/me/broken')
  render(<MarketplaceDialog open close={() => {}} market={{ marketFailures: {}, themes: [], installed: [], catalog: { entries: [] } }} connected send={(x) => sent.push(x)} pickFolder={pickFolder} />)
  expect(document.querySelector('input[aria-label="Install from a folder by path"]')).toBeNull()
  await act(async () => buttons('Install from folder…')[0]!.click())
  expect(pickFolder).toHaveBeenCalledWith('Install from folder')
  expect(sent.at(-1)).toEqual({ type: 'market.installLocal', path: '/Users/me/broken' })
  const failed = { path: '/Users/me/broken', error: '/Users/me/broken has no main.mjs. Build the extension first.', count: 1 }
  render(
    <MarketplaceDialog
      open
      close={() => {}}
      market={{ marketFailures: {}, themes: [], installed: [], catalog: { entries: [] }, localInstall: failed }}
      connected
      send={(x) => sent.push(x)}
      pickFolder={pickFolder}
    />,
  )
  expect(document.body.textContent).toContain('has no main.mjs. Build the extension first.')
  act(() => buttons('Type a path')[0]!.click())
  expect(document.querySelector('input[aria-label="Install from a folder by path"]')).toBeTruthy()
})

test('a local install is marked Local, offers Reinstall from its folder, and never an update', () => {
  const local: InstalledItem = { kind: 'extension', id: 'counter', name: 'Counter', version: '0.1.0', source: 'local', path: '/Users/me/counter' }
  const sent = market({ catalog: { entries: [entry] }, installed: [local], extensions: [counter({}, { source: 'local', path: '/Users/me/counter' })] })
  const row = detail('Counter')
  expect(row.textContent).toContain('Local')
  expect(buttons('Update to 1.0.0')).toHaveLength(0)
  act(() => buttons('Reinstall')[0]!.click())
  expect(sent.at(-1)).toEqual({ type: 'market.installLocal', path: '/Users/me/counter' })
})

test('the state keeps the last answer to Install from folder, counted', () => {
  let state = reduce(initialState, { type: 'market.localFailed', path: '/x', error: 'nope' })
  state = reduce(state, { type: 'market.localInstalled', path: '/x', kind: 'theme', ids: ['nord'] })
  expect(state.localInstall).toEqual({ path: '/x', kind: 'theme', ids: ['nord'], count: 2 })
})
