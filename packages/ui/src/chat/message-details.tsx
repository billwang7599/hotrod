// Extensions' folded rows under a message (ExtensionMessageDetail), such as the Inspector's "What was sent": folded,
// only the label shows and nothing is asked of the core; unfolding asks for the view, and it's asked again while open
// whenever the chat's extensions draw.
import { useEffect, useState } from 'react'
import { AnimatePresence, m } from 'motion/react'
import type { ClientMessage, MessageDetailInfo } from '@kothar/core/shared'
import { Chevron, MOTION } from '../controls.tsx'
import { ExtensionViewer } from '../extension-view.tsx'
import type { PanelView } from '../state.ts'

type Kind = MessageDetailInfo['kinds'][number]

/** The key a detail's view is kept under in state.detailViews. */
export const detailKey = (chatId: string, extension: string, detail: string, entry: number) => `${chatId}/${extension}/${detail}/${entry}`

/** The details offered on this message: its kind, and its entry when the detail lists entries. */
export function detailsFor(details: readonly MessageDetailInfo[] | undefined, kind: Kind, entry: number | undefined) {
  if (!details?.length || entry === undefined) return []
  return details.filter((d) => d.kinds.includes(kind) && (!d.entries || d.entries.includes(entry)))
}

const NO_ACT = () => {}

type DetailProps = {
  detail: MessageDetailInfo
  chatId: string
  entry: number
  connected: boolean
  send: (m: ClientMessage) => void
  view?: PanelView
}

function MessageDetail({ detail, chatId, entry, connected, send, view }: DetailProps) {
  // Folded until the user opens it, whatever the steps setting: opening one asks the core to draw it.
  const [open, setOpen] = useState(false)
  const { extension, id } = detail
  useEffect(() => {
    if (open && connected) send({ type: 'extension.detail.get', chatId, extension, detail: id, entry })
    // detail is a new object each time the chat's extensions draw, so an open row draws again then.
  }, [open, connected, chatId, extension, id, entry, send, detail])
  return (
    <div className={`text-muted ${open ? 'w-full' : 'self-end'}`} data-message-detail={`${extension}:${id}`}>
      <button
        type="button"
        className="group ml-auto flex h-24 items-center gap-6 rounded pr-8 pl-6 text-left text-sm transition-colors hover:bg-raised"
        aria-expanded={open}
        data-open={open || undefined}
        title={detail.hint}
        onClick={() => setOpen(!open)}
      >
        <Chevron />
        {detail.label}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <m.div {...MOTION.collapse}>
            <div className="mt-4 mb-2 rounded border bg-panel p-12 text-left text-text shadow-raised">
              <ExtensionViewer view={view?.view} error={view?.error} act={NO_ACT} extension={extension} />
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
}

type Props = {
  details: readonly MessageDetailInfo[]
  chatId: string
  entry: number
  connected: boolean
  send: (m: ClientMessage) => void
  views?: Record<string, PanelView>
}

export function MessageDetails({ details, chatId, entry, connected, send, views }: Props) {
  return details.map((detail) => (
    <MessageDetail
      key={`${detail.extension}/${detail.id}`}
      detail={detail}
      chatId={chatId}
      entry={entry}
      connected={connected}
      send={send}
      view={views?.[detailKey(chatId, detail.extension, detail.id, entry)]}
    />
  ))
}
