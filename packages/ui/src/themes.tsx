import { useSyncExternalStore, type CSSProperties } from 'react'

export const TOKENS = [
  'bg',
  'panel',
  'raised',
  'hover',
  'border',
  'text',
  'muted',
  'faint',
  'accent',
  'on-accent',
  'green',
  'amber',
  'red',
  'shadow',
] as const

type Palette = Record<(typeof TOKENS)[number], string>
type Theme = {
  name: string
  variants?: { dark: string; light: string }
  dark: Palette
  light: Palette
  backdrop?: { dark: readonly string[]; light: readonly string[] }
}

const SHADOW = { dark: '0 8px 28px rgb(0 0 0 / 0.45)', light: '0 8px 28px rgb(0 0 0 / 0.14)' }

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
      accent: '#e8743b',
      'on-accent': '#ffffff',
      green: '#3fb67c',
      amber: '#e3a33b',
      red: '#e5534b',
      shadow: SHADOW.dark,
    },
    light: {
      bg: '#ffffff',
      panel: '#f6f6f7',
      raised: '#ececee',
      hover: '#e4e4e7',
      border: '#dfe0e3',
      text: '#1d1e21',
      muted: '#5f626a',
      faint: '#8b8e96',
      accent: '#c95a22',
      'on-accent': '#ffffff',
      green: '#1f8a55',
      amber: '#a76a0c',
      red: '#c9302c',
      shadow: SHADOW.light,
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
      accent: '#e8743b',
      'on-accent': '#ffffff',
      green: '#3fb67c',
      amber: '#e3a33b',
      red: '#e5534b',
      shadow: '0 12px 40px rgb(0 0 0 / 0.4)',
    },
    light: {
      bg: '#ffffffb8',
      panel: '#ffffff8c',
      raised: '#0000000d',
      hover: '#00000014',
      border: '#0000001a',
      text: '#1b1c20',
      muted: '#54575f',
      faint: '#7f828a',
      accent: '#c95a22',
      'on-accent': '#ffffff',
      green: '#1f8a55',
      amber: '#a76a0c',
      red: '#c9302c',
      shadow: '0 12px 40px rgb(0 0 0 / 0.12)',
    },
    backdrop: {
      dark: ['#2b1f4a', '#4a1f33', '#123a47', '#0c0d12'],
      light: ['#f9d8c4', '#dcd6fb', '#c9e9ef', '#f1f2f6'],
    },
  },
  tokyoNight: {
    name: 'Tokyo Night',
    variants: { dark: 'Night', light: 'Day' },
    dark: {
      bg: '#1a1b26',
      panel: '#16161e',
      raised: '#24283b',
      hover: '#292e42',
      border: '#292e42',
      text: '#c0caf5',
      muted: '#a9b1d6',
      faint: '#565f89',
      accent: '#7aa2f7',
      'on-accent': '#1a1b26',
      green: '#9ece6a',
      amber: '#e0af68',
      red: '#f7768e',
      shadow: SHADOW.dark,
    },
    light: {
      bg: '#e1e2e7',
      panel: '#d0d5e3',
      raised: '#c4c8da',
      hover: '#a8aecb',
      border: '#b4b5b9',
      text: '#3760bf',
      muted: '#6172b0',
      faint: '#848cb5',
      accent: '#2e7de9',
      'on-accent': '#e1e2e7',
      green: '#587539',
      amber: '#8c6c3e',
      red: '#f52a65',
      shadow: SHADOW.light,
    },
  },
  catppuccin: {
    name: 'Catppuccin',
    variants: { dark: 'Mocha', light: 'Latte' },
    dark: {
      bg: '#1e1e2e',
      panel: '#181825',
      raised: '#313244',
      hover: '#45475a',
      border: '#313244',
      text: '#cdd6f4',
      muted: '#a6adc8',
      faint: '#7f849c',
      accent: '#cba6f7',
      'on-accent': '#11111b',
      green: '#a6e3a1',
      amber: '#f9e2af',
      red: '#f38ba8',
      shadow: SHADOW.dark,
    },
    light: {
      bg: '#eff1f5',
      panel: '#e6e9ef',
      raised: '#ccd0da',
      hover: '#bcc0cc',
      border: '#ccd0da',
      text: '#4c4f69',
      muted: '#6c6f85',
      faint: '#8c8fa1',
      accent: '#8839ef',
      'on-accent': '#eff1f5',
      green: '#40a02b',
      amber: '#df8e1d',
      red: '#d20f39',
      shadow: SHADOW.light,
    },
  },
  gruvbox: {
    name: 'Gruvbox',
    variants: { dark: 'Dark', light: 'Light' },
    dark: {
      bg: '#282828',
      panel: '#1d2021',
      raised: '#3c3836',
      hover: '#504945',
      border: '#3c3836',
      text: '#ebdbb2',
      muted: '#a89984',
      faint: '#7c6f64',
      accent: '#fe8019',
      'on-accent': '#282828',
      green: '#b8bb26',
      amber: '#fabd2f',
      red: '#fb4934',
      shadow: SHADOW.dark,
    },
    light: {
      bg: '#fbf1c7',
      panel: '#f2e5bc',
      raised: '#ebdbb2',
      hover: '#d5c4a1',
      border: '#d5c4a1',
      text: '#3c3836',
      muted: '#7c6f64',
      faint: '#928374',
      accent: '#af3a03',
      'on-accent': '#fbf1c7',
      green: '#79740e',
      amber: '#b57614',
      red: '#9d0006',
      shadow: SHADOW.light,
    },
  },
  rosePine: {
    name: 'Rosé Pine',
    variants: { dark: 'Main', light: 'Dawn' },
    dark: {
      bg: '#191724',
      panel: '#1f1d2e',
      raised: '#26233a',
      hover: '#403d52',
      border: '#26233a',
      text: '#e0def4',
      muted: '#908caa',
      faint: '#6e6a86',
      accent: '#c4a7e7',
      'on-accent': '#191724',
      green: '#9ccfd8',
      amber: '#f6c177',
      red: '#eb6f92',
      shadow: SHADOW.dark,
    },
    light: {
      bg: '#faf4ed',
      panel: '#fffaf3',
      raised: '#f2e9e1',
      hover: '#dfdad9',
      border: '#dfdad9',
      text: '#575279',
      muted: '#797593',
      faint: '#9893a5',
      accent: '#907aa9',
      'on-accent': '#faf4ed',
      green: '#286983',
      amber: '#ea9d34',
      red: '#b4637a',
      shadow: SHADOW.light,
    },
  },
  kanagawa: {
    name: 'Kanagawa',
    variants: { dark: 'Wave', light: 'Lotus' },
    dark: {
      bg: '#1f1f28',
      panel: '#16161d',
      raised: '#2a2a37',
      hover: '#363646',
      border: '#2a2a37',
      text: '#dcd7ba',
      muted: '#c8c093',
      faint: '#727169',
      accent: '#7e9cd8',
      'on-accent': '#1f1f28',
      green: '#98bb6c',
      amber: '#e6c384',
      red: '#e46876',
      shadow: SHADOW.dark,
    },
    light: {
      bg: '#f2ecbc',
      panel: '#e5ddb0',
      raised: '#e7dba0',
      hover: '#e4d794',
      border: '#d5cea3',
      text: '#545464',
      muted: '#716e61',
      faint: '#8a8980',
      accent: '#4d699b',
      'on-accent': '#f2ecbc',
      green: '#6f894e',
      amber: '#cc6d00',
      red: '#c84053',
      shadow: SHADOW.light,
    },
  },
  everforest: {
    name: 'Everforest',
    variants: { dark: 'Dark', light: 'Light' },
    dark: {
      bg: '#2d353b',
      panel: '#232a2e',
      raised: '#343f44',
      hover: '#3d484d',
      border: '#3d484d',
      text: '#d3c6aa',
      muted: '#9da9a0',
      faint: '#7a8478',
      accent: '#a7c080',
      'on-accent': '#2d353b',
      green: '#a7c080',
      amber: '#dbbc7f',
      red: '#e67e80',
      shadow: SHADOW.dark,
    },
    light: {
      bg: '#fdf6e3',
      panel: '#f4f0d9',
      raised: '#efebd4',
      hover: '#e6e2cc',
      border: '#e6e2cc',
      text: '#5c6a72',
      muted: '#829181',
      faint: '#a6b0a0',
      accent: '#8da101',
      'on-accent': '#fdf6e3',
      green: '#8da101',
      amber: '#dfa000',
      red: '#f85552',
      shadow: SHADOW.light,
    },
  },
  nord: {
    name: 'Nord',
    variants: { dark: 'Polar Night', light: 'Snow Storm' },
    dark: {
      bg: '#2e3440',
      panel: '#3b4252',
      raised: '#434c5e',
      hover: '#4c566a',
      border: '#434c5e',
      text: '#eceff4',
      muted: '#d8dee9',
      faint: '#616e88',
      accent: '#88c0d0',
      'on-accent': '#2e3440',
      green: '#a3be8c',
      amber: '#ebcb8b',
      red: '#bf616a',
      shadow: SHADOW.dark,
    },
    light: {
      bg: '#eceff4',
      panel: '#e5e9f0',
      raised: '#e5e9f0',
      hover: '#d8dee9',
      border: '#d8dee9',
      text: '#2e3440',
      muted: '#4c566a',
      faint: '#616e88',
      accent: '#5e81ac',
      'on-accent': '#eceff4',
      // Nord's green and yellow are too light to read on Snow Storm, so they're darkened with nord0.
      green: 'color-mix(in srgb, #a3be8c 60%, #2e3440)',
      amber: 'color-mix(in srgb, #ebcb8b 55%, #2e3440)',
      red: '#bf616a',
      shadow: SHADOW.light,
    },
  },
  solarized: {
    name: 'Solarized',
    variants: { dark: 'Dark', light: 'Light' },
    dark: {
      bg: '#002b36',
      panel: '#073642',
      raised: '#073642',
      hover: 'color-mix(in srgb, #073642 70%, #586e75)',
      border: 'color-mix(in srgb, #073642 70%, #586e75)',
      text: '#839496',
      muted: '#657b83',
      faint: '#586e75',
      accent: '#268bd2',
      'on-accent': '#fdf6e3',
      green: '#859900',
      amber: '#b58900',
      red: '#dc322f',
      shadow: SHADOW.dark,
    },
    light: {
      bg: '#fdf6e3',
      panel: '#eee8d5',
      raised: '#eee8d5',
      hover: 'color-mix(in srgb, #eee8d5 70%, #93a1a1)',
      border: 'color-mix(in srgb, #eee8d5 70%, #93a1a1)',
      // base00 is Solarized's body text but reads at 4.1:1 on base3, so text takes base01.
      text: '#586e75',
      muted: '#657b83',
      faint: '#93a1a1',
      accent: '#268bd2',
      'on-accent': '#fdf6e3',
      green: '#859900',
      amber: '#b58900',
      red: '#dc322f',
      shadow: SHADOW.light,
    },
  },
} as const satisfies Record<string, Theme>

