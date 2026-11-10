import { useEffect, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react'
import { AnimatePresence, m } from 'motion/react'
import {
  ASK_FIRST_COMMANDS,
  CONTEXT_SECTIONS,
  GLOBAL_CONTEXT,
  PERMISSION_SWITCHES,
  switchedOn,
  type ClientMessage,
  type CommandInfo,
  type ContextItem,
  type ContextSection,
  type PanelTab as ExtensionTab,
  type PermissionSwitch,
  type Setup,
  type WorkFolder,
  type Worktree,
} from '@kothar/core/shared'
import { Button, CHAT_NOUN, Chevron, Hint, MOTION, PanelToggle, Select, Switch, useSettled } from './controls.tsx'
import { usePathsShown } from './paths.ts'
import { showReportsIn, showStepsIn, useReportsShown, useStepsShown } from './steps.ts'
import { ResizeHandle, usePanelWidth } from './panel-width.tsx'
import { PanelTabs, type TabEntry } from './panel-tabs.tsx'
import { ExtensionViewer } from './extension-view.tsx'
import { SETUP_HINT } from './setups-page.tsx'
import { choosePanelTab, extensionTabId, usePanelTab } from './panel-tab.ts'
import { folderName, lineOf, panelKey, terminalKey, type ChatView, type State } from './state.ts'

export const SECTIONS: Record<ContextSection, { label: string; about: string; inherited: string }> = {
  agents: {
    label: 'AGENTS.md',
    about: 'Instructions: the global ones first, then each chat’s from the top down',
    inherited: 'The global AGENTS.md, and for a worker, its parent’s',
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
      'anywhere on, or on a system Kothar can’t sandbox, every command asks but plain reads.',
  },
  autoNetworkCommands: {
    label: 'Run network commands without asking',
    about:
      `Agents also run commands that publish or reach the network (${ASK_FIRST_COMMANDS.join(', ')}) without ` +
      'asking you first. Only matters while Run commands without asking is on; off, those commands ask.',
  },
  autoFetch: {
    label: 'Fetch web pages without asking',
    about: 'Agents read web pages and search the web without asking you first.',
  },
  autoRead: {
    label: 'Read anywhere without asking',
    about:
      'Agents read and search files outside the work folder, and run commands that only read (ls, cat, grep, ' +
      'git status, git log…), without asking, sandboxed or not. Logins and keys still ask: ~/.ssh, ~/.aws, ' +
      '~/.gnupg, ~/.config/gh, Keychains, .netrc, .env files and Kothar’s saved accounts.',
  },
}
const PERMISSIONS_HINT =
  'Each shows Settings → Work folder until you pick, or for a worker, its space. A pick is for this chat only.'
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
const COLLAPSED_KEY = 'kothar.contextCollapsed'
const PREVIEW = 'scroll-inset scroll-inset-tight max-h-160 overflow-auto rounded border bg-bg px-8 py-6 font-mono text-xs whitespace-pre-wrap text-muted'

type ItemProps = {
  item: ContextItem
  chatId: string
  source: string
  readOnly: boolean
  send: (m: ClientMessage) => void
}

type TerminalErrors = State['terminalErrors']

function TerminalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="M4.5 6.25 6.75 8 4.5 9.75M8.5 10h3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Opens the user's terminal app at a folder; the core does it, so it works in a browser tab too. */
function TerminalButton({ chatId, path, what, disabled, send }: {
  chatId: string
  path: string
  what: string
  disabled?: boolean
  send: (m: ClientMessage) => void
}) {
  return (
    <Hint text="Open in Terminal">
      <Button
        variant="ghost"
        size="icon"
        className="grid place-items-center"
        aria-label={`Open ${what} in Terminal`}
        disabled={disabled}
        onClick={() => send({ type: 'terminal.open', chatId, path })}
      >
        <TerminalIcon />
      </Button>
    </Hint>
  )
}

function TerminalError({ chatId, path, errors }: { chatId: string; path: string; errors?: TerminalErrors }) {
  const error = errors?.[terminalKey(chatId, path)]
  return error ? <p className="text-xs leading-[normal] wrap-anywhere text-red">{error}</p> : null
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
  const [was, setWas] = useState(item.text)
  if (item.text !== was) {
    setWas(item.text)
    setText(item.text)
  }
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

function PathCard({
  item,
  chatId,
  source,
  readOnly,
  send,
  worktree,
  terminalErrors,
  connected,
}: ItemProps & { worktree?: Worktree; terminalErrors?: TerminalErrors; connected: boolean }) {
  const folder = item.section === 'folders'
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
        {folder && (
          <TerminalButton chatId={chatId} path={item.path} what={item.path} disabled={!connected} send={send} />
        )}
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
      {folder && <TerminalError chatId={chatId} path={item.path} errors={terminalErrors} />}
      <CardBody collapsed={collapsed} className="gap-4 pt-4">
        {paths.context && (
          <span className="font-mono text-xs leading-[normal] wrap-anywhere text-faint" title={item.path}>
            {item.path}
          </span>
        )}
        {worktree && (
          <div className="flex items-center gap-4">
            <Hint text={CHECKOUT_HINT} align="start">
              <span className="min-w-0 text-xs leading-[normal] wrap-anywhere text-muted">
                Checked out at <span className="font-mono">{worktree.path}</span> on{' '}
                <span className="font-mono">{worktree.branch}</span>
              </span>
            </Hint>
            <TerminalButton
              chatId={chatId}
              path={worktree.path}
              what={`the checkout ${worktree.path}`}
              disabled={!connected}
              send={send}
            />
          </div>
        )}
        {worktree && <TerminalError chatId={chatId} path={worktree.path} errors={terminalErrors} />}
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

/** What the desktop app adds: the system's own folder and file pickers, and real paths for dropped files. */
export type Pickers = {
  pickFolder(title?: string): Promise<string | null>
  pickFiles(title?: string): Promise<string[]>
  pathForFile(file: File): string
}

const carriesFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')

/** Paths dropped from the file manager, sorted into folders and files. An item that can't tell is a file. */
export function droppedPaths(data: DataTransfer, pathForFile: Pickers['pathForFile']) {
  const found: Record<'folders' | 'files', string[]> = { folders: [], files: [] }
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    const path = file && pathForFile(file)
    if (!path) continue
    found[item.webkitGetAsEntry?.()?.isDirectory ? 'folders' : 'files'].push(path)
  }
  return found
}

function AddPath({ section, chatId, disabled, send, pickers }: {
  section: 'folders' | 'files'
  chatId: string
  disabled: boolean
  send: (m: ClientMessage) => void
  pickers?: Pickers
}) {
  const [path, setPath] = useState('')
  // In the desktop app the system picker comes first and typing is the fallback; a browser tab can only type.
  const [typing, setTyping] = useState(!pickers)
  const what = section === 'folders' ? 'folder' : 'file'
  const add = (path: string) => send({ type: 'context.add', chatId, section, path })
  const closeTyping = () => {
    setPath('')
    if (pickers) setTyping(false)
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (disabled || !path.trim()) return
    add(path.trim())
    closeTyping()
  }
  const pick = async () => {
    if (!pickers) return
    if (section === 'files') {
      for (const picked of await pickers.pickFiles('Add files')) add(picked)
      return
    }
    const picked = await pickers.pickFolder('Add a folder')
    if (picked) add(picked)
  }
  const form = typing && (
    <form className="flex gap-6" onSubmit={submit}>
      <input
        className="min-w-0 flex-1 font-mono text-sm"
        aria-label={`Add a ${what} by path`}
        placeholder={section === 'folders' ? '/path/to/folder' : '/path/to/file.md'}
        value={path}
        spellCheck={false}
        disabled={disabled}
        autoFocus={!!pickers}
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && pickers && (e.preventDefault(), closeTyping())}
      />
      <Button disabled={disabled || !path.trim()}>{pickers ? 'Add' : `Add ${what}`}</Button>
    </form>
  )
  if (!pickers) return form
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-6">
        <Hint text={`Or drag ${section} from your file manager onto this panel`} align="start">
          <Button type="button" disabled={disabled} onClick={() => void pick()}>
            {section === 'folders' ? 'Add folder…' : 'Add files…'}
          </Button>
        </Hint>
        <Button
          type="button"
          variant="ghost"
          size="small"
          className="text-muted"
          aria-expanded={typing}
          disabled={disabled}
          onClick={() => (typing ? closeTyping() : setTyping(true))}
        >
          Type a path
        </Button>
      </div>
      {form}
    </div>
  )
}

