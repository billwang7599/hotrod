// File links in a chat: a path an agent or the user mentions becomes a link once the core says it exists for the chat.
// Click opens it in the user's editor; right-click offers a terminal at its folder, Finder and copying the path. The
// core does the checking and the opening, so this works the same in the desktop app and a browser tab.
import { createContext, memo, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { m } from 'motion/react'
import { ContextMenu } from 'radix-ui'
import type { ClientMessage, CoreMessage, WorkFolder } from '@kothar/core/shared'
import { Hint, MOTION } from './controls.tsx'
import { splitByRefs, type FileRef } from './file-refs.ts'
import { isMac } from './shortcuts.ts'

/* The answers to files.check, kept for the window: a path found stays a link; one not found is asked about again
 * after a while, since agents create files as they work. Each link subscribes to its own answer, so an answer
 * re-renders only the links that asked. */

const RECHECK_MS = 30_000
const BATCH_MS = 30
const MAX_BATCH = 200

type Answer = { path: string | null; at: number }
const answers = new Map<string, Answer>()
const pending = new Map<string, Set<string>>()
const listeners = new Set<() => void>()
let flush: ReturnType<typeof setTimeout> | undefined

const keyOf = (chatId: string, path: string) => `${chatId}\0${path}`
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

function ask(chatId: string, path: string, send: (m: ClientMessage) => void) {
  const answer = answers.get(keyOf(chatId, path))
  if (answer && (answer.path || Date.now() - answer.at < RECHECK_MS)) return
  // Asked now: not a link until the answer comes, and not asked again for a while if it never does.
  answers.set(keyOf(chatId, path), { path: null, at: Date.now() })
  pending.set(chatId, (pending.get(chatId) ?? new Set()).add(path))
  flush ??= setTimeout(() => {
    flush = undefined
    for (const [id, paths] of pending) {
      const all = [...paths]
      for (let i = 0; i < all.length; i += MAX_BATCH) send({ type: 'files.check', chatId: id, paths: all.slice(i, i + MAX_BATCH) })
    }
    pending.clear()
  }, BATCH_MS)
}

/** Keeps the core's answer to files.check. */
export function fileLinksChecked(message: Extract<CoreMessage, { type: 'files.checked' }>) {
  const at = Date.now()
  for (const [path, found] of Object.entries(message.paths)) answers.set(keyOf(message.chatId, path), { path: found, at })
  for (const listener of listeners) listener()
}

/** Forgets every answer (tests). */
export function forgetFileLinks() {
  answers.clear()
  pending.clear()
  if (flush) clearTimeout(flush)
  flush = undefined
}

/** Where paths are links: the chat they're checked for, and how to open them. Without it, paths stay text. */
export type FileLinkScope = {
  chatId: string
  send: (m: ClientMessage) => void
  connected: boolean
  // What a plain click does (editorLabel), for the menu and the hint.
  editor: string
}
export const FileLinks = createContext<FileLinkScope | undefined>(undefined)

/** Text whose paths aren't links: a reply still typing out, where a half-typed path would be asked about. */
export function NoFileLinks({ children }: { children: ReactNode }) {
  return <FileLinks.Provider value={undefined}>{children}</FileLinks.Provider>
}

/** What a click does, for the menu and the hint: Open in Zed, Open with the default app. */
export function editorLabel(workFolder: Pick<WorkFolder, 'editor' | 'editors'>) {
  if (workFolder.editor === 'custom') return 'Open with your command'
  const name = workFolder.editors?.find((e) => e.id === workFolder.editor)?.name
  return name ? `Open in ${name}` : 'Open with the default app'
}

function useFound(scope: FileLinkScope | undefined, path: string) {
  const found = useSyncExternalStore(subscribe, () => (scope ? answers.get(keyOf(scope.chatId, path))?.path : undefined))
  const { chatId, send } = scope ?? {}
  useEffect(() => {
    if (chatId && send) ask(chatId, path, send)
  }, [chatId, send, path])
  return found ?? undefined
}

const ITEM = 'flex h-26 items-center rounded-sm px-12 text-sm whitespace-nowrap outline-none data-highlighted:bg-raised data-disabled:text-faint'

type LinkProps = Omit<FileRef, 'start' | 'end'> & {
  children: ReactNode
  // Inside a button (a tool row's summary): clickable, but not a second stop for the keyboard.
  inButton?: boolean
}

/** A path as a link, once the core finds it for the chat; until then, and outside a chat, just its text. */
export function FileLink({ path, line, col, children, inButton }: LinkProps) {
  const scope = useContext(FileLinks)
  const found = useFound(scope, path)
  if (!scope || !found) return <>{children}</>
  const { chatId, send, connected } = scope
  const open = (where: 'editor' | 'terminal') =>
    send({ type: 'file.open', chatId, path: found, ...(line && { line }), ...(col && { col }), in: where })
  const at = line ? `${found}:${line}${col ? `:${col}` : ''}` : found
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild disabled={!connected}>
        <Hint text={<span className="wrap-anywhere">{`${scope.editor}: ${at}. Right-click for more.`}</span>}>
          <span
            role="link"
            tabIndex={inButton ? -1 : 0}
            data-file-link={found}
            aria-disabled={!connected || undefined}
            className="cursor-pointer rounded-sm underline decoration-faint decoration-dotted underline-offset-2 hover:decoration-current focus-visible:outline-2 aria-disabled:cursor-default"
            onClick={(e) => {
              e.stopPropagation()
              e.preventDefault()
              if (connected) open('editor')
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || !connected) return
              e.preventDefault()
              open('editor')
            }}
          >
            {children}
          </span>
        </Hint>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content asChild>
          <m.div
            className="z-30 flex min-w-160 flex-col rounded-lg border bg-panel p-4 shadow-floating outline-none"
            initial={MOTION.menu.initial}
            animate={MOTION.menu.animate}
            transition={MOTION.menu.transition}
          >
            <ContextMenu.Item className={ITEM} onSelect={() => open('editor')}>
              {scope.editor}
            </ContextMenu.Item>
            <ContextMenu.Item className={ITEM} onSelect={() => open('terminal')}>
              Open folder in Terminal
            </ContextMenu.Item>
            <ContextMenu.Item className={ITEM} onSelect={() => send({ type: 'reveal', path: found })}>
              {isMac() ? 'Show in Finder' : 'Show in folder'}
            </ContextMenu.Item>
            <ContextMenu.Item className={ITEM} onSelect={() => void navigator.clipboard?.writeText(found)}>
              Copy path
            </ContextMenu.Item>
          </m.div>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

/** Plain text with its paths as links. Text with no path-like run renders as the string itself. */
export const LinkedText = memo(function LinkedText({ text, inButton }: { text: string; inButton?: boolean }) {
  const scope = useContext(FileLinks)
  if (!scope) return <>{text}</>
  const parts = splitByRefs(text)
  if (parts.length === 1 && typeof parts[0] === 'string') return <>{text}</>
  return (
    <>
      {parts.map((part, i) =>
        typeof part === 'string' ? (
          part
        ) : (
          <FileLink key={i} path={part.path} line={part.line} col={part.col} inButton={inButton}>
            {text.slice(part.start, part.end)}
          </FileLink>
        ),
      )}
    </>
  )
})
