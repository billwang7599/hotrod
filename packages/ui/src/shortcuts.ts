import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'

/**
 * Keyboard shortcuts: one registry of actions, each with a default binding the user can remap in Settings → Shortcuts.
 *
 * A binding is a string such as `Mod+Shift+O`: modifiers in a fixed order, then one key. `Mod` is ⌘ on macOS and
 * Ctrl elsewhere, so the defaults travel between platforms; `Ctrl` on macOS is the Control key. Keys are named from
 * the physical key (`KeyO` → `O`, `Digit1` → `1`), so ⌥ and keyboard layouts that change the typed character don't
 * change the binding. `null` means the action has no keys.
 *
 * The user's changes are saved in localStorage (`kothar.shortcuts`) as `{ [action id]: binding | null }`, only for
 * actions whose keys differ from their default.
 */

export type Binding = string
export type ShortcutAction = {
  id: string
  label: string
  /** The keys out of the box, or null for none. */
  defaultKeys: Binding | null
  /** Only in the desktop app (it needs something the browser can't do, such as a native folder picker). */
  desktopOnly?: boolean
  /** Shown in the desktop app's menu, which mirrors the user's bindings so the two never disagree. */
  menu?: boolean
}

const STORAGE_KEY = 'kothar.shortcuts'
const SAME_PRESS_MS = 300
const MODIFIERS = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const
type Modifier = (typeof MODIFIERS)[number]

export const isMac = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

const JUMPS: ShortcutAction[] = Array.from({ length: 9 }, (_, i) => ({
  id: `jump${i + 1}`,
  label: `Go to entry ${i + 1}`,
  defaultKeys: `Mod+${i + 1}`,
}))

const actions: ShortcutAction[] = [
  { id: 'search', label: 'Search', defaultKeys: 'Mod+O', menu: true },
  { id: 'previousSpace', label: 'Previous space', defaultKeys: 'Mod+ArrowUp' },
  { id: 'nextSpace', label: 'Next space', defaultKeys: 'Mod+ArrowDown' },
  ...JUMPS,
  { id: 'newSpace', label: 'New space', defaultKeys: 'Mod+N', menu: true },
  { id: 'newSpaceFromFolder', label: 'New space from folder', defaultKeys: 'Mod+Shift+O', desktopOnly: true, menu: true },
  { id: 'settings', label: 'Settings', defaultKeys: 'Mod+,', menu: true },
  { id: 'toggleSidebar', label: 'Show or hide the sidebar', defaultKeys: 'Mod+[', menu: true },
  { id: 'toggleContextPanel', label: 'Show or hide the context panel', defaultKeys: 'Mod+]', menu: true },
  { id: 'marketplace', label: 'Marketplace', defaultKeys: null },
]

const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

/** Adds an action to the registry, for extensions and later features. Replaces one with the same id. */
export function registerShortcut(action: ShortcutAction) {
  const at = actions.findIndex((a) => a.id === action.id)
  if (at < 0) actions.push(action)
  else actions[at] = action
  current = resolve(saved)
  emit()
}

/** Every action, in the order Settings lists them. */
export const shortcutActions = (): readonly ShortcutAction[] => actions

function readSaved(): Record<string, Binding | null> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(([, keys]) => keys === null || (typeof keys === 'string' && parseBinding(keys))),
    ) as Record<string, Binding | null>
  } catch {
    return {}
  }
}

const resolve = (changes: Record<string, Binding | null>) =>
  Object.fromEntries(actions.map((a) => [a.id, a.id in changes ? changes[a.id]! : a.defaultKeys])) as Record<
    string,
    Binding | null
  >

let saved = readSaved()
let current = resolve(saved)

function save(next: Record<string, Binding | null>) {
  saved = next
  current = resolve(saved)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
  emit()
}

/** Sets an action's keys; null leaves it without any. Setting the default keys drops the saved change. */
export function setBinding(id: string, keys: Binding | null) {
  const action = actions.find((a) => a.id === id)
  const { [id]: _, ...rest } = saved
  save(action && keys === action.defaultKeys ? rest : { ...rest, [id]: keys })
}

export function resetBinding(id: string) {
  const { [id]: _, ...rest } = saved
  save(rest)
}

export function resetAllBindings() {
  save({})
}

