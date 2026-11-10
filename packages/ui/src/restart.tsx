import type { ClientMessage, RestartChange, RestartState } from '@kothar/core/shared'
import { Button, confirm, Hint } from './controls.tsx'

const VERBS: Record<RestartChange['change'], string> = { start: 'starts', update: 'updates', stop: 'stops' }

// "Counter starts, Notes stops": what a restart changes, in a line.
export const changesText = (changes: readonly RestartChange[]) =>
  changes.map(({ name, change }) => `${name} ${VERBS[change]}`).join(', ')

// Asks first if chats are running, since a restart stops them as quitting does.
export async function restartKothar(running: number, send: (m: ClientMessage) => void) {
  if (running > 0) {
    const ok = await confirm({
      text: 'Restart Kothar?',
      body: `${running === 1 ? '1 chat is' : `${running} chats are`} running and will stop.`,
      ok: 'Restart',
    })
    if (!ok) return
  }
  send({ type: 'app.restart' })
}

type Props = { restart: RestartState; running: number; connected: boolean; send: (m: ClientMessage) => void }

// The Restart button, or what to do instead where Kothar can't restart itself.
export function RestartButton({ restart, running, connected, send }: Props) {
  if (!restart.canRestart) {
    return (
      <Hint text="This Kothar can't restart itself. Stop it and start it again.">
        <span className="text-sm whitespace-nowrap text-muted">Restart the dev server</span>
      </Hint>
    )
  }
  return (
    <Button size="small" disabled={!connected} onClick={() => void restartKothar(running, send)}>
      Restart
    </Button>
  )
}

// Inline in Settings: which community extension changes wait for a restart.
export function RestartNotice(props: Props) {
  const { changes } = props.restart
  if (!changes.length) return null
  return (
    <div
      role="status"
      className="mb-12 flex flex-wrap items-center gap-x-12 gap-y-6 rounded-lg border bg-warning-bg py-8 pr-8 pl-12 text-sm"
    >
      <span className="min-w-0 flex-1 text-amber">
        Restart Kothar to apply: <span className="text-text">{changesText(changes)}</span>
      </span>
      <RestartButton {...props} />
    </div>
  )
}
