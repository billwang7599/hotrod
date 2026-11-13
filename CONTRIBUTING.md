# Contributing

Thanks for helping with Kothar. This page covers how to run, test and change the code. To build an extension or theme
outside this repo, see [Writing an extension](#writing-an-extension).

## Running from source

You need **Node 26 or later** (`engines` in `package.json`) and macOS for the full app. The core and UI also run on
Linux, which is what CI uses, but sandboxing is macOS-only.

```sh
npm ci
npm run dev       # core on ws://127.0.0.1:4317, UI on http://localhost:4318 (Vite), in a browser tab
npm run desktop   # builds the UI, then opens the Electron app
```

`npm run dev` uses your real garage (`~/Library/Application Support/Kothar/`). To keep your own chats and settings out
of it, point it at a scratch folder:

```sh
KOTHAR_GARAGE=/tmp/k/garage KOTHAR_WORK=/tmp/k/work npm run dev
```

The desktop app uses the same core port, so quit Kothar first, or move the dev copy to other ports with
`KOTHAR_PORT`, `KOTHAR_UI_PORT`, `KOTHAR_UI_ORIGIN` (the UI's address) and `VITE_KOTHAR_CORE_URL` (the core's
WebSocket address, read by the UI).

Other variables the core reads (`packages/core/src/main.ts`): `KOTHAR_PORT` (core port, default 4317),
`KOTHAR_UI_ORIGIN`, `KOTHAR_TOKEN`, `KOTHAR_ENGINE`, `KOTHAR_MARKETPLACE_URL` and `KOTHAR_GITHUB_TOKEN`. The UI's Vite
port is `KOTHAR_UI_PORT` (default 4318). Each has an older `HOTROD_` name that still works (see
[Old names](#old-names-and-why-they-still-work)).

To build the Mac app, see [Building the Mac app](README.md#building-the-mac-app).

## Checks

CI (`.github/workflows/ci.yml`) runs these on every PR, on Linux. Run them before you push:

```sh
npm run lint        # oxlint
npm run typecheck   # tsc for core, ui, desktop, extensions and bench
npm test            # vitest, every package and extension
npx vitest run packages/core/src/memory.test.ts   # one file
```

- **Tests never call real models or engines.** Use the fake adapter (`packages/core/src/adapters/fake.ts`), which
  replays scripted sessions, and the fake machine in `adapters/test-machine.ts`. Adapter tests replay recorded engine
  output from `adapters/fixtures/<engine>/`.
- **About 19 tests skip when you run them inside a sandbox.** Some core tests apply Kothar's macOS sandbox, run `ps`
  or write `/tmp`. Inside a sandbox already (for example, when a Kothar agent runs the tests), those can't work, so
  `needs()` in `packages/core/src/test-env.ts` skips them and prints the reason. Run on a normal Mac terminal, they all
  run. On CI they fail instead of skipping, so a broken runner can't pass quietly. The macOS-only tests skip on Linux.
- UI tests run in jsdom. They are `*.test.tsx` files next to the components.

## Repo map

```
packages/
  core/            the core: one Node process that drives engines and owns chats (@kothar/core)
    src/main.ts          startup: reads the environment, finds the garage, registers adapters, loads extensions
    src/core.ts          wires the core together; its parts are the modules beside it (chat-store, turn, protocol,
                         instructions, memory, checkouts, extension-host, settings, setups, ...)
    src/shared.ts        what core and UI share: the adapter interface, the UI protocol, common types
    src/machine.ts       runs processes, locally and sandboxed
    src/folder-modes.ts  how agents may write in attached folders: the sandbox, permission answers and instructions
    src/folder-copies.ts folders set to Work on a copy: the copy, its changes and Copy changes back
    src/adapters/        one file per engine (claude-code, codex, opencode, pi, fake) and their helpers
    src/kothar-mcp.ts    the MCP server Kothar gives every agent (zoom, date, spawn_worker, ...)
  ui/              React app (Tailwind, Radix, Motion), talking to the core over a WebSocket (@kothar/ui)
  desktop/         Electron shell that runs the core and serves the built UI (@kothar/desktop)
  extension-api/   @kothar/extension-api: the public extension types, MIT, types only
extensions/<id>/   the built-in extensions, each default-exporting an Extension from index.ts
extension-documentation/   the extension author docs
bench/             memory benchmark (npm run bench:memory; offline, on the fake engine)
```

The core loads every `extensions/<id>/index.ts` at startup, and the folder name must match the extension's `id`.
Changing an extension's code needs a restart; switching it on or off and its settings apply from the next message.

## Words

Use the names the code uses:

| Word | Meaning |
|---|---|
| Engine | A coding-agent CLI Kothar drives: Claude Code, Codex, OpenCode, pi. |
| Adapter | Translates one engine's headless protocol into Kothar's common events. One per engine. |
| Session | One run of an engine. Each message starts a fresh one; nothing resumes. |
| Chat | An endless conversation owned by Kothar, backed by a series of sessions. |
| Space | A top-level chat with its own folders, files and `AGENTS.md`. Its agent is the **lead**. |
| Worker | A chat started below another for one task: by its agent with `spawn_worker`, or by an extension with `host.createChat({ parentId })`. Its final reply wakes the lead (or, quiet, goes to the extension). Part of the core, set in Settings → Workers. |
| Home | The built-in Home extension's chat (id `main`): a personal assistant that sees every space. |
| Extension | Adds features to Kothar through the public extension API. **Built-in** ones ship in `extensions/`; **community** ones install from the marketplace. |
| Setup | A saved choice for a kind of job: engine, model, thinking level, extensions to leave out, instructions. |
| Garage | Kothar's own folder: settings, accounts, setups and every chat. Plain files (JSON, JSONL, Markdown). |
| Machine | Where processes run. Only the local machine exists today. |

A **tool** is something an agent calls (run a command, edit a file, an MCP tool). Never call an extension a tool.

## Design rules

1. **Small core.** The core is machines, sessions, chats (workers included) and an event stream. Everything else is an
   extension.
2. **Built-in extensions use only the public extension API** (`@kothar/extension-api`). If one needs something the
   API lacks, add a small, generic API change in its own PR first, never a private hook.
3. **Extensions never import the core at runtime.** `@kothar/core` may only be a `devDependency` of an extension, for
   its tests.
4. **Engines are black boxes, always run headless.** Kothar drives them only through their headless protocol and the
   inputs every engine takes (prompt, instructions, MCP servers), never through their own plugins or hooks. Sessions
   start clean, without the user's engine plugins or MCP servers.
5. **Engine-specific code stays in its adapter.** Shared types get no engine-only fields.
6. **Adapters never start processes themselves.** They go through a `Machine`, so the same adapter can run anywhere.
7. **Kothar owns the context.** Each session sees what Kothar gives it: instructions, memory, context items.
8. **State is plain files** in the garage, not a database.
9. **Pass dependencies in.** Core modules take the home folder, environment, clock and machine as arguments rather
   than reading `os.homedir()`, `process.env` or `Date.now()` themselves. Only startup code reads them.

## Decisions

Why some things are the way they are. Add one when you make a choice the next contributor would otherwise undo.

- **Workers are part of the core, not an extension.** They were the Workers extension, but it was only a switch and two
  settings over things that were already core: child chats (`chat-lifecycle.ts`) and the `spawn_worker` tool
  (`kothar-mcp.ts`). As an extension it invited other extensions to depend on it (Deep Research greyed out a setting
  without it), though what they need, child chats, never depended on it. Every agent and every extension can now count
  on workers, so no extension declares a dependency to start one. Settings → Workers (`workers.ts`) keeps what the
  extension had: **Let agents start workers** (the old switch, so turning it off still takes `spawn_worker` and its
  instructions away), **Max running per chat**, and the instructions as an editable prompt. A setup keeps its chats
  from starting workers with `workers: false` (older setups' `extensionsOff: ['workers']` reads as that).
- **One limit counts every worker.** Max running per chat counts every running child of a chat, `spawn_worker`'s and
  extensions' (quiet ones too), so an extension can't run past the user's limit. Over it, `spawn_worker` fails, so the
  agent knows and can wait or stop one; an extension's worker waits for a slot instead, because the extension's work
  (a research run) should finish, not fail. That's also why the switch for agents is separate from the limit: a
  limit of 0 would leave an extension's workers waiting forever.
- **The agent combines extensions; code rarely does.** Each session's "What you can use" section (`core-prompts.ts`)
  lists what the chat can use, made from extensions' metadata, and tells the agent to combine them. Workers get their
  lead's extension tools. An extension a worker uses may start workers one level below that worker (only there), so a
  worker's deep research doesn't wait for the slot the worker itself holds.
- **How extensions work together: five rules.** Other people write extensions and can't change the core, so these keep
  every extension combinable without code linking them:
  1. **Shared building blocks go in the core.** If two or more extensions need the same thing (chats, workers,
     sessions, events, memory, permissions), it's core, reached through the public API. That's why workers moved in.
  2. **Prefer the agent combining tools over code dependencies.** Give each extension clear tools; the agent is told
     what it can use and combines them (a deep research run inside a worker needs no code in either).
  3. **Code dependencies only when one extension changes how another looks or behaves.** Then use
     `optionalDependencies`, `requires`, a setting's `requires`, or a capability (`provides`, `host.provide`,
     `host.use`). Never import another extension's files. Calling another extension's tool with `host.callTool`, with
     a fallback when it's off, is fine.
  4. **Never check `chat.extension` to decide what a chat can do.** It says who owns a chat, not what it can do; that
     check is how Home lost the Deep research chip (#376). Ask about the capability: `chat.keepsContext` (has folders,
     files and a work folder: false for Home), `chat.worker` / `chat.parentId`, or the space's folders.
  5. **Depend on capabilities, not ids.** Name a shared API for what it does (`search`, `research`), so a community
     extension can provide it instead of a built-in one.

## Pull requests

- **Keep PRs small** and about one thing. Run the [checks](#checks) first.
- **Stack PRs while a stack is open.** Open PRs usually form a stack: each PR's base is the branch of the PR below it,
  so they merge bottom-up without conflicts. Start your branch from the top of the open stack (`gh pr list`), base
  your PR on that branch, and link it into the stack with `gh stack link <PR numbers...>`.
- **Change an open PR with a new PR on top** rather than amending it, unless the fix is needed for it to pass CI.
- **Sign off every commit** (see [Sign-off](#sign-off-dco)).

## Adding an engine adapter

An adapter is one file in `packages/core/src/adapters/`, implementing `Adapter` from `packages/core/src/shared.ts`:

- `detect(machine)`: whether the engine is installed and signed in, and the models it offers.
- `start(machine, options, emit)`: starts a session and returns `prompt`, `interrupt`, `respond` (to a permission
  request), `close`, and optionally `answer` and `steer`. It reports what happens through `emit` as common events
  (`EngineEvent` in `@kothar/extension-api`): `turn.started`, `text.delta`, `tool.started`, `permission.requested`,
  `turn.completed` and so on. Every tool call carries a common kind (`shell`, `edit`, `read`, `search`, `fetch`,
  `mcp`, `other`).
- Optional: `complete` (one-shot model calls, used by Memory) and `accounts` (sign in, sign out, API keys).

Rules and helpers:

- **Start processes only through the `Machine`** you're given (`machine.spawn`, `machine.run`), never with
  `child_process`.
- **Read JSON lines with `onJsonLines`** (`adapters/jsonl.ts`), never Node's `readline`: JSON strings may contain
  U+2028 and U+2029, which `readline` treats as line ends. For JSON-RPC over stdio use `rpcClient` (`adapters/rpc.ts`);
  for engines that speak the Agent Client Protocol, start from `adapters/acp.ts` (OpenCode uses it).
- **Label errors** with `withKind(error, YOUR_ERRORS)` from `adapters/error-kind.ts`. Wording every engine shares lives
  there; put your engine's own wording in an `EngineErrors` object in your adapter. Extensions such as Reconnect read
  the label instead of parsing error text.
- **Build it from what it's given.** Follow `createPi` and the others: the adapter takes the user's environment and
  home folder as arguments.
- **Test with fixtures.** Record real engine output once into `adapters/fixtures/<engine>/*.jsonl` and replay it
  through the fake machine (see `pi.test.ts`). Tests never run the real engine.
- Register it in `registered` in `packages/core/src/main.ts`.

## Writing an extension

[extension-documentation/](extension-documentation/index.md) covers using, building and publishing extensions, with
the full API reference. Built-in extensions in `extensions/` follow the same API and are good examples; the
[examples page](extension-documentation/examples.md) walks through three of them.

- A built-in extension is `extensions/<id>/index.ts`, default-exporting an `Extension` whose `id` is the folder name,
  with tests beside it and a `package.json` named `@kothar/extension-<id>`.
- It imports types from `@kothar/extension-api` only. `@kothar/core` is allowed as a test `devDependency`, never at
  runtime.
- It reaches Kothar's data through the host, not around it:
  - Use `host.storage`, `host.chatStorage` or `host.everyChatStorage` for files, not paths worked out from the
    garage.
  - Use `host.home` and `host.now()` for the home folder and the time, not `node:os` or `Date.now()`.
  - Use `host.space(chatId).checkouts` and `onSpaceRemoved` for a space's checkouts.
- The core creates every checkout and removes them when a space is deleted (design rule 10). Optional cleanup of merged
  work belongs to an extension; see `extensions/git/cleanup.ts`.
- If the API lacks something, add the smallest generic change to `packages/extension-api/index.ts` and the core in its
  own PR, update `extension-documentation/reference/`, then build the extension on top.

Community extensions and themes don't live in this repo; see
[Adding a theme or extension to the marketplace](#adding-a-theme-or-extension-to-the-marketplace).

## Old names and why they still work

Kothar was called Hotrod; extensions were called mods (community ones "aftermarket" mods), and workers were
subagents. Installs, saved files and published extensions from then must keep working, so a few places still accept
the old names. Don't remove these, and don't use the old names in new code:

| Where | What it keeps working |
|---|---|
| `packages/core/src/main.ts` (`envVar`, `defaultGarage`) | Every `KOTHAR_` variable falls back to its `HOTROD_` name; an old Hotrod garage moves to Kothar's folder on first launch. |
| `packages/core/src/garage-move.ts` | That one-time garage move, repointing stored paths. |
| `packages/core/src/vocab-move.ts` | Settings, chats and garage folders saved under the old words (mod, subagent, aftermarket, `askNetworkCommands`) are read under the new ones. |
| `packages/core/src/machine.ts` (`HOTROD_TOKEN`) | The old token variable is stripped from agents' environments too. |
| `packages/core/src/core.ts` (`mod:` beside `extension:` in chat summaries) and `packages/extension-api/index.ts` (deprecated `mod` field) | Extensions written when they were called mods. |
| `packages/core/src/catalog-check.ts` (catalog `kind: 'mod'`) | Marketplace catalogs written when extensions were mods. |
| `packages/core/src/memory.ts`, `packages/ui/src/state.ts` (`[subagent "…"]`) | Worker reports in old chat logs. |
| `packages/ui/src/connection.ts` (`VITE_HOTROD_CORE_URL`), `packages/ui/vite.config.ts` (`HOTROD_UI_PORT`) | Old UI environment variables. |
| `packages/ui/src/renamed-storage.ts` | UI preferences saved under `hotrod.*` keys move to `kothar.*`. |
| `packages/ui/src/panel-tab.ts` | Panel tabs saved as `mod:<id>`. |
| `packages/core/src/workers.ts` (`moveWorkersSettings`), `packages/core/src/setups.ts` (`extensionsOff: ['workers']`) | Settings and setups saved while workers were an extension. |

## Licence of contributions

Contributions are licensed under the licence of the files they change (inbound = outbound):

- `packages/extension-api/`: MIT ([packages/extension-api/LICENSE](packages/extension-api/LICENSE)).
- Everything else: FSL-1.1-ALv2 ([LICENSE.md](LICENSE.md)).

## Adding a theme or extension to the marketplace

Themes and community extensions don't live in this repo. Publish yours from a repo of your own and submit it to the
catalog: see [kothar-marketplace](https://github.com/billwang7599/kothar-marketplace#submit-a-theme-or-extension). The
theme format and a template are in [kothar-themes](https://github.com/billwang7599/kothar-themes#make-your-own-theme);
an extension starts from the template [kothar-sample-mod](https://github.com/billwang7599/kothar-sample-mod).

## Sign-off (DCO)

Sign off every commit to certify the [Developer Certificate of Origin](https://developercertificate.org/), that you
wrote the change or otherwise have the right to submit it under that licence:

```sh
git commit -s
```

This adds a `Signed-off-by: Your Name <you@example.com>` line, which must match the commit's author.
