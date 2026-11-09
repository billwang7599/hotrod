---
title: Mod anatomy
description: The parts of a community mod - manifest.json, main.mjs and the mod object - and how Kothar loads them.
---

# Mod anatomy

A community mod ships as two files, published as the assets of a GitHub release:

| File | What it is |
|---|---|
| `manifest.json` | Who the mod is and what it uses. Kothar reads it before installing, without running any code. |
| `main.mjs` | The mod's code: one ES module whose default export is the mod object. |

## manifest.json

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

Every field is required, and Kothar refuses a manifest with any other field. See
[The manifest and uses](reference/manifest.md) for the rules on each one.

## main.mjs

- One ES module, at most 5 MB.
- It may import only Node's built-in modules (`node:fs`, `node:child_process` and so on). Bundle any npm packages into
  it; nothing installs them for you.
- Its default export is the mod object.
- It's plain JavaScript. Write it in TypeScript and bundle it, as the template does with esbuild.

## The mod object

The mod object is what Kothar runs. Five fields are required; everything else is optional.

```ts
import type { Mod } from '@kothar/mod-api'

const mod: Mod = {
  // Required.
  id: 'word-count', // the same as the manifest's id
  name: 'Word count', // shown in Settings
  description: 'Notes how many words each reply had.',
  enabledByDefault: false, // community mods always start off, whatever this says

  // Optional: whatever the mod does.
  onTurnCompleted(turn, { host }) {
    host.note(turn.chat.id, `${turn.text.split(/\s+/).filter(Boolean).length} words`)
  },
}

export default mod
```

The optional fields fall into groups:

| Group | Fields | Page |
|---|---|---|
| Settings and setup | `settings`, `setup` | [Settings and setup](reference/settings.md) |
| What agents get | `tools`, `mcpServers`, `instructions`, `memory` | [Tools, MCP servers, instructions and memory](reference/agents.md) |
| What you see | `panels`, `commands`, `chats` | [Panels and commands](reference/panels.md), [The mod object](reference/mod.md#chats) |
| Reacting to chats | `onChatCreated`, `onTurnCompleted`, `onEvent`, `onStart` and the other hooks | [Events and hooks](reference/events.md) |
| Steering agents | `onPermissionRequested`, `transformMessage`, `transformOutput` | [Events and hooks](reference/events.md) |

## The context

Most hooks get a **context** as their last argument: `{ values, host }`.

- `values` holds the mod's current settings, by key. See [Settings and setup](reference/settings.md).
- `host` is how the mod acts: send messages, read chats, run programs, save files. See [The host](reference/host.md).

Each mod gets a host of its own, so its notes and files are its own.

## How Kothar loads a mod

1. **Install.** Kothar downloads `manifest.json` and `main.mjs` into the garage's `community/<id>/` folder. It runs
   nothing.
2. **Start.** When Kothar starts, it imports `main.mjs` for each community mod that's turned on, while the
   **Community mods** switch is on too.
3. **Checks.** Kothar won't run the mod if:
   - it has no default export,
   - its `id` isn't the manifest's,
   - it has a setting with the key `enabled`,
   - it sets a field its manifest's `uses` doesn't list,
   - another mod already has its id, or one of its tool names or chat ids.

   Its row in **Settings → Community mods** says why.
4. **Run.** Kothar calls the mod's hooks as chats run. A host call the manifest doesn't list throws an error when the
   mod makes it.

A hook that throws, or a promise that rejects, shows its error and doesn't stop the chat.
