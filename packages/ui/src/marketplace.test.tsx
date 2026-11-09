// @vitest-environment jsdom
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  checkTheme,
  previewOf,
  type ClientMessage,
  type InstalledItem,
  type MarketEntry,
  type ThemeFile,
} from '@kotharhq/core/shared'
import { MarketplacePage, type Market } from './marketplace.tsx'
import { reduce, initialState } from './state.ts'
import { SettingsDialog } from './settings.tsx'
import { setInstalledThemes, startAppearance } from './themes.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// jsdom gives import.meta.url a non-file scheme, so the path comes from the folder name.
const dir = join(import.meta.dirname, '../../core/src/test-themes')
const themeFile = (id: string): ThemeFile => checkTheme(JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')))
const REPO = 'billwang7599/kothar-themes'
const entryOf = (theme: ThemeFile): MarketEntry => ({
  id: theme.id,
  kind: 'theme',
  name: theme.name,
  author: theme.author,
  description: theme.description,
  repo: REPO,
  latest: { tag: 'v1.0.0', version: theme.version, preview: previewOf(theme) },
})
const nord = themeFile('nord')
const entries = ['nord', 'gruvbox', 'catppuccin'].map((id) => entryOf(themeFile(id)))
const nordEntry = entries[0]!
const installedNord = (change: Partial<InstalledItem> = {}): InstalledItem => ({
  kind: 'theme',
  id: 'nord',
  name: 'Nord',
  version: nord.version,
  source: 'marketplace',
  repo: REPO,
  tag: 'v1.0.0',
  ...change,
})

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
  const sent = show({ marketFailures: {} })
  expect(sent).toEqual([{ type: 'marketplace.list' }])
  expect(container.textContent).toContain('Loading the marketplace…')
})

test("doesn't ask while disconnected", () => {
  expect(show({ marketFailures: {} }, [], false)).toEqual([])
})

test('lists each theme with its author, description and a swatch of its colours in both schemes', () => {
  show({ catalog: { entries }, themes: [], marketFailures: {} })
  for (const entry of entries) {
    const r = row(entry.name)!
    expect(r.textContent).toContain(entry.name)
    expect(r.textContent).toContain(`by ${entry.author}`)
    expect(r.textContent).toContain(entry.description)
    expect(button(r, 'Install')).toBeTruthy()
  }
  const swatch = row('Nord')!.querySelector('[data-scheme="dark"]') as HTMLElement
  expect(swatch.style.background).toBe(hexToRgb(nordEntry.latest!.preview!.dark.bg))
  const light = row('Nord')!.querySelector('[data-scheme="light"]') as HTMLElement
  const parts = [...light.querySelectorAll('span')].map((s) => s.style.background)
  expect(parts).toEqual(
    expect.arrayContaining([nordEntry.latest!.preview!.light.panel, nordEntry.latest!.preview!.light.text, nordEntry.latest!.preview!.light.accent].map(hexToRgb)),
  )
})

test("links each entry to its author's repo", () => {
  show({ catalog: { entries }, themes: [], marketFailures: {} })
  const link = row('Nord')!.querySelector('a')!
  expect(link.textContent).toBe(REPO)
  expect(link.getAttribute('href')).toBe(`https://github.com/${REPO}`)
})

test('installs a theme, shows it installing, then offers Use and Uninstall', () => {
  const sent = show({ catalog: { entries }, themes: [], installed: [], marketFailures: {} })
  act(() => button(row('Nord'), 'Install')!.click())
  expect(sent.at(-1)).toEqual({ type: 'market.install', kind: 'theme', id: 'nord' })
  const installing = button(row('Nord'), 'Installing…')!
  expect(installing.disabled).toBe(true)

  show({ catalog: { entries }, themes: [nord], installed: [installedNord()], marketFailures: {} }, sent)
  expect(row('Nord')!.textContent).toContain(`Installed ${nord.version}`)
  expect(button(row('Nord'), 'Install')).toBeUndefined()
  setInstalledThemes([nord])
  act(() => button(row('Nord'), 'Use')!.click())
  expect(localStorage.getItem('kothar.theme')).toBe('nord')
  expect(document.documentElement.style.getPropertyValue('--bg')).toBe(nord.dark.bg)
  expect(button(row('Nord'), 'In use')!.disabled).toBe(true)

  act(() => button(row('Nord'), 'Uninstall')!.click())
  expect(sent.at(-1)).toEqual({ type: 'market.uninstall', kind: 'theme', id: 'nord' })
})

test('shows why an install failed, inline, and lets it be tried again', () => {
  const sent = show({ catalog: { entries }, themes: [], installed: [], marketFailures: {} })
  act(() => button(row('Nord'), 'Install')!.click())
  const failed = (count: number) => ({ 'theme:nord': { error: "Couldn't reach GitHub: fetch failed", count } })
  show({ catalog: { entries }, themes: [], installed: [], marketFailures: failed(1) }, sent)
  expect(row('Nord')!.textContent).toContain("Couldn't reach GitHub: fetch failed")
  act(() => button(row('Nord'), 'Install')!.click())
  expect(button(row('Nord'), 'Installing…')).toBeTruthy()
  // The same error again still ends the install.
  show({ catalog: { entries }, themes: [], installed: [], marketFailures: failed(2) }, sent)
  expect(button(row('Nord'), 'Install')!.disabled).toBe(false)
})