type ThemeId = keyof typeof THEMES
const SCHEMES = { system: 'System', light: 'Light', dark: 'Dark' } as const
type Scheme = keyof typeof SCHEMES
type Appearance = { theme: ThemeId; scheme: Scheme; dark: boolean }

const THEME_KEY = 'hotrod.theme'
const SCHEME_KEY = 'hotrod.scheme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

let current: Appearance = { theme: 'default', scheme: 'system', dark: true }
const listeners = new Set<() => void>()

const backdropOf = (stops: readonly string[]) =>
  `radial-gradient(at 12% 8%, ${stops[0]}, transparent 50%), radial-gradient(at 88% 18%, ${stops[1]}, transparent 45%), ` +
  `radial-gradient(at 60% 100%, ${stops[2]}, transparent 55%) ${stops[3]}`

function update(change: Partial<Omit<Appearance, 'dark'>>) {
  const next = { ...current, ...change }
  current = { ...next, dark: next.scheme === 'system' ? matchMedia(DARK_QUERY).matches : next.scheme === 'dark' }
  const theme: Theme = THEMES[current.theme]
  const scheme = current.dark ? 'dark' : 'light'
  const root = document.documentElement
  for (const token of TOKENS) root.style.setProperty(`--${token}`, theme[scheme][token])
  root.style.setProperty('color-scheme', scheme)
  root.toggleAttribute('data-glass', !!theme.backdrop)
  const vibrancy = !!theme.backdrop && !!window.hotrod?.vibrancy
  if (vibrancy) root.style.setProperty('background', 'transparent')
  else if (theme.backdrop) root.style.setProperty('background', backdropOf(theme.backdrop[scheme]))
  else root.style.removeProperty('background')
  window.hotrod?.setAppearance({
    scheme: current.scheme,
    vibrancy,
    background: vibrancy ? '#00000000' : (theme.backdrop?.[scheme].at(-1) ?? theme[scheme].bg),
  })
  for (const listener of listeners) listener()
}