/** In the desktop app, folders and files dropped on the Context tab are added to the chat's context. */
function useDropPaths(add: ((section: 'folders' | 'files', path: string) => void) | undefined, pickers?: Pickers) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  if (!add || !pickers) return { over: false, handlers: {} }
  const handlers = {
    onDragEnter: (e: DragEvent) => {
      if (!carriesFiles(e)) return
      depth.current++
      setOver(true)
    },
    onDragLeave: (e: DragEvent) => {
      if (!carriesFiles(e) || --depth.current > 0) return
      setOver(false)
    },
    onDragOver: (e: DragEvent) => carriesFiles(e) && e.preventDefault(),
    onDrop: (e: DragEvent) => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setOver(false)
      const { folders, files } = droppedPaths(e.dataTransfer, pickers.pathForFile)
      for (const path of folders) add('folders', path)
      for (const path of files) add('files', path)
    },
  }
  return { over, handlers }
}

const STEPS_LABEL = 'Thinking and tool calls'
const REPORTS_LABEL = 'Worker reports'
function FoldPicker({ label, shown, choose }: { label: string; shown: boolean; choose: (shown: boolean) => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-6 rounded-lg border px-10 py-8">
      <span className="min-w-0 flex-1">{label}</span>
      <Select
        label={label}
        value={shown ? 'on' : 'off'}
        options={[
          { value: 'on', label: 'Unfolded' },
          { value: 'off', label: 'Folded' },
        ]}
        onChange={(value) => choose(value === 'on')}
      />
    </div>
  )
}

