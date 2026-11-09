import { useSyncExternalStore, type CSSProperties } from 'react'
import { checkTheme, THEME_TOKENS, type ThemeFile, type ThemePalette } from '@kothar/core/shared'
import { Button, GROUP, Select } from './controls.tsx'

export const TOKENS = THEME_TOKENS

type Palette = ThemePalette
export type Theme = {
  name: string
  variants?: { dark: string; light: string }
  dark: Palette
  light: Palette
  backdrop?: { dark: readonly string[]; light: readonly string[] }
  vibrancy?: { dark: Partial<Palette>; light: Partial<Palette> }
  dialog?: { dark: string; light: string }
}

// One light from above for every theme. Dark surfaces swallow shadows, so dark ones are stronger and add a top highlight.
export const ELEVATION = {
  dark: {
    sunken: 'inset 0 1px 2px rgb(0 0 0 / 0.35)',
    raised: 'inset 0 1px 0 rgb(255 255 255 / 0.05), 0 1px 2px rgb(0 0 0 / 0.4), 0 0 0 0.5px rgb(0 0 0 / 0.2)',
    floating: 'inset 0 1px 0 rgb(255 255 255 / 0.06), 0 2px 4px rgb(0 0 0 / 0.3), 0 10px 28px -4px rgb(0 0 0 / 0.55)',
    overlay: 'inset 0 1px 0 rgb(255 255 255 / 0.06), 0 4px 10px rgb(0 0 0 / 0.3), 0 28px 64px -12px rgb(0 0 0 / 0.7)',
  },
  light: {
    sunken: 'inset 0 1px 2px rgb(0 0 0 / 0.06)',
    raised: '0 1px 2px rgb(0 0 0 / 0.08), 0 2px 4px -2px rgb(0 0 0 / 0.06)',
    floating: '0 2px 4px -1px rgb(0 0 0 / 0.06), 0 10px 28px -6px rgb(0 0 0 / 0.16)',
    overlay: '0 4px 8px -2px rgb(0 0 0 / 0.06), 0 28px 60px -12px rgb(0 0 0 / 0.28)',
  },
}

// Light grays under 4.5:1 are darkened toward the theme's dark bg: text to 6:1, muted 5, faint 4.5.
export const THEMES = {
  default: {
    name: 'Default',
    dark: {
      bg: '#111214',
      panel: '#17181b',
      raised: '#1f2024',
      hover: '#26282d',
      border: '#2b2d32',
      text: '#e7e7ea',
      muted: '#9b9ea6',
      faint: '#6d7079',
      accent: '#5b8def',
      'on-accent': '#ffffff',
      green: '#3fb67c',
      amber: '#e3a33b',
      red: '#e5534b',
    },
    light: {
      bg: '#ffffff',
      panel: '#f6f6f7',
      raised: '#ececee',
      hover: '#e4e4e7',
      border: '#dfe0e3',
      text: '#1d1e21',
      muted: '#5f626a',
      faint: '#6d6f76',
      accent: '#2563d9',
      'on-accent': '#ffffff',
      green: '#1f8a55',
      amber: '#a76a0c',
      red: '#c9302c',
    },
  },
  glass: {
    name: 'Glass',
    dark: {
      bg: '#15171db8',
      panel: '#1b1d24a6',
      raised: '#ffffff14',
      hover: '#ffffff1f',
      border: '#ffffff1f',
      text: '#eef0f4',
      muted: '#a9adb8',
      faint: '#7b808c',
      accent: '#5b8def',
      'on-accent': '#ffffff',
      green: '#3fb67c',
      amber: '#e3a33b',
      red: '#e5534b',
    },
    light: {
      bg: '#ffffffb8',
      panel: '#ffffff8c',
      raised: '#0000000d',
      hover: '#00000014',
      border: '#0000001a',
      text: '#1b1c20',
      muted: '#54575f',
      faint: '#5b5e65',
      accent: '#2563d9',
      'on-accent': '#ffffff',
      green: '#1f8a55',
      amber: '#a76a0c',
      red: '#c9302c',
    },
    backdrop: {
      dark: ['#2b1f4a', '#4a1f33', '#123a47', '#0c0d12'],
      light: ['#cddcf8', '#dcd6fb', '#c9e9ef', '#f1f2f6'],
    },
    // Over the OS blur, which already tints: a light tint for the window, and panels only shade it.
    vibrancy: {
      dark: { bg: '#0c0d1266', panel: '#ffffff0a' },
      light: { bg: '#ffffff66', panel: '#0000000a' },
    },
    // A lone dialog over the blurred app; light text has the thinner contrast margin, so its tint is thicker.
    dialog: { dark: '#0c0d1266', light: '#ffffffcc' },
  },
} as const satisfies Record<string, Theme>