/** Rereads the saved bindings, for tests that clear storage. */
export function reloadShortcuts() {
  saved = readSaved()
  current = resolve(saved)
  emit()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const snapshot = () => current

/** The keys of every action, by id. */
export const bindings = () => current
export const useBindings = () => useSyncExternalStore(subscribe, snapshot, snapshot)
/** Whether the user changed an action's keys. */
export const isCustom = (id: string) => id in saved

type Parsed = { mods: Set<Modifier>; key: string }

export function parseBinding(binding: Binding): Parsed | null {
  // `Mod++` would be a plus key; split on '+' only between parts.
  const parts = binding.split(/\+(?=.)/)
  const key = parts.pop()
  if (!key || MODIFIERS.includes(key as Modifier)) return null
  const mods = new Set<Modifier>()
  for (const part of parts) {
    if (!MODIFIERS.includes(part as Modifier) || mods.has(part as Modifier)) return null
    mods.add(part as Modifier)
  }
  return { mods, key }
}

const CODE_KEYS: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: 'Space',
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

/** The key of a key press, named from the physical key where possible. */
export function keyOf(e: Pick<KeyboardEvent, 'key' | 'code'>): string {
  const letter = /^Key([A-Z])$/.exec(e.code ?? '')
  if (letter) return letter[1]!
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code ?? '')
  if (digit) return digit[1]!
  if (e.code && CODE_KEYS[e.code]) return CODE_KEYS[e.code]!
  if (e.key.length === 1) return e.key.toUpperCase()
  return e.key
}

const isModifierKey = (key: string) => ['Meta', 'Control', 'Alt', 'Shift', 'OS', 'Hyper', 'Super'].includes(key)

