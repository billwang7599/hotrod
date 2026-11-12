// What shows between the transcript and the message box: the archived and engine notes, the queue, workers'
// permission requests, extensions waiting on the user, and a worker's view-only bar.
import { AnimatePresence, m } from 'motion/react'
import { ROLE_NAMES, type ClientMessage, type ModelLists } from '@kothar/core/shared'
import { Button, CHAT_NOUN, Hint, MOTION } from '../controls.tsx'
import { engineName, type ChatView, type State } from '../state.ts'
import type { SettingsPage } from '../settings.tsx'
import { PaperclipIcon } from './attachments.tsx'
import { FORCE_STOP_HINT } from './composer.tsx'
import { PermissionPrompt } from './permission.tsx'

type Send = (m: ClientMessage) => void
type Engine = State['engines'][number]

export function ArchivedNote({ connected, unarchive }: { connected: boolean; unarchive: () => void }) {
  return (
    <div className="mx-auto mb-8 flex max-w-column items-center gap-8 text-sm text-muted">
      <span className="flex-1">
        This {CHAT_NOUN.one} is archived. Its history stays; unarchive it to continue.
      </span>
      <Button size="small" disabled={!connected} onClick={unarchive}>
        Unarchive
      </Button>
    </div>
  )
}

type EngineNoteProps = {
  chat: ChatView
  offers?: Engine
  noEngineOn: boolean
  modelLists?: ModelLists
  connected: boolean
  send: Send
  openSettings: (page?: SettingsPage) => void
}

/** Why this chat's model can't run, with the way back to Settings. */
export function EngineNote({ chat, offers, noEngineOn, modelLists, connected, send, openSettings }: EngineNoteProps) {
  return (
    <div className="mx-auto flex max-w-column items-center gap-12 rounded-lg border border-dashed px-14 py-12 text-muted">
      <span className="flex-1">
        {noEngineOn
          ? 'No engine is on. Turn one on in Settings to start chatting.'
          : chat.model
            ? `${chat.model} on ${engineName(offers) || chat.engine} can't run: ${offers?.enabled ? 'the engine no longer offers it' : 'the engine is off or gone'}. Pick another model, or go back to the models in Settings.`
            : `Nothing in the ${chat.role && modelLists?.[chat.role]?.length ? ROLE_NAMES[chat.role] : 'Chat'} model list can run. Add a model, or turn its engine on, in Settings.`}
      </span>
      {chat.model && !noEngineOn && (
        <Button size="small" disabled={!connected} onClick={() => send({ type: 'chat.setModel', chatId: chat.id })}>
          Use Settings' models
        </Button>
      )}
      <Button variant="primary" size="small" onClick={() => openSettings(noEngineOn ? 'engines' : 'models')}>
        Open Settings
      </Button>
    </div>
  )
}

/** Messages waiting for the turn to end (or, when steering, for its next step). */
export function QueuedMessages({ chat, connected, send }: { chat: ChatView; connected: boolean; send: Send }) {
  return (
    <AnimatePresence initial={false}>
      {chat.queue.length > 0 && (
        <m.div key="queue" {...MOTION.collapse}>
          <ul className="mx-auto mb-8 flex max-w-column flex-col text-sm" aria-label="Queued messages">
            <AnimatePresence initial={false}>
              {chat.queue.map((q) => (
                <m.li key={q.id} {...MOTION.collapse}>
                  <div className="mb-4 flex items-center gap-8 rounded border border-dashed py-2 pr-4 pl-10 text-muted">
                    <span className="flex min-w-0 flex-1 items-center gap-6" title={q.text}>
                      {q.steering && <span className="shrink-0 text-faint">At the next step:</span>}
                      {q.report && <span className="shrink-0 text-faint">Worker {q.report.name} reported:</span>}
                      {q.text && <span className="truncate">{q.text}</span>}
                      {q.attachments && (
                        <span className="flex min-w-0 shrink-0 items-center gap-4 text-faint last:shrink">
                          <PaperclipIcon />
                          <span className="truncate">{q.attachments.map((a) => a.name).join(', ')}</span>
                        </span>
                      )}
                    </span>
                    {!q.steering && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Remove from queue"
                        disabled={!connected}
                        onClick={() => send({ type: 'chat.unqueue', chatId: chat.id, id: q.id })}
                      >
                        ×
                      </Button>
                    )}
                  </div>
                </m.li>
              ))}
            </AnimatePresence>
            {chat.queue.some((q) => !q.steering) && <li className="text-sm text-faint">Sends when this turn ends</li>}
          </ul>
        </m.div>
      )}
    </AnimatePresence>
  )
}

