import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { AnimatePresence, m } from 'motion/react'
import {
  ASK_FIRST_COMMANDS,
  CONTEXT_SECTIONS,
  GLOBAL_CONTEXT,
  PERMISSION_SWITCHES,
  switchedOn,
  type ClientMessage,
  type ContextItem,
  type ContextSection,
  type PermissionSwitch,
  type WorkFolder,
  type Worktree,
} from '@hotrod/core/shared'
import { Button, CHAT_NOUN, Chevron, Hint, MOTION, PanelToggle, Select, Switch, useSettled } from './controls.tsx'
import { usePathsShown } from './paths.ts'
import { folderName, PANEL_PX, type ChatView } from './state.ts'

export const SECTIONS: Record<ContextSection, { label: string; about: string; inherited: string }> = {
  agents: {
    label: 'AGENTS.md',
    about: 'Instructions: the global ones first, then each chat’s from the top down',
    inherited: 'The global AGENTS.md, and for a subagent, its parent’s',
  },
  folders: {
    label: 'Folders',
    about:
      'Each folder’s AGENTS.md is read in. Agents read folders but don’t write them: a git folder is checked out ' +
      'in the work folder on a branch of its own, and they work there',
    inherited: `The folders of the ${CHAT_NOUN.many} above, with their AGENTS.md`,
  },
  files: {
    label: 'Files',
    about: 'Text is pasted in full into the instructions; other files go by path',
    inherited: `The files of the ${CHAT_NOUN.many} above`,
  },
}
export const PERMISSIONS: Record<PermissionSwitch, { label: string; about: string; amberWhileOn?: true }> = {
  editAnywhere: {
    label: 'Allow edits outside the work folder',
    about:
      'On: no sandbox, and edits outside the work folder ask you first. Off: agents write only in the chat’s ' +
      'folder in the work folder, and edits elsewhere are denied. From the chat’s next message.',
    amberWhileOn: true,
  },
  autoRunCommands: {
    label: 'Run commands without asking',
    about:
      'Agents run shell commands without asking you first, but only while the chat is sandboxed: with edits ' +
      'anywhere on, or on a system Hotrod can’t sandbox, every command asks.',
  },
  askNetworkCommands: {
    label: 'Still ask before commands that publish or reach the network',
    about:
      `Commands that mention ${ASK_FIRST_COMMANDS.join(', ')} ask you first, even while commands run without ` +
      'asking.',
  },
}
const PERMISSIONS_HINT =
  'Default follows Settings → Work folder. Each choice is for this chat only; its subagents follow their own.'
const EMPTY_SECTION: Record<ContextSection, string> = {
  agents: '',
  folders: 'No folders.',
  files: 'No files.',
}
const GLOBAL_SOURCE = 'Global'
const GLOBAL_HINT = 'Every chat gets this. Editing it here changes it everywhere.'
const CHAT_INTRO = 'Each message gets the items that are on, the global AGENTS.md first.'
const PILL = 'shrink-0 rounded-full bg-raised px-8 py-2 text-xs font-normal text-muted'
const CHECKOUT_HINT =
  'A git worktree made from the folder’s last commit, so changes you haven’t committed aren’t in it. Agents work ' +
  'and commit there; the branch stays when the space is deleted.'
const COLLAPSED_KEY = 'hotrod.contextCollapsed'
const PREVIEW = 'max-h-160 overflow-auto rounded border bg-bg px-8 py-6 font-mono text-xs whitespace-pre-wrap text-muted'

type ItemProps = {
  item: ContextItem
  chatId: string
  source: string
  readOnly: boolean
  send: (m: ClientMessage) => void
}

function useCollapsed(item: ContextItem) {
  const key = item.from === GLOBAL_CONTEXT ? GLOBAL_CONTEXT : item.path
  const saved = (): string[] => {
    try {
      const keys = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
      return Array.isArray(keys) ? keys : []
    } catch {
      return []
    }
  }
  const [collapsed, setCollapsed] = useState(() => saved().includes(key))
  const toggle = () => {
    const others = saved().filter((k) => k !== key)
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed ? others : [...others, key]))
    setCollapsed(!collapsed)
  }
  return { collapsed, toggle }
}

