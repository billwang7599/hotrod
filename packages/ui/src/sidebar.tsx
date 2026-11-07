import { useEffect, useRef, useState } from 'react'
import type { ClientMessage, Project } from '@hotrod/core/types'
import { MAIN_CHAT_ID, type ChatView } from './state.ts'

const CHAT_BUSY = 'Stop this chat first'
const PROJECT_BUSY = 'Stop the running chats in this project first'

type MenuItem = { label: string; run: () => void; danger?: boolean; disabledReason?: string }

function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!position) return
    const onPointer = (e: MouseEvent) => ref.current?.contains(e.target as Node) || setPosition(null)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPosition(null)
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [position])
  return (
    <div className={`row-menu ${position ? 'open' : ''}`} ref={ref}>
      <button
        className="ghost icon"
        aria-label={`More for ${label}`}
        aria-haspopup="menu"
        aria-expanded={!!position}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          setPosition(position ? null : { top: rect.bottom + 4, right: window.innerWidth - rect.right })
        }}
      >
        ⋯
      </button>
      {position && (
        <div className="menu" role="menu" style={position}>
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={item.danger ? 'danger' : ''}
              disabled={!!item.disabledReason}
              title={item.disabledReason}
              onClick={() => {
                setPosition(null)
                item.run()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
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
  const classes = [
    'chat-row',
    selected && 'selected',
    sub && 'sub',
    nested && 'nested',
    add && 'project-row',
    menu && 'has-menu',
  ]
  return (
    <div className={classes.filter(Boolean).join(' ')}>
      <button className="chat-link" title={title ?? label} onClick={select}>
        <span className={`dot ${chat.status}`} />
        <span className="chat-label">{label}</span>
        {chat.parentId && <span className="chat-tag">subagent</span>}
        {!add && <span className="chat-engine">{chat.engine}</span>}
      </button>
      {add && (
        <button
          className="ghost icon add-chat"
          aria-label={add.label}
          title={add.label}
          disabled={!!add.disabledReason}
          onClick={add.run}
        >
          +
        </button>
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
    const remove = () => {
      if (window.confirm(`Delete “${chat.title}”? Its messages are deleted from Hotrod.`)) {
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
    const remove = () => {
      const folder = `The folder ${project.path} stays on disk.`
      if (window.confirm(`Remove ${project.name} from Hotrod and delete its chats? ${folder}`)) send({ type: 'project.delete', projectId: project.id })
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
    <nav className="chat-nav">
      {main &&
        withSubagents(main, {
          label: 'Workshop',
          title: 'Workshop: not tied to a folder',
          menu: undefined,
          sub: false,
        })}
      {subchats().map((c) => withSubagents(c))}
      <button className="ghost small new-chat" disabled={!connected} onClick={() => send({ type: 'chat.create' })}>
        + New chat
      </button>

      <div className="nav-label">Projects</div>
      {activeProjects.length === 0 && <div className="nav-empty">No projects yet</div>}
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
        <details className="archived-group">
          <summary className="nav-label">
            <span className="disclosure" />
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
