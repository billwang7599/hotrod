// @vitest-environment jsdom
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { checkCatalog, checkTheme, type ClientMessage, type ThemeFile } from '@kotharhq/core/shared'
import { MarketplacePage, type Market } from './marketplace.tsx'
import { reduce, initialState } from './state.ts'
import { SettingsDialog } from './settings.tsx'
import { setInstalledThemes, startAppearance } from './themes.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// jsdom gives import.meta.url a non-file scheme, so the path comes from the folder name.
const dir = join(import.meta.dirname, '../../../marketplace')
const entries = checkCatalog(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')))
const themeFile = (id: string): ThemeFile =>
  checkTheme(JSON.parse(readFileSync(join(dir, `themes/${id}.json`), 'utf8')))
const nord = themeFile('nord')
const nordEntry = entries.find((e) => e.id === 'nord')!

let root: Root
let container: HTMLElement

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => {} }))
  localStorage.clear()
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  startAppearance()
  setInstalledThemes([])
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function show(market: Market, sent: ClientMessage[] = [], connected = true) {
  act(() =>
    root.render(
      <Tooltip.Provider>
        <MarketplacePage market={market} connected={connected} send={(m) => sent.push(m)} />
      </Tooltip.Provider>,
    ),
  )
  return sent
}

const row = (name: string) => container.querySelector(`[role="listitem"][aria-label="${name}"]`) as HTMLElement | null
const button = (within: HTMLElement | null, label: string) =>
  [...(within?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label)

test('asks the core for the catalog and says it is loading', () => {
  const sent = show({ themeFailures: {} })
  expect(sent).toEqual([{ type: 'marketplace.list' }])
  expect(container.textContent).toContain('Loading the marketplace…')
})

test("doesn't ask while disconnected", () => {
  expect(show({ themeFailures: {} }, [], false)).toEqual([])
})

test('lists each theme with its author, description and a swatch of its colours in both schemes', () => {
  show({ catalog: { entries }, themes: [], themeFailures: {} })
  for (const entry of entries) {
    const r = row(entry.name)!
    expect(r.textContent).toContain(entry.name)
    expect(r.textContent).toContain(`by ${entry.author}`)
    expect(r.textContent).toContain(entry.description)
    expect(button(r, 'Install')).toBeTruthy()
  }
  const swatch = row('Nord')!.querySelector('[data-scheme="dark"]') as HTMLElement
  expect(swatch.style.background).toBe(hexToRgb(nordEntry.preview!.dark.bg))
  const light = row('Nord')!.querySelector('[data-scheme="light"]') as HTMLElement
  const parts = [...light.querySelectorAll('span')].map((s) => s.style.background)
  expect(parts).toEqual(
    expect.arrayContaining([nordEntry.preview!.light.panel, nordEntry.preview!.light.text, nordEntry.preview!.light.accent].map(hexToRgb)),
  )
})

test('installs a theme, shows it installing, then offers Use and Uninstall', () => {
  const sent = show({ catalog: { entries }, themes: [], themeFailures: {} })
  act(() => button(row('Nord'), 'Install')!.click())
  expect(sent.at(-1)).toEqual({ type: 'theme.install', id: 'nord' })
  const installing = button(row('Nord'), 'Installing…')!
  expect(installing.disabled).toBe(true)

  show({ catalog: { entries }, themes: [nord], themeFailures: {} }, sent)
  expect(row('Nord')!.textContent).toContain('Installed')
  expect(button(row('Nord'), 'Install')).toBeUndefined()
  setInstalledThemes([nord])
  act(() => button(row('Nord'), 'Use')!.click())
  expect(localStorage.getItem('kothar.theme')).toBe('nord')
  expect(document.documentElement.style.getPropertyValue('--bg')).toBe(nord.dark.bg)
  expect(button(row('Nord'), 'In use')!.disabled).toBe(true)

  act(() => button(row('Nord'), 'Uninstall')!.click())
  expect(sent.at(-1)).toEqual({ type: 'theme.uninstall', id: 'nord' })
})

test('shows why an install failed, inline, and lets it be tried again', () => {
  const sent = show({ catalog: { entries }, themes: [], themeFailures: {} })
  act(() => button(row('Nord'), 'Install')!.click())
  const failed = (count: number) => ({ nord: { error: "Couldn't reach the marketplace: fetch failed", count } })
  show({ catalog: { entries }, themes: [], themeFailures: failed(1) }, sent)
  expect(row('Nord')!.textContent).toContain("Couldn't reach the marketplace: fetch failed")
  act(() => button(row('Nord'), 'Install')!.click())
  expect(button(row('Nord'), 'Installing…')).toBeTruthy()
  // The same error again still ends the install.
  show({ catalog: { entries }, themes: [], themeFailures: failed(2) }, sent)
  expect(button(row('Nord'), 'Install')!.disabled).toBe(false)
})

test('offers an update when the marketplace has a newer version', () => {
  const sent = show({ catalog: { entries }, themes: [{ ...nord, version: '0.9.0' }], themeFailures: {} })
  act(() => button(row('Nord'), 'Update')!.click())
  expect(sent.at(-1)).toEqual({ type: 'theme.install', id: 'nord' })
  expect(button(row('Nord'), 'Updating…')).toBeTruthy()
})

test('says the marketplace is unreachable, offers Try again, and still lists installed themes', () => {
  const error = "Couldn't reach the marketplace: fetch failed"
  const sent = show({ catalog: { error }, themes: [nord], themeFailures: {} })
  expect(container.textContent).toContain(error)
  act(() => button(container, 'Try again')!.click())
  expect(sent.filter((m) => m.type === 'marketplace.list')).toHaveLength(2)
  expect(button(row('Nord'), 'Uninstall')).toBeTruthy()
  expect(row('Nord')!.textContent).not.toContain('No longer in the marketplace')
})

test('says when the marketplace is empty', () => {
  show({ catalog: { entries: [] }, themes: [], themeFailures: {} })
  expect(container.textContent).toContain('No themes in the marketplace yet.')
})

test('the state keeps the catalog and failures, and an install clears its failure', () => {
  let state = reduce(initialState, { type: 'marketplace.catalog', entries })
  expect(state.catalog).toEqual({ entries, error: undefined })
  state = reduce(state, { type: 'theme.installFailed', id: 'nord', error: 'x' })
  state = reduce(state, { type: 'theme.installFailed', id: 'nord', error: 'x' })
  expect(state.themeFailures.nord).toEqual({ error: 'x', count: 2 })
  state = reduce(state, { type: 'themes.updated', themes: [nord] })
  expect(state.themes).toEqual([nord])
  expect(state.themeFailures).toEqual({})
})

test('Settings has a Marketplace page beside Appearance', () => {
  act(() =>
    root.render(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig transition={{ duration: 0 }}>
          <Tooltip.Provider>
            <SettingsDialog
              open
              page="marketplace"
              openPage={() => {}}
              close={() => {}}
              engines={[]}
              accounts={[]}
              contextDefaults={{ agents: true, folders: true, files: true }}
              mods={[]}
              modelLists={{ chat: [], planning: [], searching: [], subagents: [] }}
              workFolder={{ defaultPath: '/garage/work', canSandbox: true }}
              chooseWorkFolder={() => {}}
              market={{ catalog: { entries }, themes: [], themeFailures: {} }}
              connected
              send={() => {}}
            />
          </Tooltip.Provider>
        </MotionConfig>
      </LazyMotion>,
    ),
  )
  const dialog = document.querySelector('[role="dialog"]')!
  const tabs = [...dialog.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)
  expect(tabs.indexOf('Marketplace')).toBe(tabs.indexOf('Appearance') + 1)
  expect(dialog.querySelector('[role="listitem"][aria-label="Nord"]')).toBeTruthy()
})

function hexToRgb(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return `rgb(${r}, ${g}, ${b})`
}
