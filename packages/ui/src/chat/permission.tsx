// A permission request waiting in the chat (or a worker's, in its space), and the verdict pill once it's answered.
import type { ClientMessage, ToolKind } from '@kothar/core/shared'
import { Button, Chevron, Hint } from '../controls.tsx'
import type { ChatView, Permission } from '../state.ts'
import { BODY } from './parts.tsx'

export const VERDICTS = { allowed: 'Allowed', denied: 'Denied', cancelled: 'Cancelled' }
export const PILL = 'shrink-0 rounded-full px-6 text-xs leading-[1.6]'
export const VERDICT_COLORS = { allowed: 'bg-green/10 text-green', denied: 'bg-red/10 text-red', cancelled: 'bg-raised text-muted' }
const AUTO_VERDICT_HINTS: Record<'allowed' | 'denied', Partial<Record<ToolKind, string>>> = {
  allowed: {
    edit: 'An edit inside the work folder, so Kothar allowed it without asking',
    shell: 'A command in a sandboxed chat, so Kothar ran it without asking',
  },
  denied: { edit: 'An edit outside the work folder, so Kothar denied it without asking' },
}

export function Verdict({ permission: { outcome, auto, toolKind } }: { permission: Permission }) {
  if (outcome === 'pending') return null
  const hint = auto && outcome !== 'cancelled' ? AUTO_VERDICT_HINTS[outcome][toolKind] : undefined
  return (
    <Hint text={hint}>
      <span data-verdict className={`${PILL} ${VERDICT_COLORS[outcome]} ${hint ? 'cursor-help' : ''}`}>
        {auto && outcome === 'allowed' ? 'Allowed automatically' : VERDICTS[outcome]}
      </span>
    </Hint>
  )
}

export type PromptProps = {
  permission: Permission
  chat: ChatView
  connected: boolean
  send: (m: ClientMessage) => void
  // Set in a worker's own view: its requests are answered in this chat, its space, not here.
  space?: ChatView
  select?: (chatId: string) => void
  // Set in a space, on the requests of a worker below it.
  fromWorker?: boolean
}

export function PermissionPrompt({ permission, chat, connected, send, space, select, fromWorker }: PromptProps) {
  const respond = (allow: boolean) =>
    send({ type: 'permission.respond', chatId: chat.id, requestId: permission.requestId, allow })
  return (
    <div
      className="flex flex-col gap-8 rounded-lg border border-l-3 border-permission-border border-l-amber bg-permission-bg px-14 py-12 shadow-raised"
      aria-label={fromWorker ? `Request from worker ${chat.name}` : undefined}
    >
      <div className="text-body">
        {fromWorker ? (
          <>
            Worker <strong>{chat.name}</strong> wants to run <strong>{permission.name}</strong>
          </>
        ) : (
          <>
            Allow <strong>{permission.name}</strong>?
          </>
        )}
      </div>
      <pre className="rounded border bg-bg px-10 py-8">{permission.summary}</pre>
      <details className="group">
        <summary className="flex w-fit list-none items-center gap-6 text-sm text-muted hover:text-text">
          <Chevron />
          Full input
        </summary>
        <pre className={`${BODY} mt-6 rounded border bg-bg pl-10`}>{JSON.stringify(permission.input, null, 2)}</pre>
      </details>
      {space && chat.status === 'waiting' ? (
        <div className="flex items-center gap-8 text-sm text-muted" data-waiting-in={space.id}>
          <span className="flex-1">Waiting for approval in {space.name}</span>
          {select && (
            <Button size="small" onClick={() => select(space.id)}>
              Go to {space.name}
            </Button>
          )}
        </div>
      ) : chat.status === 'waiting' ? (
        <div className="flex gap-8">
          <Button variant="primary" disabled={!connected} onClick={() => respond(true)}>
            Approve
          </Button>
          <Button variant="danger" disabled={!connected} onClick={() => respond(false)}>
            Deny
          </Button>
        </div>
      ) : (
        <div className="text-sm text-muted">{chat.status === 'stopping' ? 'Stopping…' : 'Pending'}</div>
      )}
    </div>
  )
}
