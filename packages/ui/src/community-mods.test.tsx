// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ClientMessage, InstalledItem, MarketEntry, ModInfo } from '@kotharhq/core/shared'
import { ConfirmDialog } from './controls.tsx'
import { MarketplacePage, type Market } from './marketplace.tsx'
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

const counter = (change: Partial<ModInfo> = {}, community: Partial<NonNullable<ModInfo['community']>> = {}): ModInfo => ({
  id: 'counter',
  name: 'Counter',
  description: 'Counts words.',
  enabled: false,
  settings: [],
  values: {},
  community: { version: '1.0.0', author: 'Someone', uses: ['run', 'panels'], source: 'marketplace', repo: 'someone/counter', ...community },
  ...change,
})
const builtIn: ModInfo = { id: 'home', name: 'Home', description: 'Your assistant.', enabled: true, settings: [], values: {} }

const entry: MarketEntry = {
  id: 'counter',
  kind: 'mod',
  name: 'Counter',
  author: 'Someone',
  description: 'Counts words.',
  repo: 'someone/counter',
  latest: { tag: 'v1.0.0', version: '1.0.0', uses: ['run', 'panels'] },
}
const installed: InstalledItem = { kind: 'mod', id: 'counter', name: 'Counter', version: '1.0.0', source: 'marketplace', repo: 'someone/counter', tag: 'v1.0.0' }

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

function settings(mods: ModInfo[], sent: ClientMessage[] = []) {
  render(
    <SettingsDialog
      open
      page="community-mods"
      openPage={() => {}}
      close={() => {}}
      engines={[]}
      accounts={[]}
      contextDefaults={{ agents: true, folders: true, files: true }}
      mods={mods}
      modelLists={{ chat: [], planning: [], searching: [], subagents: [] }}
      workFolder={{ defaultPath: '/garage/work', canSandbox: true }}
      chooseWorkFolder={() => {}}
      connected
      send={(m) => sent.push(m)}
    />,
  )
  return sent
}

const buttons = (label: string) => [...document.querySelectorAll('button')].filter((b) => b.textContent === label)
const confirmText = () => document.querySelector('[role="alertdialog"]')?.textContent ?? ''
const answer = async (ok: boolean) => {
  await act(async () => buttons(ok ? 'OK' : 'Cancel')[0]!.click())
}

test('Community mods lists only community mods, with the warning, what each uses and where it came from', () => {
  settings([builtIn, counter()])
  const dialog = document.querySelector('[role="dialog"]')!
  const tabs = [...dialog.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)
  expect(tabs.indexOf('Community mods')).toBe(tabs.indexOf('Built-in mods') + 1)
  const text = dialog.textContent!
  expect(text).toContain('runs code on your computer with your permissions')
  expect(text).toContain('Counter')
  expect(text).toContain('1.0.0 by Someone')
  expect(text).toContain('Runs programs on your computer')
  expect(text).toContain('Adds panels')
  expect(text).toContain('Off. Turn it on in Community mods.')
  expect(text).not.toContain('Your assistant.')
  expect(dialog.querySelector('a[href="https://github.com/someone/counter"]')).toBeTruthy()
})

test('says when no community mods are installed', () => {
  settings([builtIn])
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('No community mods installed.')
})

test('turning a mod on asks first, listing what it uses, and says it starts on the next start', async () => {
  const sent = settings([counter()])
  await act(async () => (document.querySelector('[role="switch"]') as HTMLElement).click())
  expect(confirmText()).toContain('Turn on Counter?')
  expect(confirmText()).toContain('• Runs programs on your computer')
  await answer(false)
  expect(sent).toEqual([])

  await act(async () => (document.querySelector('[role="switch"]') as HTMLElement).click())
  await answer(true)
  expect(sent).toEqual([{ type: 'mod.setEnabled', modId: 'counter', enabled: true }])

  settings([counter({ enabled: true })], sent)
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('On from the next start of Kothar.')
})

test('turning a mod off, uninstalling it, and a mod that failed to load', async () => {
  const sent = settings([counter({ enabled: true, loadError: 'boom' }, { running: undefined })])
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Couldn't load: boom")
  await act(async () => (document.querySelector('[role="switch"]') as HTMLElement).click())
  expect(sent).toEqual([{ type: 'mod.setEnabled', modId: 'counter', enabled: false }])
  act(() => buttons('Uninstall')[0]!.click())
  expect(sent.at(-1)).toEqual({ type: 'market.uninstall', kind: 'mod', id: 'counter' })
})

test('says when a running mod has an update waiting for a restart', () => {
  settings([counter({ enabled: true }, { version: '1.1.0', running: '1.0.0' })])
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Running 1.0.0. Restart Kothar to run 1.1.0.')
})

test("a mod's own settings page lists what it uses", () => {
  const withSettings = counter({ enabled: true, settings: [{ key: 'n', label: 'N', type: 'number', default: 1 }], values: { n: 1 } }, { running: '1.0.0' })
  render(
    <SettingsDialog
      open
      page="mod:counter"
      openPage={() => {}}
      close={() => {}}
      engines={[]}
      accounts={[]}
      contextDefaults={{ agents: true, folders: true, files: true }}
      mods={[withSettings]}
      modelLists={{ chat: [], planning: [], searching: [], subagents: [] }}
      workFolder={{ defaultPath: '/garage/work', canSandbox: true }}
      chooseWorkFolder={() => {}}
      connected
      send={() => {}}
    />,
  )
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('UsesRuns programs on your computer')
})

function market(m: Partial<Market>, sent: ClientMessage[] = []) {
  render(<MarketplacePage market={{ marketFailures: {}, themes: [], installed: [], ...m }} connected send={(x) => sent.push(x)} />)
  return sent
}

test('the Marketplace lists mods with what they use and the warning, and asks before installing', async () => {
  const sent = market({ catalog: { entries: [entry] } })
  const row = document.querySelector('[role="listitem"][aria-label="Counter"]')!
  expect(row.textContent).toContain('Runs programs on your computer')
  expect(row.textContent).toContain('1.0.0')
  expect(container.textContent).toContain('A community mod runs code on your computer')
  await act(async () => buttons('Install')[0]!.click())
  expect(confirmText()).toContain('Install Counter? It stays off until you turn it on in Community mods.')
  expect(confirmText()).toContain('• Adds panels')
  await answer(true)
  expect(sent.at(-1)).toEqual({ type: 'market.install', kind: 'mod', id: 'counter' })
})

test('the Marketplace says an installed mod is off, and offers its update', () => {
  market({ catalog: { entries: [entry] }, installed: [installed], mods: [counter()] })
  const row = document.querySelector('[role="listitem"][aria-label="Counter"]')!
  expect(row.textContent).toContain('Off. Turn it on in Community mods.')
  market({
    catalog: { entries: [{ ...entry, latest: { ...entry.latest!, version: '2.0.0' } }] },
    installed: [installed],
    mods: [counter()],
  })
  expect(buttons('Update to 2.0.0')).toHaveLength(1)
})

test('the state adds a newly installed mod and drops an uninstalled one', () => {
  let state = reduce({ ...initialState, mods: [builtIn] }, { type: 'mod.updated', mod: counter() })
  expect(state.mods.map((m) => m.id)).toEqual(['home', 'counter'])
  state = reduce(state, { type: 'mod.updated', mod: counter({ enabled: true }) })
  expect(state.mods.find((m) => m.id === 'counter')!.enabled).toBe(true)
  state = reduce(state, { type: 'mod.removed', modId: 'counter' })
  expect(state.mods.map((m) => m.id)).toEqual(['home'])
})