function CardToggle({ name, collapsed, toggle }: { name: string; collapsed: boolean; toggle: () => void }) {
  return (
    <button
      className="group flex min-w-0 items-center gap-6 text-left font-semibold"
      aria-expanded={!collapsed}
      aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${name}`}
      data-open={!collapsed || undefined}
      onClick={toggle}
    >
      <Chevron />
      <span className="truncate">{name}</span>
    </button>
  )
}

function CardBody({ collapsed, className, children }: { collapsed: boolean; className: string; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {!collapsed && (
        <m.div {...MOTION.collapse}>
          <div className={`flex flex-col ${className}`}>{children}</div>
        </m.div>
      )}
    </AnimatePresence>
  )
}

function AgentsCard({ item, chatId, source, readOnly, send }: ItemProps) {
  const [text, setText] = useState(item.text)
  useEffect(() => setText(item.text), [item.text])
  const { collapsed, toggle } = useCollapsed(item)
  const paths = usePathsShown()
  const own = item.from === chatId
  const global = item.from === GLOBAL_CONTEXT
  const writable = own || global
  const dim = item.enabled ? '' : 'opacity-55'
  return (
    <div className={`mb-8 flex flex-col rounded-lg border p-10 ${item.enabled ? 'bg-bg shadow-raised' : ''}`}>
      <div className="flex items-center justify-between gap-8">
        <span className={`flex min-w-0 items-center gap-6 ${dim}`}>
          <CardToggle name={source} collapsed={collapsed} toggle={toggle} />
          <Hint text={global && GLOBAL_HINT}>
            <span className={PILL}>{own ? 'Own' : global ? 'Every chat' : 'Read-only here'}</span>
          </Hint>
        </span>
        <Switch
          label={`Use the AGENTS.md of ${source}`}
          checked={item.enabled}
          disabled={readOnly}
          onChange={(enabled) => send({ type: 'context.set', chatId, path: item.path, enabled })}
        />
      </div>
      <CardBody collapsed={collapsed} className="gap-6 pt-6">
        {paths.context && (
          <span className="font-mono text-xs leading-[normal] wrap-anywhere text-faint" title={item.path}>
            {item.path}
          </span>
        )}
        <textarea
          className={`resize-y px-8 py-6 font-mono text-sm leading-[1.5] focus:border-accent read-only:bg-transparent read-only:text-muted ${writable ? 'min-h-96' : 'min-h-36'} ${dim}`}
          value={text}
          rows={writable ? 6 : 2}
          spellCheck={false}
          readOnly={!writable || readOnly}
          aria-label={`AGENTS.md of ${source}`}
          placeholder={
            global
              ? 'Empty. Instructions written here go to every chat.'
              : own
                ? 'Empty. Instructions written here go to the engine.'
                : 'Empty'
          }
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            if (text === item.text) return
            send(global ? { type: 'instructions.write', text } : { type: 'context.write', chatId: item.from, text })
          }}
        />
      </CardBody>
    </div>
  )
}

function PathCard({ item, chatId, source, readOnly, send, worktree }: ItemProps & { worktree?: Worktree }) {
  const own = item.from === chatId
  const section = item.section === 'folders' ? 'folders' : 'files'
  const preview = item.section === 'folders' ? 'AGENTS.md' : 'Contents'
  const { collapsed, toggle } = useCollapsed(item)
  const paths = usePathsShown()
  return (
    <div className={`mb-8 flex flex-col rounded-lg border px-10 py-8 ${item.enabled ? 'bg-bg shadow-raised' : ''}`}>
      <div className="flex items-center gap-8">
        <span className={`flex min-w-0 flex-1 ${item.enabled ? '' : 'opacity-55'}`}>
          <Hint text={!paths.context && item.path} align="start">
            <span className="flex min-w-0">
              <CardToggle name={folderName(item.path)} collapsed={collapsed} toggle={toggle} />
            </span>
          </Hint>
        </span>
        {own && (
          <Hint text="Remove from this chat's context">
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${item.path}`}
              disabled={readOnly}
              onClick={() => send({ type: 'context.remove', chatId, section, path: item.path })}
            >
              ×
            </Button>
          </Hint>
        )}
        <Switch
          label={`Use ${item.path}`}
          checked={item.enabled}
          disabled={readOnly}
          onChange={(enabled) => send({ type: 'context.set', chatId, path: item.path, enabled })}
        />
      </div>
      <CardBody collapsed={collapsed} className="gap-4 pt-4">
        {paths.context && (
          <span className="font-mono text-xs leading-[normal] wrap-anywhere text-faint" title={item.path}>
            {item.path}
          </span>
        )}
        {worktree && (
          <Hint text={CHECKOUT_HINT} align="start">
            <span className="w-fit text-xs leading-[normal] wrap-anywhere text-muted">
              Checked out at <span className="font-mono">{worktree.path}</span> on{' '}
              <span className="font-mono">{worktree.branch}</span>
            </span>
          </Hint>
        )}
        <div className="flex items-start gap-6 text-xs text-faint">
          <span className={PILL}>{own ? 'Own' : `From ${source}`}</span>
          {item.section === 'files' && (
            <Hint text={item.binary && 'Not text, so the engine gets its path and opens it'}>
              <span className={PILL}>{item.binary ? 'By path' : 'Pasted in full'}</span>
            </Hint>
          )}
          {item.binary ? null : item.text.trim() ? (
            <details className="group min-w-0 flex-1">
              <summary className="flex w-fit list-none items-center gap-4 py-2 hover:text-text">
                <Chevron />
                {preview}
              </summary>
              <pre className={PREVIEW}>{item.text}</pre>
            </details>
          ) : (
            <span className="py-2">{item.section === 'folders' ? 'No AGENTS.md' : 'Empty'}</span>
          )}
        </div>
      </CardBody>
    </div>
  )
}

