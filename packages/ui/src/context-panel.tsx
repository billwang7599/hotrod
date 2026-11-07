import { useEffect, useState } from 'react'
import type { ClientMessage, ContextKind, ContextLayer } from '@hotrod/core/types'
import { Switch } from './controls.tsx'

export const CONTEXT_LABELS: Record<ContextKind, { label: string; about: string }> = {
  workshop: { label: 'Workshop', about: 'Your AGENTS.md for every chat' },
  repo: { label: 'Repo', about: "The AGENTS.md in a project's folder" },
  project: { label: 'Project', about: 'Your notes for one project' },
  parent: { label: 'Parent', about: 'The notes of the subchat a subagent works for' },
  own: { label: 'Subchat', about: "A subchat's own notes" },
}
const EMPTY_LAYER = 'Empty. Instructions written here go to the engine.'

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
  return (
    <section className={`context-layer ${layer.enabled ? '' : 'off'}`} aria-label={`${label} context`}>
      <div className="context-layer-header">
        <span className="context-label">
          {label}
          {own && <span className="pill">This chat</span>}
          {!layer.writable && <span className="pill">Read-only</span>}
        </span>
        <Switch
          label={`Use ${label} in this chat`}
          checked={layer.enabled}
          disabled={readOnly}
          onChange={(enabled) => send({ type: 'context.set', chatId, kind: layer.kind, enabled })}
        />
      </div>
      <span className="context-path" title={layer.path}>
        {layer.path}
      </span>
      <textarea
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
    <aside className="context-panel" aria-label="Context">
      <header className="context-header">
        <span className="context-title">Context</span>
        <button className="ghost icon" aria-label="Close context" onClick={close}>
          ×
        </button>
      </header>
      <div className="context-list">
        <p className="hint context-hint">
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