const NO_SETUP = 'none:'

/** The setup this chat uses, at the top of the General tab. */
function SetupPicker({ chat, setups, disabled, send, openSetups }: {
  chat: ChatView
  setups: Setup[]
  disabled: boolean
  send: (m: ClientMessage) => void
  openSetups?: () => void
}) {
  const current = setups.find((s) => s.id === chat.setup)
  return (
    <section className="flex flex-col gap-6" aria-label="Setup">
      <About intro={SETUP_HINT} notes={[]} />
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-6 rounded-lg border px-10 py-8">
        <span className="min-w-0 flex-1">Setup</span>
        <Select
          label="Setup"
          value={current?.id ?? NO_SETUP}
          disabled={disabled || (!setups.length && !current)}
          options={[{ value: NO_SETUP, label: 'None' }, ...setups.map((s) => ({ value: s.id, label: s.name }))]}
          onChange={(value) =>
            send({ type: 'chat.setSetup', chatId: chat.id, ...(value !== NO_SETUP && { setup: value }) })
          }
        />
      </div>
      {openSetups && (
        <Button variant="ghost" size="small" className="w-fit" onClick={openSetups}>
          {setups.length ? 'Edit setups…' : 'Make a setup…'}
        </Button>
      )}
    </section>
  )
}

function ViewPickers({ chatId }: { chatId: string }) {
  const steps = useStepsShown(chatId)
  const reports = useReportsShown(chatId)
  return (
    <section className="flex flex-col gap-6" aria-label="View">
      <FoldPicker label={STEPS_LABEL} shown={steps} choose={(shown) => showStepsIn(chatId, shown)} />
      <FoldPicker label={REPORTS_LABEL} shown={reports} choose={(shown) => showReportsIn(chatId, shown)} />
    </section>
  )
}

/** The chat's permission switches, in the General tab below the view options. */
function Permissions({ chat, above, workFolder, disabled, send }: {
  chat: ChatView
  above: ChatView[]
  workFolder: WorkFolder
  disabled: boolean
  send: (m: ClientMessage) => void
}) {
  return (
    <section className="flex flex-col gap-8" aria-label="Permissions">
      <h3 className="font-semibold">Permissions</h3>
      <About intro={PERMISSIONS_HINT} notes={PERMISSION_SWITCHES.map((name) => PERMISSIONS[name])} />
      {PERMISSION_SWITCHES.map((name) => {
        const { label, amberWhileOn } = PERMISSIONS[name]
        const on = switchedOn(name, chat, ...above, workFolder)
        const amber = amberWhileOn && on
        return (
          <div
            key={name}
            className="flex flex-wrap items-center justify-between gap-x-8 gap-y-6 rounded-lg border px-10 py-8"
          >
            <span className={`min-w-0 flex-1 ${amber ? 'text-amber' : ''}`}>{label}</span>
            <Select
              label={label}
              value={on ? 'on' : 'off'}
              disabled={disabled}
              options={[
                { value: 'on', label: 'On' },
                { value: 'off', label: 'Off' },
              ]}
              onChange={(value) =>
                send({ type: 'chat.setPermission', chatId: chat.id, name, enabled: value === 'on' })
              }
            />
          </div>
        )
      })}
    </section>
  )
}

