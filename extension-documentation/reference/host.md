---
title: The host
description: Every call an extension can make through host - chats, messages, accounts, programs, storage and more.
---

# The host

`host` is how an extension acts on Kothar. Every hook gets it in its context, `{ values, host }`, and a tool gets it in
its `call`. Each extension has a host of its own.

A community extension must list the calls it makes in its manifest's `uses`. A call it didn't list throws an error that
names the missing entry.

| Calls | List in `uses` |
|---|---|
| `chats`, `chat`, `read`, `space`, `messages`, `reaches`, `reachable` | `readChats` |
| `send`, `createChat`, `retry`, `continue`, `interrupt` | `sendMessages` |
| `accounts`, `useAccount` | `accounts` |
| `run`, `spawn`, `openTerminal`, `reveal` | `run` |
| `complete` | `models` |
| `chatStorage`, `everyChatStorage` | `memory` |
| `home` | `files` |
| `spaceValues`, `setSpaceValue` | `settings` |
| `wait`, `endWait`, `processes`, `processAction`, `processesChanged` | `panels` |
| `note`, `error`, `notify`, `storage`, `refresh`, `now` | nothing |

A community extension can't make any other host call, including one added in a later Kothar, until Kothar lists it here.
Built-in extensions aren't held to `uses`.

## Reading chats

| Call | Returns |
|---|---|
| `chats()` | Every chat you can see: spaces, workers and extension chats, as [`ChatDetail`](types.md#chats)s. |
| `chat(chatId)` | One chat, or `undefined`. |
| `read(chatId, { last? })` | The chat's log, oldest first, as [`ChatEntry`](types.md#log-entries)s. `last` keeps only the newest entries. |
| `messages(chatId)` | The chat's log as numbered [memory messages](types.md#memory-messages), oldest first. |
| `message(chatId, entry)` | The message at `entry` in the chat's log (the index in `read`), as an [`ExtensionMessage`](panels.md#message-actions), or `undefined` when that entry isn't the user's message, a worker's report or a reply. |
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
import type { ExtensionTool } from '@kothar/extension-api'

const lastReply: ExtensionTool = {
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
import type { ExtensionHost } from '@kothar/extension-api'

// The last thing the user asked in a chat.
function lastQuestion(host: ExtensionHost, chatId: string) {
  const entries = host.read(chatId, { last: 50 })
  return entries.findLast((entry) => entry.type === 'user.message')
}

// The folder a chat's agent works in.
function workFolder(host: ExtensionHost, chatId: string) {
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
| `addContextFile(chatId, path)` | Adds a file to the chat's context (**Context → Files**), as the user adding it there does. It's pasted into the instructions of the chat's next sessions and its workers'. A worker's goes to its space. Throws a short message for the user when there's no such file, it's already there, or the chat keeps no files (an extension's own chat, such as Home). |

```ts
import type { Extension } from '@kothar/extension-api'

const reviewer: Extension = {
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

This extension lists `events` and `sendMessages`. Careful: an extension that sends a message after every turn can loop.
Here the review turn only sends again if it edited files.

### Child chats

`createChat` with `parentId` makes a child of that chat, exactly as the built-in Workers extension makes a worker:

- It's listed under its parent, and it's view only: you can watch it and stop it, not write to it.
- It works in its space's work folder and checkouts, so it takes no `folders` or `files` of its own.
- It sees its parent's memory as it was at launch.
- It runs on the model list named by `role`: `chat`, `planning`, `searching` or `workers` (the default). Use `role`
  only with `parentId`.
- Its final reply joins the parent's queue as a report and wakes the parent. Then the child is removed.
- A child can't have children of its own, and its parent must not be archived.

The host sets no limit on how many children run at once. Keep your own count.

```ts
import type { ExtensionHost } from '@kothar/extension-api'

function research(host: ExtensionHost, parentId: string, question: string) {
  const child = host.createChat({ name: 'Research', parentId, role: 'searching' })
  host.send(child.id, `Find out: ${question}. Reply with a short answer and your sources.`)
  return child.id
}

export { research }
```

## Accounts

| Call | What it does |
|---|---|
| `accounts(engine)` | The engine's saved accounts, in the order Settings lists them: `{ engine, active, accounts: { id, name, signedIn?, provider? }[] }`. `provider` is set on engines whose accounts each sign in to one model provider (OpenCode): a model runs only on an account of its own provider. `undefined` if the engine keeps none. |
| `useAccount(engine, accountId)` | Makes that account the engine's active one, for every chat. Turns already running keep theirs. |

## Running programs

### run

`run(command, args, options?)` runs a command and waits for it to end. It resolves with `{ code, stdout, stderr }`.
`options` are `{ cwd?, env?, timeoutMs?, onStdout? }`; `onStdout` gets output as it arrives. `cwd` defaults to `/`.

`run` isn't sandboxed: it's the extension's own command, not an agent's.

```ts
import type { ExtensionHost } from '@kothar/extension-api'

async function currentBranch(host: ExtensionHost, folder: string) {
  const { code, stdout } = await host.run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: folder, timeoutMs: 5000 })
  return code === 0 ? stdout.trim() : undefined
}

