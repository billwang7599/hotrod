// Copy changes back: for a folder set to Work on a copy, the files the agents changed in its copy, picked by the user
// and copied back into the folder. The core's answers (context.copyChanges) are kept here, outside the app's state,
// since only this dialog reads them.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { AnimatePresence, m } from 'motion/react'
import { Dialog } from 'radix-ui'
import type { ClientMessage, CopyChange, CoreMessage } from '@kothar/core/shared'
import { Button, Hint, MOTION, useReturnFocus } from './controls.tsx'

type Review = Omit<Extract<CoreMessage, { type: 'context.copyChanges' }>, 'type'>

let reviews: Record<string, Review> = {}
const listeners = new Set<() => void>()
const keyOf = (chatId: string, path: string) => `${chatId}\n${path}`

/** Keeps the core's latest answer for a folder's copy. */
export function receiveCopyChanges({ type: _, ...review }: Extract<CoreMessage, { type: 'context.copyChanges' }>) {
  reviews = { ...reviews, [keyOf(review.chatId, review.path)]: review }
  listeners.forEach((listener) => listener())
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const KIND_LABELS: Record<CopyChange['kind'], string> = { added: 'Added', changed: 'Changed', deleted: 'Deleted' }
const CONFLICT_HINT = 'The original changed too since the copy was made, so copying this back overwrites that change'
const COPY_HINT =
  'Agents write only in this copy, in the work folder. Copy changes back shows what they changed and copies your ' +
  'pick into the folder.'

type Props = { chatId: string; path: string; copy?: string; disabled: boolean; send: (m: ClientMessage) => void }

/** Where a folder's copy is, and the button that reviews and copies its changes back. */
export function CopyRow({ chatId, path, copy, disabled, send }: Props) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex items-center gap-8 pt-4 text-xs text-muted">
      <Hint text={COPY_HINT} align="start">
        <span className="min-w-0 flex-1 leading-[normal] wrap-anywhere">
          {copy ? (
            <>
              Copy at <span className="font-mono">{copy}</span>
            </>
          ) : (
            'Copied into the work folder at the chat’s next message'
          )}
        </span>
      </Hint>
      {copy && (
        <Button size="small" variant="ghost" disabled={disabled} onClick={() => setOpen(true)}>
          Copy changes back…
        </Button>
      )}
      <CopyBackDialog open={open} close={() => setOpen(false)} chatId={chatId} path={path} send={send} />
    </div>
  )
}

function CopyBackDialog({ open, close, chatId, path, send }: {
  open: boolean
  close: () => void
  chatId: string
  path: string
  send: (m: ClientMessage) => void
}) {
  const review = useSyncExternalStore(subscribe, () => reviews[keyOf(chatId, path)])
  const [asked, setAsked] = useState<Review | undefined>()
  const [picked, setPicked] = useState<string[]>([])
  const [overwrite, setOverwrite] = useState(false)
  const focus = useReturnFocus()
  useEffect(() => {
    if (open) send({ type: 'context.copyChanges', chatId, path })
  }, [open, chatId, path, send])
  // Each fresh answer picks every change but the ones that would overwrite a changed original.
  const current = open ? review : undefined
  if (current !== asked) {
    setAsked(current)
    setPicked(current?.changes.filter((c) => !c.conflict).map((c) => c.path) ?? [])
    setOverwrite(false)
  }
  const changes = current?.changes ?? []
  const conflicts = changes.filter((c) => c.conflict && picked.includes(c.path))
  const toggle = (file: string) =>
    setPicked((now) => (now.includes(file) ? now.filter((p) => p !== file) : [...now, file]))
  const apply = () => send({ type: 'context.copyBack', chatId, path, files: picked, overwrite })
  return (
    <Dialog.Root open={open} onOpenChange={(o) => o || close()}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay forceMount asChild>
              <m.div className="fixed inset-0 z-30 bg-backdrop" {...MOTION.fade} />
            </Dialog.Overlay>
            <Dialog.Content
              forceMount
              asChild
              aria-describedby={undefined}
              onOpenAutoFocus={focus.remember}
              onCloseAutoFocus={focus.restore}
            >
              <m.div
                className="fixed inset-0 z-30 m-auto flex h-fit max-h-[calc(100vh-32px)] w-[min(520px,calc(100vw-32px))] flex-col gap-12 scroll-inset overflow-y-auto rounded-xl border bg-panel pt-14 pr-2 pb-16 pl-16 text-text shadow-overlay"
                {...MOTION.pop}
              >
                <Dialog.Title className="text-[16px] font-semibold">Copy changes back</Dialog.Title>
                <p className="font-mono text-xs wrap-anywhere text-muted">{path}</p>
                {!current ? (
                  <p className="text-sm text-muted">Looking for changes…</p>
                ) : !changes.length ? (
                  <p className="text-sm text-muted">The copy has no changes to copy back.</p>
                ) : (
                  <ul className="flex flex-col gap-2" aria-label="Changes">
                    {changes.map((change) => (
                      <li key={change.path}>
                        <label className="flex items-center gap-8 py-2 text-sm">
                          <input
                            type="checkbox"
                            checked={picked.includes(change.path)}
                            onChange={() => toggle(change.path)}
                          />
                          <span className="w-60 shrink-0 text-xs text-muted">{KIND_LABELS[change.kind]}</span>
                          <span className="min-w-0 flex-1 font-mono text-xs wrap-anywhere">{change.path}</span>
                          {change.conflict && (
                            <Hint text={CONFLICT_HINT}>
                              <span className="shrink-0 text-xs text-amber">Original changed</span>
                            </Hint>
                          )}
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
                {conflicts.length > 0 && (
                  <label className="flex items-center gap-8 text-sm text-amber">
                    <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
                    Overwrite {conflicts.length === 1 ? 'the original that' : `the ${conflicts.length} originals that`}{' '}
                    changed since the copy was made
                  </label>
                )}
                {current?.error && <p className="text-sm text-red">{current.error}</p>}
                {current?.copied !== undefined && !current.error && (
                  <p className="text-sm text-green">
                    Copied back {current.copied} {current.copied === 1 ? 'file' : 'files'}.
                  </p>
                )}
                <div className="flex justify-end gap-8">
                  <Dialog.Close asChild>
                    <Button type="button">Close</Button>
                  </Dialog.Close>
                  <Button
                    variant="primary"
                    disabled={!picked.length || (conflicts.length > 0 && !overwrite)}
                    onClick={apply}
                  >
                    Copy back {picked.length} {picked.length === 1 ? 'file' : 'files'}
                  </Button>
                </div>
              </m.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}
