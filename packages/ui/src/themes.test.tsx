/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Appearance, chooseAppearance, startAppearance, THEMES, TOKENS } from './themes.tsx'

// Vitest loads CSS imports as empty strings, so the stylesheet is read from disk.
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
const SCHEMES = ['dark', 'light'] as const

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function over(top: string, under: string) {
  const alpha = top.length === 9 ? parseInt(top.slice(7), 16) / 255 : 1
  const mix = [1, 3, 5].map((i) => {
    const value = parseInt(top.slice(i, i + 2), 16) * alpha + parseInt(under.slice(i, i + 2), 16) * (1 - alpha)
    return Math.round(value).toString(16).padStart(2, '0')
  })
  return `#${mix.join('')}`
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

function fakePage({ dark = true, desktop = false } = {}) {
  const props = new Map<string, string>()
  const attrs = new Set<string>()
  const store = new Map<string, string>()
  const mediaListeners: (() => void)[] = []
  const media = { matches: dark, addEventListener: (_: string, fn: () => void) => mediaListeners.push(fn) }
  const bridge = { setAppearance: vi.fn() }
  vi.stubGlobal('document', {
    documentElement: {
      style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) },
      toggleAttribute: (name: string, on: boolean) => (on ? attrs.add(name) : attrs.delete(name)),
    },
  })
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  })
  vi.stubGlobal('matchMedia', () => media)
  vi.stubGlobal('window', desktop ? { hotrod: bridge } : {})
  return {
    props,
    attrs,
    store,
    bridge,
    setSystemDark(next: boolean) {
      media.matches = next
      for (const fn of mediaListeners) fn()
    },
  }
}

describe('theme table', () => {
  it('has a token for every color and shadow the stylesheet maps', () => {
    const theme = css.slice(css.indexOf('@theme'))
    const mapped = [...theme.matchAll(/--(?:color-[\w-]+|shadow): var\(--([\w-]+)\)/g)].map((m) => m[1])
    expect(new Set(mapped)).toEqual(new Set(TOKENS))
  })

  it('leaves the palette out of the stylesheet, so the table is its only source', () => {
    const root = css.slice(0, css.indexOf('@theme'))
    for (const token of TOKENS) expect(root).not.toMatch(new RegExp(`--${token}:`))
  })

  it('defines every token in both schemes of every theme', () => {
    for (const [id, theme] of Object.entries(THEMES))
      for (const scheme of SCHEMES) {
        expect(Object.keys(theme[scheme]).sort(), `${id} ${scheme}`).toEqual([...TOKENS].sort())
        for (const token of TOKENS) expect(theme[scheme][token], `${id} ${scheme} ${token}`).toMatch(/\S/)
      }
  })

  it('keeps body text readable on every background', () => {
    for (const [id, theme] of Object.entries(THEMES))
      for (const scheme of SCHEMES) {
        const { bg, text } = theme[scheme]
        const backdrop: readonly string[] = 'backdrop' in theme ? theme.backdrop[scheme] : [bg]
        for (const under of backdrop)
          for (const surface of [under, over(bg, under)])
            expect(contrast(text, surface), `${id} ${scheme} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
  })
})

describe('appearance', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('starts with the default theme following the system', () => {
    const page = fakePage({ dark: true })
    startAppearance()
    expect(page.props.get('--bg')).toBe(THEMES.default.dark.bg)
    expect(page.props.get('color-scheme')).toBe('dark')
  })

  it('applies a picked theme at once and keeps it for the next start', () => {
    const page = fakePage({ dark: false })
    startAppearance()
    chooseAppearance({ theme: 'nord' })
    for (const token of TOKENS) expect(page.props.get(`--${token}`)).toBe(THEMES.nord.light[token])

    const store = new Map(page.store)
    const next = fakePage({ dark: false })
    for (const [k, v] of store) next.store.set(k, v)
    startAppearance()
    expect(next.props.get('--bg')).toBe(THEMES.nord.light.bg)
  })

  it('follows prefers-color-scheme under System, and ignores it once a scheme is picked', () => {
    const page = fakePage({ dark: true })
    startAppearance()
    chooseAppearance({ theme: 'catppuccin' })
    page.setSystemDark(false)
    expect(page.props.get('--bg')).toBe(THEMES.catppuccin.light.bg)
    expect(page.props.get('color-scheme')).toBe('light')

    chooseAppearance({ scheme: 'dark' })
    page.setSystemDark(false)
    expect(page.props.get('--bg')).toBe(THEMES.catppuccin.dark.bg)
  })

  it('lays Glass over the same opaque gradient in the browser and the desktop app, with no native vibrancy', () => {
    const browser = fakePage()
    startAppearance()
    chooseAppearance({ theme: 'glass' })
    expect(browser.attrs.has('data-glass')).toBe(true)
    expect(browser.props.get('background')).toContain('gradient')
    chooseAppearance({ theme: 'default' })
    expect(browser.attrs.has('data-glass')).toBe(false)
    expect(browser.props.has('background')).toBe(false)

    const desktop = fakePage({ desktop: true })
    startAppearance()
    chooseAppearance({ theme: 'glass', scheme: 'light' })
    expect(desktop.props.get('background')).toContain('gradient')
    expect(desktop.bridge.setAppearance).toHaveBeenLastCalledWith({
      scheme: 'light',
      background: THEMES.glass.backdrop.light.at(-1),
    })
    chooseAppearance({ theme: 'gruvbox' })
    expect(desktop.bridge.setAppearance).toHaveBeenLastCalledWith({
      scheme: 'light',
      background: THEMES.gruvbox.light.bg,
    })
  })

  it('paints the window background opaque, so the desktop app never shows through stale frames', () => {
    const desktop = fakePage({ desktop: true })
    startAppearance()
    for (const theme of Object.keys(THEMES) as (keyof typeof THEMES)[])
      for (const scheme of SCHEMES) {
        chooseAppearance({ theme, scheme })
        const { background } = desktop.bridge.setAppearance.mock.lastCall?.[0]
        expect(background, `${theme} ${scheme}`).toMatch(/^#[0-9a-f]{6}$/i)
      }
  })

  it('shows a card for every theme and marks the current one', () => {
    fakePage({ dark: true })
    startAppearance()
    chooseAppearance({ theme: 'rosePine' })
    const html = renderToStaticMarkup(<Appearance />)
    for (const theme of Object.values(THEMES)) expect(html).toContain(`>${theme.name}<`)
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(html).toMatch(/aria-pressed="true"[^>]*>(?:(?!<button).)*Rosé Pine/)
  })
})