export { currentBranch }
```

### spawn

`spawn(command, args, options?)` starts a long-running command and resolves once it has started, without waiting for it
to end. Nothing times it out. It resolves with a `ExtensionProcess`:

| Member | What it does |
|---|---|
| `onOutput(listener)` | Calls `listener` with stdout as it arrives. For stderr too, run it through a shell with `2>&1`. |
| `onExit(listener)` | Calls `listener(code, stderrTail)` when it ends. `stderrTail` is the end of what it wrote to stderr. |
| `stop()` | Stops it and everything it started: SIGTERM, then SIGKILL if it hasn't gone after a grace period. |

`options` are `{ cwd?, env?, chat? }`. With `chat`, the command runs as that chat's own commands do: sandboxed to its
space's work folder and checkouts, unless the chat may edit anywhere. `cwd` then defaults to the space's work folder; without `chat`, it defaults to `/`.

Everything an extension started stops when the extension is turned off or Kothar quits. `onStop` runs first (for an
extension that started, so give it an `onStart`, even an empty one), before any of its processes exit: an extension
can set a flag there and tell those exits from a process that died on its own. Processes does this to note a process
killed outside Kothar, without a false note at quit.

```ts
import type { ExtensionHost } from '@kothar/extension-api'

async function startWatcher(host: ExtensionHost, chatId: string) {
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

### reveal

`reveal(path)` shows a file or folder in Finder, selected. It reaches only Kothar's own folders: the data folder (your
extension's `storage.dir` and the chats' folders are in it), the work folder, and each chat's folders, files, work folder
and checkouts, or anything inside them. It rejects with a short message for you otherwise, or when the path doesn't
exist. A symlink counts where it points.

For a path the user should be able to find, a `text` view with `reveal: true` draws the button for you (see
[Panels](panels.md)).

## Notes

`note(chatId, text, { panel? })` writes a short line into the chat's transcript, for you. Agents don't see it. With
`panel`, clicking the note opens that panel of your extension's; it must be one of your extension's panel ids.

```ts
import type { ExtensionHost } from '@kothar/extension-api'

function tellUser(host: ExtensionHost, chatId: string) {
  host.note(chatId, 'The dev server stopped', { panel: 'processes' })
}

export { tellUser }
```

## Errors

`error(text)` shows an error to you, the same way as one from a hook that throws: after the extension's name. Use it for
background work, where there's no hook to throw from. It needs nothing listed.

## Notifications

`notify({ chatId?, title, body? })` shows a system notification, for something you'd want to hear of while you're away
from Kothar: a wait gave up, a browser needs you to log in. It needs nothing listed. Title and body are plain text; a
title past 120 characters or a body past 400 is cut.

Kothar shows it as it shows its own (**Settings → Appearance → Notifications**): not at all if you turned notifications
off, and not while you're looking at the chat it names (or that chat's space). Several arriving within a second show as
one. With `chatId`, clicking it brings Kothar to the front and opens that chat, or the space of a worker. An unknown
`chatId` throws.

```ts
import type { ExtensionHost } from '@kothar/extension-api'

function gaveUp(host: ExtensionHost, chatId: string) {
  host.notify({ chatId, title: 'Reconnect gave up', body: 'Still offline after 2 hours' })
}

export { gaveUp }
```

Don't notify for every step: a note in the chat is for the record, a notification for when the user should come back.

## Model calls

`complete({ system, prompt, schema?, timeoutMs })` makes one call to the model picked for summaries in **Settings →
Models**, on your own login, with no tools and no session. It resolves with the model's text. `schema` asks for JSON of
that shape where the engine supports it. It rejects when no engine that's on can make the call.

```ts
import type { ExtensionHost } from '@kothar/extension-api'

async function titleFor(host: ExtensionHost, text: string) {
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
| `spaceValues(chatId)` | The extension's `spaceSettings` for the chat's space (a worker's space), defaults filled in. |
| `setSpaceValue(chatId, key, value)` | Saves one for the chat's space, checked as Settings checks, and draws the extension's panels again. Throws for an unknown key or a bad value. |

See [Settings per space](settings.md#settings-per-space).

## Storage

`storage` keeps plain files of the extension's own, in the garage's `extensions/<id>/` folder. Names are relative to
that folder and can't leave it; they may include subfolders.

| Member | What it does |
|---|---|
| `dir` | The folder's absolute path. |
| `read(name)` | The file's text, or `undefined` if it doesn't exist. |
| `write(name, text)` | Writes the file, making folders as needed. |
| `append(name, text)` | Adds to the end of the file, making it if it's missing. |
| `remove(name)` | Deletes the file, if it's there. |
| `list(folder?)` | The plain files directly in that folder (the top without one) as `{ name, size }[]`, `size` in bytes, sorted by name. Folders and links aren't listed; a missing folder lists nothing. |

`chatStorage(chatId)` is the same, for files of the extension's own that belong to one chat. They live in the chat's
folder and go when the chat is deleted. Kothar's own files there are out of reach, and `list` leaves them out. It needs
`memory` listed.

`everyChatStorage()` returns `{ chatId, storage }[]`: the `chatStorage` of every chat Kothar keeps, including chats
the user can't see right now, such as Home while its extension is off. It's for housekeeping across chats, such as
showing how much disk your files take or deleting them all. It isn't for reading chats the user can't see. It needs
`memory` listed. Memory's Settings readout uses it:

```ts
const used = host
  .everyChatStorage()
  .flatMap(({ storage }) => storage.list().filter((file) => file.name === 'summaries.jsonl'))
  .reduce((sum, file) => sum + file.size, 0)
