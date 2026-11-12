// @vitest-environment jsdom
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { checkTheme } from '@kothar/core/catalog-check'
import {
  previewOf,
  type ClientMessage,
  type InstalledItem,
  type MarketEntry,
  type ThemeFile,
} from '@kothar/core/shared'
import { ConfirmDialog } from './controls.tsx'
import { MarketplaceDialog, shownRows, type Market } from './marketplace.tsx'
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

// Opens the Marketplace, on All as it always opens, then picks a kind if asked.
function show(market: Market, sent: ClientMessage[] = [], connected = true, kind?: 'Themes' | 'Extensions') {
  render(<MarketplaceDialog open close={() => {}} market={market} connected={connected} send={(m) => sent.push(m)} />)
  if (kind) act(() => button(document.querySelector('[role="group"][aria-label="Kind"]'), kind)!.click())
  return sent
}

const option = (name: string) => document.querySelector(`[role="option"][aria-label="${name}"]`) as HTMLElement | null
const options = () => [...document.querySelectorAll('[role="option"]')].map((o) => o.getAttribute('aria-label'))
// Picks the entry in the list and returns its detail pane.
const row = (name: string) => {
  const o = option(name)
  if (!o) return null
  act(() => o.click())
  return document.querySelector(`article[aria-label="${name}"]`) as HTMLElement | null
}
const button = (within: Element | null, label: string) =>
  [...(within?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label)
const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
const search = () => document.querySelector('input[aria-label="Search the marketplace"]') as HTMLInputElement

test('opens as its own window, asks the core for the catalog and shows skeleton rows while it loads', () => {
  const sent = show({ marketFailures: {} })
  expect(sent).toEqual([{ type: 'marketplace.list' }])
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.querySelector('h2')?.textContent).toBe('Marketplace')
  expect(dialog.querySelectorAll('[data-skeleton]').length).toBeGreaterThan(0)
  expect(dialog.querySelector('[role="listbox"]')!.getAttribute('aria-busy')).toBe('true')
  expect(dialog.textContent).toContain('Loading the marketplace…')
})

test("doesn't ask while disconnected", () => {
  expect(show({ marketFailures: {} }, [], false)).toEqual([])
})

test('asks again when reopened after a failure, but not when it already has the catalog', () => {
  const sent = show({ catalog: { entries }, marketFailures: {} })
  expect(sent).toEqual([])
  render(<MarketplaceDialog open={false} close={() => {}} market={{ catalog: { error: 'x' }, marketFailures: {} }} connected send={(m) => sent.push(m)} />)
  render(<MarketplaceDialog open close={() => {}} market={{ catalog: { error: 'x' }, marketFailures: {} }} connected send={(m) => sent.push(m)} />)
  expect(sent).toEqual([{ type: 'marketplace.list' }])
})

test('lists each theme with its author and description, and shows the picked one in detail with its colours', () => {
  show({ catalog: { entries }, themes: [], marketFailures: {} })
  expect(options()).toEqual(['Nord', 'Gruvbox', 'Catppuccin'])
  for (const entry of entries) {
    expect(option(entry.name)!.textContent).toContain(`by ${entry.author}`)
    const r = row(entry.name)!
    expect(r.textContent).toContain(entry.description)
    expect(button(r, 'Install')).toBeTruthy()
    expect(option(entry.name)!.getAttribute('aria-selected')).toBe('true')
  }
  const swatch = row('Nord')!.querySelector('[data-scheme="dark"]') as HTMLElement
  expect(swatch.style.background).toBe(hexToRgb(nordEntry.latest!.preview!.dark.bg))
  const light = row('Nord')!.querySelector('[data-scheme="light"]') as HTMLElement
  const parts = [...light.querySelectorAll('span')].map((s) => s.style.background)
  expect(parts).toEqual(
    expect.arrayContaining([nordEntry.latest!.preview!.light.panel, nordEntry.latest!.preview!.light.text, nordEntry.latest!.preview!.light.accent].map(hexToRgb)),
  )
})

test('picks the first entry at first, and the arrow keys move through the list', () => {
  show({ catalog: { entries }, themes: [], marketFailures: {} })
  expect(document.querySelector('article')!.getAttribute('aria-label')).toBe('Nord')
  act(() => search().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  expect(document.querySelector('article')!.getAttribute('aria-label')).toBe('Gruvbox')
  act(() => search().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })))
  act(() => search().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })))
  expect(document.querySelector('article')!.getAttribute('aria-label')).toBe('Nord')
})

test('searches names, authors, descriptions and repos, and says when nothing matches', () => {
  show({ catalog: { entries }, themes: [], marketFailures: {} })
  type(search(), 'gruv')
  expect(options()).toEqual(['Gruvbox'])
  type(search(), nordEntry.author.toUpperCase())
  expect(options()).toContain('Nord')
  type(search(), 'no such thing')
  expect(options()).toEqual([])
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Nothing matches “no such thing”.')
})

