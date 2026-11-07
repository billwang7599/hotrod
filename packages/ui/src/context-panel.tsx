import { useEffect, useState } from 'react'
import type { ClientMessage, ContextKind, ContextLayer } from '@hotrod/core/types'
import { Button, Switch } from './controls.tsx'

export const CONTEXT_LABELS: Record<ContextKind, { label: string; about: string }> = {
  workshop: { label: 'Workshop', about: 'Your AGENTS.md for every chat' },
  repo: { label: 'Repo', about: "The AGENTS.md in a project's folder" },
  project: { label: 'Project', about: 'Your notes for one project' },
  parent: { label: 'Parent', about: 'The notes of the subchat a subagent works for' },
  own: { label: 'Subchat', about: "A subchat's own notes" },
}
const EMPTY_LAYER = 'Empty. Instructions written here go to the engine.'
const PILL = 'rounded-full bg-raised px-8 py-2 text-xs font-normal text-muted'

type LayerProps = {
  layer: ContextLayer
  chatId: string
  own: boolean
  readOnly: boolean
  send: (m: ClientMessage) => void
}

function ContextLayerCard({ layer, chatId, own, readOnly, send }: LayerProps) {
  const [text, setText] = useState(layer.text)
  useEffect(() => setText(layer.text), [layer.text])
  const { label } = CONTEXT_LABELS[layer.kind]
  const editable = layer.writable && !readOnly
  const dim = layer.enabled ? '' : 'opacity-55'
  return (
    <section
      className={`flex flex-col gap-6 rounded-lg border p-10 ${layer.enabled ? 'bg-bg' : ''}`}
      aria-label={`${label} context`}
    >
      <div className="flex items-center justify-between gap-8">
        <span className={`flex items-center gap-6 font-semibold ${dim}`}>
          {label}
          {own && <span className={PILL}>This chat</span>}
          {!layer.writable && <span className={PILL}>Read-only</span>}
        </span>
        <Switch
          label={`Use ${label} in this chat`}
          checked={layer.enabled}
          disabled={readOnly}
          onChange={(enabled) => send({ type: 'context.set', chatId, kind: layer.kind, enabled })}
        />
      </div>
      <span className="font-mono text-xs leading-[normal] wrap-anywhere text-faint" title={layer.path}>
        {layer.path}
      </span>
      <textarea
        className={`min-h-96 resize-y px-8 py-6 font-mono text-sm leading-[1.5] focus:border-accent read-only:bg-transparent read-only:text-muted ${dim}`}
        value={text}
        rows={6}
        spellCheck={false}
        readOnly={!editable}
        aria-label={`${label} AGENTS.md`}
        placeholder={layer.writable ? EMPTY_LAYER : 'No AGENTS.md in this folder'}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== layer.text && send({ type: 'context.write', chatId, kind: layer.kind, text })}
      />
    </section>
  )
}

type ContextPanelProps = {
  chatId: string
  layers?: ContextLayer[]
  contextDefaults: Record<ContextKind, boolean>
  readOnly: boolean
  connected: boolean
  send: (m: ClientMessage) => void
  close: () => void
}

export function ContextPanel({ chatId, layers, contextDefaults, readOnly, connected, send, close }: ContextPanelProps) {
  useEffect(() => {
    if (connected) send({ type: 'context.get', chatId })
  }, [chatId, connected, contextDefaults, send])
  return (
    <aside className="flex w-320 shrink-0 flex-col border-l bg-panel" aria-label="Context">
      <header className="flex h-44 shrink-0 items-center justify-between border-b pr-8 pl-14">
        <span className="font-semibold">Context</span>
        <Button variant="ghost" size="icon" aria-label="Close context" onClick={close}>
          ×
        </Button>
      </header>
      <div className="flex flex-1 flex-col gap-10 overflow-y-auto p-12">
        <p className="text-sm text-faint">
          Each message gets the layers that are on, top first. Edits apply from the next message.
        </p>
        {layers?.map((layer, i) => (
          <ContextLayerCard
            key={layer.path}
            layer={layer}
            chatId={chatId}
            own={i === layers.length - 1}
            readOnly={readOnly || !connected}
            send={send}
          />
        ))}
      </div>
    </aside>
  )
}