/** The binding a key press makes, or null for a lone modifier key. */
export function bindingOf(e: KeyLike, mac = isMac()): Binding | null {
  if (isModifierKey(e.key)) return null
  const mods: Modifier[] = []
  if (mac ? e.metaKey : e.ctrlKey) mods.push('Mod')
  if (mac && e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  return [...mods, keyOf(e)].join('+')
}

/** Whether a key press is exactly this binding: the same key and no extra modifiers. */
export function matches(e: KeyLike, binding: Binding | null, mac = isMac()) {
  if (!binding) return false
  // Off macOS the Windows/Super key isn't part of any binding.
  if (!mac && e.metaKey) return false
  return bindingOf(e, mac) === normalize(binding)
}

/** A binding in its canonical modifier order. */
export function normalize(binding: Binding): Binding {
  const parsed = parseBinding(binding)
  if (!parsed) return binding
  return [...MODIFIERS.filter((m) => parsed.mods.has(m)), parsed.key].join('+')
}

const MAC_SYMBOLS: Record<Modifier, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' }
const MAC_ORDER: Modifier[] = ['Ctrl', 'Alt', 'Shift', 'Mod']
const KEY_NAMES: Record<string, [mac: string, other: string]> = {
  ArrowUp: ['↑', 'Up'],
  ArrowDown: ['↓', 'Down'],
  ArrowLeft: ['←', 'Left'],
  ArrowRight: ['→', 'Right'],
  Enter: ['↩', 'Enter'],
  Escape: ['⎋', 'Esc'],
  Backspace: ['⌫', 'Backspace'],
  Delete: ['⌦', 'Delete'],
  Tab: ['⇥', 'Tab'],
  Space: ['Space', 'Space'],
}

/** How a binding reads to the user: `⌘⇧O` on macOS, `Ctrl+Shift+O` elsewhere. */
export function formatBinding(binding: Binding | null, mac = isMac()): string {
  if (!binding) return ''
  const parsed = parseBinding(binding)
  if (!parsed) return binding
  const key = KEY_NAMES[parsed.key]?.[mac ? 0 : 1] ?? parsed.key
  if (mac) return MAC_ORDER.filter((m) => parsed.mods.has(m)).map((m) => MAC_SYMBOLS[m]).join('') + key
  const names: Record<Modifier, string> = { Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' }
  return [...MODIFIERS.filter((m) => parsed.mods.has(m)).map((m) => names[m]), key].join('+')
}

/** An action's keys as the user reads them, or '' when it has none. */
export const shortcutText = (id: string, mac = isMac()) => formatBinding(current[id] ?? null, mac)

/** Keys the system or the editing basics own; Kothar never takes them. */
const RESERVED = ['Mod+Q', 'Mod+W', 'Mod+C', 'Mod+V', 'Mod+X', 'Mod+Z', 'Mod+Shift+Z', 'Mod+A', 'Mod+H', 'Mod+M', 'Mod+R', 'Mod+Tab']

/** Why a key press can't be a shortcut, or undefined if it can. */
export function refusal(binding: Binding): string | undefined {
  const parsed = parseBinding(binding)
  if (!parsed) return 'Not a key combination'
  const bareKeyOk = /^F\d{1,2}$/.test(parsed.key)
  if (!bareKeyOk && !['Mod', 'Ctrl', 'Alt'].some((m) => parsed.mods.has(m as Modifier)))
    return `Add ${isMac() ? '⌘, ⌃ or ⌥' : 'Ctrl or Alt'}, so typing never triggers it`
  if (RESERVED.includes(normalize(binding))) return `${formatBinding(binding)} belongs to the system`
  return undefined
}

/** The other actions already on these keys. */
export function conflictsOf(id: string, binding: Binding | null, all = current): ShortcutAction[] {
  if (!binding) return []
  const keys = normalize(binding)
  return actions.filter((a) => a.id !== id && all[a.id] && normalize(all[a.id]!) === keys)
}

/** An Electron menu accelerator for a binding, such as `CmdOrCtrl+Shift+O`. */
export function acceleratorOf(binding: Binding | null): string | null {
  const parsed = binding && parseBinding(binding)
  if (!parsed) return null
  const names: Record<Modifier, string> = { Mod: 'CmdOrCtrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' }
  const key = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc' }[parsed.key]
  return [...MODIFIERS.filter((m) => parsed.mods.has(m)).map((m) => names[m]), key ?? parsed.key].join('+')
}

export type ShortcutHandlers = Partial<Record<string, () => void>>

type Panels = { covered: boolean; chatOpen: boolean; toggleSidebar: () => void; toggleContext: () => void }

/**
 * The keys that show or hide the side panels, the same as their toggle buttons. Behind Settings or the Marketplace
 * (covered) the panels can't be seen, so the keys do nothing; the context panel also needs an open chat.
 */
export function panelShortcuts({ covered, chatOpen, toggleSidebar, toggleContext }: Panels): ShortcutHandlers {
  if (covered) return {}
  return { toggleSidebar, ...(chatOpen && { toggleContextPanel: toggleContext }) }
}

/** The action a key press runs, if it has a handler. */
export function actionFor(e: KeyLike, handlers: ShortcutHandlers, all = current, mac = isMac()) {
  return actions.find((a) => handlers[a.id] && matches(e, all[a.id] ?? null, mac))?.id
}

/**
 * Runs the handlers for shortcuts pressed anywhere in the window. A key press something else already handled (the
 * key recorder in Settings, a menu) is left alone. In the desktop app, the menu's items for the same actions also
 * arrive here, so a shortcut works the same whether the page or the menu sees the key first.
 */
export function useShortcuts(handlers: ShortcutHandlers) {
  const latest = useRef(handlers)
  useLayoutEffect(() => {
    latest.current = handlers
  })
  useEffect(() => {
    // The page and the desktop menu can both see one key press; whichever is second is dropped.
    let last = { id: '', at: 0, from: '' }
    const run = (id: string, from: 'page' | 'menu') => {
      const now = performance.now()
      if (last.id === id && last.from !== from && now - last.at < SAME_PRESS_MS) return
      last = { id, at: now, from }
      latest.current[id]?.()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return
      const id = actionFor(e, latest.current)
      if (!id) return
      e.preventDefault()
      run(id, 'page')
    }
    addEventListener('keydown', onKeyDown)
    const offMenu = window.kothar?.onShortcut?.((id) => run(id, 'menu'))
    return () => {
      removeEventListener('keydown', onKeyDown)
      offMenu?.()
    }
  }, [])
  const keys = useBindings()
  useEffect(() => {
    window.kothar?.setMenuShortcuts?.(
      Object.fromEntries(actions.filter((a) => a.menu).map((a) => [a.id, acceleratorOf(keys[a.id] ?? null)])),
    )
  }, [keys])
}