// Kothar's own tabs; an extension's panel is `extension:<extension>/<panel>` (extensionTabId).
type PanelTabId = string
const TAB_LABEL: Record<string, string> = { context: 'Context', general: 'General' }

/** Actions extensions add for this chat, listed in the General tab. */
function ExtensionCommands({ chatId, commands, disabled, send }: {
  chatId: string
  commands: CommandInfo[]
  disabled: boolean
  send: (m: ClientMessage) => void
}) {
  if (!commands.length) return null
  return (
    <section className="flex flex-col gap-8" aria-label="Commands">
      <h3 className="font-semibold">Commands</h3>
      <div className="flex flex-wrap gap-6">
        {commands.map((c) => {
          const button = (
            <Button
              key={`${c.extension}/${c.id}`}
              size="small"
              disabled={disabled}
              onClick={() => send({ type: 'extension.command', chatId, extension: c.extension, command: c.id })}
            >
              {c.label}
            </Button>
          )
          return c.hint ? (
            <Hint key={`${c.extension}/${c.id}`} text={c.hint}>
              {button}
            </Hint>
          ) : (
            button
          )
        })}
      </div>
    </section>
  )
}

function WorkFolderRow({ chatId, path, disabled, send, errors }: {
  chatId: string
  path: string
  disabled: boolean
  send: (m: ClientMessage) => void
  errors?: TerminalErrors
}) {
  return (
    <section className="flex flex-col gap-4" aria-label="Work folder">
      <h3 className="font-semibold">Work folder</h3>
      <div className="flex items-center gap-8">
        <span className="min-w-0 flex-1 font-mono text-xs leading-[normal] wrap-anywhere text-muted">{path}</span>
        <TerminalButton chatId={chatId} path={path} what="the work folder" disabled={disabled} send={send} />
      </div>
      <TerminalError chatId={chatId} path={path} errors={errors} />
    </section>
  )
}

