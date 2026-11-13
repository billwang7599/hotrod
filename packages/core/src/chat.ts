// A chat as the core keeps it while it runs: what's saved (info, context, entries) plus its live turn state. The core's
// modules share this type; only the core makes and holds chats.
import type { ExtensionWait, TurnSummary } from '@kothar/extension-api'
import type { ChatEntry, ChatInfo, ChatStatus, QueuedMessage, Session } from './shared.ts'

export type Chat = {
  info: ChatInfo
  dir: string
  context: Record<string, boolean>
  entries: ChatEntry[]
  status: ChatStatus
  session?: Session
  unsavedText: string
  stopTimer?: ReturnType<typeof setTimeout>
  pendingRequests: Map<string, 'permission' | 'question'>
  // What extensions wait on the user for while the turn runs (ExtensionHost.wait), by extension id.
  waits: Map<string, ExtensionWait>
  // The turn has ended and extensions hear of it (onSessionEnded, onTurnCompleted): a wait now holds the chat.
  ending?: boolean
  // An extension's wait holds the chat after its turn ended: it shows waiting, a worker hasn't reported and queued
  // messages wait, until the wait ends. error is the turn's, for the report.
  held?: { error?: string }
  mcpToken?: string
  queue: QueuedMessage[]
  turns: number
  // The account and model the running turn started on, and the limit it ran into, if any.
  account?: string
  runModel?: string
  // The id the Inspector knows the running turn's session by (SentTurn.turn), for messages steered into it.
  sentTurn?: string
  limit?: { message: string; resetsAt?: string }
  // The engine wrote, thought or called a tool since the chat's last message; a continuation doesn't reset it.
  produced?: boolean
  // What the running turn has done so far, for onTurnCompleted.
  turn?: { text: string; tools: TurnSummary['tools'] }
  // The run the UI last got for this chat (JSON), so a change in Settings or an engine resends only the chats it moves.
  shownRun?: string
}
