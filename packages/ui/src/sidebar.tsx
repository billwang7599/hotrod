import { useState, type FormEvent } from 'react'
import { AnimatePresence, m } from 'motion/react'
import { Dialog, DropdownMenu } from 'radix-ui'
import type { ChatStatus, ClientMessage } from '@hotrod/core/shared'
import { Button, CHAT_NOUN, Chevron, confirm, Hint, MOTION, NAV_LABEL, useReturnFocus, useSettled } from './controls.tsx'
import { chatTree, familyOf, folderName, folderOf, type ChatView, type TreeRow } from './state.ts'

const CHAT_BUSY = `Stop this ${CHAT_NOUN.one} and the ones below it first`
const DOTS: Record<ChatStatus, string> = {
  idle: 'bg-faint',
  running: 'bg-green animate-blink',
  waiting: 'bg-amber',
  stopping: 'bg-amber',
}
const INDENTS = ['pl-8', 'pl-22', 'pl-36', 'pl-50']
const ROW_ACTION = 'hidden group-hover/row:block group-focus-within/row:block'

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

type RowProps = {
  row: TreeRow
  animate: boolean
  title: string
  selected: boolean
  showEngine: boolean
  select: () => void
  menu?: MenuItem[]
}

function ChatRow({ row: { chat, depth }, animate, title, selected, showEngine, select, menu }: RowProps) {
  const highlight = selected
    ? 'bg-raised text-text'
    : 'text-muted hover:bg-raised hover:text-text has-data-[state=open]:bg-raised has-data-[state=open]:text-text'
  const engineHidden = menu
    ? 'group-hover/row:hidden group-focus-within/row:hidden group-has-data-[state=open]/row:hidden'
    : ''
  return (
    <m.div
      className={`group/row relative flex shrink-0 items-center rounded transition-colors ${highlight}`}
      {...MOTION.collapse}
      initial={animate && MOTION.collapse.initial}
    >
      <button
        className={`flex h-control min-w-0 flex-1 items-center gap-8 pr-8 text-left whitespace-nowrap ${INDENTS[Math.min(depth, INDENTS.length - 1)]}`}
        title={title}
        onClick={select}
      >
        <span className={`size-7 shrink-0 rounded-full ${DOTS[chat.status]}`} />
        <span className="min-w-0 flex-1 truncate">{chat.name}</span>
        {chat.subagent && <span className="rounded border px-5 text-xs text-muted">subagent</span>}
        {showEngine && <span className={`text-xs text-faint ${engineHidden}`}>{chat.engine}</span>}
      </button>
      {menu && <RowMenu label={chat.name} items={menu} />}
    </m.div>
  )
}

export type NameRequest = { kind: 'new' } | { kind: 'rename'; chatId: string; name: string }

type SidebarProps = {
  chats: ChatView[]
  selectedId: string
  connected: boolean
  send: (m: ClientMessage) => void
  select: (chatId: string) => void
  askName: (request: NameRequest) => void
}

export function ChatNav({ chats, selectedId, connected, send, select, askName }: SidebarProps) {
  const offline = connected ? undefined : 'Disconnected from the core'
  const settled = useSettled(chats.length > 0)
  const tree = chatTree(chats)
  const mixedEngines = new Set(chats.map((c) => c.engine)).size > 1

  const chatMenu = (chat: ChatView): MenuItem[] => {
    const family = familyOf(chats, chat.id)
    const disabledReason = offline ?? (family.some((c) => c.status !== 'idle') ? CHAT_BUSY : undefined)
    const remove = async () => {
      const below = family.length > 1 ? ' and everything below it' : ''
      const work = chat.workDir ? ` Its work folder goes too (${chat.workDir}); its git branches stay.` : ''
      const text =
        `Delete “${chat.name}”${below}? Messages are deleted from Hotrod; your folders and files stay on disk.` + work
      if (await confirm(text)) send({ type: 'chat.delete', chatId: chat.id })
    }
    return [
      {
        label: 'Rename…',
        disabledReason: offline,
        run: () => askName({ kind: 'rename', chatId: chat.id, name: chat.name }),
      },
      {
        label: chat.archived ? 'Unarchive' : 'Archive',
        disabledReason,
        run: () => send({ type: 'chat.archive', chatId: chat.id, archived: !chat.archived }),
      },
      { label: 'Delete…', danger: true, disabledReason, run: remove },
    ]
  }
  const row = (row: TreeRow) => {
    const { chat } = row
    const folder = folderOf(chats, chat) ?? 'Not tied to a folder'
    return (
      <ChatRow
        key={chat.id}
        row={row}
        animate={settled.current}
        title={`${chat.name}: ${folder}`}
        selected={chat.id === selectedId}
        showEngine={mixedEngines}
        select={() => select(chat.id)}
        menu={chat.mod ? undefined : chatMenu(chat)}
      />
    )
  }

  return (
    <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-8 pb-8">
      <AnimatePresence>{tree.active.map(row)}</AnimatePresence>
      <Button
        variant="ghost"
        size="small"
        className="mt-2 ml-14 self-start"
        disabled={!connected}
        onClick={() => askName({ kind: 'new' })}
      >
        + New {CHAT_NOUN.one}
      </Button>

      {tree.archived.length > 0 && (
        <details className="group mt-auto">
          <summary className={`list-none ${NAV_LABEL}`}>
            <Chevron />
            Archived ({tree.archived.filter((r) => r.depth === 0).length})
          </summary>
          <AnimatePresence>{tree.archived.map(row)}</AnimatePresence>
        </details>
      )}
    </nav>
  )
}

type NameDialogProps = {
  request: NameRequest | null
  connected: boolean
  send: (m: ClientMessage) => void
  pickFolder?: () => Promise<string | null>
  close: () => void
}

export function NameDialog({ request, connected, send, pickFolder, close }: NameDialogProps) {
  const [shown, setShown] = useState<NameRequest | null>(null)
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  if (request && request !== shown) {
    setShown(request)
    setName(request.kind === 'rename' ? request.name : '')
    setFolder('')
  }
  const focus = useReturnFocus()
  const isNew = shown?.kind === 'new'
  const choose = async () => {
    const picked = await pickFolder?.()
    if (!picked) return
    setFolder(picked)
    if (!name.trim()) setName(folderName(picked))
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!request || !connected || !name.trim()) return
    if (request.kind === 'rename') send({ type: 'chat.rename', chatId: request.chatId, name })
    else send({ type: 'chat.create', name, ...(folder.trim() && { folders: [folder.trim()] }) })
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
                className="fixed inset-0 m-auto flex h-fit max-h-[calc(100vh-32px)] w-[min(420px,calc(100vw-32px))] flex-col gap-12 overflow-y-auto rounded-xl border bg-panel px-16 pt-14 pb-16 text-text shadow-overlay"
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
                {isNew && (
                  <label className="flex flex-col gap-4">
                    <Hint
                      text={`Its agents read this folder; a git folder is checked out in the work folder for them`}
                      side="right"
                    >
                      <span className="w-fit text-muted">
                        Folder <span className="text-faint">(optional)</span>
                      </span>
                    </Hint>
                    <span className="flex gap-6">
                      <input
                        className="flex-1 font-mono text-sm"
                        value={folder}
                        placeholder="/path/to/folder"
                        spellCheck={false}
                        onChange={(e) => setFolder(e.target.value)}
                      />
                      {pickFolder && (
                        <Button type="button" onClick={() => void choose()}>
                          Choose…
                        </Button>
                      )}
                    </span>
                  </label>
                )}
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
