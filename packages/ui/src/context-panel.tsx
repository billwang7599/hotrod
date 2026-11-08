import { useEffect, useState, type FormEvent } from 'react'
import { AnimatePresence, m } from 'motion/react'
import {
  CONTEXT_SECTIONS,
  GLOBAL_CONTEXT,
  type ClientMessage,
  type ContextItem,
  type ContextSection,
} from '@hotrod/core/shared'
import { Button, CHAT_NOUN, Chevron, Hint, MOTION, PanelToggle, Switch, useSettled } from './controls.tsx'
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
      'Where it works; each folder’s AGENTS.md is read in. With none, it runs in the nearest folder above, or a ' +
      'scratch folder',
    inherited: `The folders of the ${CHAT_NOUN.many} above, with their AGENTS.md`,
  },
  files: {
    label: 'Files',
    about: 'Text is pasted in full into the instructions; other files go by path',
    inherited: `The files of the ${CHAT_NOUN.many} above`,
  },
}
const EMPTY_SECTION: Record<ContextSection, string> = {
  agents: '',
  folders: 'No folders.',
  files: 'No files.',
}
const GLOBAL_SOURCE = 'Global'
const GLOBAL_HINT = 'Every chat gets it. Edit it in Settings → Instructions.'
const CHAT_INTRO = 'Each message gets the items that are on, the global AGENTS.md first.'
const PILL = 'shrink-0 rounded-full bg-raised px-8 py-2 text-xs font-normal text-muted'
const PREVIEW = 'max-h-160 overflow-auto rounded border bg-bg px-8 py-6 font-mono text-xs whitespace-pre-wrap text-muted'

type ItemProps = {
  item: ContextItem
  chatId: string
  source: string
  readOnly: boolean
  send: (m: ClientMessage) => void
}

function AgentsCard({ item, chatId, source, readOnly, send }: ItemProps) {
  const [text, setText] = useState(item.text)
  useEffect(() => setText(item.text), [item.text])
  const own = item.from === chatId
  const editable = own && !readOnly
  const dim = item.enabled ? '' : 'opacity-55'
  return (
    <div className={`mb-8 flex flex-col gap-6 rounded-lg border p-10 ${item.enabled ? 'bg-bg shadow-raised' : ''}`}>
      <div className="flex items-center justify-between gap-8">
        <span className={`flex min-w-0 items-center gap-6 font-semibold ${dim}`}>
          <span className="truncate">{source}</span>
          <Hint text={item.from === GLOBAL_CONTEXT && GLOBAL_HINT}>
            <span className={PILL}>{own ? 'Own' : 'Read-only here'}</span>
          </Hint>
        </span>
        <Switch
          label={`Use the AGENTS.md of ${source}`}
          checked={item.enabled}
          disabled={readOnly}
          onChange={(enabled) => send({ type: 'context.set', chatId, path: item.path, enabled })}
        />
      </div>
      <span className="font-mono text-xs leading-[normal] wrap-anywhere text-faint" title={item.path}>
        {item.path}
      </span>
      <textarea
        className={`resize-y px-8 py-6 font-mono text-sm leading-[1.5] focus:border-accent read-only:bg-transparent read-only:text-muted ${own ? 'min-h-96' : 'min-h-36'} ${dim}`}
        value={text}
        rows={own ? 6 : 2}
        spellCheck={false}
        readOnly={!editable}
        aria-label={`AGENTS.md of ${source}`}
        placeholder={own ? 'Empty. Instructions written here go to the engine.' : 'Empty'}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== item.text && send({ type: 'context.write', chatId: item.from, text })}
      />
    </div>
  )
}

function PathCard({ item, chatId, source, readOnly, send }: ItemProps) {
  const own = item.from === chatId
  const section = item.section === 'folders' ? 'folders' : 'files'
  const preview = item.section === 'folders' ? 'AGENTS.md' : 'Contents'
  return (
    <div className={`mb-8 flex flex-col gap-4 rounded-lg border px-10 py-8 ${item.enabled ? 'bg-bg shadow-raised' : ''}`}>
      <div className="flex items-center gap-8">
        <span className={`min-w-0 flex-1 truncate font-semibold ${item.enabled ? '' : 'opacity-55'}`}>
          {folderName(item.path)}
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
      <span className="font-mono text-xs leading-[normal] wrap-anywhere text-faint" title={item.path}>
        {item.path}
      </span>
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

type ContextPanelProps = {
  chatId: string
  items?: ContextItem[]
  chats: ChatView[]
  readOnly: boolean
  connected: boolean
  send: (m: ClientMessage) => void
  hide?: () => void
}

export function ContextPanel({ chatId, items, chats, readOnly, connected, send, hide }: ContextPanelProps) {
  const settled = useSettled(items !== undefined)
  const locked = readOnly || !connected
  const sourceOf = (item: ContextItem) =>
    item.from === GLOBAL_CONTEXT ? GLOBAL_SOURCE : (chats.find((c) => c.id === item.from)?.name ?? item.from)
  const chat = chats.find((c) => c.id === chatId)
  const sections: readonly ContextSection[] = chat?.mod ? ['agents'] : CONTEXT_SECTIONS
  const intro = chat?.mod ? `${chat.name} keeps no folders, files or AGENTS.md of its own.` : CHAT_INTRO
  return (
    <aside className="flex shrink-0 flex-col border-l bg-panel" style={{ width: PANEL_PX.context }} aria-label="Context">
      <header className="flex h-44 shrink-0 items-center justify-between border-b px-12">
        <Hint text={`${intro} Edits apply from the next message.`} side="bottom" align="start">
          <span className="font-semibold">Context</span>
        </Hint>
        {hide && <PanelToggle side="right" label="Context panel" noun="context" open toggle={hide} />}
      </header>
      <div className="flex flex-1 flex-col gap-18 overflow-y-auto p-12">
        {sections.map((section) => {
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
                      <PathCard item={item} chatId={chatId} source={sourceOf(item)} readOnly={locked} send={send} />
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