function AddPath({ section, chatId, disabled, send }: {
  section: 'folders' | 'files'
  chatId: string
  disabled: boolean
  send: (m: ClientMessage) => void
}) {
  const [path, setPath] = useState('')
  const what = section === 'folders' ? 'folder' : 'file'
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (disabled || !path.trim()) return
    send({ type: 'context.add', chatId, section, path: path.trim() })
    setPath('')
  }
  return (
    <form className="flex gap-6" onSubmit={submit}>
      <input
        className="flex-1 font-mono text-sm"
        aria-label={`Add a ${what}`}
        placeholder={section === 'folders' ? '/path/to/folder' : '/path/to/file.md'}
        value={path}
        spellCheck={false}
        disabled={disabled}
        onChange={(e) => setPath(e.target.value)}
      />
      <Button disabled={disabled || !path.trim()}>Add {what}</Button>
    </form>
  )
}

type PanelTabId = 'context' | 'permissions'
const TAB_KEY = 'hotrod.panelTab'
const TAB_LABEL: Record<PanelTabId, string> = { context: 'Context', permissions: 'Permissions' }

type PanelTabProps = {
  id: PanelTabId
  tab: PanelTabId
  choose: (id: PanelTabId) => void
  hint: string
  children: ReactNode
}

function PanelTab(props: PanelTabProps) {
  const selected = props.id === props.tab
  return (
    <Hint text={props.hint} side="bottom" align="start">
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        className="rounded px-8 py-4 font-semibold text-muted transition-[background-color,color] hover:bg-hover hover:text-text aria-selected:bg-hover aria-selected:text-text"
        onClick={() => props.choose(props.id)}
      >
        {props.children}
      </button>
    </Hint>
  )
}

type ContextPanelProps = {
  chatId: string
  items?: ContextItem[]
  chats: ChatView[]
  workFolder: WorkFolder
  readOnly: boolean
  connected: boolean
  send: (m: ClientMessage) => void
  hide?: () => void
}

