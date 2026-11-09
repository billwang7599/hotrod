---
title: The host
description: Every call a mod can make through host - chats, messages, accounts, programs, storage and more.
---

# The host

`host` is how a mod acts on Kothar. Every hook gets it in its context, `{ values, host }`, and a tool gets it in its
`call`. Each mod has a host of its own.

A community mod must list the calls it makes in its manifest's `uses`. A call it didn't list throws an error that names
the missing entry.

| Calls | List in `uses` |
|---|---|
| `chats`, `chat`, `read`, `space`, `messages`, `reaches`, `reachable` | `readChats` |
| `send`, `createChat`, `retry`, `continue`, `interrupt` | `sendMessages` |
| `accounts`, `useAccount` | `accounts` |
| `run`, `spawn`, `openTerminal` | `run` |
| `complete` | `models` |
| `chatStorage` | `memory` |
| `spaceValues`, `setSpaceValue` | `settings` |
| `note`, `error`, `storage`, `refresh` | nothing |

## Reading chats

| Call | Returns |
|---|---|
| `chats()` | Every chat you can see: spaces, workers and mod chats, as [`ChatDetail`](types.md#chats)s. |
| `chat(chatId)` | One chat, or `undefined`. |
| `read(chatId, { last? })` | The chat's log, oldest first, as [`ChatEntry`](types.md#log-entries)s. `last` keeps only the newest entries. |
| `messages(chatId)` | The chat's log as numbered [memory messages](types.md#memory-messages), oldest first. |
| `space(chatId)` | The space the chat is in (the chat itself for a space), as a [`SpaceDetail`](types.md#spaces), or `undefined`. |
| `reaches(callerId, chatId)` | Whether chat `callerId` may reach chat `chatId`. See below. |
| `reachable(callerId)` | Every chat `callerId` may reach, by the same rule. |

### Who may reach whom

When an agent calls your tool and names another chat, check that it may act on that chat before you read or message
it. `reaches` uses the same rule as Kothar's own `list_chats`, `read_chat`, `send_message` and `stop_chat` tools:

- A chat reaches its own workers.
- A chat that sees every chat, such as Home, also reaches every other chat, except other chats' workers.
- No chat reaches itself.

```ts
import type { ModTool } from '@kothar/mod-api'

const lastReply: ModTool = {
  name: 'last_reply',
  description: "Returns another chat's last reply.",
  inputSchema: { type: 'object', properties: { chatId: { type: 'string' } }, required: ['chatId'] },
  offered: () => true,
  run(input, { caller, host }) {
    const chatId = String(input.chatId)
    if (!host.reaches(caller.id, chatId)) throw new Error(`No chat "${chatId}" this chat can reach`)
    const reply = host.read(chatId).findLast((entry) => entry.type === 'text.completed')
    return reply?.type === 'text.completed' ? reply.text : 'No reply yet.'
  },
}

export { lastReply }
```

```ts
import type { ModHost } from '@kothar/mod-api'

// The last thing the user asked in a chat.
function lastQuestion(host: ModHost, chatId: string) {
  const entries = host.read(chatId, { last: 50 })
  return entries.findLast((entry) => entry.type === 'user.message')
}

// The folder a chat's agent works in.
function workFolder(host: ModHost, chatId: string) {
  return host.space(chatId)?.workDir
}

export { lastQuestion, workFolder }
```

## Sending messages

| Call | What it does |
|---|---|
| `send(chatId, text)` | Sends a message as if you typed it. If a turn is running, it waits in the queue behind it. |
| `createChat({ name, folders?, files?, engine?, parentId?, role? })` | Makes a new chat and returns `{ id }`. Without `parentId` it's a space; `folders` and `files` are absolute paths that go into its context. With `parentId` it's a [child chat](#child-chats). Send it its first message with `send`. |
| `retry(chatId)` | Sends the chat's last message again, ahead of anything queued. |
| `continue(chatId, text)` | Carries on the chat's last turn with a prompt from Kothar, as a turn of its own. The agent sees the turn so far in its memory. The prompt isn't shown or logged as a message, and queued messages run after it. The chat must be idle. |
| `interrupt(chatId)` | Asks a running turn to stop, as the Stop button does. |

```ts
import type { Mod } from '@kothar/mod-api'

const reviewer: Mod = {
  id: 'auto-review',
  name: 'Auto review',
  description: 'After a turn edits files, asks the agent to review its own changes.',
  enabledByDefault: false,
  onTurnCompleted({ chat, files, error }, { host }) {
    if (error || chat.worker || !files.length) return
    host.send(chat.id, `Review your changes to ${files.join(', ')} for bugs. Fix any you find.`)
  },
}

export default reviewer
```

This mod lists `events` and `sendMessages`. Careful: a mod that sends a message after every turn can loop. Here the
review turn only sends again if it edited files.

### Child chats

`createChat` with `parentId` makes a child of that chat, exactly as the built-in Workers mod makes a worker:

- It's listed under its parent, and it's view only: you can watch it and stop it, not write to it.
- It works in its space's work folder and checkouts, so it takes no `folders` or `files` of its own.
- It sees its parent's memory as it was at launch.
- It runs on the model list named by `role`: `chat`, `planning`, `searching` or `workers` (the default). Use `role`
  only with `parentId`.
- Its final reply joins the parent's queue as a report and wakes the parent. Then the child is removed.
- A child can't have children of its own, and its parent must not be archived.

The host sets no limit on how many children run at once. Keep your own count.

```ts
import type { ModHost } from '@kothar/mod-api'

function research(host: ModHost, parentId: string, question: string) {
  const child = host.createChat({ name: 'Research', parentId, role: 'searching' })
  host.send(child.id, `Find out: ${question}. Reply with a short answer and your sources.`)
  return child.id
}

export { research }
```

## Accounts

| Call | What it does |
|---|---|
| `accounts(engine)` | The engine's saved accounts, in the order Settings lists them: `{ engine, active, accounts: { id, name, signedIn? }[] }`. `undefined` if the engine keeps none. |
| `useAccount(engine, accountId)` | Makes that account the engine's active one, for every chat. Turns already running keep theirs. |

## Running programs

### run

`run(command, args, options?)` runs a command and waits for it to end. It resolves with `{ code, stdout, stderr }`.
`options` are `{ cwd?, env?, timeoutMs?, onStdout? }`; `onStdout` gets output as it arrives. `cwd` defaults to `/`.

`run` isn't sandboxed: it's the mod's own command, not an agent's.

```ts
import type { ModHost } from '@kothar/mod-api'

async function currentBranch(host: ModHost, folder: string) {
  const { code, stdout } = await host.run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: folder, timeoutMs: 5000 })
  return code === 0 ? stdout.trim() : undefined
}

export { currentBranch }
```

### spawn

`spawn(command, args, options?)` starts a long-running command and resolves once it has started, without waiting for it
to end. Nothing times it out. It resolves with a `ModProcess`:

| Member | What it does |
|---|---|
| `onOutput(listener)` | Calls `listener` with stdout as it arrives. For stderr too, run it through a shell with `2>&1`. |
| `onExit(listener)` | Calls `listener(code, stderrTail)` when it ends. `stderrTail` is the end of what it wrote to stderr. |
| `stop()` | Stops it and everything it started: SIGTERM, then SIGKILL if it hasn't gone after a grace period. |

`options` are `{ cwd?, env?, chat? }`. With `chat`, the command runs as that chat's own commands do: sandboxed to its
space's work folder and checkouts, unless the chat may edit anywhere. `cwd` then defaults to the space's work folder; without `chat`, it defaults to `/`.

Everything a mod started stops when the mod is turned off or Kothar quits.

```ts
import type { ModHost } from '@kothar/mod-api'

async function startWatcher(host: ModHost, chatId: string) {
  const proc = await host.spawn('/bin/sh', ['-c', 'exec 2>&1\nnpm run watch'], { chat: chatId })
  proc.onOutput((chunk) => {
    if (chunk.includes('error')) host.note(chatId, 'The watcher printed an error')
  })
  proc.onExit((code) => host.note(chatId, `The watcher exited with code ${code}`))
  return proc
}

export { startWatcher }
```

### openTerminal

`openTerminal(path)` opens your terminal app at a folder, in a new window or tab. The folder must be in some space: one
of its folders, its work folder or a checkout, or inside one. It rejects with a short message for you when it can't,
such as when the folder doesn't exist.

## Notes

`note(chatId, text, { panel? })` writes a short line into the chat's transcript, for you. Agents don't see it. With
`panel`, clicking the note opens that panel of your mod's; it must be one of your mod's panel ids.

```ts
import type { ModHost } from '@kothar/mod-api'

function tellUser(host: ModHost, chatId: string) {
  host.note(chatId, 'The dev server stopped', { panel: 'processes' })
}

export { tellUser }
```

## Errors

`error(text)` shows an error to you, the same way as one from a hook that throws: after the mod's name. Use it for
background work, where there's no hook to throw from. It needs nothing listed.

## Model calls

`complete({ system, prompt, schema?, timeoutMs })` makes one call to the model picked for summaries in **Settings →
Models**, on your own login, with no tools and no session. It resolves with the model's text. `schema` asks for JSON of
that shape where the engine supports it. It rejects when no engine that's on can make the call.

```ts
import type { ModHost } from '@kothar/mod-api'

async function titleFor(host: ModHost, text: string) {
  const title = await host.complete({
    system: 'You write short titles.',
    prompt: `A title of at most five words for:\n\n${text}`,
    timeoutMs: 30_000,
  })
  return title.trim()
}

export { titleFor }
```

List `models` in the manifest's `uses`: each call runs on your account.

## Settings per space

| Call | What it does |
|---|---|
| `spaceValues(chatId)` | The mod's `spaceSettings` for the chat's space (a worker's space), defaults filled in. |
| `setSpaceValue(chatId, key, value)` | Saves one for the chat's space, checked as Settings checks, and draws the mod's panels again. Throws for an unknown key or a bad value. |

See [Settings per space](settings.md#settings-per-space).

## Storage

`storage` keeps plain files of the mod's own, in the garage's `mods/<id>/` folder. Names are relative to that folder and
can't leave it; they may include subfolders.

| Member | What it does |
|---|---|
| `dir` | The folder's absolute path. |
| `read(name)` | The file's text, or `undefined` if it doesn't exist. |
| `write(name, text)` | Writes the file, making folders as needed. |
| `append(name, text)` | Adds to the end of the file, making it if it's missing. |
| `remove(name)` | Deletes the file, if it's there. |

`chatStorage(chatId)` is the same, for files of the mod's own that belong to one chat. They live in the chat's folder
and go when the chat is deleted. Kothar's own files there are out of reach. It needs `memory` listed.

```ts
import type { ModHost } from '@kothar/mod-api'

type Counts = Record<string, number>

function bump(host: ModHost, key: string) {
  const counts = JSON.parse(host.storage.read('counts.json') ?? '{}') as Counts
  counts[key] = (counts[key] ?? 0) + 1
  host.storage.write('counts.json', JSON.stringify(counts, null, 2))
}

export { bump }
```

The folder stays when the mod is turned off or uninstalled.

## refresh

`refresh(chatId?)` draws the mod's panels and commands for that chat again, and re-renders its open panels. Without a
chat, it does so for every chat. Call it when what your panels show has changed. See
[Panels](panels.md#panels).