test("offers an update when the author's latest release has another version", () => {
  const old = installedNord({ version: '0.9.0' })
  const sent = show({ catalog: { entries }, themes: [{ ...nord, version: '0.9.0' }], installed: [old], marketFailures: {} })
  expect(row('Nord')!.textContent).toContain('Installed 0.9.0')
  act(() => button(row('Nord'), `Update to ${nord.version}`)!.click())
  expect(sent.at(-1)).toEqual({ type: 'market.install', kind: 'theme', id: 'nord' })
  expect(button(row('Nord'), 'Updating…')).toBeTruthy()
})

test('links the changes beside Update, from the installed tag to the new one, with the notes on hover', () => {
  const newer = { ...nordEntry, latest: { ...nordEntry.latest!, tag: 'v1.1.0', notes: 'Warmer greens.' } }
  const old = installedNord({ version: '0.9.0' })
  show({ catalog: { entries: [newer] }, themes: [{ ...nord, version: '0.9.0' }], installed: [old], marketFailures: {} })
  const link = [...row('Nord')!.querySelectorAll('a')].find((a) => a.textContent === 'See changes')!
  expect(link.getAttribute('href')).toBe(`https://github.com/${REPO}/compare/v1.0.0...v1.1.0`)
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.dataset.hint).toBe('')
  expect(button(row('Nord'), `Update to ${nord.version}`)).toBeTruthy()
})

test('shows no changes link without a stored tag, or without an update', () => {
  const newer = { ...nordEntry, latest: { ...nordEntry.latest!, tag: 'v1.1.0' } }
  const seeChanges = () => [...row('Nord')!.querySelectorAll('a')].some((a) => a.textContent === 'See changes')
  const legacy: InstalledItem = { kind: 'theme', id: 'nord', name: 'Nord', version: '0.9.0', source: 'legacy' }
  show({ catalog: { entries: [newer] }, themes: [nord], installed: [legacy], marketFailures: {} })
  expect(button(row('Nord'), `Update to ${nord.version}`)).toBeTruthy()
  expect(seeChanges()).toBe(false)
  show({ catalog: { entries: [newer] }, themes: [nord], installed: [installedNord({ tag: undefined, version: '0.9.0' })], marketFailures: {} })
  expect(seeChanges()).toBe(false)
  show({ catalog: { entries: [newer] }, themes: [nord], installed: [installedNord()], marketFailures: {} })
  expect(seeChanges()).toBe(false)
})

test("says why an entry's release couldn't be read, and offers no install", () => {
  const broken = { ...nordEntry, latest: undefined, problem: `${REPO} has no published release` }
  show({ catalog: { entries: [broken] }, themes: [], installed: [], marketFailures: {} })
  expect(row('Nord')!.textContent).toContain(`${REPO} has no published release`)
  expect(button(row('Nord'), 'Install')).toBeUndefined()
})

test('marks a theme installed from a folder as Local, and never offers to update it', () => {
  const local = installedNord({ source: 'local', path: '/Users/me/my-theme', repo: undefined, tag: undefined, version: '0.1.0' })
  show({ catalog: { entries }, themes: [nord], installed: [local], marketFailures: {} })
  expect(row('Nord')!.textContent).toContain('Local')
  expect(button(row('Nord'), `Update to ${nord.version}`)).toBeUndefined()
  expect(button(row('Nord'), 'Uninstall')).toBeTruthy()
})

test('says the marketplace is unreachable, offers Try again, and still lists installed themes', () => {
  const error = "Couldn't reach the marketplace: fetch failed"
  const sent = show({ catalog: { error }, themes: [nord], installed: [installedNord()], marketFailures: {} })
  expect(container.textContent).toContain(error)
  act(() => button(container, 'Try again')!.click())
  expect(sent.filter((m) => m.type === 'marketplace.list')).toHaveLength(2)
  expect(button(row('Nord'), 'Uninstall')).toBeTruthy()
  expect(row('Nord')!.textContent).not.toContain('No longer in the marketplace')
})

test('says when an installed theme left the marketplace', () => {
  show({ catalog: { entries: [] }, themes: [nord], installed: [installedNord()], marketFailures: {} })
  expect(row('Nord')!.textContent).toContain('No longer in the marketplace')
})

test('says when the marketplace is empty', () => {
  show({ catalog: { entries: [] }, themes: [], installed: [], marketFailures: {} })
  expect(container.textContent).toContain('No themes in the marketplace yet.')
})

test('the state keeps the catalog, what is installed and failures, and an install clears its failure', () => {
  let state = reduce(initialState, { type: 'marketplace.catalog', entries })
  expect(state.catalog).toEqual({ entries, error: undefined })
  state = reduce(state, { type: 'market.installFailed', kind: 'theme', id: 'nord', error: 'x' })
  state = reduce(state, { type: 'market.installFailed', kind: 'theme', id: 'nord', error: 'x' })
  expect(state.marketFailures['theme:nord']).toEqual({ error: 'x', count: 2 })
  state = reduce(state, { type: 'themes.updated', themes: [nord] })
  expect(state.themes).toEqual([nord])
  state = reduce(state, { type: 'market.installed', items: [installedNord()] })
  expect(state.installed).toEqual([installedNord()])
  expect(state.marketFailures).toEqual({})
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
              market={{ catalog: { entries }, themes: [], marketFailures: {} }}
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
