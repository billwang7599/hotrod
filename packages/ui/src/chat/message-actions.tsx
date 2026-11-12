// Extensions' buttons on a message in the transcript (ExtensionMessageAction), beside Copy: shown on hover or keyboard
// focus, and kept in view, filled, on a message the extension marks (such as a pinned one).
import type { ClientMessage, MessageActionInfo } from '@kothar/core/shared'
import { COPY_REVEAL, Hint } from '../controls.tsx'

type Kind = MessageActionInfo['kinds'][number]

const ICONS: Record<MessageActionInfo['icon'], string> = {
  pin: 'M6 2.5h4M6.5 2.5v4L4.5 9h7l-2-2.5v-4M8 9v4.5',
  bookmark: 'M4.5 2.5h7v11L8 10.5l-3.5 3z',
  star: 'M8 2.2l1.7 3.6 3.9.5-2.9 2.7.8 3.9L8 11l-3.5 1.9.8-3.9-2.9-2.7 3.9-.5z',
}

export function ActionIcon({ icon, filled }: { icon: MessageActionInfo['icon']; filled?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" aria-hidden="true">
      <path d={ICONS[icon]} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

type Props = {
  actions: readonly MessageActionInfo[]
  chatId: string
  // Where the message is in the chat's log; without it the message can't be acted on.
  entry?: number
  kind: Kind
  connected: boolean
  send: (m: ClientMessage) => void
  className?: string
}

/** The buttons, as siblings of the message's Copy, so they show while the same parent is hovered. */
export function MessageActions({ actions, chatId, entry, kind, connected, send, className = '' }: Props) {
  if (entry === undefined) return null
  return actions
    .filter((a) => a.kinds.includes(kind))
    .map((a) => {
      const active = a.marked.includes(entry)
      const label = active ? (a.activeLabel ?? a.label) : a.label
      const hint = (active ? a.activeHint : a.hint) ?? label
      return (
        <Hint key={`${a.extension}\n${a.id}`} text={hint}>
          <button
            type="button"
            className={`grid size-24 shrink-0 place-items-center rounded transition-[opacity,background-color,color] duration-150 hover:bg-raised disabled:cursor-default ${className} ${
              active ? 'text-accent' : `text-muted hover:text-text ${COPY_REVEAL}`
            }`}
            aria-label={label}
            data-message-action={a.id}
            data-marked={active || undefined}
            disabled={!connected}
            onClick={() => send({ type: 'extension.message.action', chatId, extension: a.extension, action: a.id, entry })}
          >
            <ActionIcon icon={a.icon} filled={active} />
          </button>
        </Hint>
      )
    })
}
