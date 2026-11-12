// Workers: a chat hands a task to a new chat below it (spawn_worker), which reports back when it ends. This is the one
// extension the core declares itself. It stays in core because spawn_worker is a Kothar MCP tool (kothar-mcp.ts) that
// needs the core's own chat tree (createChild, the running count per chat) and must exist before any extension loads;
// the extension here is only its switch and settings, so it shows, turns off and is left out by a setup like any other.
import type { Extension, ExtensionValues } from '@kothar/extension-api'
import type { Chat } from './chat.ts'

export const WORKER_INSTRUCTIONS =
  'Delegate by default. Any task that needs more than a few tool calls (exploring code, making a change, running ' +
  'tests, researching) goes to a worker you start with spawn_worker, not to you, so you stay free to keep ' +
  'talking with the user while it runs. Split the work into as many workers as it needs, each with a whole task ' +
  "it can finish on its own, independent of the others. You can edit the same files, just ensure they're in " +
  'different worktrees, and make a stack PR so we have less merge conflicts. Do the work yourself only for quick ' +
  "answers and one-line changes. Each worker's final reply comes back to you as a message, so don't wait for it " +
  'or poll it; tell the user what you started and carry on. To stop a worker you no longer need, use stop_chat.'

export const WORKERS_EXTENSION: Extension = {
  id: 'workers',
  name: 'Workers',
  description: 'Chats can hand a task to a new chat that reports back when it ends.',
  enabledByDefault: true,
  settings: [
    {
      key: 'limit',
      label: 'Max running per chat',
      description: 'How many workers one chat can run at once. -1 for no limit.',
      type: 'number',
      default: 4,
      min: -1,
      integer: true,
    },
    {
      key: 'instructions',
      label: 'Instructions',
      description: 'What every chat that can start workers is told about them.',
      type: 'text',
      default: WORKER_INSTRUCTIONS,
      rows: 6,
    },
  ],
}

// What a chat that may start workers is told about them: undefined for a worker (workers can't start chats) and for a
// chat whose setup leaves Workers out or while it's off.
export function workerInstructionsFor(
  chat: Chat,
  deps: { isOnFor: (extension: Extension, chat: Chat) => boolean; valuesOf: (extension: Extension) => ExtensionValues },
) {
  if (chat.info.worker || !deps.isOnFor(WORKERS_EXTENSION, chat)) return undefined
  return String(deps.valuesOf(WORKERS_EXTENSION).instructions)
}

// Whether a chat (or, without one, any chat) may start workers, and how many may run at once (-1: no limit). enabled is
// the extension's switch in Settings, and false for a chat whose setup leaves Workers out.
export function workersFor(
  chat: Chat | undefined,
  deps: {
    isOnFor: (extension: Extension, chat: Chat | undefined) => boolean
    extensionInfo: (extension: Extension) => { enabled: boolean; values: ExtensionValues }
  },
) {
  const { enabled, values } = deps.extensionInfo(WORKERS_EXTENSION)
  return { enabled: enabled && deps.isOnFor(WORKERS_EXTENSION, chat), limit: Number(values.limit) }
}