test('filters by kind and by what is installed or has an update', () => {
  const extension: MarketEntry = {
    id: 'counter',
    kind: 'extension',
    name: 'Counter',
    author: 'Someone',
    description: 'Counts words.',
    repo: 'someone/counter',
    latest: { tag: 'v1.0.0', version: '1.0.0', uses: ['panels'] },
  }
  const old = installedNord({ version: '0.9.0' })
  const market: Market = { catalog: { entries: [...entries, extension] }, themes: [nord], installed: [old], marketFailures: {} }
  show(market, [], true, 'Extensions')
  expect(options()).toEqual(['Counter'])
  act(() => button(document.querySelector('[role="group"][aria-label="Kind"]'), 'Themes')!.click())
  expect(options()).toEqual(['Nord', 'Gruvbox', 'Catppuccin'])
  act(() => button(document.querySelector('[role="group"][aria-label="Kind"]'), 'All')!.click())
  expect(options()).toHaveLength(4)
  expect(option('Nord')!.textContent).toContain('Update')
  // The Show menu's choices, checked through what they list.
  expect(shownRows(market, 'all', 'installed', '').map((r) => r.id)).toEqual(['nord'])
  expect(shownRows(market, 'all', 'updates', '').map((r) => r.id)).toEqual(['nord'])
  const current = { ...market, installed: [installedNord()] }
  expect(shownRows(current, 'all', 'updates', '')).toEqual([])
  expect(document.querySelector('[role="dialog"] button[aria-label="Show"]')!.textContent).toContain('Everything')
})

test("links each entry to its author's repo", () => {
  show({ catalog: { entries }, themes: [], marketFailures: {} })
  const link = row('Nord')!.querySelector('a')!
  expect(link.textContent).toBe(`github.com/${REPO}`)
  expect(link.getAttribute('href')).toBe(`https://github.com/${REPO}`)
})

