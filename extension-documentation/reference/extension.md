---
title: The extension object
description: Every field of the Extension type, with links to the page that covers it.
---

# The extension object

An extension is an object of type `Extension`, the default export of its module. This page lists every field. The pages
after it cover each group in detail.

## Required fields

| Field | Type | What it is |
|---|---|---|
| `id` | `string` | Lowercase letters, digits and dashes. The same as the manifest's `id`. |
| `name` | `string` | Shown in Settings and in errors. |
| `description` | `string` | One or two sentences, shown in Settings. |
| `enabledByDefault` | `boolean` | Whether a built-in extension starts on. Community extensions always start off, so set it to `false`. |

## Optional fields

| Field | What it adds | Page |
|---|---|---|
| `settings` | Settings on the extension's own page in Settings | [Settings and setup](settings.md) |
| `spaceSettings` | Settings kept per space, shown in the extension's panels | [Settings and setup](settings.md#settings-per-space) |
| `settingsVersion`, `migrateSettings` | Updating saved settings once when their shape changes | [Settings and setup](settings.md#migrating-saved-settings) |
| `settingsView`, `onSettingsChanged` | A readout and buttons of the extension's own on its Settings page, and a hook for a changed setting | [Settings and setup](settings.md#a-view-of-its-own) |
| `setup` | A check and an install step for something the extension needs | [Settings and setup](settings.md#setup) |
| `tools` | Tools agents can call | [Tools, MCP servers, instructions and memory](agents.md#tools) |
| `mcpServers` | MCP servers for each session | [Tools, MCP servers, instructions and memory](agents.md#mcp-servers) |
| `instructions` | Text added to each session's instructions | [Tools, MCP servers, instructions and memory](agents.md#instructions) |
| `panels` | Tabs in the right sidebar | [Panels and commands](panels.md#panels) |
| `commands` | Actions in a chat's General tab | [Panels and commands](panels.md#commands) |
| `chats` | Chats of the extension's own | [Chats](#chats), below |
| `memory` | What each session sees of its chat's history | [Tools, MCP servers, instructions and memory](agents.md#memory) |
| `onStart`, `onStop` | Start and stop background work | [Events and hooks](events.md#background-work) |
| `onChatCreated`, `onChatRemoved`, `onChatArchived`, `onSpaceRemoved`, `onStatusChanged`, `onTurnStarted`, `onTurnCompleted`, `onSessionEnded`, `onEvent`, `onLimitReached` | Hooks that react to chats as they run | [Events and hooks](events.md) |
| `onPermissionRequested` | A policy that answers permission requests | [Events and hooks](events.md#onpermissionrequested) |
| `transformMessage`, `transformOutput` | Rewrites of messages and replies | [Events and hooks](events.md#transforms) |
| `onWaitAction` | The user's answer to the extension's wait on a chat | [The host](host.md#waiting-for-the-user) |
| `processes`, `onProcessAction`, `onProcessesChanged` | Rows of the extension's own in the Processes tab | [The host](host.md#processes-rows) |

## Chats

`chats` gives an extension chats of its own. Home is one: the built-in Home extension declares a single chat, and its
tools let that chat make spaces.

```ts
import type { Extension } from '@kothar/extension-api'

const journal: Extension = {
  id: 'journal',
  name: 'Journal',
  description: 'A pinned chat that keeps a daily journal with you.',
  enabledByDefault: false,
  chats: [
    {
      id: 'journal',
      name: 'Journal',
      instructions: 'You help the user keep a short daily journal. Ask one question at a time.',
    },
  ],
}

export default journal
```

A `ExtensionChat` has:

| Field | Type | What it is |
|---|---|---|
| `id` | `string` | The chat's id. No other extension's chat may have it. |
| `name` | `string` | Shown in the sidebar. |
| `instructions` | `string` | The chat's role, given first in every session's instructions. |
| `seesAll` | `boolean`, optional | The chat can list, read and message every chat through Kothar's own tools, as Home does. |

An extension's chat is pinned. It can't be renamed, archived or deleted, and it keeps no folders, files or `AGENTS.md`
of its own. When the extension is off, its chats are hidden and their history stays.

List `chats` in the manifest's `uses`.

## Rules for every hook

- Hooks run in Kothar's core, not in the window.
- A hook that throws, or a promise that rejects, shows its error as "Extension name: message" and doesn't stop the chat.
- Kothar doesn't wait for async hooks, except `onPermissionRequested`, a tool's `run`, and a panel's `render` and
  `onAction`.
- Extensions are called in load order: built-in extensions first, then community extensions.
- A chat's setup (Settings → Setups) can leave an extension that's on out of that chat's sessions. For those chats
  Kothar doesn't call its `mcpServers`, `instructions`, `memory`, `transformMessage`, `transformOutput` or
  `onPermissionRequested`, the Kothar MCP server doesn't offer its `tools`, and the chat doesn't show its `panels` or
  `commands`. An extension's own chat always keeps it. Hooks that only report what happened
  (`onTurnStarted`, `onStatusChanged`, `onEvent` and the rest) still run for every chat.