type BuiltIn = keyof typeof THEMES
const SCHEMES = { system: 'System', light: 'Light', dark: 'Dark' } as const
type Scheme = keyof typeof SCHEMES
// theme: the theme showing. wanted: the one picked, which is a marketplace theme that isn't installed (or isn't known
// yet, before the core says what is) while Default shows in its place.
type Appearance = { theme: string; wanted: string; scheme: Scheme; dark: boolean }

const THEME_KEY = 'kothar.theme'
const SCHEME_KEY = 'kothar.scheme'
// The picked marketplace theme's file, so it shows at once on the next start, before the core connects.
const THEME_FILE_KEY = 'kothar.themeFile'
const DARK_QUERY = '(prefers-color-scheme: dark)'
// Themes that were built in before they moved to the marketplace, under the ids they had then.
const MOVED: Record<string, string> = { tokyoNight: 'tokyo-night', rosePine: 'rose-pine' }

let current: Appearance = { theme: 'default', wanted: 'default', scheme: 'system', dark: true }
// Installed marketplace themes, by id; undefined until the core sends them.
let installed: Map<string, ThemeFile> | undefined
const listeners = new Set<() => void>()

const isBuiltIn = (id: string): id is BuiltIn => Object.hasOwn(THEMES, id)

export function themeOf(id: string): Theme | undefined {
  if (isBuiltIn(id)) return THEMES[id]
  const file = installed?.get(id)
  return file && { name: file.name, variants: file.variants, dark: file.dark, light: file.light }
}

const backdropOf = (stops: readonly string[]) =>
  `radial-gradient(at 12% 8%, ${stops[0]}, transparent 50%), radial-gradient(at 88% 18%, ${stops[1]}, transparent 45%), ` +
  `radial-gradient(at 60% 100%, ${stops[2]}, transparent 55%) ${stops[3]}`

function update(change: Partial<Pick<Appearance, 'wanted' | 'scheme'>>) {
  const next = { ...current, ...change }
  const showing = themeOf(next.wanted) ? next.wanted : 'default'
  current = {
    ...next,
    theme: showing,
    dark: next.scheme === 'system' ? matchMedia(DARK_QUERY).matches : next.scheme === 'dark',
  }
  const theme = themeOf(showing)!
  const scheme = current.dark ? 'dark' : 'light'
  const stops = theme.backdrop?.[scheme]
  const base = stops?.at(-1)
  const vibrancy = !!base && !!window.kothar?.vibrancy
  const palette = { ...theme[scheme], ...(vibrancy && theme.vibrancy?.[scheme]) }
  const root = document.documentElement
  for (const token of TOKENS) root.style.setProperty(`--${token}`, palette[token])
  for (const [level, shadow] of Object.entries(ELEVATION[scheme])) root.style.setProperty(`--shadow-${level}`, shadow)
  root.style.setProperty('color-scheme', scheme)
  if (stops) root.setAttribute('data-glass', vibrancy ? 'vibrancy' : 'blur')
  else root.removeAttribute('data-glass')
  if (stops && !vibrancy) root.style.setProperty('background', backdropOf(stops))
  else root.style.removeProperty('background')
  for (const [name, value] of Object.entries({ '--glass-base': base, '--glass-dialog': theme.dialog?.[scheme] }))
    if (vibrancy && value) root.style.setProperty(name, value)
    else root.style.removeProperty(name)
  window.kothar?.setAppearance({
    scheme: current.scheme,
    vibrancy,
    background: vibrancy ? '#00000000' : (base ?? theme[scheme].bg),
  })
  for (const listener of listeners) listener()
}

function cachedFile(id: string) {
  try {
    const file = checkTheme(JSON.parse(localStorage.getItem(THEME_FILE_KEY) ?? ''))
    return file.id === id ? file : undefined
  } catch {
    return undefined
  }
}

export function startAppearance() {
  const saved = localStorage.getItem(THEME_KEY) || 'default'
  const scheme = localStorage.getItem(SCHEME_KEY) ?? ''
  const wanted = MOVED[saved] ?? saved
  const cached = isBuiltIn(wanted) ? undefined : cachedFile(wanted)
  installed = cached && new Map([[cached.id, cached]])
  // Until the core says what's installed, the cached file stands in for it.
  update({ wanted, scheme: Object.hasOwn(SCHEMES, scheme) ? (scheme as Scheme) : 'system' })
  matchMedia(DARK_QUERY).addEventListener('change', () => current.scheme === 'system' && update({}))
}

