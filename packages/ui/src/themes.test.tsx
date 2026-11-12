/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'
import { checkTheme } from '@kothar/core/catalog-check'
import type { ThemeFile } from '@kothar/core/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import { Tooltip } from 'radix-ui'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Appearance,
  chooseAppearance,
  ELEVATION,
  setInstalledThemes,
  startAppearance,
  THEMES,
  TOKENS,
  type Theme,
} from './themes.tsx'

// Vitest loads CSS imports as empty strings, so the stylesheet is read from disk.
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
const SCHEMES = ['dark', 'light'] as const
// Marketplace themes (copies of three from billwang7599/kothar-themes), held to the same tests as the built-in ones.
const catalogDir = new URL('../../core/src/test-themes/', import.meta.url)
const CATALOG: Record<string, ThemeFile> = Object.fromEntries(
  readdirSync(catalogDir).map((name) => {
    const theme = checkTheme(JSON.parse(readFileSync(new URL(name, catalogDir), 'utf8')))
    return [theme.id, theme]
  }),
)
const EVERY: [string, Theme][] = [...Object.entries(THEMES), ...Object.entries(CATALOG)]
const nord = CATALOG.nord!
const catppuccin = CATALOG.catppuccin!
const gruvbox = CATALOG.gruvbox!

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

const fade = (color: string, by: number) => {
  const alpha = color.length === 9 ? parseInt(color.slice(7), 16) / 255 : 1
  return color.slice(0, 7) + Math.round(alpha * by * 255).toString(16).padStart(2, '0')
}

const declarations = (selector: string) => css.split(`${selector} {`)[1]?.split('}')[0] ?? ''

