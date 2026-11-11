// Files on a message: ones waiting to be sent from the message box, and sent ones with Open and Pin.
import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, m } from 'motion/react'
import { Dialog } from 'radix-ui'
import { IMAGE_TYPES, type Attachment, type ClientMessage, type ContextItem, type Upload } from '@kothar/core/shared'
import { attachmentUrl, coreUrl, readToken } from '../connection.ts'
import { Button, Hint, MOTION } from '../controls.tsx'
import { formatBytes, MAX_PREVIEW_BYTES, pinState, previewText, type ChatView } from '../state.ts'

export const FILE_CHIP = 'flex max-w-200 min-w-0 items-center rounded-lg border px-10'
/** The ::after stretches the hit area to 24px tall, the size of the icon buttons, without changing the look. */
const FILE_ACTION =
  "relative rounded px-5 text-sm leading-[1.35] text-muted after:absolute after:inset-x-0 after:-inset-y-4 after:content-[''] enabled:hover:bg-raised enabled:hover:text-text disabled:text-faint"
/**
 * Shown on hover or focus. While hidden it takes no clicks. Anything below opacity 1 paints above its in-flow
 * siblings, so whatever is hidden must also be click-through, or it sits invisibly on top of what is shown.
 */
const REVEAL =
  'pointer-events-none opacity-0 transition-opacity duration-150 group-focus-within/file:pointer-events-auto group-focus-within/file:opacity-100 group-hover/file:pointer-events-auto group-hover/file:opacity-100'

export type Pending = Upload & { id: string; size: number; preview?: string }

export function PaperclipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
      <path
        d="M13.5 7.5 8 13a3.5 3.5 0 0 1-5-5l6-6a2.3 2.3 0 0 1 3.3 3.3l-6 6a1.2 1.2 0 0 1-1.7-1.7L10 4"
        strokeWidth="1.4"
      />
    </svg>
  )
}

export function FileLabel({ name, size, actions }: { name: string; size: number; actions?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col leading-[1.35]">
      <span className="truncate text-ui">{name}</span>
      <span className="grid text-sm text-faint *:col-start-1 *:row-start-1">
        {/* Click-through: faded out it paints above the buttons that share its cell (see REVEAL). */}
        <span className="pointer-events-none transition-opacity duration-150 group-focus-within/file:opacity-0 group-hover/file:opacity-0">
          {formatBytes(size)}
        </span>
        {actions}
      </span>
    </span>
  )
}

function PinIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M5 1.5h6M6.5 1.5v4.5L3.5 9.5h9L9.5 6V1.5M8 9.5v5" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  )
}

type SentAttachmentProps = {
  chat: ChatView
  attachment: Attachment
  contextItems?: ContextItem[]
  connected: boolean
  send: (m: ClientMessage) => void
}

