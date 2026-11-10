---
title: Examples
description: How three built-in extensions - Home, Processes and Account rotation - plus Browser use the extension API.
---

# Examples

Kothar's built-in extensions use only the public extension API, the same one community extensions use. So they're good
patterns to copy. Their full source is in the Kothar repo's [`extensions/`
folder](https://github.com/billwang7599/kothar/tree/main/extensions).

## Home: a chat of its own, with a tool

[Source](https://github.com/billwang7599/kothar/blob/main/extensions/home/index.ts)

Home is your personal assistant, pinned beside your spaces. The whole extension is two fields:

- **`chats`** declares one chat, with id `main`, role instructions, and `seesAll: true`, so it can list, read and
  message every space.
- **`tools`** gives that chat one tool, `create_chat`, which makes a new space.

The tool's `offered` limits it to Home's own chat. Its `run` checks the input, then calls the host:

```ts
import type { Extension } from '@kothar/extension-api'

type NewSpace = { name: string; prompt?: string; folders?: string[] }

const home: Extension = {
  id: 'home-like',
  name: 'Home-like',
  description: 'A pinned assistant chat that can make spaces.',
  enabledByDefault: false,
  chats: [{ id: 'assistant', name: 'Assistant', instructions: 'You are the user’s assistant.', seesAll: true }],
  tools: [
    {
      name: 'make_space',
      description: 'Make a space with these folders. Give a prompt to start it. Returns its id.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1 },
          prompt: { type: 'string' },
          folders: { type: 'array', items: { type: 'string' } },
        },
        required: ['name'],
      },
      offered: (caller) => caller.id === 'assistant',
      run(input, { host }) {
        const { prompt, ...spec } = input as NewSpace
        const chat = host.createChat(spec)
        if (prompt) host.send(chat.id, prompt)
        return { chatId: chat.id }
      },
    },
  ],
}

export default home
```

**The pattern:** an extension chat is a role (its instructions) plus tools only that chat is offered.

## Processes: tools, a live panel and cleanup

[Source](https://github.com/billwang7599/kothar/blob/main/extensions/processes/index.ts)

Processes lets agents run dev servers and watchers that outlive a turn. It uses most of the API:

- **`instructions`** tell agents to use its tools instead of running things in the background. It returns text only
  when `tools` is `true`, since a session without Kothar's MCP server can't call them.
- **`tools`**: `start_process`, `list_processes`, `read_output` and `stop_process`. Each finds the caller's space with
  `host.space(caller.id)`, so a lead and its workers share one list.
- **`host.spawn`** with `chat` set runs each command sandboxed as the space's own commands are. `onOutput` collects
  the output; `onExit` records how it ended and writes a `host.note` that opens the panel.
- **`panels`**: a Processes tab. `shown` hides it until the space has run something. `render` builds a `list` of
  processes, each with a status `dot`, an uptime in `since` and a link to its address, plus a `code` view of the
  selected one's output with `follow: true`. Buttons send `stop`, `restart` and `terminal` actions to `onAction`.
- **`host.refresh`**, throttled, redraws the panel as output arrives.
- **`host.storage.dir`** holds each process's log file.
- **`onChatArchived`** and **`onChatRemoved`** stop a space's processes when it's archived or deleted.

**The pattern:** keep state in the extension (a map by space id), let tools and the panel read the same state, and call
`refresh` when it changes.

## Account rotation: one hook

[Source](https://github.com/billwang7599/kothar/blob/main/extensions/account-rotation/index.ts)

Account rotation switches to the next saved account when a turn hits its usage limit. It's one setting and one hook,
`onLimitReached`:

1. `host.accounts(limit.engine)` lists the engine's saved accounts.
2. It picks the next account that isn't limited, and calls `host.useAccount`. On engines where each account signs in
   to one provider (OpenCode), it skips accounts of another `provider`, since the chat's model won't run there. An
   account with no `provider` (the engine's own login) is a fallback for every provider. From one, the chat's provider
   comes from `limit.model`, the model the turn ran on: the part before `/` when a saved account has that `provider`
   (OpenCode's ids look like `anthropic/claude-sonnet-4-5`). When the model can't tell it, it rotates only to other
   accounts without a `provider` rather than guess.
3. If the turn hadn't produced anything yet (`limit.output` is `false`), `host.retry` sends the message again.
   Otherwise `host.continue` carries on the turn, with a prompt that tells the agent not to redo finished work.
4. `host.note` tells you what happened.

```ts
import type { Extension } from '@kothar/extension-api'

const rotate: Extension = {
  id: 'simple-rotation',
  name: 'Simple rotation',
  description: 'On a usage limit, switch to the next saved account and carry on.',
  enabledByDefault: false,
  onLimitReached(limit, { host }) {
    const saved = host.accounts(limit.engine)
    if (!saved || saved.accounts.length < 2) return
    const at = saved.accounts.findIndex((account) => account.id === saved.active)
    const next = saved.accounts[(at + 1) % saved.accounts.length]!
    host.useAccount(limit.engine, next.id)
    host.note(limit.chat.id, `Switched to ${next.name}`)
    if (limit.output) host.continue(limit.chat.id, 'Continue from where you stopped. Don’t redo finished work.')
    else host.retry(limit.chat.id)
  },
}

export default rotate
```

Its manifest would list `events`, `accounts` and `sendMessages`.

**The pattern:** one hook, a few host calls, and a note so you know what the extension did.

## Browser: a background process, and handing it to the user

[Source](https://github.com/billwang7599/kothar/blob/main/extensions/browser/index.ts)

Browser gives agents Playwright's MCP server, attached to one headless browser per space that the extension itself
runs: Playwright's Chromium on a profile of its own, or a copy of one of the user's profiles on that browser's own app.
Parts worth copying:

- **`onStart` and `onStop`** start and stop a small local HTTP endpoint. `mcpServers` gives Playwright MCP that
  address as `--cdp-endpoint`, and the browser launches (with `host.spawn`) only when an agent first browses. It
  stays between messages, so tabs and logins do, and stops when the space has been idle a while, the extension is turned
  off, or Kothar quits.
- **A tool that waits for the user.** `ask_user_in_browser` relaunches the space's profile in a window with the same
  tabs and cookies, then calls [`host.wait`](reference/host.md#waiting-for-the-user) with **Open browser** and
  **Done** buttons and waits. `onWaitAction` ends the hand-off, and the tool returns the tabs the user left.
  `show_browser` is the same tool with another description, for showing the user something.
- **Settings that depend on the machine.** `settings` is a getter, so the Profile picker lists the browser profiles
  installed now; `settingsView` adds a readout of where logins come from and a **Refresh logins now** button, and
  `onSettingsChanged` closes the background browsers when the profile changes.
- **Commands.** **Show browser** and **Hide browser** in the General tab, each `shown` only when it applies.
- **Filtering an MCP server's tools.** Playwright MCP runs behind a small stdio filter (`mcp-filter.ts`) that drops
  tools from `tools/list` and refuses calls to them, since its `--caps` flag only adds whole groups.
- **A Processes row.** [`processes`](reference/host.md#processes-rows) lists the space's browser while it runs, with
  **Show** (take it over at any time; **Hide** puts it back) and **Stop**, and `host.processesChanged` redraws the
  tab when it changes.
- **`setup`** checks for Playwright's Chromium and installs it, reporting download progress with `report`.

**The pattern:** keep what the agent needs running in the extension, not in the session, so it outlives each turn; let
the user see it in Processes, and hand it to them with a wait when the agent can't go on alone.