// The core's installed themes. A picked theme that isn't among them shows as Default until it's installed again.
export function setInstalledThemes(themes: ThemeFile[]) {
  installed = new Map(themes.map((theme) => [theme.id, theme]))
  const file = installed.get(current.wanted)
  if (file) localStorage.setItem(THEME_FILE_KEY, JSON.stringify(file))
  else if (!isBuiltIn(current.wanted)) localStorage.removeItem(THEME_FILE_KEY)
  update({})
}

export function chooseAppearance(change: { theme?: string; scheme?: Scheme }) {
  if (change.theme) {
    localStorage.setItem(THEME_KEY, change.theme)
    const file = installed?.get(change.theme)
    if (file) localStorage.setItem(THEME_FILE_KEY, JSON.stringify(file))
    else localStorage.removeItem(THEME_FILE_KEY)
  }
  if (change.scheme) localStorage.setItem(SCHEME_KEY, change.scheme)
  update({ ...(change.theme && { wanted: change.theme }), ...(change.scheme && { scheme: change.scheme }) })
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const snapshot = () => current

export const useAppearance = () => useSyncExternalStore(subscribe, snapshot, snapshot)

// Default and Glass, then the installed marketplace themes.
export function shownThemes(): [string, Theme][] {
  const files = [...(installed?.values() ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  return [...Object.entries(THEMES), ...files.map((file): [string, Theme] => [file.id, themeOf(file.id)!])]
}

function Preview({ theme, scheme }: { theme: Theme; scheme: 'dark' | 'light' }) {
  const vars = Object.fromEntries(TOKENS.map((token) => [`--${token}`, theme[scheme][token]]))
  const style = { ...vars, background: theme.backdrop ? backdropOf(theme.backdrop[scheme]) : undefined }
  return (
    <div className="flex h-80 overflow-hidden rounded border bg-bg" style={style as CSSProperties} aria-hidden="true">
      <div className="flex w-36 flex-col gap-5 border-r bg-panel px-6 py-8">
        <span className="h-4 rounded-full bg-accent" />
        <span className="h-4 rounded-full bg-faint" />
        <span className="h-4 rounded-full bg-faint" />
      </div>
      <div className="flex flex-1 flex-col gap-5 p-8">
        <span className="ml-auto h-12 w-3/5 rounded bg-raised" />
        <span className="h-4 w-4/5 rounded-full bg-text" />
        <span className="h-4 w-3/5 rounded-full bg-muted" />
        <span className="mt-auto flex gap-4">
          <span className="h-8 w-8 rounded-full bg-green" />
          <span className="h-8 w-8 rounded-full bg-amber" />
          <span className="h-8 w-8 rounded-full bg-red" />
        </span>
      </div>
    </div>
  )
}

// browse: opens the Marketplace on its themes.
export function Appearance({ browse }: { browse?: () => void } = {}) {
  const { theme: picked, scheme, dark } = useAppearance()
  const shown = dark ? 'dark' : 'light'
  return (
    <>
      <div className={GROUP}>
        <div className="flex flex-wrap items-center gap-x-16 gap-y-8 py-12">
          <span className="min-w-200 flex-1">Base color scheme</span>
          <Select
            label="Base color scheme"
            value={scheme}
            options={Object.entries(SCHEMES).map(([value, label]) => ({ value, label }))}
            onChange={(value) => chooseAppearance({ scheme: value as Scheme })}
          />
        </div>
      </div>
      <div className="pt-24 pb-8 font-semibold">Themes</div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-12">
        {shownThemes().map(([id, theme]) => (
          <button
            key={id}
            type="button"
            aria-pressed={id === picked}
            className="flex flex-col gap-6 rounded-lg border bg-panel p-6 text-left shadow-raised transition-[background-color,border-color,box-shadow] hover:bg-raised active:shadow-sunken aria-pressed:border-accent aria-pressed:ring-1 aria-pressed:ring-accent"
            onClick={() => chooseAppearance({ theme: id })}
          >
            <Preview theme={theme} scheme={shown} />
            <span className="flex items-baseline justify-between gap-6 px-2">
              <span>{theme.name}</span>
              {theme.variants && <span className="text-xs text-muted">{theme.variants[shown]}</span>}
            </span>
          </button>
        ))}
      </div>
      <p className="flex items-center gap-12 pt-12 text-sm text-muted">
        More themes are in the Marketplace.
        {browse && (
          <Button size="small" onClick={browse}>
            Browse…
          </Button>
        )}
      </p>
    </>
  )
}