/** A tab's how-it-works notes, folded under one quiet line until asked for. */
function About({ intro, notes }: { intro: string; notes: readonly { label: string; about: string }[] }) {
  return (
    <details className="text-sm text-muted">
      <summary className="w-fit cursor-pointer text-faint transition-colors hover:text-muted">How this works</summary>
      <div className="mt-6 flex flex-col gap-6">
        <p>{intro}</p>
        {notes.map((n) => (
          <p key={n.label}>
            <span className="text-text">{n.label}:</span> {n.about}
          </p>
        ))}
      </div>
    </details>
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
  extensionUi?: State['extensionUi']
  panelViews?: State['panelViews']
  terminalErrors?: TerminalErrors
  /** The desktop app's pickers (`window.kothar`); a browser tab has none and types paths instead. */
  pickers?: Pickers
  setups?: Setup[]
  // Opens Settings → Setups.
  openSetups?: () => void
}

export function ContextPanel(props: ContextPanelProps) {
  const { chatId, items, chats, workFolder, readOnly, connected, send, hide, pickers } = props
  const settled = useSettled(items !== undefined)
  const locked = readOnly || !connected
  const sourceOf = (item: ContextItem) =>
    item.from === GLOBAL_CONTEXT ? GLOBAL_SOURCE : (chats.find((c) => c.id === item.from)?.name ?? item.from)
  const chat = chats.find((c) => c.id === chatId)
  // A worker follows its space's switches unless it has its own.
  const above = chat ? lineOf(chats, chat).slice(1) : []
  // The space's work folder, once its first message has picked one.
  const workDir = chat && !chat.extension ? (above.at(-1) ?? chat).workDir : undefined
  const sections: readonly ContextSection[] = chat?.extension ? ['agents'] : CONTEXT_SECTIONS
  const intro = chat?.extension ? `${chat.name} keeps no folders, files or AGENTS.md of its own.` : CHAT_INTRO
  const tab = usePanelTab()
  const extensionUi = props.extensionUi?.chatId === chatId ? props.extensionUi : undefined
  const extensionTabs: ExtensionTab[] = chat ? (extensionUi?.panels ?? []) : []
  const extensionTab = extensionTabs.find((p) => extensionTabId(p.extension, p.id) === tab)
  const known = tab === 'general' || extensionTab
  const shown: PanelTabId = chat && known ? tab : 'context'
  const panelView = extensionTab && props.panelViews?.[panelKey(chatId, extensionTab.extension, extensionTab.id)]
  // By the tab's names, not the tab object, which is new on every render.
  const tabExtension = extensionTab?.extension
  const tabPanel = extensionTab?.id
  useEffect(() => {
    if (connected && tabExtension && tabPanel) send({ type: 'extension.panel.get', chatId, extension: tabExtension, panel: tabPanel })
  }, [chatId, connected, tabExtension, tabPanel, send])
  const width = usePanelWidth('context')
  const canAdd = shown === 'context' && !locked && sections.includes('folders')
  const drop = useDropPaths(
    canAdd ? (section, path) => send({ type: 'context.add', chatId, section, path }) : undefined,
    pickers,
  )
  const tabs: TabEntry[] = [
    ...(chat ? [{ id: 'general', label: TAB_LABEL.general! }] : []),
    { id: 'context', label: TAB_LABEL.context! },
    ...extensionTabs.map((p) => ({ id: extensionTabId(p.extension, p.id), label: p.title })),
  ]
  return (
    <aside
      className="relative flex shrink-0 flex-col border-l bg-panel"
      style={{ width }}
      aria-label="Context"
      {...drop.handlers}
    >
      <ResizeHandle panel="context" />
      <AnimatePresence>
        {drop.over && (
          <m.div
            key="drop"
            className="pointer-events-none absolute inset-8 z-10 grid place-items-center rounded-lg border-2 border-dashed border-accent bg-bg/85 px-12 text-center text-body text-muted"
            {...MOTION.fade}
          >
            Drop to add folders and files
          </m.div>
        )}
      </AnimatePresence>
      <header className="flex h-44 shrink-0 items-center justify-between gap-8 border-b px-12">
        <PanelTabs tabs={tabs} active={shown} choose={choosePanelTab} />
        {hide && <PanelToggle side="right" label="Context panel" noun="context" open toggle={hide} action="toggleContextPanel" />}
      </header>
      <div
        className="flex flex-1 scroll-inset flex-col gap-18 overflow-y-auto py-12 pl-12"
        role="tabpanel"
        aria-label={extensionTab?.title ?? TAB_LABEL[shown]}
      >
        {shown === 'context' && (
          <About intro={`${intro} Edits apply from the next message.`} notes={sections.map((s) => SECTIONS[s])} />
        )}
        {shown === 'context' &&
          sections.map((section) => {
            const listed = items?.filter((item) => item.section === section) ?? []
            return (
              <section key={section} className="flex flex-col" aria-label={SECTIONS[section].label}>
                <h3 className="mb-8 font-semibold">{SECTIONS[section].label}</h3>
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
                          terminalErrors={props.terminalErrors}
                          connected={connected}
                        />
                      )}
                    </m.div>
                  ))}
                </AnimatePresence>
                {items && !listed.length && <p className="mb-8 text-sm text-faint">{EMPTY_SECTION[section]}</p>}
                {section !== 'agents' && (
                  <AddPath section={section} chatId={chatId} disabled={locked} send={send} pickers={pickers} />
                )}
              </section>
            )
          })}
        {shown === 'general' && chat && !chat.worker && (
          <SetupPicker chat={chat} setups={props.setups ?? []} disabled={locked} send={send} openSetups={props.openSetups} />
        )}
        {shown === 'general' && chat && <ViewPickers chatId={chatId} />}
        {shown === 'general' && chat && workDir && (
          <WorkFolderRow
            chatId={chatId}
            path={workDir}
            disabled={!connected}
            send={send}
            errors={props.terminalErrors}
          />
        )}
        {shown === 'general' && chat && (
          <Permissions chat={chat} above={above} workFolder={workFolder} disabled={locked} send={send} />
        )}
        {shown === 'general' && chat && (
          <ExtensionCommands chatId={chatId} commands={extensionUi?.commands ?? []} disabled={locked} send={send} />
        )}
        {extensionTab && (
          <ExtensionViewer
            view={panelView?.view}
            error={panelView?.error}
            act={(action) => send({ type: 'extension.panel.action', chatId, extension: extensionTab.extension, panel: extensionTab.id, action })}
            set={(key, value) => send({ type: 'extension.space.set', chatId, extension: extensionTab.extension, key, value })}
            reveal={(path) => send({ type: 'reveal', path })}
          />
        )}
      </div>
    </aside>
  )
}
