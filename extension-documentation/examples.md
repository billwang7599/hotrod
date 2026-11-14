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

Browser gives agents a few browser tools of its own, which speak the Chrome DevTools Protocol to one headless browser
per space that the extension itself runs: the user's installed Google Chrome (or Edge, Brave, Arc or Chromium) on a
profile of its own per space, or the user's own Chrome through a Chrome extension of Kothar's.
Parts worth copying:

- **Tools of its own instead of an MCP server.** `tools` lists `browser_open`, `browser_snapshot`, `browser_act`,
  `browser_type`, `browser_tabs`, `browser_screenshot` and `browser_cdp`, about 800 tokens in all. They connect through
  a small local HTTP endpoint that `onStart` and `onStop` start and stop, and the browser launches (with `host.spawn`)
  only when an agent first browses. It stays between messages, so tabs and logins do, and stops when the space has
  been idle a while, the extension is turned off, or Kothar quits. `browser_screenshot` sets `result: 'mcp'` to return
  a picture.
- **A raw escape hatch, with rules.** `browser_cdp` sends any DevTools command to the agent's own tab, checked first
  (`safety.ts`): browser-wide and cookie commands are refused, page reads and interaction run, and the rest ask the
  user with [`host.requestPermission`](reference/host.md), which shows the method and its parameters.
- **A tool that waits for the user.** `ask_user_in_browser` relaunches the space's profile as a plain window (no
  remote debugging, so sites like Google let the user sign in) on the same tabs, then calls
  [`host.wait`](reference/host.md#waiting-for-the-user) with **Open browser** and **Done** buttons and waits.
  `onWaitAction` ends the hand-off, and the tool returns the tabs the browser reopens from the profile's saved session.
  `show_browser` relaunches in a window Kothar still reads over DevTools, for showing the user something.
- **Settings that depend on the machine.** `settingsView` says which installed browser runs Kothar's own profile (or
  to install Chrome), or, for your own Chrome, the setup steps and pairing code; `onSettingsChanged` closes the
  background browsers when the profile changes, and `migrateSettings` turns choices that no longer exist into ones
  that do.
- **Commands.** **Show browser**, **Sign in…** and **Hide browser** in the General tab, each `shown` only when it
  applies.
- **A Processes row.** [`processes`](reference/host.md#processes-rows) lists the space's browser while it runs, with
  **Show** (take it over at any time; **Hide** puts it back) and **Stop**, and `host.processesChanged` redraws the
  tab when it changes.
- **`setup`** is ready when a Chromium-family browser is installed; with none, it says to install Google Chrome.

**The pattern:** keep what the agent needs running in the extension, not in the session, so it outlives each turn; let
the user see it in Processes, and hand it to them with a wait when the agent can't go on alone.
