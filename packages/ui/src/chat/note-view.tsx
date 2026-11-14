// An extension's live card in the transcript (ExtensionNoteView), such as a research run's progress: drawn by the
// extension as a panel is, asked for when it shows, and asked again whenever the chat's extensions draw, so it updates
// live. Its buttons go back to the extension. While the extension can't draw it (off, or left out of the chat), the
// note's text shows instead.
import { useEffect } from 'react'
import type { ExtensionAction } from '@kothar/extension-api'
import type { ClientMessage, NoteViewInfo } from '@kothar/core/shared'
import { ExtensionViewer } from '../extension-view.tsx'
import { noteViewKey, type PanelView } from '../state.ts'

type Props = {
  chatId: string
  extension: string
  view: { id: string; key: string }
  text: string
  // The note views the chat can draw now; a new list each time the chat's extensions draw.
  offered?: readonly NoteViewInfo[]
  views?: Record<string, PanelView>
  connected: boolean
  send: (m: ClientMessage) => void
}

const BOX = 'w-full max-w-560 min-w-0 rounded-lg border bg-bg px-12 py-10 text-left shadow-raised'

export function NoteView({ chatId, extension, view, text, offered, views, connected, send }: Props) {
  const drawn = offered?.some((v) => v.extension === extension && v.id === view.id) === true
  const { id, key } = view
  useEffect(() => {
    if (drawn && connected) send({ type: 'extension.noteView.get', chatId, extension, noteView: id, key })
    // offered is a new list each time the chat's extensions draw (host.refresh), so the card draws again then.
  }, [drawn, connected, chatId, extension, id, key, send, offered])
  if (!drawn) {
    return (
      <div className={`${BOX} text-sm text-muted`} data-note-view={`${extension}:${id}`}>
        {text}
      </div>
    )
  }
  const shown = views?.[noteViewKey(chatId, extension, id, key)]
  const act = (action: ExtensionAction) => send({ type: 'extension.noteView.action', chatId, extension, noteView: id, key, action })
  return (
    <div className={BOX} data-note-view={`${extension}:${id}`}>
      <ExtensionViewer view={shown?.view} error={shown?.error} act={act} extension={extension} />
    </div>
  )
}