function appUnderDialog() {
  const app = declarations(`:root[data-glass='vibrancy'] body:has(> [role$='dialog'][data-state='open']) > #root`)
  const [, blurPx, opacity] = app.match(/filter: blur\((\d+)px\) opacity\(([\d.]+)\);/) ?? []
  return { blurPx: Number(blurPx), opacity: Number(opacity) }
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
    removeItem: (k: string) => store.delete(k),
  })
  vi.stubGlobal('matchMedia', () => media)
  vi.stubGlobal('window', desktop ? { kothar: bridge } : {})
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
    for (const [id, theme] of EVERY)
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

  it('blurs and dims the app under a lone dialog on the see-through window, and tints the dialog', () => {
    const vibrancy = `:root[data-glass='vibrancy']`
    const open = `[role$='dialog'][data-state='open']`
    const alone = `:not(${open} ~ *)`
    expect(declarations(`${vibrancy} body:has(> ${open}) > #root`)).not.toMatch(/\bopacity:/)
    const { blurPx, opacity } = appUnderDialog()
    expect(blurPx).toBeGreaterThan(0)
    expect(opacity).toBeGreaterThan(0)
    expect(opacity).toBeLessThan(1)
    const dialog = declarations(`${vibrancy} body > [role$='dialog']${alone}`)
    expect(dialog).toMatch(/background-color: var\(--glass-dialog\);/)
    expect(declarations(`${vibrancy} body > .bg-backdrop${alone}`)).toMatch(/background-color: transparent;/)
    const motion = css.split('@media (prefers-reduced-motion: no-preference) {')[1]?.split('}')[0] ?? ''
    expect(motion).toMatch(/#root \{[^]*transition: filter /)
    expect(css.replace(motion, '')).not.toMatch(/#root \{[^}]*transition/)
  })

  it('keeps text readable on the see-through window and on a dialog over the blurred app', () => {
    const { blurPx, opacity } = appUnderDialog()
    const controlPx = Number(css.match(/--control: (\d+)px;/)?.[1])
    // A blur of σ px leaves a bar w px across at most w / (σ√2π) of its color; nothing solid outsizes a control.
    const coverage = Math.min(1, controlPx / (blurPx * Math.sqrt(2 * Math.PI))) * opacity
    for (const scheme of SCHEMES) {
      const { text, muted, faint } = THEMES.glass[scheme]
      const palette = { ...THEMES.glass[scheme], ...THEMES.glass.vibrancy[scheme] }
      const { bg, panel } = palette
      const read = scheme === 'light' ? { text, muted, faint } : { text }
      for (const material of THEMES.glass.backdrop[scheme]) {
        const window = over(bg, material)
        const behind = [window, ...Object.values(palette).map((color) => over(fade(color, coverage), window))]
        const dialogs = behind.map((under) => over(THEMES.glass.dialog[scheme], under))
        for (const surface of [window, over(panel, window), ...dialogs, ...dialogs.map((d) => over(panel, d))])
          for (const [name, color] of Object.entries(read))
            expect(contrast(color, surface), `${scheme} ${name} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keeps secondary text readable on light pages and panels', () => {
    for (const [id, theme] of EVERY) {
      const { bg, panel, muted, faint } = theme.light
      const backdrop: readonly string[] = theme.backdrop?.light ?? [bg]
      for (const under of backdrop)
        for (const surface of [under, over(bg, under), over(panel, under)])
          for (const [name, color] of [['muted', muted], ['faint', faint]])
            expect(contrast(color!, surface), `${id} ${name} on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps button labels readable on the built-in accents', () => {
    for (const id of ['default', 'glass'] as const)
      for (const scheme of SCHEMES) {
        const { accent, 'on-accent': onAccent } = THEMES[id][scheme]
        expect(contrast(onAccent, accent), `${id} ${scheme}`).toBeGreaterThanOrEqual(3)
      }
  })

  it('keeps the accent apart from amber, which only means Kothar needs you', () => {
    for (const id of ['default', 'glass'] as const)
      for (const scheme of SCHEMES) {
        const { accent, amber } = THEMES[id][scheme]
        const hue = (hex: string) => {
          const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
          const max = Math.max(r, g, b)
          const d = max - Math.min(r, g, b)
          const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
          return (h * 60 + 360) % 360
        }
        const apart = Math.abs(hue(accent) - hue(amber))
        expect(Math.min(apart, 360 - apart), `${id} ${scheme}`).toBeGreaterThan(90)
      }
  })

  it('keeps body text readable on every background', () => {
    for (const [id, theme] of EVERY)
      for (const scheme of SCHEMES) {
        const { bg, panel, text } = theme[scheme]
        const backdrop: readonly string[] = theme.backdrop?.[scheme] ?? [bg]
        for (const under of backdrop)
          for (const surface of [under, over(bg, under), over(panel, under)])
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
    chooseAppearance({ theme: 'glass', scheme: 'light' })
    for (const [level, shadow] of Object.entries(ELEVATION.light)) expect(page.props.get(`--shadow-${level}`)).toBe(shadow)
  })

  it('applies a picked theme at once and keeps it for the next start, before the core connects', () => {
    const page = fakePage({ dark: false })
    startAppearance()
    setInstalledThemes([nord])
    chooseAppearance({ theme: 'nord' })
    for (const token of TOKENS) expect(page.props.get(`--${token}`)).toBe(nord.light[token])

    const store = new Map(page.store)
    const next = fakePage({ dark: false })
    for (const [k, v] of store) next.store.set(k, v)
    startAppearance()
    expect(next.props.get('--bg')).toBe(nord.light.bg)
  })

  it('shows Default in place of a picked theme that is no longer installed, and the theme again once it is', () => {
    const page = fakePage({ dark: true })
    startAppearance()
    setInstalledThemes([nord])
    chooseAppearance({ theme: 'nord' })
    setInstalledThemes([])
    expect(page.props.get('--bg')).toBe(THEMES.default.dark.bg)
    expect(page.store.has('kothar.themeFile')).toBe(false)
    setInstalledThemes([nord])
    expect(page.props.get('--bg')).toBe(nord.dark.bg)
  })

  it('starts on Default when the saved theme was a built-in that moved to the marketplace, without downloading it', () => {
    for (const saved of ['tokyoNight', 'gruvbox']) {
      const page = fakePage({ dark: true })
      page.store.set('kothar.theme', saved)
      startAppearance()
      expect(page.props.get('--bg'), saved).toBe(THEMES.default.dark.bg)
      setInstalledThemes([])
      expect(page.props.get('--bg'), saved).toBe(THEMES.default.dark.bg)
    }
    const page = fakePage({ dark: true })
    page.store.set('kothar.theme', 'tokyoNight')
    startAppearance()
    setInstalledThemes([CATALOG['tokyo-night']!])
    expect(page.props.get('--bg')).toBe(CATALOG['tokyo-night']!.dark.bg)
  })

  it('ignores a cached theme file that fails the check', () => {
    const page = fakePage({ dark: true })
    page.store.set('kothar.theme', 'nord')
    page.store.set('kothar.themeFile', JSON.stringify({ ...nord, dark: { ...nord.dark, bg: 'red;}body{x:y' } }))
    startAppearance()
    expect(page.props.get('--bg')).toBe(THEMES.default.dark.bg)
  })

  it('follows prefers-color-scheme under System, and ignores it once a scheme is picked', () => {
    const page = fakePage({ dark: true })
    startAppearance()
    setInstalledThemes([catppuccin])
    chooseAppearance({ theme: 'catppuccin' })
    page.setSystemDark(false)
    expect(page.props.get('--bg')).toBe(catppuccin.light.bg)
    expect(page.props.get('color-scheme')).toBe('light')

    chooseAppearance({ scheme: 'dark' })
    page.setSystemDark(false)
    expect(page.props.get('--bg')).toBe(catppuccin.dark.bg)
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
    expect(mac.props.get('--glass-dialog')).toBe(THEMES.glass.dialog.dark)

    setInstalledThemes([gruvbox])
    chooseAppearance({ theme: 'gruvbox' })
    expect(mac.attrs.has('data-glass')).toBe(false)
    expect(mac.props.has('--glass-base')).toBe(false)
    expect(mac.props.has('--glass-dialog')).toBe(false)
    expect(mac.bridge.setAppearance).toHaveBeenLastCalledWith({
      scheme: 'dark',
      vibrancy: false,
      background: gruvbox.dark.bg,
    })
  })

  it('keeps every other theme in an opaque window, so nothing shows through stale frames', () => {
    const mac = fakePage({ desktop: true, vibrancy: true })
    startAppearance()
    setInstalledThemes(Object.values(CATALOG))
    for (const [theme] of EVERY)
      for (const scheme of SCHEMES) {
        chooseAppearance({ theme, scheme })
        const { vibrancy, background } = mac.bridge.setAppearance.mock.lastCall![0]
        expect(vibrancy, `${theme} ${scheme}`).toBe(theme === 'glass')
        if (theme !== 'glass') expect(background, `${theme} ${scheme}`).toMatch(/^#[0-9a-f]{6}$/i)
      }
  })

  it('shows a card for Default, Glass and each installed theme, and marks the current one', () => {
    fakePage({ dark: true })
    startAppearance()
    setInstalledThemes([CATALOG['tokyo-night']!, nord])
    chooseAppearance({ theme: 'tokyo-night' })
    const html = renderToStaticMarkup(
      <Tooltip.Provider>
        <Appearance />
      </Tooltip.Provider>,
    )
    for (const name of ['Default', 'Glass', 'Nord', 'Tokyo Night']) expect(html).toContain(`>${name}<`)
    expect(html).not.toContain('>Gruvbox<')
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(html).toMatch(/aria-pressed="true"[^>]*>(?:(?!<button).)*Tokyo Night/)
  })

  it('builds in only Default and Glass', () => {
    expect(Object.keys(THEMES)).toEqual(['default', 'glass'])
  })

  it('leaves the color scheme to speak for itself, with no explanation', () => {
    fakePage({ dark: true })
    startAppearance()
    const html = renderToStaticMarkup(
      <Tooltip.Provider>
        <Appearance />
      </Tooltip.Provider>,
    )
    expect(html).toContain('Base color scheme')
    expect(html).not.toContain('System follows your OS')
  })
})
