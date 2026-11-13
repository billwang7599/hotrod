// Settings → Workers: workers are part of Kothar, not an extension. Whether agents may start them, how many one chat
// runs at once (extensions' workers count too), and what chats that may start them are told.
import type { ClientMessage, PromptInfo, WorkersSettings } from '@kothar/core/shared'
import { GROUP, Switch } from '../controls.tsx'
import { ExtensionSettingRow, PromptRow } from './extensions.tsx'
import { SettingRow } from './rows.tsx'

export const WORKERS_INTRO =
  'A worker is a chat started below another for one task, which reports back when it ends. Agents start them with ' +
  'spawn_worker, and extensions start them for their own work, such as Deep Research’s searches.'

const LIMIT = {
  key: 'limit',
  label: 'Max running per chat',
  description: 'How many workers one chat runs at once, its agent’s and its extensions’ together. More wait for a slot. -1 for no limit.',
  type: 'number',
  default: 4,
  min: -1,
  integer: true,
} as const

type Props = { workers?: WorkersSettings; connected: boolean; send: (m: ClientMessage) => void }

export function WorkersPage({ workers, connected, send }: Props) {
  if (!workers) return null
  return (
    <>
      <div className={GROUP}>
        <SettingRow
          name="Let agents start workers"
          description="Off: chats get no spawn_worker tool and no instructions about it. Extensions can still start workers for their own work."
        >
          <Switch
            label="Let agents start workers"
            checked={workers.start}
            disabled={!connected}
            onChange={(start) => send({ type: 'workers.set', start })}
          />
        </SettingRow>
        <ExtensionSettingRow
          setting={LIMIT}
          value={workers.limit}
          disabled={!connected}
          save={(limit) => {
            // 0 would let no worker run, so an extension's would wait forever: Let agents start workers is the switch.
            if (typeof limit === 'number' && limit !== 0) send({ type: 'workers.set', limit })
          }}
        />
      </div>
      <section aria-label="Prompts" className="flex flex-col py-12">
        <h3 className="text-[13px] font-semibold">Prompts</h3>
        <p className="pb-4 text-sm text-muted">
          What every chat that may start workers is told about them. Your edit is sent instead of the default; the
          Inspector shows it where it’s sent.
        </p>
        <PromptRow
          prompt={workers.instructions}
          anchor={`prompt-workers-${workers.instructions.id}`}
          disabled={!connected || !workers.start}
          save={(text) => send({ type: 'workers.prompt.set', ...(text !== undefined && { text }) })}
        />
      </section>
    </>
  )
}

export const CORE_PROMPTS_INTRO =
  'Kothar’s own prompts, sent with every message of the chats they apply to. Your edit is sent instead of the default; ' +
  'the Inspector shows each where it’s sent. Workers’ instructions are under Settings → Workers.'

// Settings → Prompts: Kothar's own prompts, such as the intro to "What you can use". Each has an id
// (prompt-kothar-<prompt>) that the Inspector's Edit links scroll to.
export function CorePromptsPage({ prompts = [], connected, send }: { prompts?: PromptInfo[]; connected: boolean; send: (m: ClientMessage) => void }) {
  return (
    <section aria-label="Prompts" className="flex flex-col">
      {prompts.map((prompt) => (
        <div key={prompt.id}>
          {prompt.description && <p className="text-sm text-muted">{prompt.description}</p>}
          <PromptRow
            prompt={prompt}
            anchor={`prompt-kothar-${prompt.id}`}
            disabled={!connected}
            save={(text) => send({ type: 'corePrompt.set', id: prompt.id, ...(text !== undefined && { text }) })}
          />
        </div>
      ))}
    </section>
  )
}