export function ContextPanel({ chatId, items, chats, workFolder, readOnly, connected, send, hide }: ContextPanelProps) {
  const settled = useSettled(items !== undefined)
  const locked = readOnly || !connected
  const sourceOf = (item: ContextItem) =>
    item.from === GLOBAL_CONTEXT ? GLOBAL_SOURCE : (chats.find((c) => c.id === item.from)?.name ?? item.from)
  const chat = chats.find((c) => c.id === chatId)
  const sections: readonly ContextSection[] = chat?.mod ? ['agents'] : CONTEXT_SECTIONS
  const intro = chat?.mod ? `${chat.name} keeps no folders, files or AGENTS.md of its own.` : CHAT_INTRO
  const [tab, setTab] = useState<PanelTabId>(() =>
    localStorage.getItem(TAB_KEY) === 'permissions' ? 'permissions' : 'context',
  )
  const chooseTab = (id: PanelTabId) => {
    localStorage.setItem(TAB_KEY, id)
    setTab(id)
  }
  const shown: PanelTabId = chat ? tab : 'context'
  return (
    <aside className="flex shrink-0 flex-col border-l bg-panel" style={{ width: PANEL_PX.context }} aria-label="Context">
      <header className="flex h-44 shrink-0 items-center justify-between gap-8 border-b px-12">
        <div role="tablist" aria-label="Panel" className="flex items-center gap-2">
          <PanelTab id="context" tab={tab} choose={chooseTab} hint={`${intro} Edits apply from the next message.`}>
            Context
          </PanelTab>
          {chat && (
            <PanelTab id="permissions" tab={tab} choose={chooseTab} hint={PERMISSIONS_HINT}>
              Permissions
            </PanelTab>
          )}
        </div>
        {hide && <PanelToggle side="right" label="Context panel" noun="context" open toggle={hide} />}
      </header>
      <div className="flex flex-1 flex-col gap-18 overflow-y-auto p-12" role="tabpanel" aria-label={TAB_LABEL[shown]}>
        {shown === 'permissions' && chat && (
          <section className="flex flex-col gap-8" aria-label="Permissions">
            {PERMISSION_SWITCHES.map((name) => {
              const { label, about, amberWhileOn } = PERMISSIONS[name]
              const chosen = chat[name]
              const amber = amberWhileOn && switchedOn(name, chat, workFolder)
              return (
                <Hint key={name} text={about} align="start">
                  <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-6 rounded-lg border px-10 py-8">
                    <span className={`min-w-0 flex-1 ${amber ? 'text-amber' : ''}`}>{label}</span>
                    <Select
                      label={label}
                      value={chosen === undefined ? 'default' : chosen ? 'on' : 'off'}
                      disabled={locked}
                      options={[
                        { value: 'default', label: `Default (${switchedOn(name, workFolder) ? 'On' : 'Off'})` },
                        { value: 'on', label: 'On' },
                        { value: 'off', label: 'Off' },
                      ]}
                      onChange={(value) =>
                        send({
                          type: 'chat.setPermission',
                          chatId,
                          name,
                          ...(value !== 'default' && { enabled: value === 'on' }),
                        })
                      }
                    />
                  </div>
                </Hint>
              )
            })}
          </section>
        )}
        {shown === 'context' &&
          sections.map((section) => {
            const listed = items?.filter((item) => item.section === section) ?? []
            return (
              <section key={section} className="flex flex-col" aria-label={SECTIONS[section].label}>
                <Hint text={SECTIONS[section].about} align="start">
                  <h3 className="mb-8 w-fit font-semibold">{SECTIONS[section].label}</h3>
                </Hint>
                <AnimatePresence initial={false}>
                  {listed.map((item) => (
                    <m.div key={item.path} {...MOTION.collapse} initial={settled.current && MOTION.collapse.initial}>
                      {section === 'agents' ? (
                        <AgentsCard item={item} chatId={chatId} source={sourceOf(item)} readOnly={locked} send={send} />
                      ) : (
                        <PathCard
                          item={item}
                          chatId={chatId}
                          source={sourceOf(item)}
                          readOnly={locked}
                          send={send}
                          worktree={chats.find((c) => c.id === item.from)?.worktrees?.[item.path]}
                        />
                      )}
                    </m.div>
                  ))}
                </AnimatePresence>
                {items && !listed.length && <p className="mb-8 text-sm text-faint">{EMPTY_SECTION[section]}</p>}
                {section !== 'agents' && <AddPath section={section} chatId={chatId} disabled={locked} send={send} />}
              </section>
            )
          })}
      </div>
    </aside>
  )
}