export function SentAttachment({ chat, attachment, contextItems, connected, send }: SentAttachmentProps) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState<string | null>()
  const { name, size, mimeType, path } = attachment
  const url = attachmentUrl(coreUrl(import.meta.env, location, readToken('', sessionStorage)), chat.id, path)
  const kind = IMAGE_TYPES.includes(mimeType) ? 'image' : mimeType === 'application/pdf' ? 'pdf' : 'file'
  const pin = pinState(chat, contextItems, path)

  useEffect(() => {
    if (!open || kind !== 'file') return
    const abort = new AbortController()
    // oxlint-disable-next-line react/set-state-in-effect -- shows loading while a fresh fetch starts
    setText(undefined)
    void (async () => {
      try {
        const response = await fetch(url, { signal: abort.signal })
        if (!response.ok || !response.body) throw new Error(String(response.status))
        const reader = response.body.getReader()
        const chunks: Uint8Array<ArrayBuffer>[] = []
        for (let total = 0; total < MAX_PREVIEW_BYTES; ) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          total += value.length
        }
        void reader.cancel()
        setText(previewText(new Uint8Array(await new Blob(chunks).arrayBuffer())) ?? null)
      } catch {
        if (!abort.signal.aborted) setText(null)
      }
    })()
    return () => abort.abort()
  }, [open, kind, url])

  const actions = (
    <>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger asChild>
          <button className={FILE_ACTION} aria-label={`Open ${name}`}>
            Open
          </button>
        </Dialog.Trigger>
        <AnimatePresence>
          {open && (
            <Dialog.Portal forceMount>
              <Dialog.Overlay forceMount asChild>
                <m.div className="fixed inset-0 bg-backdrop" {...MOTION.fade} />
              </Dialog.Overlay>
              <Dialog.Content forceMount asChild aria-describedby={undefined}>
                <m.div
                  className="fixed inset-0 m-auto flex size-fit max-h-[calc(100vh-32px)] max-w-[calc(100vw-32px)] min-w-[min(320px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border bg-panel shadow-overlay"
                  {...MOTION.pop}
                >
                  <header className="flex h-40 shrink-0 items-center gap-8 border-b pr-8 pl-12">
                    <Dialog.Title className="min-w-0 flex-1 truncate font-semibold">{name}</Dialog.Title>
                    <Dialog.Close asChild>
                      <Button variant="ghost" size="icon" aria-label="Close">
                        ×
                      </Button>
                    </Dialog.Close>
                  </header>
                  {kind === 'image' && (
                    <img
                      src={url}
                      alt={name}
                      className="mx-auto block max-h-[calc(100vh-74px)] max-w-[calc(100vw-34px)] object-contain"
                    />
                  )}
                  {kind === 'pdf' && (
                    <iframe src={url} title={name} className="h-[calc(100vh-74px)] w-[min(900px,calc(100vw-34px))]" />
                  )}
                  {kind === 'file' && (
                    <>
                      {typeof text === 'string' ? (
                        <pre className="min-h-0 w-[min(880px,calc(100vw-34px))] flex-1 overflow-auto px-12 py-10 text-sm leading-[1.5] whitespace-pre-wrap [word-break:break-word]">
                          {text}
                        </pre>
                      ) : (
                        <p className="px-12 py-16 text-muted">
                          {text === undefined ? 'Loading…' : 'No preview for this kind of file.'}
                        </p>
                      )}
                      <div className="flex shrink-0 items-center gap-8 border-t py-8 pr-8 pl-12 text-sm text-muted">
                        <span className="min-w-0 flex-1 truncate">
                          {mimeType} · {formatBytes(size)}
                          {typeof text === 'string' &&
                            size > MAX_PREVIEW_BYTES &&
                            ` · showing the first ${formatBytes(MAX_PREVIEW_BYTES)}`}
                        </span>
                        <a
                          href={url}
                          download={name}
                          className="flex h-24 items-center rounded border bg-raised px-8 text-text shadow-raised hover:bg-hover active:shadow-sunken"
                        >
                          Download
                        </a>
                      </div>
                    </>
                  )}
                </m.div>
              </Dialog.Content>
            </Dialog.Portal>
          )}
        </AnimatePresence>
      </Dialog.Root>
      {pin && (
        <Hint text={pin === 'pinned' ? "Remove from this chat's context" : "Add to this chat's context, for every message"}>
          <button
            className={FILE_ACTION}
            disabled={!connected}
            aria-label={pin === 'pinned' ? `Unpin ${name}` : `Pin ${name}`}
            onClick={() =>
              send({ type: pin === 'pinned' ? 'context.remove' : 'context.add', chatId: chat.id, section: 'files', path })
            }
          >
            {pin === 'pinned' ? 'Unpin' : 'Pin'}
          </button>
        </Hint>
      )}
    </>
  )
  return (
    <div className="group/file relative">
      {kind === 'image' ? (
        <>
          <img
            src={url}
            alt={name}
            title={name}
            className="block max-h-160 min-h-32 max-w-240 min-w-80 rounded-lg border object-contain shadow-raised"
          />
          <span className={`absolute top-4 right-4 flex rounded border bg-panel p-2 shadow-floating ${REVEAL}`}>{actions}</span>
        </>
      ) : (
        <div className={`${FILE_CHIP} h-40 bg-panel shadow-raised`} title={name}>
          <FileLabel name={name} size={size} actions={<span className={`-ml-5 flex ${REVEAL}`}>{actions}</span>} />
        </div>
      )}
      {pin === 'pinned' && (
        <Hint text="Pinned to this chat's context">
          <span
            className="absolute -top-6 -left-6 grid size-18 place-items-center rounded-full bg-accent text-on-accent"
            role="img"
            aria-label="Pinned to the context"
          >
            <PinIcon />
          </span>
        </Hint>
      )}
    </div>
  )
}