```

```ts
import type { ExtensionHost } from '@kothar/extension-api'

type Counts = Record<string, number>

function bump(host: ExtensionHost, key: string) {
  const counts = JSON.parse(host.storage.read('counts.json') ?? '{}') as Counts
  counts[key] = (counts[key] ?? 0) + 1
  host.storage.write('counts.json', JSON.stringify(counts, null, 2))
}

export { bump }
```

The folder stays when the extension is turned off or uninstalled.

## Home folder and clock

| Member | What it is |
|---|---|
| `home` | The user's home folder, as the core has it. A test, or a core on another machine, can give a different one, so read it here rather than from `node:os`. Needs `files` listed. |
| `now()` | The core's clock, as a `Date`. Use it instead of `Date.now()` or `new Date()`, so your times match the core's and tests can fix them. |

## refresh

`refresh(chatId?)` draws the extension's panels and commands for that chat again, and re-renders its open panels.
Without a chat, it does so for every chat. Call it when what your panels show has changed. See
[Panels](panels.md#panels).

## Waiting for the user

`wait(chatId, { text, buttons })` puts a running chat in **waiting**, as an unanswered permission request does: it
turns amber in the sidebar, and a bar above the composer shows `text` and the buttons. A worker's bar shows in its
space too, where the user is. Each button is `{ id, label, primary?, hint? }`.

When the user clicks a button, Kothar calls the extension's `onWaitAction(chat, { button }, context)`. When they send
the chat a message instead, it calls `onWaitAction(chat, { message }, context)`, and the message still goes to the
agent.

The wait stays until the extension calls `endWait(chatId)`, the turn ends, or the extension is turned off. Calling
`wait` again replaces the extension's wait. `wait` throws if the chat's turn isn't running, so call it from a tool's
`run` or a hook that runs during the turn, or as it ends (see [Holding a chat after its turn](#holding-a-chat-after-its-turn)). The usual shape is a tool that waits on a promise the button resolves:

```ts
let answered: (() => void) | undefined

const extension: Extension = {
  // ...
  tools: [
    {
      name: 'ask_user',
      description: 'Waits until the user clicks Done.',
      inputSchema: { type: 'object', properties: { why: { type: 'string' } } },
      offered: () => true,
      async run(input, { caller, host }) {
        host.wait(caller.id, { text: String(input.why), buttons: [{ id: 'done', label: 'Done', primary: true }] })
        await new Promise<void>((resolve) => (answered = resolve))
        host.endWait(caller.id)
        return 'The user is done.'
      },
    },
  ],
  onWaitAction: () => answered?.(),
}
```

The built-in Browser extension's `ask_user_in_browser` works this way.

### Holding a chat after its turn

Call `wait` from `onTurnCompleted` or `onSessionEnded`, before any `await`, and it holds the chat after its turn
ended, for something the extension waits on, such as the network coming back:

- The chat shows **waiting** with your bar, as above.
- A worker doesn't report to its lead yet, and isn't removed.
- Messages sent to the chat, the user's included, are queued. The user's message still reaches `onWaitAction` as
  `{ message }`.

The hold ends one of two ways:

- `endWait(chatId)`, the user's **Stop**, or the extension being turned off. The chat then ends its turn as it would
  have without the hold: a worker reports, with the turn's error, and goes; queued messages run.
- [`continue` or `retry`](#sending-messages). They carry the turn on, and the turn they start ends it as usual, so a
  worker reports once.

Hear about Stop from `onStatusChanged`: the chat leaves `waiting`. The built-in Reconnect extension works this way.

## Processes rows

The Processes tab lists the commands agents start. An extension can add rows of its own for something it runs in a
space, such as the Browser extension's browser, with `processes(spaceId, context)` on the extension (see [The extension
object](extension.md#optional-fields)):

```ts
processes: (spaceId) => [
  { key: 'tunnel', label: 'Tunnel', detail: 'https://abc.example', since: startedAt, dot: 'success',
    actions: [{ name: 'stop', label: 'Stop' }] },
],
onProcessAction(spaceId, key, action) {
  if (action === 'stop') stopTunnel(spaceId)
},
```

Kothar asks for the rows each time the tab draws. When yours change, call `host.processesChanged(spaceId)` so the tab
draws again. A row's buttons call your `onProcessAction(spaceId, key, action, context)`.

The other calls are for an extension that draws the tab, as the Processes extension does: `processes(spaceId)` returns
every other extension's rows, each with its `extension` id; `processAction(spaceId, extension, key, action)` runs a
row's button in the extension that owns it; and its `onProcessesChanged(spaceId, context)` hook runs when another
extension calls `processesChanged`.
