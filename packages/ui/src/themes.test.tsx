/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Appearance, chooseAppearance, ELEVATION, startAppearance, THEMES, TOKENS } from './themes.tsx'

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

function fakePage({ dark = true, desktop = false, vibrancy = false } = {}) {
  const props = new Map<string, string>()
  const attrs = new Map<string, string>()
  const store = new Map<string, string>()
  const mediaListeners: (() => void)[] = []
  const media = { matches: dark, addEventListener: (_: string, fn: () => void) => mediaListeners.push(fn) }
  const bridge = { vibrancy, setAppearance: vi.fn() }
  vi.stubGlobal('document', {
    documentElement: {
      style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) },
      setAttribute: (name: string, value: string) => attrs.set(name, value),
      removeAttribute: (name: string) => attrs.delete(name),
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
  it('has a token for every color the stylesheet maps', () => {
    const theme = css.slice(css.indexOf('@theme'))
    const mapped = [...theme.matchAll(/--color-[\w-]+: var\(--([\w-]+)\)/g)].map((m) => m[1])
    expect(new Set(mapped)).toEqual(new Set(TOKENS))
  })

  it('maps every elevation level, and each scheme defines them all', () => {
    const theme = css.slice(css.indexOf('@theme'))
    const mapped = [...theme.matchAll(/--shadow-([\w-]+): var\(--shadow-\1\)/g)].map((m) => m[1])
    expect(mapped.length).toBeGreaterThan(0)
    for (const scheme of SCHEMES) expect(Object.keys(ELEVATION[scheme]).sort(), scheme).toEqual(mapped.sort())
  })

  it('lights dark surfaces from above with a top highlight, since dark shadows barely show', () => {
    const { sunken, ...lifted } = ELEVATION.dark
    expect(sunken).toMatch(/^inset /)
    for (const shadow of Object.values(lifted)) expect(shadow).toMatch(/^inset 0 1px 0 rgb\(255 255 255 \//)
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

  it('blurs only in the gradient fallback, since the OS already blurs a see-through window', () => {
    const blurred = [...css.matchAll(/([^{}]+)\{[^}]*backdrop-filter/g)].map((m) => m[1]!.trim())
    expect(blurred.length).toBeGreaterThan(0)
    for (const selector of blurred) expect(selector).toContain(`[data-glass='blur']`)
  })

  it('tints every surface of the see-through window, and paints floating layers solid', () => {
    expect(css).toMatch(/:root \{[^}]*\bbackground: var\(--bg\)/)
    expect(css).toMatch(
      /:root\[data-glass='vibrancy'\] :is\(\.shadow-floating, \.shadow-overlay\) \{[^}]*background-color: var\(--glass-base\)/,
    )
    for (const scheme of SCHEMES) {
      const alpha = parseInt(THEMES.glass.vibrancy[scheme].bg.slice(7), 16)
      expect(alpha, scheme).toBeGreaterThan(0)
      expect(alpha, scheme).toBeLessThan(255)
      expect(THEMES.glass.backdrop[scheme].at(-1), scheme).toMatch(/^#[0-9a-f]{6}$/i)
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

  it("sets the scheme's elevation shadows with its palette", () => {
    const page = fakePage({ dark: true })
    startAppearance()
    for (const [level, shadow] of Object.entries(ELEVATION.dark)) expect(page.props.get(`--shadow-${level}`)).toBe(shadow)
    chooseAppearance({ theme: 'gruvbox', scheme: 'light' })
    for (const [level, shadow] of Object.entries(ELEVATION.light)) expect(page.props.get(`--shadow-${level}`)).toBe(shadow)
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

  it('blurs Glass panels over a gradient where the window cannot see through: the browser, Windows and Linux', () => {
    const browser = fakePage()
    startAppearance()
    chooseAppearance({ theme: 'glass' })
    expect(browser.attrs.get('data-glass')).toBe('blur')
    expect(browser.props.get('background')).toContain('gradient')
    chooseAppearance({ theme: 'default' })
    expect(browser.attrs.has('data-glass')).toBe(false)
    expect(browser.props.has('background')).toBe(false)

    const desktop = fakePage({ desktop: true })
    startAppearance()
    chooseAppearance({ theme: 'glass', scheme: 'light' })
    expect(desktop.attrs.get('data-glass')).toBe('blur')
    expect(desktop.props.get('background')).toContain('gradient')
    expect(desktop.bridge.setAppearance).toHaveBeenLastCalledWith({
      scheme: 'light',
      vibrancy: false,
      background: THEMES.glass.backdrop.light.at(-1),
    })
  })

  it('makes the macOS window see-through for Glass, tinting the page instead of blurring it', () => {
    const mac = fakePage({ desktop: true, vibrancy: true })
    startAppearance()
    chooseAppearance({ theme: 'glass', scheme: 'dark' })
    expect(mac.attrs.get('data-glass')).toBe('vibrancy')
    expect(mac.bridge.setAppearance).toHaveBeenLastCalledWith({
      scheme: 'dark',
      vibrancy: true,
      background: '#00000000',
    })
    expect(mac.props.has('background')).toBe(false)
    const tinted = { ...THEMES.glass.dark, ...THEMES.glass.vibrancy.dark }
    for (const token of TOKENS) expect(mac.props.get(`--${token}`)).toBe(tinted[token])
    expect(mac.props.get('--glass-base')).toBe(THEMES.glass.backdrop.dark.at(-1))

    chooseAppearance({ theme: 'gruvbox' })
    expect(mac.attrs.has('data-glass')).toBe(false)
    expect(mac.props.has('--glass-base')).toBe(false)
    expect(mac.bridge.setAppearance).toHaveBeenLastCalledWith({
      scheme: 'dark',
      vibrancy: false,
      background: THEMES.gruvbox.dark.bg,
    })
  })

  it('keeps every other theme in an opaque window, so nothing shows through stale frames', () => {
    const mac = fakePage({ desktop: true, vibrancy: true })
    startAppearance()
    for (const theme of Object.keys(THEMES) as (keyof typeof THEMES)[])
      for (const scheme of SCHEMES) {
        chooseAppearance({ theme, scheme })
        const { vibrancy, background } = mac.bridge.setAppearance.mock.lastCall?.[0]
        expect(vibrancy, `${theme} ${scheme}`).toBe(theme === 'glass')
        if (theme !== 'glass') expect(background, `${theme} ${scheme}`).toMatch(/^#[0-9a-f]{6}$/i)
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