type WorkerRequest = { chat: ChatView; permission: Parameters<typeof PermissionPrompt>[0]['permission'] }

/** Permission requests from the workers below this chat, answered here. */
export function WorkerRequests({ requests, connected, send }: { requests: WorkerRequest[]; connected: boolean; send: Send }) {
  return (
    <ul
      className="mx-auto mb-8 flex max-h-[50vh] max-w-column flex-col gap-8 overflow-y-auto"
      aria-label="Worker requests"
    >
      {requests.map(({ chat: below, permission }) => (
        <li key={`${below.id}-${permission.requestId}`}>
          <PermissionPrompt permission={permission} chat={below} connected={connected} send={send} fromWorker />
        </li>
      ))}
    </ul>
  )
}

type Wait = { chat: ChatView; wait: NonNullable<ChatView['waits']>[number] }

/** Extensions waiting on the user, in this chat or a worker below it. */
export function Waits({ chat, waits, connected, send }: { chat: ChatView; waits: Wait[]; connected: boolean; send: Send }) {
  return (
    <ul className="mx-auto mb-8 flex max-w-column flex-col gap-8" aria-label="Waiting for you">
      {waits.map(({ chat: of, wait }) => (
        <li
          key={`${of.id}-${wait.extension}`}
          className="flex flex-wrap items-center gap-8 rounded-lg border border-l-3 border-permission-border border-l-amber bg-permission-bg px-14 py-10 shadow-raised"
        >
          <span className="min-w-0 flex-1 text-body">
            {of.id !== chat.id && (
              <>
                Worker <strong>{of.name}</strong>:{' '}
              </>
            )}
            {wait.text}
          </span>
          {wait.buttons.map((button) => (
            <Hint key={button.id} text={button.hint}>
              <Button
                size="small"
                variant={button.primary ? 'primary' : 'default'}
                disabled={!connected}
                onClick={() =>
                  send({ type: 'extension.wait.answer', chatId: of.id, extension: wait.extension, button: button.id })
                }
              >
                {button.label}
              </Button>
            </Hint>
          ))}
        </li>
      ))}
    </ul>
  )
}

type WorkerBarProps = { chat: ChatView; parentName: string; busy: boolean; connected: boolean; stop: () => void }

/** In a worker's own view, in place of the message box: whose worker it is, and Stop while it runs. */
export function WorkerBar({ chat, parentName, busy, connected, stop }: WorkerBarProps) {
  return (
    <div
      className="mx-auto flex max-w-column items-center gap-12 rounded-lg border border-dashed px-14 py-10 text-muted"
      aria-label="Worker"
    >
      <span className="min-w-0 flex-1 truncate">
        Worker of {parentName ?? 'another chat'} · view only
      </span>
      {busy && (
        <Hint text={chat.status === 'stopping' && FORCE_STOP_HINT}>
          <Button
            variant="danger"
            size="small"
            className={chat.status === 'stopping' ? 'enabled:animate-[blink_1.4s_ease-in-out_infinite]' : ''}
            disabled={!connected}
            onClick={stop}
          >
            {chat.status === 'stopping' ? 'Stopping…' : 'Stop'}
          </Button>
        </Hint>
      )}
    </div>
  )
}
