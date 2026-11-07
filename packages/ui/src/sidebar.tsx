import { DropdownMenu } from 'radix-ui'
import type { ChatStatus, ClientMessage, Project } from '@hotrod/core/types'
import { Button, Chevron, confirm, NAV_LABEL } from './controls.tsx'
import { MAIN_CHAT_ID, type ChatView } from './state.ts'

const CHAT_BUSY = 'Stop this chat first'
const PROJECT_BUSY = 'Stop the running chats in this project first'
const DOTS: Record<ChatStatus, string> = {
  idle: 'bg-faint',
  running: 'bg-green animate-blink',
  waiting: 'bg-amber',
  stopping: 'bg-amber',
}
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
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-20 flex min-w-140 flex-col rounded-lg border bg-panel p-4 shadow outline-none"
        >
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.label}
              disabled={!!item.disabledReason}
              title={item.disabledReason}
              onSelect={item.run}
              className={`flex h-26 cursor-pointer items-center rounded px-12 text-sm whitespace-nowrap outline-none data-disabled:cursor-default data-disabled:text-faint ${item.danger ? 'text-red data-highlighted:bg-red/10' : 'data-highlighted:bg-raised'}`}
            >
              {item.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

type RowProps = {
  chat: ChatView
  label: string
  title?: string
  selected: boolean
  sub?: boolean
  nested?: boolean
  select: () => void
  add?: MenuItem
  menu?: MenuItem[]
}

function ChatRow({ chat, label, title, selected, sub, nested, select, add, menu }: RowProps) {
  const highlight = selected
    ? 'bg-raised text-text'
    : 'text-muted hover:bg-raised hover:text-text has-data-[state=open]:bg-raised has-data-[state=open]:text-text'
  const engineHidden = menu
    ? 'group-hover/row:hidden group-focus-within/row:hidden group-has-data-[state=open]/row:hidden'
    : ''
  return (
    <div className={`group/row relative flex shrink-0 items-center rounded ${highlight}`}>
      <button
        className={`flex h-control min-w-0 flex-1 items-center gap-8 pr-8 text-left whitespace-nowrap ${nested ? 'pl-36' : sub ? 'pl-22' : 'pl-8'} ${add ? 'font-medium text-text' : ''}`}
        title={title ?? label}
        onClick={select}
      >
        <span className={`size-7 shrink-0 rounded-full ${DOTS[chat.status]}`} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {chat.parentId && <span className="rounded border px-5 text-xs text-muted">subagent</span>}
        {!add && <span className={`text-xs text-faint ${engineHidden}`}>{chat.engine}</span>}
      </button>
      {add && (
        <Button
          variant="ghost"
          size="icon"
          className={ROW_ACTION}
          aria-label={add.label}
          title={add.label}
          disabled={!!add.disabledReason}
          onClick={add.run}
        >
          +
        </Button>
      )}
      {menu && <RowMenu label={label} items={menu} />}
    </div>
  )
}

const newestFirst = (a: ChatView, b: ChatView) => b.createdAt.localeCompare(a.createdAt)

type SidebarProps = {
  projects: Project[]
  chats: ChatView[]
  selectedId: string
  connected: boolean
  send: (m: ClientMessage) => void
  select: (chatId: string) => void
}

export function ChatNav({ projects, chats, selectedId, connected, send, select }: SidebarProps) {
  const main = chats.find((c) => c.id === MAIN_CHAT_ID)
  const shown = (c: ChatView) => !c.archived && !projects.find((p) => p.id === c.projectId)?.archived
  const hasShownParent = (c: ChatView) => chats.some((p) => p.id === c.parentId && shown(p))
  const subchats = (projectId?: string) =>
    chats.filter((c) => !c.main && shown(c) && c.projectId === projectId && !hasShownParent(c)).sort(newestFirst)
  const projectBusy = (id: string) => chats.some((c) => c.projectId === id && c.status !== 'idle')
  const offline = connected ? undefined : 'Disconnected from the core'

  const chatMenu = (chat: ChatView): MenuItem[] => {
    const disabledReason = offline ?? (chat.status !== 'idle' ? CHAT_BUSY : undefined)
    const remove = async () => {
      if (await confirm(`Delete “${chat.title}”? Its messages are deleted from Hotrod.`)) {
        send({ type: 'chat.delete', chatId: chat.id })
      }
    }
    return [
      {
        label: chat.archived ? 'Unarchive' : 'Archive',
        disabledReason,
        run: () => send({ type: 'chat.archive', chatId: chat.id, archived: !chat.archived }),
      },
      { label: 'Delete…', danger: true, disabledReason, run: remove },
    ]
  }
  const projectMenu = (project: Project): MenuItem[] => {
    const disabledReason = offline ?? (projectBusy(project.id) ? PROJECT_BUSY : undefined)
    const remove = async () => {
      const folder = `The folder ${project.path} stays on disk.`
      if (await confirm(`Remove ${project.name} from Hotrod and delete its chats? ${folder}`)) send({ type: 'project.delete', projectId: project.id })
    }
    return [
      {
        label: project.archived ? 'Unarchive' : 'Archive',
        disabledReason,
        run: () => send({ type: 'project.archive', projectId: project.id, archived: !project.archived }),
      },
      { label: 'Delete…', danger: true, disabledReason, run: remove },
    ]
  }
  const row = (chat: ChatView, props: Partial<RowProps> = {}) => (
    <ChatRow
      key={chat.id}
      chat={chat}
      label={chat.title}
      selected={chat.id === selectedId}
      select={() => select(chat.id)}
      menu={chatMenu(chat)}
      sub
      {...props}
    />
  )
  const withSubagents = (chat: ChatView, props: Partial<RowProps> = {}) => [
    row(chat, props),
    ...chats
      .filter((c) => c.parentId === chat.id && !c.archived)
      .sort(newestFirst)
      .map((c) => row(c, { nested: true })),
  ]

  const activeProjects = projects.filter((p) => !p.archived)
  const archivedProjects = projects.filter((p) => p.archived)
  const archivedChats = chats
    .filter((c) => c.archived && !projects.find((p) => p.id === c.projectId)?.archived)
    .sort(newestFirst)
  const placeOf = (chat: ChatView) => projects.find((p) => p.id === chat.projectId)?.name ?? 'Workshop'

  return (
    <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-8 pb-8">
      {main &&
        withSubagents(main, {
          label: 'Workshop',
          title: 'Workshop: not tied to a folder',
          menu: undefined,
          sub: false,
        })}
      {subchats().map((c) => withSubagents(c))}
      <Button
        variant="ghost"
        size="small"
        className="mt-2 ml-14 self-start"
        disabled={!connected}
        onClick={() => send({ type: 'chat.create' })}
      >
        + New chat
      </Button>

      <div className={NAV_LABEL}>Projects</div>
      {activeProjects.length === 0 && <div className="px-8 py-2 text-sm text-faint">No projects yet</div>}
      {activeProjects.map((project) => {
        const projectMain = chats.find((c) => c.projectId === project.id && c.main)
        return (
          projectMain && (
            <section key={project.id}>
              {withSubagents(projectMain, {
                label: project.name,
                title: project.path,
                sub: false,
                add: {
                  label: `New chat in ${project.name}`,
                  disabledReason: offline,
                  run: () => send({ type: 'chat.create', projectId: project.id }),
                },
                menu: projectMenu(project),
              })}
              {subchats(project.id).map((c) => withSubagents(c))}
            </section>
          )
        )
      })}

      {(archivedProjects.length > 0 || archivedChats.length > 0) && (
        <details className="group mt-auto">
          <summary className={`list-none ${NAV_LABEL}`}>
            <Chevron />
            Archived ({archivedProjects.length + archivedChats.length})
          </summary>
          {archivedProjects.map((project) => {
            const projectMain = chats.find((c) => c.projectId === project.id && c.main)
            return (
              projectMain && (
                <ChatRow
                  key={project.id}
                  chat={projectMain}
                  label={project.name}
                  title={`${project.path} (archived project)`}
                  selected={chats.some((c) => c.projectId === project.id && c.id === selectedId)}
                  select={() => select(projectMain.id)}
                  menu={projectMenu(project)}
                />
              )
            )
          })}
          {archivedChats.map((c) => row(c, { title: `${c.title} (in ${placeOf(c)})`, sub: false }))}
        </details>
      )}
    </nav>
  )
}
