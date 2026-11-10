---
title: Events and hooks
description: React to chats and turns, answer permission requests, and rewrite messages and replies.
---

# Events and hooks

Hooks let an extension react as chats run. They all run in Kothar's core. Each gets the extension's
[context](../anatomy.md#the-context), `{ values, host }`, as its last argument.

Every hook on this page except `onPermissionRequested` and the transforms needs `events` in the manifest's `uses`.

## Background work

| Hook | Called when |
|---|---|
| `onStart(context)` | Kothar is ready for model calls (engines found, a work folder chosen), or the extension was turned on after that. Start background work here, such as summarizing chats. |
| `onStop(context)` | The extension was turned off, or Kothar is quitting. Stop background work here. It isn't called for an extension that never started. |

```ts
import type { Extension } from '@kothar/extension-api'

let timer: ReturnType<typeof setInterval> | undefined

const heartbeat: Extension = {
  id: 'heartbeat',
  name: 'Heartbeat',
  description: 'Writes a line to its log every minute while it runs.',
  enabledByDefault: false,
  onStart({ host }) {
    timer = setInterval(() => host.storage.append('heartbeat.log', `${new Date().toISOString()}\n`), 60_000)
  },
  onStop() {
    clearInterval(timer)
    timer = undefined
  },
}

export default heartbeat
```

Background work has no hook to throw from, so report failures with [`host.error`](host.md#errors).

## Chats

| Hook | Called when |
|---|---|
| `onChatCreated(chat, context)` | A chat is made: a space, a worker or an extension's chat. |
| `onChatArchived(chat, archived, context)` | A chat is archived (`archived` is `true`) or brought back (`false`). |
| `onChatRemoved(chat, context)` | A chat is deleted. By now it's gone from Kothar, with its log and folder. |
| `onStatusChanged(chat, status, context)` | A chat's status changes: `idle`, `running`, `waiting` (on the user, such as a permission request) or `stopping`. |

```ts
import type { Extension } from '@kothar/extension-api'

const waitingNote: Extension = {
  id: 'waiting-log',
  name: 'Waiting log',
  description: 'Keeps a log of when chats waited for you.',
  enabledByDefault: false,
  onStatusChanged(chat, status, { host }) {
    if (status !== 'waiting') return
    const log = host.storage.read('waiting.log') ?? ''
    host.storage.write('waiting.log', `${log}${new Date().toISOString()} ${chat.name}\n`)
  },
}

export default waitingNote
```

## Turns

A turn is one message and the agent's work on it. Each message runs its own engine session.

| Hook | Called when |
|---|---|
| `onTurnStarted(turn, context)` | A turn starts. `turn` is `{ chat, text, continued }`: the message as sent, before any transform, and whether it's a [continuation](host.md#sending-messages). |
| `onTurnCompleted(turn, context)` | A turn ends. See below. |
| `onSessionEnded({ chat, error? }, context)` | The engine session ends, after every turn. `error` is set if the engine quit early. |
| `onLimitReached(limit, context)` | A turn ran into its account's usage limit. See below. |

`onTurnCompleted` gets a `TurnSummary`:

| Field | What it is |
|---|---|
| `chat` | The chat, as a [`ChatDetail`](types.md#chats). |
| `text` | The turn's last reply. |
| `error` | Set if the turn failed. |
| `tools` | Each tool call: `{ name, kind, summary, path?, isError? }`. |
| `files` | The paths the turn's edit tools named, in order, without repeats. |

```ts
import type { Extension } from '@kothar/extension-api'

const touched: Extension = {
  id: 'touched-files',
  name: 'Touched files',
  description: 'Lists the files each turn edited.',
  enabledByDefault: false,
  onTurnCompleted({ chat, files, error }, { host }) {
    if (error || !files.length) return
    host.note(chat.id, `Edited: ${files.join(', ')}`)
  },
}

export default touched
```

### onLimitReached

Kothar stops the turn before calling it, so the chat is idle. `limit` has:

| Field | What it is |
|---|---|
| `chat` | The chat, as a [`ChatSummary`](types.md#chats). |
| `engine` | The engine's id. |
| `account` | The account the turn ran on, if the engine keeps accounts. The active account may have changed since. |
| `message` | The engine's message. |
| `resetsAt` | When the limit lifts (ISO time), if the engine said. |
| `output` | `true` if the agent had already written, thought or called a tool since the chat's last message. Sending that message again would redo work, so [`host.continue`](host.md#sending-messages) fits better than `host.retry`. |

The built-in Account rotation extension uses it. See [Examples](../examples.md).

## Every event

`onEvent(chat, event, context)` gets every event from the engine as it arrives, including each piece of streamed text.
It's read-only, and it runs often, so keep it quick. It doesn't return anything.

```ts
import type { Extension } from '@kothar/extension-api'

const shellCount = new Map<string, number>()

const shellCounter: Extension = {
  id: 'shell-counter',
  name: 'Shell counter',
  description: 'Counts the commands each chat runs.',
  enabledByDefault: false,
  onEvent(chat, event) {
    if (event.type === 'tool.started' && event.kind === 'shell') {
      shellCount.set(chat.id, (shellCount.get(chat.id) ?? 0) + 1)
    }
  },
}

export default shellCounter
```

Events are the same for every engine. See [Engine events](types.md#engine-events) for the full list.

## onPermissionRequested

A policy for permission requests. Kothar asks the extension about each request it would otherwise ask you about, or
would allow on its own. Return a verdict to answer it, or nothing to leave it.

```ts
import type { Extension } from '@kothar/extension-api'

const noForcePush: Extension = {
  id: 'no-force-push',
  name: 'No force push',
  description: 'Denies git push --force.',
  enabledByDefault: false,
  onPermissionRequested(request) {
    if (request.kind !== 'shell' || !request.command) return undefined
    if (/\bgit\s+push\b.*(--force\b|-f\b)/.test(request.command)) {
      return { allow: false, message: 'Force pushing is turned off. Push without --force.' }
    }
    return undefined
  },
}

export default noForcePush
```

- The `request` has the tool's `name`, its `kind` (`shell`, `edit`, `read`, `search`, `fetch`, `mcp` or `other`), a
  `summary`, its raw `input`, and `path` (edits) or `command` (shell) when there is one.
- A verdict is `{ allow: boolean, message? }`. `message` is shown to the agent when the request is denied.
- Extensions are asked in load order. The first verdict wins.
- Kothar waits for a promise before asking the next extension. Don't keep it waiting long: the agent is stopped until
  then.
- Kothar's own denials, such as edits outside the work folder in a sandbox, always stand.
- pi never asks before running a tool, so pi sessions have no permission requests.

List `permissions` in the manifest's `uses`.

## Transforms

`transformMessage(text, chat, context)` rewrites each message on its way to the engine. The chat's log, and you, keep
the original.

`transformOutput(text, chat, context)` rewrites each finished reply before it's logged, shown and remembered. While it
streams, the chat shows the engine's own text; your version replaces it when the reply finishes.

```ts
import type { Extension } from '@kothar/extension-api'

const britishSpelling: Extension = {
  id: 'british-spelling',
  name: 'British spelling',
  description: 'Asks for British spelling, and fixes a few words in replies.',
  enabledByDefault: false,
  transformMessage(text) {
    return `${text}\n\n(Use British spelling.)`
  },
  transformOutput(text) {
    return text.replace(/\bcolor\b/g, 'colour').replace(/\bfavorite\b/g, 'favourite')
  },
}

export default britishSpelling
```

- Both must return text, synchronously.
- Extensions chain in load order: each gets the text the last one returned.
- If a transform throws, or returns something that isn't text, Kothar shows the error and keeps the text as it was.

List `transforms` in the manifest's `uses`.
