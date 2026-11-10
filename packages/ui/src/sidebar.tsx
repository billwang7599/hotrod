import { useEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from 'react'
import { AnimatePresence, m } from 'motion/react'
import { Dialog, DropdownMenu } from 'radix-ui'
import type { ChatStatus, ClientMessage } from '@kothar/core/shared'
import { Button, CHAT_NOUN, Chevron, confirm, Hint, MOTION, NAV_LABEL, useReturnFocus, useSettled } from './controls.tsx'
import { foldChat, useFoldedChats } from './folded.ts'
import { chatTree, familyOf, folderOf, workerRequests, type ChatView, type TreeRow } from './state.ts'
import { Keys } from './shortcuts-page.tsx'
import type { Binding } from './shortcuts.ts'
import { showsUnread } from './unread.ts'

const CHAT_BUSY = `Stop this ${CHAT_NOUN.one} and the ones below it first`
const DOTS: Record<ChatStatus, string> = {
  idle: 'bg-faint',
  running: 'bg-green animate-blink',
  waiting: 'bg-amber',
  // Amber means only "waiting on you": a chat on its way to idle blinks grey.
  stopping: 'bg-muted animate-blink',
}
/** A folded row shows the busiest status among the workers it hides. */
const BUSIEST: ChatStatus[] = ['waiting', 'stopping', 'running', 'idle']
const INDENTS = ['pl-8', 'pl-22', 'pl-36', 'pl-50']
const ROW_ACTION = 'hidden group-hover/row:block group-focus-within/row:block'
// After a keyboard move, the row is focused again for this long, while the core's updates reorder the list.
const REFOCUS_MS = 1000

type MenuItem = { label: string; run: () => void; danger?: boolean; disabledReason?: string }

function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  return (
    <DropdownMenu.Root modal={false}>
      <div className={`mr-2 has-data-[state=open]:block ${ROW_ACTION}`}>
        <DropdownMenu.Trigger asChild>
          <Button variant="ghost" size="icon" aria-label={`More for ${label}`}>
            ⋯
          </Button>
        </DropdownMenu.Trigger>
      </div>
      <DropdownMenu.Portal>
        <DropdownMenu.Content asChild align="end" sideOffset={4}>
          <m.div
            className="z-20 flex min-w-140 flex-col rounded-lg border bg-panel p-4 shadow-floating outline-none"
            initial={MOTION.menu.initial}
            animate={MOTION.menu.animate}
            transition={MOTION.menu.transition}
          >
            {items.map((item) => (
              <Hint key={item.label} text={item.disabledReason} side="left">
                <DropdownMenu.Item
                  disabled={!!item.disabledReason}
                  onSelect={item.run}
                  className={`flex h-26 items-center rounded-sm px-12 text-sm whitespace-nowrap outline-none data-disabled:text-faint ${item.danger ? 'text-red data-highlighted:bg-red/10' : 'data-highlighted:bg-raised'}`}
                >
                  {item.label}
                </DropdownMenu.Item>
              </Hint>
            ))}
          </m.div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

type Reorder = {
  dragging: boolean
  drop?: 'before' | 'after'
  start: (e: DragEvent) => void
  over: (e: DragEvent) => void
  land: (e: DragEvent) => void
  end: () => void
  key: (e: KeyboardEvent) => void
}

type RowProps = {
  row: TreeRow
  animate: boolean
  title: string
  selected: boolean
  // Shown as the chat's status while a worker below it waits for approval, since the user answers it here.
  status: ChatStatus
  // Bold: a space or Home whose own lead finished a turn the user hasn't seen.
  unread: boolean
  showEngine: boolean
  select: () => void
  menu?: MenuItem[]
  fold?: { folded: boolean; hidden: ChatView[]; toggle: () => void }
  reorder?: Reorder
}

function ChatRow(props: RowProps) {
  const { row, animate, title, selected, status: own, unread, showEngine, select, menu, fold, reorder } = props
  const { chat, depth } = row
  const status = fold?.folded ? BUSIEST.find((s) => [own, ...fold.hidden.map((c) => c.status)].includes(s))! : own
  const highlight = selected
    ? 'bg-raised text-text'
    : unread
    ? 'text-text hover:bg-raised has-data-[state=open]:bg-raised'
    : 'text-muted hover:bg-raised hover:text-text has-data-[state=open]:bg-raised has-data-[state=open]:text-text'
  const engineHidden = menu
    ? 'group-hover/row:hidden group-focus-within/row:hidden group-has-data-[state=open]/row:hidden'
    : ''
  return (
    <m.div
      className={`group/row relative flex shrink-0 items-center rounded transition-colors ${highlight} ${reorder?.dragging ? 'opacity-50' : ''}`}
      {...MOTION.collapse}
      initial={animate && MOTION.collapse.initial}
    >
      <button
        className={`flex h-control min-w-0 flex-1 items-center gap-8 pr-8 text-left whitespace-nowrap ${INDENTS[Math.min(depth, INDENTS.length - 1)]}`}
        title={title}
        onClick={select}
        data-chat-id={chat.id}
        draggable={reorder && depth === 0 ? true : undefined}
        onDragStart={reorder?.start}
        onDragOver={reorder?.over}
        onDrop={reorder?.land}
        onDragEnd={reorder?.end}
        onKeyDown={reorder?.key}
      >
        <span className={`size-7 shrink-0 rounded-full ${DOTS[status]}`} data-status={status} />
        {chat.extension === 'home' && <HouseIcon />}
        <span className={`min-w-0 flex-1 truncate ${unread ? 'font-semibold' : ''}`} data-unread={unread || undefined}>
          {chat.name}
        </span>
        {chat.worker && <span className="rounded border px-5 text-xs text-muted">worker</span>}
        {showEngine && <span className={`text-xs text-faint ${engineHidden}`}>{chat.engine}</span>}
      </button>
      {fold && (
        <Hint text={fold.folded ? 'Show workers' : 'Hide workers'}>
          <Button
            variant="ghost"
            size="none"
            className="group mr-2 flex h-22 items-center gap-4 px-4 text-xs text-faint"
            aria-label={fold.folded ? 'Show workers' : 'Hide workers'}
            aria-expanded={!fold.folded}
            data-open={fold.folded ? undefined : ''}
            onClick={fold.toggle}
          >
            {fold.folded && <span className="tabular-nums">{fold.hidden.length}</span>}
            <Chevron />
          </Button>
        </Hint>
      )}
      {menu && <RowMenu label={chat.name} items={menu} />}
      {reorder?.drop && (
        <span
          aria-hidden
          data-drop={reorder.drop}
          className={`pointer-events-none absolute inset-x-4 h-2 rounded-full bg-accent ${reorder.drop === 'before' ? '-top-2' : '-bottom-2'}`}
        />
      )}
    </m.div>
  )
}

function HouseIcon() {
  return (
    <svg className="size-14 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h3v-3.5h2V13h3V6.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export type NameRequest = { kind: 'new' } | { kind: 'rename'; chatId: string; name: string }

type SidebarProps = {
  chats: ChatView[]
  selectedId: string
  // The user is looking at this window, so the open chat is being seen.
  looking?: boolean
  connected: boolean
  send: (m: ClientMessage) => void
  select: (chatId: string) => void
  askName: (request: NameRequest) => void
  // The New space shortcut, shown when the New space button is hovered.
  newSpaceKeys?: Binding | null
}

export function ChatNav({
  chats,
  selectedId,
  looking = true,
  connected,
  send,
  select,
  askName,
  newSpaceKeys,
}: SidebarProps) {
  const offline = connected ? undefined : 'Disconnected from the core'
  const settled = useSettled(chats.length > 0)
  const tree = chatTree(chats)
  // Extension chats (Home) sort first; they sit above the spaces, apart from them.
  const firstSpace = tree.active.findIndex((r) => r.depth === 0 && !r.chat.extension)
  const split = firstSpace < 0 ? tree.active.length : firstSpace
  const folded = useFoldedChats()
  // A row is hidden while a chat above it is folded, unless it's the chat being viewed.
  const ancestors = (chat: ChatView): ChatView[] => {
    const parent = chats.find((c) => c.id === chat.parentId)
    return parent ? [parent, ...ancestors(parent)] : []
  }
  const shown = (row: TreeRow) => row.chat.id === selectedId || !ancestors(row.chat).some((c) => folded.has(c.id))
  const mixedEngines = new Set(chats.map((c) => c.engine)).size > 1
  const rootOf = (chat: ChatView) => ancestors(chat).at(-1) ?? chat
  const spaceRows = tree.active.slice(split)
  const groupRows = (pinned: boolean) => spaceRows.filter((r) => !!rootOf(r.chat).pinned === pinned)
  const spacesIn = (pinned: boolean) =>
    groupRows(pinned)
      .filter((r) => r.depth === 0)
      .map((r) => r.chat)

  const [drag, setDrag] = useState<{ id: string; over?: { id: string; after: boolean } } | null>(null)
  const refocus = useRef<{ id: string; until: number } | null>(null)
  useEffect(() => {
    const pending = refocus.current
    if (!pending) return
    if (Date.now() > pending.until) refocus.current = null
    else document.querySelector<HTMLElement>(`nav [data-chat-id="${pending.id}"]`)?.focus()
  }, [chats])
  const move = (chat: ChatView, pinned: boolean, index: number) =>
    send({ type: 'chat.move', chatId: chat.id, pinned, index })
  // Moves a space one place up or down within its group, keeping it focused when done from the keyboard.
  const step = (chat: ChatView, by: -1 | 1, keyboard = false) => {
    const group = spacesIn(!!chat.pinned)
    const index = group.findIndex((c) => c.id === chat.id) + by
    if (index < 0 || index >= group.length) return
    // oxlint-disable-next-line react/purity -- step runs only from key and menu handlers, never during render
    if (keyboard) refocus.current = { id: chat.id, until: Date.now() + REFOCUS_MS }
    move(chat, !!chat.pinned, index)
  }
  const reorder = (row: TreeRow): Reorder | undefined => {
    if (!connected || row.chat.archived || row.chat.extension) return undefined
    const space = rootOf(row.chat)
    const target = (e: DragEvent) => {
      const box = e.currentTarget.getBoundingClientRect()
      return { id: space.id, after: row.depth > 0 || e.clientY > box.top + box.height / 2 }
    }
    return {
      dragging: drag?.id === row.chat.id,
      drop:
        drag && drag.id !== space.id && drag.over?.id === row.chat.id
          ? drag.over.after
            ? 'after'
            : 'before'
          : undefined,
      start: (e) => {
        if (row.depth > 0) return e.preventDefault()
        e.dataTransfer?.setData('text/plain', row.chat.name)
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
        setDrag({ id: row.chat.id })
      },
      over: (e) => {
        if (!drag) return
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
        const { after } = target(e)
        // The indicator sits on the row the space lands next to: below a space's last worker when after it.
        const family = groupRows(!!space.pinned).filter((r) => rootOf(r.chat).id === space.id && shown(r))
        const id = after ? family.at(-1)!.chat.id : space.id
        if (drag.over?.id !== id || drag.over.after !== after) setDrag({ ...drag, over: { id, after } })
      },
      land: (e) => {
        if (!drag) return
        e.preventDefault()
        const dragged = chats.find((c) => c.id === drag.id)
        setDrag(null)
        if (!dragged || dragged.id === space.id) return
        const pinned = !!space.pinned
        const group = spacesIn(pinned).filter((c) => c.id !== dragged.id)
        move(dragged, pinned, group.findIndex((c) => c.id === space.id) + (target(e).after ? 1 : 0))
      },
      end: () => setDrag(null),
      key: (e) => {
        if (!e.altKey || row.depth > 0 || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
        e.preventDefault()
        step(row.chat, e.key === 'ArrowUp' ? -1 : 1, true)
      },
    }
  }

  const chatMenu = (chat: ChatView): MenuItem[] => {
    const family = familyOf(chats, chat.id)
    const disabledReason = offline ?? (family.some((c) => c.status !== 'idle') ? CHAT_BUSY : undefined)
    const remove = async () => {
      const below = family.length > 1 ? ' and everything below it' : ''
      const work = chat.workDir ? ` Its work folder goes too (${chat.workDir}); its git branches stay.` : ''
      const text =
        `Delete “${chat.name}”${below}? Messages are deleted from Kothar; your folders and files stay on disk.` + work
      if (await confirm(text)) send({ type: 'chat.delete', chatId: chat.id })
    }
    const group = spacesIn(!!chat.pinned)
    const index = group.findIndex((c) => c.id === chat.id)
    const placing: MenuItem[] = chat.archived
      ? []
      : [
          chat.pinned
            ? { label: 'Unpin', disabledReason: offline, run: () => move(chat, false, 0) }
            : { label: 'Pin', disabledReason: offline, run: () => move(chat, true, spacesIn(true).length) },
          ...(index > 0 ? [{ label: 'Move up', disabledReason: offline, run: () => step(chat, -1) }] : []),
          ...(index < group.length - 1
            ? [{ label: 'Move down', disabledReason: offline, run: () => step(chat, 1) }]
            : []),
        ]
    return [
      {
        label: 'Rename…',
        disabledReason: offline,
        run: () => askName({ kind: 'rename', chatId: chat.id, name: chat.name }),
      },
      ...placing,
      {
        label: chat.archived ? 'Unarchive' : 'Archive',
        disabledReason,
        run: () => send({ type: 'chat.archive', chatId: chat.id, archived: !chat.archived }),
      },
      { label: 'Delete…', danger: true, disabledReason, run: remove },
    ]
  }
  const pinnedRows = groupRows(true)
  const row = (row: TreeRow) => {
    const { chat } = row
    const folder = folderOf(chats, chat) ?? 'Not tied to a folder'
    const below = familyOf(chats, chat.id).filter((c) => c.id !== chat.id && c.archived === chat.archived)
    const isFolded = folded.has(chat.id)
    const asksBelow = !chat.worker && workerRequests(chats, chat.id).length > 0
    return (
      <ChatRow
        key={chat.id}
        row={row}
        animate={settled.current}
        title={`${chat.name}: ${folder}`}
        selected={chat.id === selectedId}
        status={asksBelow ? 'waiting' : chat.status}
        unread={showsUnread(chat, looking && chat.id === selectedId)}
        showEngine={mixedEngines}
        select={() => select(chat.id)}
        menu={chat.extension || chat.worker ? undefined : chatMenu(chat)}
        fold={below.length ? { folded: isFolded, hidden: below, toggle: () => foldChat(chat.id, !isFolded) } : undefined}
        reorder={reorder(row)}
      />
    )
  }

  return (
    <nav className="flex flex-1 scroll-inset flex-col gap-1 overflow-y-auto pt-10 pr-0 pb-8 pl-8">
      <AnimatePresence>{tree.active.slice(0, split).filter(shown).map(row)}</AnimatePresence>
      {pinnedRows.length > 0 && (
        <>
          <h2 id="pinned-label" className={NAV_LABEL}>
            Pinned
          </h2>
          <div role="group" aria-labelledby="pinned-label" className="flex flex-col gap-1">
            <AnimatePresence>{pinnedRows.filter(shown).map(row)}</AnimatePresence>
          </div>
        </>
      )}
      <h2 id="spaces-label" className={NAV_LABEL}>
        {CHAT_NOUN.many}
      </h2>
      <div role="group" aria-labelledby="spaces-label" className="flex flex-col gap-1">
        <AnimatePresence>{groupRows(false).filter(shown).map(row)}</AnimatePresence>
      </div>
      <Hint text={newSpaceKeys && <Keys binding={newSpaceKeys} />} side="right">
        {/* As wide and tall as a space row, its label under the space names: the + sits where a row's dot does
            (pl-7 plus the button's 1px border makes the rows' pl-8). */}
        <Button
          variant="ghost"
          size="none"
          className="flex h-control w-full shrink-0 items-center gap-8 pr-8 pl-7 text-left"
          disabled={!connected}
          onClick={() => askName({ kind: 'new' })}
        >
          <span aria-hidden="true" className="flex w-7 shrink-0 justify-center">
            +
          </span>
          New {CHAT_NOUN.one}
        </Button>
      </Hint>

      {tree.archived.length > 0 && (
        <details className="group mt-auto">
          <summary className={`list-none ${NAV_LABEL}`}>
            <Chevron />
            Archived ({tree.archived.filter((r) => r.depth === 0).length})
          </summary>
          <AnimatePresence>{tree.archived.filter(shown).map(row)}</AnimatePresence>
        </details>
      )}
    </nav>
  )
}

type NameDialogProps = {
  request: NameRequest | null
  connected: boolean
  send: (m: ClientMessage) => void
  close: () => void
}

export function NameDialog({ request, connected, send, close }: NameDialogProps) {
  const [shown, setShown] = useState<NameRequest | null>(null)
  const [name, setName] = useState('')
  if (request && request !== shown) {
    setShown(request)
    setName(request.kind === 'rename' ? request.name : '')
  }
  const focus = useReturnFocus()
  const isNew = shown?.kind === 'new'
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!request || !connected || !name.trim()) return
    if (request.kind === 'rename') send({ type: 'chat.rename', chatId: request.chatId, name })
    else send({ type: 'chat.create', name })
    close()
  }
  return (
    <Dialog.Root open={!!request} onOpenChange={(open) => open || close()}>
      <AnimatePresence>
        {request && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay forceMount asChild>
              <m.div className="fixed inset-0 bg-backdrop" {...MOTION.fade} />
            </Dialog.Overlay>
            <Dialog.Content
              forceMount
              asChild
              aria-describedby={undefined}
              onOpenAutoFocus={focus.remember}
              onCloseAutoFocus={focus.restore}
            >
              <m.form
                className="fixed inset-0 m-auto flex h-fit max-h-[calc(100vh-32px)] w-[min(420px,calc(100vw-32px))] flex-col gap-12 scroll-inset overflow-y-auto rounded-xl border bg-panel pt-14 pr-2 pb-16 pl-16 text-text shadow-overlay"
                {...MOTION.pop}
                onSubmit={submit}
              >
                <Dialog.Title className="text-[16px] font-semibold">
                  {isNew ? `New ${CHAT_NOUN.one}` : `Rename ${CHAT_NOUN.one}`}
                </Dialog.Title>
                <label className="flex flex-col gap-4">
                  <span className="text-muted">Name</span>
                  <input
                    value={name}
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <div className="flex justify-end gap-8">
                  <Dialog.Close asChild>
                    <Button type="button">Cancel</Button>
                  </Dialog.Close>
                  <Button variant="primary" disabled={!connected || !name.trim()}>
                    {isNew ? 'Create' : 'Rename'}
                  </Button>
                </div>
              </m.form>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}

const FOOTER_ROW = 'flex h-control w-full items-center gap-8 px-8'

/** The sidebar's bottom row: Settings, with its shortcut on hover. New space sits under the spaces instead. */
export function SidebarFooter({ settingsKeys, openSettings }: { settingsKeys?: Binding | null; openSettings: () => void }) {
  return (
    <div className="flex flex-col gap-1 px-8 pb-10">
      <Hint text={settingsKeys && <Keys binding={settingsKeys} />} side="right">
        <Button variant="ghost" size="none" className={FOOTER_ROW} onClick={openSettings}>
          <span aria-hidden="true">⚙</span>
          Settings
        </Button>
      </Hint>
    </div>
  )
}