test('installs a theme, shows its progress, then offers Use and Uninstall', () => {
  const sent = show({ catalog: { entries }, themes: [], installed: [], marketFailures: {} })
  act(() => button(row('Nord'), 'Install')!.click())
  expect(sent.at(-1)).toEqual({ type: 'market.install', kind: 'theme', id: 'nord' })
  const installing = button(row('Nord'), 'Installing…')!
  expect(installing.disabled).toBe(true)
  expect(row('Nord')!.querySelector('[role="progressbar"]')!.getAttribute('aria-label')).toBe('Installing Nord')
  expect(option('Nord')!.textContent).toContain('Installing…')

  show({ catalog: { entries }, themes: [nord], installed: [installedNord()], marketFailures: {} }, sent)
  expect(row('Nord')!.textContent).toContain(`Installed ${nord.version}`)
  expect(row('Nord')!.querySelector('[role="progressbar"]')).toBeNull()
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

test("offers an update when the author's latest release has another version, with its release notes", () => {
  const old = installedNord({ version: '0.9.0' })
  const notes = { ...nordEntry, latest: { ...nordEntry.latest!, notes: 'Warmer greens.\nFixed contrast.' } }
  const sent = show({ catalog: { entries: [notes] }, themes: [{ ...nord, version: '0.9.0' }], installed: [old], marketFailures: {} })
  expect(row('Nord')!.textContent).toContain('Installed 0.9.0')
  expect(row('Nord')!.textContent).toContain(`Latest ${nord.version}`)
  expect(row('Nord')!.textContent).toContain(`Release notes, ${nord.version}`)
  expect(row('Nord')!.textContent).toContain('Warmer greens.')
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
  expect(option('Nord')!.textContent).toContain('Local')
  expect(button(row('Nord'), `Update to ${nord.version}`)).toBeUndefined()
  expect(button(row('Nord'), 'Uninstall')).toBeTruthy()
})

test('says the marketplace is unreachable or rate-limited, offers Retry, and still lists installed themes', () => {
  const error = "GitHub's limit of 60 requests an hour is used up; it resets at 3:00 PM. Set KOTHAR_GITHUB_TOKEN to a GitHub token to lift it."
  const market: Market = { catalog: { error }, themes: [nord], installed: [installedNord()], marketFailures: {} }
  // Opened after a failure, it asks again at once; the answer is the same failure.
  const sent = show(market)
  expect(sent).toEqual([{ type: 'marketplace.list' }])
  show({ ...market, catalog: { error } }, sent)
  const alert = document.querySelector('[role="dialog"] [role="alert"]')!
  expect(alert.textContent).toContain(error)
  act(() => button(alert, 'Retry')!.click())
  expect(sent.filter((m) => m.type === 'marketplace.list')).toHaveLength(2)
  // Loading again: the error gives way to skeleton rows below what's installed.
  expect(document.querySelector('[role="dialog"] [role="alert"]')).toBeNull()
  expect(document.querySelectorAll('[data-skeleton]').length).toBeGreaterThan(0)
  expect(button(row('Nord'), 'Uninstall')).toBeTruthy()
  expect(row('Nord')!.textContent).not.toContain('No longer in the marketplace')
  // A fresh answer ends the loading.
  show({ ...market, catalog: { entries } }, sent)
  expect(document.querySelectorAll('[data-skeleton]')).toHaveLength(0)
})

test('says when an installed theme left the marketplace', () => {
  show({ catalog: { entries: [] }, themes: [nord], installed: [installedNord()], marketFailures: {} })
  expect(row('Nord')!.textContent).toContain('No longer in the marketplace')
})

test('says when the marketplace is empty', () => {
  show({ catalog: { entries: [] }, themes: [], installed: [], marketFailures: {} }, [], true, 'Themes')
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('No themes in the marketplace yet.')
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

function settingsAt(page: 'appearance' | 'community-extensions', openMarketplace: () => void) {
  render(
    <SettingsDialog
      open
      page={page}
      openPage={() => {}}
      close={() => {}}
      engines={[]}
      accounts={[]}
      contextDefaults={{ agents: true, folders: true, files: true }}
      extensions={[]}
      modelLists={{ chat: [], planning: [], searching: [], workers: [] }}
      workFolder={{ defaultPath: '/garage/work', canSandbox: true }}
      chooseWorkFolder={() => {}}
      market={{ catalog: { entries }, themes: [], marketFailures: {} }}
      openMarketplace={openMarketplace}
      connected
      send={() => {}}
    />,
  )
}

test('Settings has no Marketplace page; Appearance and Community hub open it with Browse', () => {
  let opened = 0
  settingsAt('appearance', () => opened++)
  const tabs = [...document.querySelectorAll('[role="dialog"] [role="tab"]')].map((tab) => tab.textContent)
  expect(tabs).not.toContain('Marketplace')
  act(() => button(document.querySelector('[role="dialog"]'), 'Browse…')!.click())
  settingsAt('community-extensions', () => opened++)
  act(() => button(document.querySelector('[role="dialog"]'), 'Browse…')!.click())
  expect(opened).toBe(2)
})

function hexToRgb(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return `rgb(${r}, ${g}, ${b})`
}

test("the list and the detail keep their scrollbars inset from the window's edges", () => {
  show({ marketFailures: {} })
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.querySelector('[role="listbox"]')!.classList).toContain('scroll-inset')
  expect(dialog.querySelectorAll('.scroll-inset').length).toBe(2)
})

test('the Marketplace always opens on All, and picking a kind there lasts only until it closes', () => {
  const market: Market = { catalog: { entries }, themes: [], installed: [], marketFailures: {} }
  const pressed = () => document.querySelector('[role="group"][aria-label="Kind"] [aria-pressed="true"]')!.textContent
  const view = (open: boolean) => (
    <MarketplaceDialog open={open} close={() => {}} market={market} connected send={() => {}} />
  )
  render(view(true))
  expect(pressed()).toBe('All')
  act(() => button(document.querySelector('[role="group"][aria-label="Kind"]'), 'Themes')!.click())
  expect(pressed()).toBe('Themes')
  render(view(false))
  render(view(true))
  expect(pressed()).toBe('All')
})

test('the list shows as List, Grid or Compact, and the choice is remembered', () => {
  const market: Market = { catalog: { entries }, themes: [nord], installed: [installedNord()], marketFailures: {} }
  const views = () => document.querySelector('[role="group"][aria-label="View"]')
  const list = () => document.querySelector('[role="listbox"]') as HTMLElement
  show(market)
  expect(views()!.querySelector('[aria-pressed="true"]')!.textContent).toBe('List')
  expect(list().dataset.view).toBe('list')
  act(() => button(views(), 'Grid')!.click())
  expect(list().dataset.view).toBe('grid')
  expect(localStorage.getItem('kothar.marketplaceView')).toBe('grid')
  // Each card is still an option with its name, author, description and install state.
  const card = option('Nord')!
  expect(card.textContent).toContain('by ')
  expect(card.textContent).toContain('Installed')
  expect(options()).toEqual(['Nord', 'Gruvbox', 'Catppuccin'])
  act(() => button(views(), 'Compact')!.click())
  expect(option('Nord')!.textContent).not.toContain(nordEntry.description!)
  expect(options()).toHaveLength(3)

  // Opened again, it comes back in the view last chosen.
  act(() => root.unmount())
  root = createRoot(container)
  show(market)
  expect(list().dataset.view).toBe('compact')
})

test('in the grid, Left and Right on the list move one card, and Down past the end stays put', () => {
  localStorage.setItem('kothar.marketplaceView', 'grid')
  show({ catalog: { entries }, themes: [], installed: [], marketFailures: {} })
  const list = document.querySelector('[role="listbox"]') as HTMLElement
  const selected = () => document.querySelector('[role="option"][aria-selected="true"]')!.getAttribute('aria-label')
  const key = (k: string) => act(() => list.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))
  expect(selected()).toBe('Nord')
  key('ArrowRight')
  expect(selected()).toBe('Gruvbox')
  key('ArrowLeft')
  expect(selected()).toBe('Nord')
  // jsdom lays nothing out, so all three cards count as one row: Down has no row to go to.
  key('ArrowDown')
  expect(selected()).toBe('Nord')
})

test('an unknown saved view falls back to List', () => {
  localStorage.setItem('kothar.marketplaceView', 'mosaic')
  show({ catalog: { entries }, themes: [], marketFailures: {} })
  expect((document.querySelector('[role="listbox"]') as HTMLElement).dataset.view).toBe('list')
})
