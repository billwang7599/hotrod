// Extensions' switches in the composer (ExtensionComposerToggle): a chip each, beside Attach, pressed while it's on in
// this chat. The core keeps the state; a click asks it to flip, and the chip follows what the core says back.
import type { ClientMessage, ComposerToggleInfo } from '@kothar/core/shared'
import { Hint } from '../controls.tsx'

type Icon = NonNullable<ComposerToggleInfo['icon']>

const ICONS: Record<Icon, string> = {
  search: 'M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.3 10.3l3.2 3.2',
  globe: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM2.5 8h11M8 2.5c1.6 1.7 2.3 3.5 2.3 5.5S9.6 11.8 8 13.5M8 2.5C6.4 4.2 5.7 6 5.7 8s.7 3.8 2.3 5.5',
  book: 'M3 3.5h3.5A1.5 1.5 0 0 1 8 5v8a1.5 1.5 0 0 0-1.5-1.5H3zM13 3.5H9.5A1.5 1.5 0 0 0 8 5v8a1.5 1.5 0 0 1 1.5-1.5H13z',
  sparkle: 'M8 2.5l1.3 3.7 3.7 1.3-3.7 1.3L8 12.5l-1.3-3.7L3 7.5l3.7-1.3z',
  bolt: 'M9 2.5L4 9h4l-1 4.5L12 7H8z',
}

function ToggleIcon({ icon }: { icon: Icon }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
      <path d={ICONS[icon]} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

type Props = {
  toggles: readonly ComposerToggleInfo[]
  chatId: string
  disabled: boolean
  send: (m: ClientMessage) => void
}

export function ComposerToggles({ toggles, chatId, disabled, send }: Props) {
  return toggles.map((t) => {
    const hint = (t.on ? t.activeHint : t.hint) ?? t.label
    return (
      <Hint key={`${t.extension}\n${t.id}`} text={hint}>
        <button
          type="button"
          aria-pressed={t.on}
          data-composer-toggle={t.id}
          disabled={disabled}
          className={`flex h-24 shrink-0 items-center gap-4 rounded-full border px-8 text-[12px] leading-none transition-[background-color,border-color,color] duration-150 disabled:cursor-default disabled:opacity-50 ${
            t.on ? 'border-accent bg-accent/10 text-accent' : 'border-transparent text-muted hover:bg-raised hover:text-text'
          }`}
          onClick={() => send({ type: 'extension.toggle', chatId, extension: t.extension, toggle: t.id, on: !t.on })}
        >
          {t.icon && <ToggleIcon icon={t.icon} />}
          <span className="truncate">{t.label}</span>
        </button>
      </Hint>
    )
  })
}
