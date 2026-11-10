---
title: The manifest and uses
description: The fields of manifest.json, and what each extension field and host call needs listed in uses.
---

# The manifest and `uses`

Every community extension ships a `manifest.json` beside its `main.mjs`. Kothar reads it before installing, so it can
show you what the extension is and what it does without running any of its code.

```json
{
  "id": "word-count",
  "name": "Word count",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "Notes how many words each reply had.",
  "api": 1,
  "uses": ["events"]
}
```

## Fields

Every field is required. Kothar refuses a manifest with any other field.

| Field | Rule |
|---|---|
| `id` | Lowercase letters, digits and dashes, up to 64 characters, starting and ending with a letter or digit. The same as the extension object's `id`. It's also the extension's folder name. |
| `name` | 1 to 40 characters. |
| `version` | Three numbers, like `1.2.3`. |
| `author` | 1 to 60 characters. |
| `description` | One line, 1 to 200 characters. |
| `api` | The extension API version the extension is written for. Today that's `1`. |
| `uses` | Everything the extension does through the extension API. See below. |

The manifest may be up to 64 KB.

## uses

`uses` lists everything the extension does through the extension API. Kothar shows the list before you install the
extension and before you turn it on, and holds the extension to it:

- An extension that sets a field it didn't list doesn't start.
- A host call it didn't list throws an error.
- An update is turned off until you turn it on again, and the popup names what it lists that the version you turned on
  didn't.

| Value | Shown to you as | Covers |
|---|---|---|
| `run` | Runs programs on your computer | `host.run`, `host.spawn`, `host.openTerminal`, `host.reveal`; Node's `child_process`, `worker_threads`, `cluster` |
| `network` | Reaches the internet | Node's own network APIs: `fetch`, `WebSocket`, `node:http`, `https`, `net`, `tls`, `dns`, `dgram`, `undici` |
| `files` | Reads or writes your files | Node's `node:fs` and `fs/promises`, for anything beyond `host.storage` |
| `setup` | Installs software it needs | `setup` |
| `mcpServers` | Starts MCP servers for agents | `mcpServers` |
| `permissions` | Approves or denies agents' requests for you | `onPermissionRequested` |
| `sendMessages` | Sends messages and starts chats as you | `host.send`, `host.createChat`, `host.retry`, `host.continue`, `host.interrupt`, `host.addContextFile` |
| `accounts` | Sees and switches your engine accounts | `host.accounts`, `host.useAccount` |
| `models` | Makes model calls on your accounts | `host.complete` |
| `memory` | Decides what agents remember of each chat | `memory`, `host.chatStorage` |
| `readChats` | Reads your chats | `host.chats`, `host.chat`, `host.read`, `host.space`, `host.messages`, `host.reaches`, `host.reachable` |
| `transforms` | Rewrites your messages or agents' replies | `transformMessage`, `transformOutput` |
| `instructions` | Adds to every agent's instructions | `instructions` |
| `tools` | Gives agents tools | `tools` |
| `events` | Watches chats as they run | `onEvent`, `onTurnStarted`, `onTurnCompleted`, `onStatusChanged`, `onSessionEnded`, `onChatCreated`, `onChatRemoved`, `onChatArchived`, `onLimitReached`, `onStart`, `onStop` |
| `chats` | Adds chats of its own | `chats` |
| `panels` | Adds panels | `panels`, `processes`, `onProcessAction`, `onProcessesChanged`, `onWaitAction`, `host.wait`, `host.endWait`, `host.processes`, `host.processAction`, `host.processesChanged` |
| `commands` | Adds commands | `commands` |
| `settings` | Has settings | `settings`, `spaceSettings`, `settingsVersion`/`migrateSettings`, `settingsView`, `onSettingsChanged`, `host.spaceValues`, `host.setSpaceValue` |

`host.note`, `host.error`, `host.notify`, `host.storage` and `host.refresh` need nothing listed. Any other host call
needs its use, and a host call that's new to Kothar is refused to community extensions until Kothar gives it one. An empty list, such as `tools: []`, counts as
unset.

List only what you use. Every entry is something people have to agree to, and a short list is easier to trust.

## What `uses` doesn't cover

Before it imports `main.mjs`, Kothar reads its text for Node's own APIs: `run` for `child_process`, `network` for
`fetch` or `node:https`, `files` for `node:fs`. Calls that load Node modules by name (`process.getBuiltinModule`,
`createRequire`, `process.binding`) need all three. An extension that uses one without listing it doesn't start, and
its row says which. Comments don't count, nor does a method that happens to be named `fetch` (`cache.fetch(key)`) or a
module name outside `import`, `from` or `require` (`['fs', 'net']`).

This catches a forgotten entry. It isn't a sandbox: community extensions still run inside Kothar, and code can reach
Node in ways a text check can't see. Reviewers check that an extension's `uses` is honest when it joins the
Marketplace. See [Publishing](../publishing.md). Running each community extension in its own locked-down process is
planned for a later extension API version.
