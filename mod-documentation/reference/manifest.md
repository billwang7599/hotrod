---
title: The manifest and uses
description: The fields of manifest.json, and what each mod field and host call needs listed in uses.
---

# The manifest and `uses`

Every community mod ships a `manifest.json` beside its `main.mjs`. Kothar reads it before installing, so it can show
you what the mod is and what it does without running any of its code.

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
| `id` | Lowercase letters, digits and dashes, up to 64 characters, starting and ending with a letter or digit. The same as the mod object's `id`. It's also the mod's folder name. |
| `name` | 1 to 40 characters. |
| `version` | Three numbers, like `1.2.3`. |
| `author` | 1 to 60 characters. |
| `description` | One line, 1 to 200 characters. |
| `api` | The mod API version the mod is written for. Today that's `1`. |
| `uses` | Everything the mod does through the mod API. See below. |

The manifest may be up to 64 KB.

## uses

`uses` lists everything the mod does through the mod API. Kothar shows the list before you install the mod and before
you turn it on, and holds the mod to it:

- A mod that sets a field it didn't list doesn't start.
- A host call it didn't list throws an error.
- An update that lists more than the version you turned on is turned off until you turn it on again.

| Value | Shown to you as | Covers |
|---|---|---|
| `run` | Runs programs on your computer | `host.run`, `host.spawn`, `host.openTerminal` |
| `setup` | Installs software it needs | `setup` |
| `mcpServers` | Starts MCP servers for agents | `mcpServers` |
| `permissions` | Approves or denies agents' requests for you | `onPermissionRequested` |
| `sendMessages` | Sends messages and starts chats as you | `host.send`, `host.createChat`, `host.retry`, `host.continue`, `host.interrupt` |
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
| `settings` | Has settings | `settings`, `spaceSettings`, `settingsVersion`/`migrateSettings`, `host.spaceValues`, `host.setSpaceValue` |

`host.note`, `host.error`, `host.storage` and `host.refresh` need nothing listed. An empty list, such as `tools: []`, counts as
unset.

List only what you use. Every entry is something people have to agree to, and a short list is easier to trust.

## What `uses` doesn't cover

`uses` covers the mod API only. Kothar can't sandbox a mod's code, so a mod could still use Node's own APIs, such as
`node:fs` or `fetch`, without listing anything. Reviewers check that a mod's `uses` is honest when it joins the
Marketplace. See [Publishing](../publishing.md).
