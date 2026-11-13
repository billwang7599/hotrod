// Extensions' switches in a chat's composer (Extension.composerToggles): what the UI gets of one, and each chat's state,
// kept in its chat.json by extension id, then toggle id.
import type { Extension, ExtensionComposerToggle } from '@kothar/extension-api'
import type { ChatInfo, ComposerToggleInfo } from './shared.ts'

const ICONS: readonly NonNullable<ExtensionComposerToggle['icon']>[] = ['search', 'globe', 'book', 'sparkle', 'bolt']

/** The extension's toggle by id, or a throw. */
export function toggleOf(extension: Extension, id: unknown): ExtensionComposerToggle {
  const toggle = extension.composerToggles?.find((t) => t.id === id)
  if (!toggle) throw new Error(`${extension.name} has no composer toggle "${id}"`)
  return toggle
}

/** Whether the toggle is on in the chat: as the chat saved it, else its default. */
export function isToggled(info: Pick<ChatInfo, 'toggles'>, extension: Extension, toggle: ExtensionComposerToggle): boolean {
  const saved = info.toggles?.[extension.id]?.[toggle.id]
  return typeof saved === 'boolean' ? saved : toggle.default === true
}

/** The chat's toggles with this one set. */
export function withToggle(info: Pick<ChatInfo, 'toggles'>, extension: Extension, toggle: ExtensionComposerToggle, on: boolean) {
  return { ...info.toggles, [extension.id]: { ...info.toggles?.[extension.id], [toggle.id]: on } }
}

/** What the UI gets of one toggle: its labels and icon checked, and whether it's on in the chat. */
export function toggleInfo(extension: string, toggle: ExtensionComposerToggle, on: boolean): ComposerToggleInfo {
  const { id, label, icon, hint, activeHint } = toggle
  if (typeof id !== 'string' || !id || typeof label !== 'string' || !label) throw new Error('A composer toggle needs an id and a label')
  if (icon !== undefined && !ICONS.includes(icon)) throw new Error(`A composer toggle's icon is one of ${ICONS.join(', ')}`)
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)
  return {
    extension,
    id,
    label,
    on,
    ...(icon && { icon }),
    ...(text(hint) && { hint: text(hint) }),
    ...(text(activeHint) && { activeHint: text(activeHint) }),
  }
}