export function startAppearance() {
  const theme = localStorage.getItem(THEME_KEY) ?? ''
  const scheme = localStorage.getItem(SCHEME_KEY) ?? ''
  update({
    theme: Object.hasOwn(THEMES, theme) ? (theme as ThemeId) : 'default',
    scheme: Object.hasOwn(SCHEMES, scheme) ? (scheme as Scheme) : 'system',
  })
  matchMedia(DARK_QUERY).addEventListener('change', () => current.scheme === 'system' && update({}))
}

export function chooseAppearance(change: { theme?: ThemeId; scheme?: Scheme }) {
  if (change.theme) localStorage.setItem(THEME_KEY, change.theme)
  if (change.scheme) localStorage.setItem(SCHEME_KEY, change.scheme)
  update(change)
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const snapshot = () => current

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

export function Appearance() {
  const { theme: picked, scheme, dark } = useSyncExternalStore(subscribe, snapshot, snapshot)
  const shown = dark ? 'dark' : 'light'
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-16 gap-y-8 py-12">
        <div className="flex min-w-200 flex-1 flex-col gap-2">
          Base color scheme
          <div className="text-sm text-muted">Every theme has a light and a dark version. System follows your OS.</div>
        </div>
        <select
          className="h-control rounded border bg-bg px-8"
          aria-label="Base color scheme"
          value={scheme}
          onChange={(e) => chooseAppearance({ scheme: e.target.value as Scheme })}
        >
          {Object.entries(SCHEMES).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="border-t pt-12 pb-10">Themes</div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-12">
        {Object.entries(THEMES).map(([id, theme]: [string, Theme]) => (
          <button
            key={id}
            type="button"
            aria-pressed={id === picked}
            className="flex flex-col gap-6 rounded-lg border p-6 text-left hover:bg-raised aria-pressed:border-accent aria-pressed:ring-1 aria-pressed:ring-accent"
            onClick={() => chooseAppearance({ theme: id as ThemeId })}
          >
            <Preview theme={theme} scheme={shown} />
            <span className="flex items-baseline justify-between gap-6 px-2">
              <span>{theme.name}</span>
              {theme.variants && <span className="text-xs text-muted">{theme.variants[shown]}</span>}
            </span>
          </button>
        ))}
      </div>
    </>
  )
}
